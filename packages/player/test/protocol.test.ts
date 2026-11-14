// SPDX-License-Identifier: Apache-2.0
// Protocol validators and key mapping. Tests run against the build (`dist`).

import { LIMITS } from "@pptaken/schema";
import { describe, expect, it } from "vitest";
import {
  KEY_CODES,
  type KeyLike,
  keyCodeOf,
  MAX_SLIDES,
  MAX_STEPS,
  parseContentMessage,
  parseShellMessage,
} from "../dist/index.js";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("shell -> iframe messages", () => {
  it("accepts well-formed messages and returns a copy", () => {
    const goto = { v: 1, type: "goto", slide: 3, step: 2 };
    const parsed = parseShellMessage(goto);
    expect(parsed).toEqual(goto);
    expect(parsed).not.toBe(goto);
    expect(parseShellMessage({ v: 1, type: "goto", slide: 0, step: 0 })).not.toBeNull();
    expect(
      parseShellMessage({ v: 1, type: "goto", slide: MAX_SLIDES - 1, step: MAX_STEPS }),
    ).not.toBeNull();
    expect(parseShellMessage({ v: 1, type: "mode", mode: "present" })).toEqual({
      v: 1,
      type: "mode",
      mode: "present",
    });
  });

  it("drops anything else", () => {
    const bad: unknown[] = [
      null,
      undefined,
      0,
      "goto",
      [],
      [{ v: 1, type: "goto", slide: 0, step: 0 }],
      {},
      { v: 1, type: "goto", slide: 0 },
      { v: 1, type: "goto", slide: 0, step: 0, extra: 1 },
      { v: 2, type: "goto", slide: 0, step: 0 },
      { v: "1", type: "goto", slide: 0, step: 0 },
      { type: "goto", slide: 0, step: 0 },
      { v: 1, type: "goto", slide: -1, step: 0 },
      { v: 1, type: "goto", slide: MAX_SLIDES, step: 0 },
      { v: 1, type: "goto", slide: 0, step: MAX_STEPS + 1 },
      { v: 1, type: "goto", slide: 1.5, step: 0 },
      { v: 1, type: "goto", slide: Number.NaN, step: 0 },
      { v: 1, type: "goto", slide: "1", step: 0 },
      { v: 1, type: "goto", slide: 0, step: null },
      { v: 1, type: "mode", mode: "overview" },
      { v: 1, type: "mode", mode: "print" },
      { v: 1, type: "mode", mode: "PRESENT" },
      { v: 1, type: "unknown" },
      { v: 1, type: "ready", slides: [{ id: "a", steps: 0 }] },
      Object.assign(Object.create({ inherited: 1 }), { v: 1, type: "goto", slide: 0, step: 0 }),
      Object.assign(Object.create(null), { v: 1, type: "goto", slide: 0, step: 0 }),
      JSON.parse('{"v":1,"type":"goto","slide":0,"step":0,"__proto__":{"x":1}}'),
    ];
    for (const data of bad) expect(parseShellMessage(data), JSON.stringify(data)).toBeNull();
  });
});

describe("iframe -> shell messages", () => {
  it("accepts ready, key and state", () => {
    const ready = {
      v: 1,
      type: "ready",
      slides: [
        { id: "cover", steps: 0 },
        { id: "a-2", steps: 3 },
      ],
    };
    expect(parseContentMessage(ready)).toEqual(ready);
    for (const code of KEY_CODES) {
      expect(parseContentMessage({ v: 1, type: "key", code })).toEqual({ v: 1, type: "key", code });
    }
    expect(parseContentMessage({ v: 1, type: "state", slide: 2, step: 1 })).not.toBeNull();
  });

  it("drops anything else", () => {
    const many = Array.from({ length: MAX_SLIDES + 1 }, (_, i) => ({ id: `s${i}`, steps: 0 }));
    const bad: unknown[] = [
      { v: 1, type: "ready", slides: [] },
      { v: 1, type: "ready", slides: many },
      {
        v: 1,
        type: "ready",
        slides: [
          { id: "a", steps: 0 },
          { id: "a", steps: 1 },
        ],
      },
      { v: 1, type: "ready", slides: [{ id: "A", steps: 0 }] },
      { v: 1, type: "ready", slides: [{ id: "a".repeat(41), steps: 0 }] },
      { v: 1, type: "ready", slides: [{ id: 'a"><script>', steps: 0 }] },
      { v: 1, type: "ready", slides: [{ id: "a", steps: -1 }] },
      { v: 1, type: "ready", slides: [{ id: "a", steps: MAX_STEPS + 1 }] },
      { v: 1, type: "ready", slides: [{ id: "a", steps: 0, title: "x" }] },
      { v: 1, type: "ready", slides: [null] },
      { v: 1, type: "ready", slides: "a" },
      { v: 1, type: "ready", slides: [{ id: "a", steps: 0 }], extra: true },
      { v: 1, type: "key", code: "KeyA" },
      { v: 1, type: "key", code: "Escape" },
      { v: 1, type: "key", code: "toString" },
      { v: 1, type: "key" },
      { v: 1, type: "state", slide: -1, step: 0 },
      { v: 1, type: "state", slide: 0, step: 0.5 },
      { v: 1, type: "goto", slide: 0, step: 0 },
      { v: 0, type: "key", code: "Space" },
    ];
    for (const data of bad) expect(parseContentMessage(data), JSON.stringify(data)).toBeNull();
  });

  it("uses the schema's slide limit", () => {
    expect(MAX_SLIDES).toBe(LIMITS.maxSlides);
  });
});

describe("keyCodeOf", () => {
  it("maps navigation and clicker keys", () => {
    const cases: [string, string][] = [
      ["ArrowRight", "ArrowRight"],
      ["ArrowLeft", "ArrowLeft"],
      ["ArrowUp", "ArrowUp"],
      ["ArrowDown", "ArrowDown"],
      ["PageDown", "PageDown"],
      ["PageUp", "PageUp"],
      [" ", "Space"],
      ["Enter", "Enter"],
      ["Backspace", "Backspace"],
      ["Home", "Home"],
      ["End", "End"],
      ["b", "KeyB"],
      ["B", "KeyB"],
      [".", "Period"],
      ["f", "KeyF"],
      ["F", "KeyF"],
    ];
    for (const [k, code] of cases) expect(keyCodeOf(key(k))).toBe(code);
    expect(keyCodeOf(key(" ", { shiftKey: true }))).toBe("ShiftSpace");
  });

  it("ignores other keys and modifiers", () => {
    for (const k of ["a", "Escape", "Tab", "F5", "Unidentified", ""])
      expect(keyCodeOf(key(k))).toBeNull();
    for (const mods of [
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      expect(keyCodeOf(key("ArrowRight", mods))).toBeNull();
    }
    expect(keyCodeOf(key(" ", { ctrlKey: true }))).toBeNull();
    expect(keyCodeOf(key("ArrowRight", { isComposing: true }))).toBeNull();
  });
});
