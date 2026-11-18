// SPDX-License-Identifier: AGPL-3.0-or-later
// The interactive profile (ADR-020) and the static fallback. The interactive profile is a strict superset of the
// safe one that still contains nothing executable or navigating; the static fallback re-sanitizes a scripted deck
// with the safe profile and drops its scripts and libraries.
import { type Deck, parseDeck } from "@pptaken/schema";
import { describe, expect, it } from "vitest";
import { sanitizeDeck, sanitizeSlideHtml, staticDeck } from "../src/index.js";

const interactive = (html: string) => sanitizeSlideHtml(html, { profile: "interactive" });

describe("interactive profile", () => {
  it("keeps canvas, controls and their value attributes", () => {
    const html =
      '<canvas width="800" height="450"></canvas><label for="k">k</label><input id="k" type="range" min="0" max="10" step="0.5" value="3">' +
      '<input type="checkbox" checked><input type="number" step="any"><button type="button" disabled>Run</button>' +
      '<select><option value="a" selected>A</option><option value="b">B</option></select>' +
      '<output for="k">3</output><progress value="0.3" max="1"></progress><meter value="2" min="0" max="5"></meter>' +
      '<div data-qubits="3" data-mode="bloch"></div>';
    const out = interactive(html);
    expect(out.warnings).toEqual([]);
    expect(out.html).toBe(
      html
        .replace('<input type="checkbox" checked>', '<input type="checkbox" checked="">')
        .replace(" disabled>", ' disabled="">')
        .replace(" selected>", ' selected="">'),
    );
  });

  it("still removes scripts, handlers, links, forms, frames, media and other input types", () => {
    const cases: [string, RegExp][] = [
      ["<script>x()</script><p>a</p>", /<script/],
      ['<button type="button" onclick="x()">b</button>', /onclick/],
      ['<input type="range" oninput="x()">', /oninput/],
      ['<a href="https://x">a</a>', /href/],
      ["<form><input type=range></form>", /<form/],
      ['<iframe src="x"></iframe>', /<iframe/],
      ['<video src="x"></video>', /<video/],
      ['<audio src="x"></audio>', /<audio/],
      ['<input type="text" value="x">', /<input/],
      ['<input type="file">', /<input/],
      ["<input>", /<input/],
      ['<input type="image" src="x">', /<input/],
      ['<button type="submit">x</button>', /submit/],
      ["<textarea>x</textarea>", /<textarea/],
      [
        '<div data-slide="x" data-section="y" data-pptaken-x="1"></div>',
        /data-(slide|section|pptaken)/,
      ],
      ['<canvas width="javascript:x"></canvas>', /javascript/],
      ['<input type="range" formaction="https://x">', /formaction/],
      ['<label for="a b">x</label>', /for=/],
    ];
    for (const [input, banned] of cases) {
      const out = interactive(input);
      expect(out.warnings.length, input).toBeGreaterThan(0);
      expect(out.html, input).not.toMatch(banned);
    }
  });

  it("is a fixed point (mutation-XSS defense) on select and option edge cases", () => {
    for (const input of [
      "<select><option><svg><script>x</script></svg></option></select>",
      "<select><div>a</div><option>b</option></select>",
      "<select><option>a<select><option>b</select></option></select>",
      '<option><img src="asset:0123456789abcdef"></option>',
    ]) {
      const once = interactive(input).html;
      expect(interactive(once).html, input).toBe(once);
      expect(once).not.toMatch(/<script/);
    }
  });

  it("is the default nowhere: the safe profile removes every addition", () => {
    const out = sanitizeSlideHtml('<canvas></canvas><input type="range"><div data-x="1"></div>');
    expect(out.html).toBe("<div></div>");
  });
});

describe("staticDeck", () => {
  const parsed = parseDeck({
    schemaVersion: 1,
    title: "S",
    libs: ["uplot@1"],
    slides: [
      { id: "a", html: "<p>a</p>", notes: "kept" },
      {
        id: "b",
        html: '<div class="x"><canvas></canvas><p>fallback</p></div>',
        css: "p{color:red}",
        script: "draw()",
      },
    ],
  });
  if (!parsed.ok) throw new Error("bad fixture");
  const scripted: Deck = sanitizeDeck(parsed.deck, { profile: "interactive" }).deck;

  it("drops scripts and libraries and re-sanitizes with the safe profile", () => {
    const { deck } = staticDeck(scripted);
    expect(deck.libs).toBeUndefined();
    expect(deck.slides.map((s) => s.script)).toEqual([undefined, undefined]);
    expect(deck.slides[1]?.html).toBe('<div class="x"><p>fallback</p></div>');
    expect(deck.slides[1]?.css).toContain("color:red");
    expect(deck.slides[0]?.notes).toBe("kept");
    expect(JSON.stringify(deck)).not.toMatch(/draw\(\)|canvas|uplot/);
  });

  it("returns decks without scripts unchanged", () => {
    const plain = sanitizeDeck({
      ...scripted,
      libs: undefined,
      slides: [scripted.slides[0] as never],
    }).deck;
    const { libs: _l, ...rest } = plain;
    const out = staticDeck(rest as Deck);
    expect(out.deck).toBe(rest);
    expect(out.warnings).toEqual([]);
  });
});
