// SPDX-License-Identifier: Apache-2.0
// Protocol validators and key mapping. Tests run against the build (`dist`).

import { LIMITS } from "@pptaken/schema";
import { describe, expect, it } from "vitest";
import {
  KEY_CODES,
  type KeyLike,
  keyCodeOf,
  MAX_CANVAS,
  MAX_SLIDES,
  MAX_STEPS,
  MODES,
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
    for (const mode of MODES) {
      expect(parseShellMessage({ v: 1, type: "mode", mode })).toEqual({ v: 1, type: "mode", mode });
    }
    expect(MODES).toEqual(["present", "overview", "print"]);
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
      { v: 1, type: "mode", mode: "speaker" },
      { v: 1, type: "mode", mode: "toString" },
      { v: 1, type: "mode", mode: ["overview"] },
      { v: 1, type: "mode", mode: "overview", extra: 1 },
      { v: 1, type: "mode", mode: "PRESENT" },
      { v: 1, type: "select", slide: 0 },
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
  it("accepts ready, key, state and select", () => {
    const ready = {
      v: 1,
      type: "ready",
      slides: [
        { id: "cover", steps: 0 },
        { id: "a-2", steps: 3 },
      ],
      width: 1920,
      height: 1080,
    };
    expect(parseContentMessage(ready)).toEqual(ready);
    for (const code of KEY_CODES) {
      expect(parseContentMessage({ v: 1, type: "key", code })).toEqual({ v: 1, type: "key", code });
    }
    expect(parseContentMessage({ v: 1, type: "state", slide: 2, step: 1 })).not.toBeNull();
    expect(parseContentMessage({ v: 1, type: "select", slide: 0 })).toEqual({
      v: 1,
      type: "select",
      slide: 0,
    });
    expect(parseContentMessage({ v: 1, type: "select", slide: MAX_SLIDES - 1 })).not.toBeNull();
  });

  it("drops anything else", () => {
    const many = Array.from({ length: MAX_SLIDES + 1 }, (_, i) => ({ id: `s${i}`, steps: 0 }));
    const size = { width: 1920, height: 1080 };
    const bad: unknown[] = [
      { v: 1, type: "ready", slides: [], ...size },
      { v: 1, type: "ready", slides: many, ...size },
      {
        v: 1,
        type: "ready",
        slides: [
          { id: "a", steps: 0 },
          { id: "a", steps: 1 },
        ],
        ...size,
      },
      { v: 1, type: "ready", slides: [{ id: "A", steps: 0 }], ...size },
      { v: 1, type: "ready", slides: [{ id: "a".repeat(41), steps: 0 }], ...size },
      { v: 1, type: "ready", slides: [{ id: 'a"><script>', steps: 0 }], ...size },
      { v: 1, type: "ready", slides: [{ id: "a", steps: -1 }], ...size },
      { v: 1, type: "ready", slides: [{ id: "a", steps: MAX_STEPS + 1 }], ...size },
      { v: 1, type: "ready", slides: [{ id: "a", steps: 0, title: "x" }], ...size },
      { v: 1, type: "ready", slides: [null], ...size },
      { v: 1, type: "ready", slides: "a", ...size },
      { v: 1, type: "ready", slides: [{ id: "a", steps: 0 }], extra: true, ...size },
      { v: 1, type: "ready", slides: [{ id: "a", steps: 0 }] },
      { v: 1, type: "ready", slides: [{ id: "a", steps: 0 }], width: 0, height: 1080 },
      { v: 1, type: "ready", slides: [{ id: "a", steps: 0 }], width: 1920, height: MAX_CANVAS + 1 },
      { v: 1, type: "ready", slides: [{ id: "a", steps: 0 }], width: 1920.5, height: 1080 },
      { v: 1, type: "ready", slides: [{ id: "a", steps: 0 }], width: "1920", height: 1080 },
      { v: 1, type: "select", slide: -1 },
      { v: 1, type: "select", slide: MAX_SLIDES },
      { v: 1, type: "select", slide: 0.5 },
      { v: 1, type: "select", slide: "0" },
      { v: 1, type: "select" },
      { v: 1, type: "select", slide: 0, step: 0 },
      { v: 2, type: "select", slide: 0 },
      { v: 1, type: "mode", mode: "overview" },
      { v: 1, type: "key", code: "KeyA" },
      { v: 1, type: "key", code: "Tab" },
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
      ["o", "KeyO"],
      ["O", "KeyO"],
      ["s", "KeyS"],
      ["p", "KeyP"],
      ["t", "KeyT"],
      ["Escape", "Escape"],
      ["?", "Question"],
    ];
    for (const [k, code] of cases) expect(keyCodeOf(key(k))).toBe(code);
    expect(keyCodeOf(key(" ", { shiftKey: true }))).toBe("ShiftSpace");
    expect(keyCodeOf(key("R", { shiftKey: true }))).toBe("ShiftKeyR");
    expect(keyCodeOf(key("?", { shiftKey: true }))).toBe("Question");
    // Every mapped code is in the closed set the shell accepts.
    for (const [, code] of cases) expect(KEY_CODES).toContain(code);
  });

  it("ignores other keys and modifiers", () => {
    for (const k of ["a", "r", "R", "Tab", "F5", "Unidentified", "", "constructor", "oo", "ß"])
      expect(keyCodeOf(key(k))).toBeNull();
    for (const k of ["O", "S", "P", "T", "B", "ArrowRight"])
      expect(keyCodeOf(key(k, { shiftKey: true }))).toBeNull();
    expect(keyCodeOf(key("R", { shiftKey: true, ctrlKey: true }))).toBeNull();
    expect(keyCodeOf(key("?", { altKey: true }))).toBeNull();
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
