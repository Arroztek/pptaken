// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { sanitizeDeck } from "@pptaken/sanitizer";
import { type Deck, parseDeck } from "@pptaken/schema";
import { describe, expect, it } from "vitest";
import { exportFilenames, slugify, unicodeStem } from "../src/filename.js";
import { exportHtml, fontsUsedBy, HTML_SIZE_WARNING_BYTES, scriptJson } from "../src/html.js";

const load = (file: string): Deck => {
  const r = parseDeck(
    JSON.parse(readFileSync(new URL(`../../schema/examples/${file}`, import.meta.url), "utf8")),
  );
  if (!r.ok) throw new Error(file);
  return sanitizeDeck(r.deck).deck;
};
const talk = load("talk-20-slides.json");
const hello = load("hello.json");
const SHA = "ab".repeat(32);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const woff2 = new Uint8Array(64).fill(1);
woff2.set([0x77, 0x4f, 0x46, 0x32]);

/** The deck document inside the srcdoc attribute, unescaped. */
function inner(html: string): string {
  const m = /srcdoc="([^"]*)"/.exec(html);
  if (!m) throw new Error("no srcdoc");
  return (m[1] as string).replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

describe("exportHtml", () => {
  it("builds one self-contained document with the security barriers", () => {
    const out = exportHtml({ deck: hello });
    expect(out.filename).toBe(`${slugify(hello.title)}.html`);
    expect(out.bytes).toBe(Buffer.byteLength(out.html));
    expect(out.html.startsWith("<!doctype html>")).toBe(true);
    expect(out.html).toContain('<iframe id="pptaken-frame" sandbox="allow-scripts"');
    // Nothing external: no http(s) URL, no module script, no src attribute on scripts.
    expect(out.html).not.toMatch(/https?:\/\//);
    expect(out.html).not.toMatch(/type="module"|<script[^>]*\ssrc=/);
    const doc = inner(out.html);
    const csp =
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(doc)?.[1] ?? "";
    expect(csp).toMatch(
      /^default-src 'none'; script-src 'nonce-[A-Za-z0-9+/=]{24}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'$/,
    );
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(doc).toContain(`<script nonce="${nonce}">`);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<style"));
    // The outer page uses the same nonce and policy (a srcdoc frame inherits it).
    expect(out.html).toContain(`<script nonce="${nonce}">`);
    expect(out.html).toContain("connect-src 'none'");
  });

  it("uses a fresh nonce every time", () => {
    const a = /'nonce-([^']+)'/.exec(exportHtml({ deck: hello }).html)?.[1];
    const b = /'nonce-([^']+)'/.exec(exportHtml({ deck: hello }).html)?.[1];
    expect(a).not.toBe(b);
  });

  it("never contains speaker notes by default (T7)", () => {
    const notes = talk.slides.flatMap((s) => (s.notes ? [s.notes] : []));
    expect(notes.length).toBeGreaterThan(5);
    const out = exportHtml({ deck: talk });
    expect(out.includesNotes).toBe(false);
    for (const note of notes) expect(out.html).not.toContain(scriptJson(note).slice(1, 40));
    for (const note of notes) expect(out.html).not.toContain(note.slice(0, 40));
  });

  it("with includeNotes, keeps them in the outer page only", () => {
    const out = exportHtml({ deck: talk, includeNotes: true });
    expect(out.includesNotes).toBe(true);
    const first = talk.slides[0]?.notes as string;
    expect(out.html).toContain(scriptJson(first).slice(1, -1));
    expect(inner(out.html)).not.toContain(scriptJson(first).slice(1, 30));
    expect(inner(out.html)).not.toContain(first.slice(0, 30));
    expect(out.html).toContain('id="pptaken-notes"');
  });

  it("inlines assets by exact-token rewriting only", () => {
    const deck: Deck = {
      ...hello,
      theme: { css: `.t{background:url(asset:${SHA})}` },
      slides: [
        {
          id: "x",
          title: "",
          html: `<img src="asset:${SHA}"><p>asset:${SHA} stays text</p><p data-x="asset:${SHA}">attr</p><div style="background:url(&quot;asset:${SHA.slice(0, 16)}&quot;)"></div><img src="asset:${"cd".repeat(32)}">`,
          css: `[data-slide="x"] p{background:url('asset:${SHA}')}`,
        },
      ],
    };
    const out = exportHtml({
      deck,
      assets: new Map([[SHA, { mediaType: "image/png", bytes: png }]]),
    });
    const doc = inner(out.html);
    const uri = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    expect(doc).toContain(`<img src="${uri}">`);
    expect(doc).toContain(`<p>asset:${SHA} stays text</p>`);
    expect(doc).toContain(`data-x="asset:${SHA}"`);
    expect(doc).toContain(`url(&quot;${uri}&quot;)`); // prefix ref resolved
    expect(doc).toContain(`url('${uri}')`);
    expect(doc).toContain(`.t{background:url(${uri})}`);
    expect(out.warnings).toEqual([
      { code: "MISSING_ASSET", message: expect.stringContaining("cdcd") },
    ]);
  });

  it("does not inline non-image assets", () => {
    const deck: Deck = {
      ...hello,
      slides: [{ id: "x", title: "", html: `<img src="asset:${SHA}">` }],
    };
    const out = exportHtml({
      deck,
      assets: new Map([[SHA, { mediaType: "text/html", bytes: png }]]),
    });
    expect(out.warnings.map((w) => w.code)).toEqual(["UNSUPPORTED_ASSET"]);
    expect(inner(out.html)).toContain(`src="asset:${SHA}"`);
  });

  it("embeds only the fonts the deck uses, and only valid WOFF2", () => {
    expect(fontsUsedBy(talk)).toEqual(["Inter", "Bricolage Grotesque", "JetBrains Mono"]);
    expect(
      fontsUsedBy({ ...hello, theme: {}, slides: [{ id: "x", title: "", html: "<p>x</p>" }] }),
    ).toEqual([]);
    const fonts = [
      { family: "Inter" as const, weight: "100 900", bytes: woff2, unicodeRange: "U+0000-00FF" },
      { family: "Fraunces" as const, weight: "400", bytes: woff2 },
      { family: "Bricolage Grotesque" as const, weight: "bold;}x{", bytes: woff2 },
      { family: "JetBrains Mono" as const, weight: "400", bytes: new Uint8Array(100) },
    ];
    const out = exportHtml({ deck: talk, fonts });
    expect(out.embeddedFonts).toEqual(["Inter"]);
    expect(out.warnings.map((w) => w.code)).toEqual(["FONT_SKIPPED", "FONT_SKIPPED"]);
    const doc = inner(out.html);
    expect(doc).toContain(
      '@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,',
    );
    expect(doc).not.toContain('Fraunces";');
  });

  it("hostile titles and content cannot break out of the srcdoc attribute or the scripts", () => {
    const ls = String.fromCharCode(0x2028);
    const hostile = `</title></script><script>alert(1)</script>" onload="alert(2)" & <!-- ${ls}`;
    const deck: Deck = {
      ...hello,
      title: hostile,
      slides: [
        {
          id: "s1",
          title: hostile,
          html: `<p>&lt;/script&gt; " &amp; ' ${ls}</p>`,
          notes: hostile,
        },
      ],
    };
    const out = exportHtml({ deck, includeNotes: true });
    // Exactly the elements we wrote (the srcdoc value is a separate document, checked below).
    const outer = out.html.replace(/srcdoc="[^"]*"/, 'srcdoc=""');
    expect(outer.match(/<script/g)).toHaveLength(1);
    expect(outer.match(/<\/script>/g)).toHaveLength(1);
    expect(outer.match(/<iframe/g)).toHaveLength(1);
    expect(outer.match(/<\/title>/g)).toHaveLength(1);
    const doc = inner(out.html);
    expect(doc.match(/<script/g)).toHaveLength(1);
    expect(doc.match(/<\/title>/g)).toHaveLength(1);
    expect(doc).not.toContain("alert(1)</script>");
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(out.html)?.[1] ?? "";
    expect(script).not.toMatch(/<\/|<!--/);
    // U+2028 is harmless in HTML text but not inside the script.
    expect(script).not.toContain(ls);
    // The srcdoc attribute value has no raw quote, so it ends where we closed it.
    const attr = /srcdoc="([^"]*)"><\/iframe>/.exec(out.html);
    expect(attr).not.toBeNull();
    // The config is valid JSON that decodes to the original notes.
    const json = /\)\((\{[\s\S]*\})\);$/.exec(script)?.[1] as string;
    expect(JSON.parse(json).notes).toEqual([hostile]);
    expect(out.filename).toBe("title-script-script-alert-1-script-onload-alert-2.html");
  });

  it("warns about large files", () => {
    const big = new Uint8Array(HTML_SIZE_WARNING_BYTES * 0.8);
    const deck: Deck = {
      ...hello,
      slides: [{ id: "x", title: "", html: `<img src="asset:${SHA}">` }],
    };
    const out = exportHtml({
      deck,
      assets: new Map([[SHA, { mediaType: "image/png", bytes: big }]]),
    });
    expect(out.bytes).toBeGreaterThan(HTML_SIZE_WARNING_BYTES);
    expect(out.warnings.map((w) => w.code)).toEqual(["LARGE_FILE"]);
  });

  it("speaks the deck's language in its own texts", () => {
    expect(exportHtml({ deck: load("charla-4-3.json") }).html).toContain('<html lang="es">');
    expect(exportHtml({ deck: load("charla-4-3.json") }).html).toContain(
      "Esta presentación necesita JavaScript.",
    );
    expect(exportHtml({ deck: hello }).html).toContain("This presentation needs JavaScript.");
  });
});

describe("file names", () => {
  it.each([
    ["My Talk: Ünïcode!", "my-talk-unicode"],
    ["../../etc/passwd", "etc-passwd"],
    ["   ", "presentation"],
    ["CON", "presentation"],
    ["日本語", "presentation"],
    ["a".repeat(100), "a".repeat(60)],
  ])("slugify(%j) = %j", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });

  it("keeps a readable Unicode name without separators or controls", () => {
    expect(unicodeStem("Charla: ¿qué tal? / v2")).toBe("Charla qué tal v2");
    expect(unicodeStem(`a${String.fromCharCode(0x202e)}b\r\nc"d`)).toBe("a b c d");
    expect(unicodeStem("...")).toBe("presentation");
    expect(exportFilenames("日本語", ".pptaken")).toEqual({
      ascii: "presentation.pptaken",
      unicode: "日本語.pptaken",
    });
    expect(() => exportFilenames("x", "/../")).toThrow(TypeError);
  });
});
