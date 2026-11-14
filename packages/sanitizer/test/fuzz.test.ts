// SPDX-License-Identifier: AGPL-3.0-or-later
// Seeded, deterministic mutation fuzzing of the corpus. Every mutated input must sanitize without throwing,
// satisfy the output invariants and be idempotent.

import { describe, expect, it } from "vitest";
import { sanitizeCss, sanitizeSlideHtml } from "../src/index.js";
import { assertSafeCss, assertSafeHtml, loadLegit, loadVectors, prng, SCOPE } from "./support.js";

const HTML_MUTATIONS = 2500;
const CSS_MUTATIONS = 1500;

const HTML_TOKENS = [
  "<svg>",
  "</svg>",
  "<math>",
  "</math>",
  "<mtext>",
  "<mglyph>",
  "<malignmark>",
  "<style>",
  "</style>",
  "<script>",
  "</script>",
  "<!--",
  "-->",
  "--!>",
  "<![CDATA[",
  "]]>",
  "<noscript>",
  "</noscript>",
  "<template>",
  "<table>",
  "<tr>",
  "<td>",
  "</table>",
  "<desc>",
  "<title>",
  "<foreignObject>",
  "<form>",
  "</form>",
  "<p>",
  "</p>",
  "<img src=x onerror=alert(1)>",
  "<a href=javascript:alert(1)>",
  '"',
  "'",
  "`",
  "<",
  ">",
  "=",
  "/",
  "&",
  "&lt;",
  "&#x3c;",
  "&#60",
  "&quot;",
  "javascript:",
  " on",
  "error=",
  "\u0000",
  "\t",
  "\n",
  " ",
  "asset:0123456789abcdef",
  "#x",
  "url(",
  ")",
  'style="',
  "<select>",
  "<option>",
  "<xmp>",
  "<plaintext>",
  "<iframe>",
  "<textarea>",
  "<noembed>",
  "<use href=#a>",
  "<g id=a>",
  "<b>",
  "<i>",
  "<x-y>",
  "</div>",
];
const CSS_TOKENS = [
  "url(",
  ")",
  "(",
  "{",
  "}",
  ";",
  ":",
  "\\",
  "\\75",
  "/*",
  "*/",
  '"',
  "'",
  "@import ",
  "@media ",
  "@font-face",
  "expression(",
  "</style>",
  "<!--",
  "-->",
  "!important",
  "var(--x)",
  "--x:",
  "asset:0123456789abcdef",
  "http://evil.test/",
  "javascript:",
  "html ",
  "body ",
  ":root",
  "~",
  "+",
  ">",
  ",",
  "&",
  "\u0000",
  "\n",
  "image-set(",
  "@keyframes k",
  "from",
  "to",
  "50%",
  "#x",
  "\\3c",
  "u\\72l(",
  "@supports ",
  "@property --x",
];

function mutate(input: string, rand: () => number, tokens: string[], pool: string[]): string {
  let s = input;
  const ops = 1 + Math.floor(rand() * 4);
  for (let k = 0; k < ops; k++) {
    const at = Math.floor(rand() * (s.length + 1));
    switch (Math.floor(rand() * 6)) {
      case 0:
        s = s.slice(0, at) + tokens[Math.floor(rand() * tokens.length)] + s.slice(at);
        break;
      case 1: {
        const len = Math.floor(rand() * 12);
        s = s.slice(0, at) + s.slice(at + len);
        break;
      }
      case 2: {
        const len = Math.floor(rand() * 24);
        s = s.slice(0, at) + s.slice(at, at + len) + s.slice(at);
        break;
      }
      case 3: {
        const len = Math.floor(rand() * 16);
        const seg = s.slice(at, at + len);
        s =
          s.slice(0, at) +
          (rand() < 0.5 ? seg.toUpperCase() : seg.toLowerCase()) +
          s.slice(at + len);
        break;
      }
      case 4: {
        const other = pool[Math.floor(rand() * pool.length)] ?? "";
        const from = Math.floor(rand() * other.length);
        s = s.slice(0, at) + other.slice(from, from + 40 + Math.floor(rand() * 80)) + s.slice(at);
        break;
      }
      default: {
        const c = String.fromCharCode(Math.floor(rand() * 0x80));
        s = s.slice(0, at) + c + s.slice(at);
      }
    }
  }
  return s;
}

const vectors = loadVectors();
const legit = loadLegit();
// Keep the fuzz inputs small: generated resource-exhaustion inputs are tested on their own.
const htmlPool = [
  ...vectors.flatMap((v) => (v.html && v.html.length < 4000 ? [v.html] : [])),
  ...legit.map((l) => l.html),
];
const cssPool = [
  ...vectors.flatMap((v) => (v.css && v.css.length < 4000 ? [v.css] : [])),
  ...legit.flatMap((l) => (l.css ? [l.css] : [])),
];

describe("fuzzing (seeded)", () => {
  it(`${HTML_MUTATIONS} HTML mutations keep the invariants`, () => {
    const rand = prng(0x5eed);
    for (let i = 0; i < HTML_MUTATIONS; i++) {
      const base = htmlPool[Math.floor(rand() * htmlPool.length)] ?? "";
      const input = mutate(base, rand, HTML_TOKENS, htmlPool);
      let out = "";
      try {
        out = sanitizeSlideHtml(input).html;
        assertSafeHtml(out);
        expect(sanitizeSlideHtml(out).html).toBe(out);
      } catch (error) {
        throw new Error(
          `mutation #${i} failed: ${(error as Error).message}\ninput: ${JSON.stringify(input)}\noutput: ${JSON.stringify(out)}`,
        );
      }
    }
  }, 120_000);

  it(`${CSS_MUTATIONS} CSS mutations keep the invariants (scoped and unscoped)`, () => {
    const rand = prng(0xc55);
    for (let i = 0; i < CSS_MUTATIONS; i++) {
      const base = cssPool[Math.floor(rand() * cssPool.length)] ?? "";
      const input = mutate(base, rand, CSS_TOKENS, cssPool);
      let out = "";
      try {
        out = sanitizeCss(input).css;
        assertSafeCss(out);
        expect(sanitizeCss(out).css).toBe(out);
        out = sanitizeCss(input, { scope: SCOPE }).css;
        assertSafeCss(out, SCOPE);
        expect(sanitizeCss(out, { scope: SCOPE }).css).toBe(out);
      } catch (error) {
        throw new Error(
          `mutation #${i} failed: ${(error as Error).message}\ninput: ${JSON.stringify(input)}\noutput: ${JSON.stringify(out)}`,
        );
      }
    }
  }, 120_000);
});
