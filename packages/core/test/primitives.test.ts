// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { countSteps } from "../src/deck.js";
import { DomainError, isDomainError, revisionConflict } from "../src/errors.js";
import { sha256Hex, utf8Encode } from "../src/sha256.js";
import { createUlidFactory, isUlid, ulidTime } from "../src/ulid.js";

describe("sha256Hex", () => {
  it("matches known vectors", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(utf8Encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches node:crypto on every length around the block boundaries and on large input", () => {
    for (let n = 0; n <= 200; n++) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
      expect(sha256Hex(data)).toBe(createHash("sha256").update(data).digest("hex"));
    }
    const big = new Uint8Array(5 * 1024 * 1024).map((_, i) => (i * 7) & 255);
    expect(sha256Hex(big)).toBe(createHash("sha256").update(big).digest("hex"));
  });
});

describe("utf8Encode", () => {
  it("matches TextEncoder, including astral characters and lone surrogates", () => {
    for (const text of [
      "",
      "abc",
      "ñandú",
      "€",
      "🎉 emoji",
      "a\uD800b",
      "\uDC00",
      "\u0000\u007f\u0080߿ࠀ￿",
    ]) {
      expect(utf8Encode(text)).toEqual(new TextEncoder().encode(text));
    }
  });
});

describe("ULID", () => {
  it("encodes time and is monotonic within a millisecond", () => {
    let i = 0;
    const next = createUlidFactory(
      () => 1_234_567_890_123,
      (n) => new Uint8Array(n).fill(i++ === 0 ? 0xff : 0),
    );
    const a = next();
    const b = next();
    expect(isUlid(a)).toBe(true);
    expect(ulidTime(a)).toBe(1_234_567_890_123);
    expect(b > a).toBe(true);
  });

  it("moves to the next millisecond instead of overflowing the random part", () => {
    const next = createUlidFactory(
      () => 1000,
      (n) => new Uint8Array(n).fill(0xff),
    );
    const a = next(); // random part all ones
    const b = next(); // overflow -> time + 1
    expect(ulidTime(b)).toBe(1001);
    expect(b > a).toBe(true);
  });

  it("rejects out-of-range time", () => {
    expect(() =>
      createUlidFactory(
        () => -1,
        (n) => new Uint8Array(n),
      )(),
    ).toThrow(RangeError);
  });
});

describe("DomainError", () => {
  it("serializes the agent-facing body without the cause", () => {
    const error = revisionConflict(3, 7);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.toJSON()).toEqual({
      code: "REVISION_CONFLICT",
      message: "Expected revision 3 but the current revision is 7",
      path: "expectedRevision",
      hint: expect.stringContaining("The current revision is 7"),
      retryable: true,
      details: { currentRevision: 7, expectedRevision: 3 },
    });
    expect(isDomainError({ name: "DomainError", code: "NOT_FOUND", hint: "x" })).toBe(true);
    expect(isDomainError({ name: "DomainError", code: "NOPE", hint: "x" })).toBe(false);
    expect(isDomainError(new Error("x"))).toBe(false);
  });
});

describe("config", () => {
  it("rejects nonsensical values", () => {
    expect(() => resolveConfig({ limits: { maxSlides: 500 } })).toThrow(RangeError);
    expect(() => resolveConfig({ limits: { maxAssetBytes: 0 } })).toThrow(RangeError);
    expect(() => resolveConfig({ revisionsKept: 0 })).toThrow(RangeError);
    expect(resolveConfig({ limits: { maxSlides: 10 } }).limits.maxSlides).toBe(10);
  });
});

describe("countSteps", () => {
  it("counts like the player: distinct numbers, then one step per unnumbered element", () => {
    expect(countSteps("<p>no steps</p>")).toBe(0);
    expect(
      countSteps(
        '<b data-step="2">B</b><i data-step="">U1</i><a data-step="1">A</a><i data-step="">U2</i><b data-step="2">B2</b>',
      ),
    ).toBe(4);
    expect(countSteps('<p>text data-step="3" is not an attribute</p>')).toBe(0);
  });
});
