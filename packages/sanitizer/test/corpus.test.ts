// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { sanitizeCss, sanitizeSlideHtml, WARNING_CODES } from "../src/index.js";
import { assertSafeCss, assertSafeHtml, loadLegit, loadVectors, SCOPE } from "./support.js";

const vectors = loadVectors();

describe("XSS corpus", () => {
  it("has at least 150 vectors with unique ids and the required metadata", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(150);
    const ids = new Set(vectors.map((v) => v.id));
    expect(ids.size).toBe(vectors.length);
    for (const v of vectors) {
      expect(v.category, v.id).toBeTruthy();
      expect(v.source, v.id).toBeTruthy();
      expect(v.notes, v.id).toBeTruthy();
      expect(v.html !== undefined || v.css !== undefined, v.id).toBe(true);
    }
  });

  it("covers every required category", () => {
    const categories = new Set(vectors.map((v) => v.category));
    for (const c of [
      "script",
      "event-handlers",
      "url-schemes",
      "svg",
      "mathml",
      "mxss",
      "css",
      "css-inline",
      "html5",
      "attributes",
      "encoding",
      "exhaustion",
      "prototype-pollution",
    ]) {
      expect(categories, c).toContain(c);
    }
  });

  for (const v of vectors) {
    describe(`${v.category}/${v.id}`, () => {
      if (v.html !== undefined) {
        const input = v.html;
        it("HTML output is safe and idempotent", () => {
          const first = sanitizeSlideHtml(input);
          assertSafeHtml(first.html);
          const second = sanitizeSlideHtml(first.html);
          expect(second.html).toBe(first.html);
          expect(second.warnings).toEqual([]);
          for (const w of first.warnings) {
            expect(WARNING_CODES).toContain(w.code);
            expect((w.name ?? "").length).toBeLessThanOrEqual(41);
          }
        });
      }
      if (v.css !== undefined) {
        const input = v.css;
        it("CSS output is safe and idempotent (theme, unscoped)", () => {
          const first = sanitizeCss(input);
          assertSafeCss(first.css);
          const second = sanitizeCss(first.css);
          expect(second.css).toBe(first.css);
          expect(second.warnings).toEqual([]);
        });
        it("CSS output is safe and idempotent (slide, scoped)", () => {
          const first = sanitizeCss(input, { scope: SCOPE });
          assertSafeCss(first.css, SCOPE);
          const second = sanitizeCss(first.css, { scope: SCOPE });
          expect(second.css).toBe(first.css);
          expect(second.warnings).toEqual([]);
        });
      }
    });
  }

  it("reports at least one warning for every hostile vector that carries a payload", () => {
    // Vectors that are only text once parsed, or that the HTML parser itself neutralizes (comments, a <body> or
    // <frameset> tag in a fragment, CDATA in SVG), legitimately produce no warning. Their safety is still asserted
    // by the per-vector invariant tests above.
    const textOnly = new Set([
      "css-cdo-cdc",
      "on-body-onload",
      "html5-conditional-comment",
      "html5-frameset",
      "mxss-svg-cdata-breakout",
      "enc-utf7-script",
      "enc-overlong-utf8",
      "enc-fullwidth",
      "enc-entity-lt",
      "enc-entity-no-semicolon-lt",
      "enc-double-encoded",
      "enc-control-chars-text",
      "enc-bidi-override",
      "enc-surrogate-halves",
      "exhaust-entity-flood",
      "exhaust-deep-tables",
      "exhaust-formatting-elements",
      "exhaust-many-distinct-attributes",
      "html5-comment-bogus",
      "html5-bogus-comment-pi",
      "html5-cdata-html",
      "mxss-style-attr-quote",
      "mxss-backtick-attr",
      "mxss-nbsp-attr",
      "mxss-comment-in-attr",
      "url-asset-entity",
      "proto-id-proto",
    ]);
    const silent: string[] = [];
    for (const v of vectors) {
      if (textOnly.has(v.id)) continue;
      const htmlWarnings = v.html !== undefined ? sanitizeSlideHtml(v.html).warnings.length : 0;
      const cssWarnings =
        v.css !== undefined ? sanitizeCss(v.css, { scope: SCOPE }).warnings.length : 0;
      if (htmlWarnings + cssWarnings === 0) silent.push(v.id);
    }
    expect(silent).toEqual([]);
  });
});

describe("legitimate content stays intact", () => {
  const cases = loadLegit();

  it("has at least 15 realistic slides", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  for (const c of cases) {
    it(`${c.id}: no warnings and the important structure survives`, () => {
      const h = sanitizeSlideHtml(c.html);
      expect(h.warnings).toEqual([]);
      assertSafeHtml(h.html);
      for (const needle of c.expectHtml ?? []) expect(h.html).toContain(needle);
      expect(sanitizeSlideHtml(h.html).html).toBe(h.html);
      if (c.css !== undefined) {
        const s = sanitizeCss(c.css, { scope: SCOPE });
        expect(s.warnings).toEqual([]);
        assertSafeCss(s.css, SCOPE);
        for (const needle of c.expectCss ?? []) expect(s.css).toContain(needle);
        expect(sanitizeCss(s.css, { scope: SCOPE }).css).toBe(s.css);
      }
    });
  }
});
