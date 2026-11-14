// SPDX-License-Identifier: Apache-2.0
// Navigation is pure: exhaustive checks over many deck shapes, no browser. Tests run against the build (`dist`).

import { describe, expect, it } from "vitest";
import { KEY_ACTIONS, KEY_CODES, navigation as nav, type Position } from "../dist/index.js";

const shape = (...steps: number[]) => ({ slides: steps.map((s) => ({ steps: s })) });

/** Every valid position of a shape, in presentation order. */
function positions(s: { slides: { steps: number }[] }): Position[] {
  return s.slides.flatMap((slide, i) =>
    Array.from({ length: slide.steps + 1 }, (_, step) => ({ slide: i, step })),
  );
}

// Deterministic set of shapes: all with 1..4 slides and 0..3 steps per slide, plus some larger ones.
const shapes: { slides: { steps: number }[] }[] = [];
for (let n = 1; n <= 4; n++) {
  const total = 4 ** n;
  for (let code = 0; code < total; code++) {
    const steps: number[] = [];
    let c = code;
    for (let i = 0; i < n; i++) {
      steps.push(c % 4);
      c = Math.floor(c / 4);
    }
    shapes.push(shape(...steps));
  }
}
shapes.push(shape(...Array.from({ length: 200 }, (_, i) => i % 7)));
shapes.push(shape(255, 0, 255));

describe("navigation", () => {
  it("next walks every position in order and stops at the end", () => {
    for (const s of shapes) {
      const all = positions(s);
      let p = nav.first(s);
      const seen = [p];
      for (let i = 1; i < all.length; i++) {
        p = nav.next(s, p);
        seen.push(p);
      }
      expect(seen).toEqual(all);
      expect(nav.next(s, p)).toEqual(p);
      expect(p).toEqual(nav.last(s));
    }
  });

  it("prev is the inverse of next and stops at the start", () => {
    for (const s of shapes) {
      for (const p of positions(s)) {
        const n = nav.next(s, p);
        if (!nav.samePosition(n, p)) expect(nav.prev(s, n)).toEqual(p);
        const b = nav.prev(s, p);
        if (!nav.samePosition(b, p)) expect(nav.next(s, b)).toEqual(p);
      }
      expect(nav.prev(s, nav.first(s))).toEqual({ slide: 0, step: 0 });
    }
  });

  it("prev from step 0 lands on the previous slide fully revealed", () => {
    const s = shape(3, 0, 2);
    expect(nav.prev(s, { slide: 1, step: 0 })).toEqual({ slide: 0, step: 3 });
    expect(nav.prev(s, { slide: 2, step: 0 })).toEqual({ slide: 1, step: 0 });
  });

  it("first and last", () => {
    expect(nav.first(shape(2, 2))).toEqual({ slide: 0, step: 0 });
    expect(nav.last(shape(2, 5))).toEqual({ slide: 1, step: 5 });
    expect(nav.last(shape(0))).toEqual({ slide: 0, step: 0 });
    expect(nav.last({ slides: [] })).toEqual({ slide: 0, step: 0 });
  });

  it("clamp keeps valid positions and repairs invalid ones", () => {
    const s = shape(2, 0, 4);
    for (const p of positions(s)) expect(nav.clamp(s, p)).toEqual(p);
    expect(nav.clamp(s, { slide: -3, step: -1 })).toEqual({ slide: 0, step: 0 });
    expect(nav.clamp(s, { slide: 99, step: 99 })).toEqual({ slide: 2, step: 4 });
    expect(nav.clamp(s, { slide: 1, step: 3 })).toEqual({ slide: 1, step: 0 });
    expect(nav.clamp(s, { slide: 0, step: 1.9 })).toEqual({ slide: 0, step: 1 });
    expect(nav.clamp(s, { slide: Number.NaN, step: Number.POSITIVE_INFINITY })).toEqual({
      slide: 0,
      step: 0,
    });
    expect(nav.clamp({ slides: [] }, { slide: 4, step: 4 })).toEqual({ slide: 0, step: 0 });
    // Bad step counts in the shape are treated as 0.
    expect(nav.clamp({ slides: [{ steps: -2 }] }, { slide: 0, step: 1 })).toEqual({
      slide: 0,
      step: 0,
    });
  });

  it("next and prev clamp their input first", () => {
    const s = shape(1, 1);
    expect(nav.next(s, { slide: 9, step: 9 })).toEqual({ slide: 1, step: 1 });
    expect(nav.prev(s, { slide: -1, step: 0 })).toEqual({ slide: 0, step: 0 });
  });

  it("parses and formats URL hashes", () => {
    expect(nav.parseHash("#/5/1")).toEqual({ slide: 4, step: 1 });
    expect(nav.parseHash("#/5")).toEqual({ slide: 4, step: 0 });
    expect(nav.parseHash("#/5/")).toEqual({ slide: 4, step: 0 });
    expect(nav.parseHash("#/1/0")).toEqual({ slide: 0, step: 0 });
    expect(nav.parseHash("#/0/0")).toEqual({ slide: -1, step: 0 });
    for (const bad of [
      "",
      "#",
      "#/",
      "#5/1",
      "#/a/1",
      "#/1/b",
      "#/1/2/3",
      "#/-1/0",
      "#/1.5",
      "#/1234567",
    ]) {
      expect(nav.parseHash(bad)).toBeNull();
    }
    expect(nav.formatHash({ slide: 0, step: 0 })).toBe("#/1/0");
    expect(nav.formatHash({ slide: 4, step: 2 })).toBe("#/5/2");
    for (const p of positions(shape(2, 3))) expect(nav.parseHash(nav.formatHash(p))).toEqual(p);
  });

  it("maps every key code to an action", () => {
    for (const code of KEY_CODES) expect(KEY_ACTIONS[code]).toBeTypeOf("string");
    expect(Object.keys(KEY_ACTIONS).sort()).toEqual([...KEY_CODES].sort());
  });
});
