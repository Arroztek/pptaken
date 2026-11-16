// SPDX-License-Identifier: Apache-2.0
// End of the talk: `isEnd` (where the presenter view shows its cue and Esc finishes), the help rows for the
// presenter keys, and the end/finish texts in both languages. Tests run against the build (`dist`).

import { describe, expect, it } from "vitest";
import { KEY_ACTIONS, keyHelpRows, LABELS, navigation as nav } from "../dist/index.js";

const shape = (...steps: number[]) => ({ slides: steps.map((s) => ({ steps: s })) });

describe("isEnd", () => {
  it("is true only at the last slide with every step revealed", () => {
    const s = shape(0, 2, 3);
    for (let slide = 0; slide < 3; slide++) {
      for (let step = 0; step <= (s.slides[slide]?.steps ?? 0); step++) {
        expect(nav.isEnd(s, { slide, step }), `${slide}/${step}`).toBe(slide === 2 && step === 3);
      }
    }
  });

  it("agrees with next() staying put, over many shapes", () => {
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        const s = shape(a, b);
        for (const p of [
          { slide: 0, step: 0 },
          { slide: 1, step: 0 },
          { slide: 1, step: b },
          nav.last(s),
        ]) {
          expect(nav.isEnd(s, p)).toBe(nav.samePosition(nav.next(s, p), nav.clamp(s, p)));
        }
      }
    }
  });

  it("clamps out-of-range positions and is false for an empty deck", () => {
    expect(nav.isEnd(shape(1, 1), { slide: 99, step: 99 })).toBe(true);
    expect(nav.isEnd({ slides: [] }, { slide: 0, step: 0 })).toBe(false);
    expect(nav.isEnd(shape(0), { slide: 0, step: 0 })).toBe(true);
  });

  it("Escape keeps its key action (close); the presenter maps it to finish at the end", () => {
    expect(KEY_ACTIONS.Escape).toBe("close");
  });
});

describe("key help rows", () => {
  it("list the presenter keys only with a presenter window", () => {
    const keys = (rows: [string, string][]) => rows.map(([k]) => k);
    const withPresenter = keyHelpRows(LABELS.en, true, false);
    const without = keyHelpRows(LABELS.en, false, false);
    expect(keys(withPresenter)).toEqual(expect.arrayContaining(["S", "T", "Shift+R"]));
    expect(withPresenter).toContainEqual(["Esc", LABELS.en.helpFinish]);
    expect(keys(without)).not.toContain("T");
    expect(without).not.toContainEqual(["Esc", LABELS.en.helpFinish]);
    // Esc still closes the help in every case.
    expect(without).toContainEqual(["Esc", LABELS.en.helpClose]);
    expect(withPresenter).toContainEqual(["Esc", LABELS.en.helpClose]);
  });

  it("use the Spanish labels", () => {
    expect(keyHelpRows(LABELS.es, true, false)).toContainEqual(["Esc", LABELS.es.helpFinish]);
  });
});

describe("end and finish texts", () => {
  it("exist in English and Spanish with the same keys", () => {
    expect(Object.keys(LABELS.es).sort()).toEqual(Object.keys(LABELS.en).sort());
    for (const locale of ["en", "es"] as const) {
      for (const [key, value] of Object.entries(LABELS[locale])) {
        expect(value.trim(), `${locale}.${key}`).not.toBe("");
      }
    }
  });

  it("name Esc in the end cue", () => {
    expect(LABELS.en.endCue).toBe("End of presentation · Esc to exit");
    expect(LABELS.es.endCue).toContain("Esc");
    expect(LABELS.en.finish).toBe("Finish");
    expect(LABELS.es.finish).toBe("Terminar");
    expect(LABELS.en.backToPanel).toBe("Back to panel");
    expect(LABELS.es.backToPanel).toBe("Volver al panel");
  });
});
