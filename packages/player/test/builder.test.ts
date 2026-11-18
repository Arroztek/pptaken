// SPDX-License-Identifier: Apache-2.0
// Document builder, CSP and headers. Tests run against the build (`dist`). The sanitizer is a dev dependency
// used only here, to build the example decks the way the server will.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { sanitizeDeck } from "@pptaken/sanitizer";
import { type Deck, parseDeck } from "@pptaken/schema";
import { describe, expect, it } from "vitest";
import {
  assetHeaders,
  buildDeckDocument,
  contentHeaders,
  contentSecurityPolicy,
  RUNTIME_SHA256,
  RUNTIME_SOURCE,
} from "../dist/index.js";

const NONCE = "q1w2e3r4t5y6u7i8o9p0aA==";
const HEX = "0123456789abcdef0123456789abcdef";
const BASE = "https://content.example/c/asset/";
const EXAMPLES = new URL("../../schema/examples/", import.meta.url);

function deck(input: unknown): Deck {
  const result = parseDeck(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.deck;
}

const tiny = (over: Partial<Deck> = {}): Deck => ({
  ...deck({ schemaVersion: 1, title: "T", slides: [{ id: "a", html: "<p>a</p>" }] }),
  ...over,
});

describe("buildDeckDocument", () => {
  it("builds every example deck: one hidden section per slide, ids equal to the deck's", () => {
    const files = readdirSync(EXAMPLES).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const clean = sanitizeDeck(deck(JSON.parse(readFileSync(new URL(file, EXAMPLES), "utf8"))));
      expect(clean.warnings).toEqual([]);
      const { html, csp } = buildDeckDocument(clean.deck, { nonce: NONCE, assetBaseUrl: BASE });
      const ids = [...html.matchAll(/<section data-slide="([^"]*)"[^>]*\bhidden>/g)].map(
        (m) => m[1],
      );
      expect(ids).toEqual(clean.deck.slides.map((s) => s.id));
      expect(html.match(/<section /g)?.length).toBe(clean.deck.slides.length);
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain(`<script nonce="${NONCE}">${RUNTIME_SOURCE}</script>`);
      expect(html.match(/<script/g)?.length).toBe(1);
      const { width, height } =
        clean.deck.aspectRatio === "4:3"
          ? { width: 1440, height: 1080 }
          : { width: 1920, height: 1080 };
      expect(html).toContain(
        `<div id="pptaken-stage" data-width="${width}" data-height="${height}">`,
      );
      expect(csp).toBe(contentSecurityPolicy({ nonce: NONCE, assetBaseUrl: BASE }));
    }
  });

  it("requires a valid nonce", () => {
    const d = tiny();
    const bad: unknown[] = [
      undefined,
      "",
      "short",
      'abcdefghijklmnopqrstuvwxyz"><script>',
      "abcdefghijklmnopqrstuv wxyz",
      "a".repeat(129),
      42,
    ];
    for (const nonce of bad) {
      expect(() => buildDeckDocument(d, { nonce } as never), String(nonce)).toThrow(TypeError);
    }
    expect(() => buildDeckDocument(d, undefined as never)).toThrow(TypeError);
    expect(() => buildDeckDocument(d, { nonce: NONCE })).not.toThrow();
  });

  it("escapes the title and validates lang and slide ids", () => {
    const evil = "</title><script>alert(1)</script>&\"'";
    const { html } = buildDeckDocument(
      tiny({ title: evil, slides: [{ id: "a", title: evil, html: "" }] }),
      { nonce: NONCE },
    );
    expect(html).toContain(
      "<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;</title>",
    );
    expect(html).toContain(
      'aria-label="&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;"',
    );
    expect(html.match(/<script/g)?.length).toBe(1);
    expect(() => buildDeckDocument(tiny(), { nonce: NONCE, lang: 'en"><x' })).toThrow(TypeError);
    expect(buildDeckDocument(tiny({ lang: "es-PE" }), { nonce: NONCE }).html).toContain(
      '<html lang="es-PE">',
    );
    expect(buildDeckDocument(tiny({ lang: "es" }), { nonce: NONCE, lang: "pt-BR" }).html).toContain(
      '<html lang="pt-BR">',
    );
    expect(buildDeckDocument(tiny(), { nonce: NONCE }).html).toContain("<html>");
    for (const id of ['a"><script>', "A", "", "a".repeat(41)]) {
      expect(() =>
        buildDeckDocument(tiny({ slides: [{ id, title: "", html: "" }] }), { nonce: NONCE }),
      ).toThrow(TypeError);
    }
    expect(() =>
      buildDeckDocument(
        tiny({
          slides: [
            { id: "a", title: "", html: "" },
            { id: "a", title: "", html: "" },
          ],
        }),
        { nonce: NONCE },
      ),
    ).toThrow(/duplicated/);
    expect(() => buildDeckDocument(tiny({ slides: [] }), { nonce: NONCE })).toThrow(TypeError);
  });

  it("rewrites exact asset tokens only", () => {
    const html =
      `<img src="asset:${HEX}" alt="x"><div style="background:url(asset:${HEX})">asset:${HEX}</div>` +
      `<svg><image href="asset:${HEX}"></image></svg><p title="asset:${HEX}">t</p>` +
      `<img src="asset:${HEX}${HEX}0"><img src="asset:${HEX.toUpperCase()}">`;
    const css = `[data-slide="a"] div{background:url(asset:${HEX})}[data-slide="a"] p{--x:url("asset:${HEX}")}`;
    const out = buildDeckDocument(
      tiny({
        slides: [{ id: "a", title: "", html, css }],
        theme: { css: `body{background-image:url('asset:${HEX}')}` },
      }),
      { nonce: NONCE, assetBaseUrl: BASE },
    ).html;
    expect(out).toContain(`<img src="${BASE}${HEX}" alt="x">`);
    expect(out).toContain(`style="background:url(${BASE}${HEX})">asset:${HEX}</div>`);
    expect(out).toContain(`<image href="${BASE}${HEX}">`);
    expect(out).toContain(`<p title="asset:${HEX}">`);
    // 65 hex characters or uppercase hex are not asset tokens: left as they are (and blocked by the CSP).
    expect(out).toContain(`<img src="asset:${HEX}${HEX}0">`);
    expect(out).toContain(`<img src="asset:${HEX.toUpperCase()}">`);
    expect(out).toContain(`[data-slide="a"] div{background:url(${BASE}${HEX})}`);
    expect(out).toContain(`--x:url("${BASE}${HEX}")`);
    expect(out).toContain(`body{background-image:url('${BASE}${HEX}')}`);
    // Without a base URL nothing is rewritten.
    const raw = buildDeckDocument(tiny({ slides: [{ id: "a", title: "", html }] }), {
      nonce: NONCE,
    });
    expect(raw.html).toContain(`<img src="asset:${HEX}" alt="x">`);
  });

  it("rejects unsafe asset base URLs", () => {
    const bad = [
      "/c/asset/",
      "c/asset/",
      "https://content.example/c/asset",
      "javascript:alert(1)//",
      "https://content.example/c/a sset/",
      'https://content.example/c/"/',
      "https://content.example/c/)/",
      "https://content.example/c/'/",
      "https://content.example/c/$&/",
      "https://user@content.example/c/",
      "https://content.example/c/?q/",
      "data:text/html,/",
      "https://content.example/c/../",
    ];
    for (const assetBaseUrl of bad) {
      expect(() => buildDeckDocument(tiny(), { nonce: NONCE, assetBaseUrl }), assetBaseUrl).toThrow(
        TypeError,
      );
    }
    for (const ok of [
      "http://127.0.0.1:8080/c/asset/",
      "https://content.example/",
      "http://[::1]:3000/a/",
    ]) {
      expect(() => buildDeckDocument(tiny(), { nonce: NONCE, assetBaseUrl: ok }), ok).not.toThrow();
    }
  });

  it("refuses CSS that could close the style element", () => {
    for (const css of ["</style><script>x</script>", "a{}<!--", "</STYLE>"]) {
      expect(() =>
        buildDeckDocument(tiny({ slides: [{ id: "a", title: "", html: "", css }] }), {
          nonce: NONCE,
        }),
      ).toThrow(TypeError);
      expect(() => buildDeckDocument(tiny({ theme: { css } }), { nonce: NONCE })).toThrow(
        TypeError,
      );
    }
  });

  it("puts the stage rules last so the theme cannot remove the black letterbox", () => {
    const { html } = buildDeckDocument(tiny({ theme: { css: "body{background:red}" } }), {
      nonce: NONCE,
    });
    const theme = html.indexOf("body{background:red}");
    const stage = html.indexOf("background:#000!important");
    expect(theme).toBeGreaterThan(0);
    expect(stage).toBeGreaterThan(theme);
  });

  it("marks sections with their escaped section name and adds overview and print rules", () => {
    const deck = tiny();
    const first = deck.slides[0];
    if (!first) throw new Error("tiny deck has no slide");
    const { html } = buildDeckDocument(
      { ...deck, slides: [{ ...first, section: 'Intro "<x>"' }] },
      { nonce: NONCE },
    );
    expect(html).toContain('data-section="Intro &quot;&lt;x&gt;&quot;"');
    expect(html).toContain("html[data-pptaken-mode=overview] #pptaken-stage");
    expect(html).toContain(
      "html[data-pptaken-mode=print] #pptaken-stage [data-step]{visibility:visible!important}",
    );
    expect(html).toContain("@media print{");
    expect(html).toContain("@page{size:1920px 1080px;margin:0}");
    expect(html).toContain("break-after:page");
    const four = buildDeckDocument({ ...deck, aspectRatio: "4:3" }, { nonce: NONCE }).html;
    expect(four).toContain("@page{size:1440px 1080px;margin:0}");
    // Without a section, no attribute.
    expect(buildDeckDocument(deck, { nonce: NONCE }).html).not.toContain("data-section=");
  });
});

describe("runtime source", () => {
  it("is a small classic script that cannot break out of its element", () => {
    expect(RUNTIME_SOURCE.startsWith("(() => {")).toBe(true);
    expect(RUNTIME_SOURCE).not.toMatch(/<\/script|<!--/i);
    expect(RUNTIME_SOURCE).not.toMatch(/\b(import|export)\b\s*[{*"']/);
    // It never parses HTML itself: "innerHTML" appears only as a property name the script-mode lockdown wraps.
    expect(RUNTIME_SOURCE).not.toMatch(/\beval\b|\.innerHTML\b|new Function/);
    // F1 was about 5 KB; F3 (overview layout, select, mode ack, offline preload) about 10 KB; the script-mode
    // lockdown, port handshake and author API (ADR-020) must keep it under 22 KB.
    expect(Buffer.byteLength(RUNTIME_SOURCE)).toBeLessThan(22 * 1024);
    // It parses as a script.
    expect(() => new Function(RUNTIME_SOURCE)).not.toThrow();
  });

  it("comes with its CSP hash", () => {
    const hash = createHash("sha256").update(RUNTIME_SOURCE, "utf8").digest("base64");
    expect(RUNTIME_SHA256).toBe(hash);
  });
});

describe("content security policy and headers", () => {
  it("matches ADR-001 with images and fonts limited to the asset path", () => {
    expect(contentSecurityPolicy({ nonce: NONCE, assetBaseUrl: BASE })).toBe(
      `sandbox allow-scripts; default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'unsafe-inline'; ` +
        `img-src ${BASE}; font-src ${BASE}; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'`,
    );
    const csp = contentSecurityPolicy({ nonce: NONCE });
    expect(csp).toContain("img-src 'none'; font-src 'none'");
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(
      contentSecurityPolicy({
        nonce: NONCE,
        frameAncestors: ["https://app.example", "http://localhost:3000"],
      }),
    ).toMatch(/; frame-ancestors https:\/\/app\.example http:\/\/localhost:3000$/);
    expect(contentSecurityPolicy({ nonce: NONCE, frameAncestors: [] })).toMatch(
      /frame-ancestors 'none'$/,
    );
    expect(() =>
      contentSecurityPolicy({ nonce: NONCE, frameAncestors: ["https://a.example/path"] }),
    ).toThrow();
    expect(() => contentSecurityPolicy({ nonce: NONCE, frameAncestors: ["*"] })).toThrow();
    expect(() => contentSecurityPolicy({ nonce: "x" })).toThrow(TypeError);
    expect(() => contentSecurityPolicy({ nonce: NONCE, assetBaseUrl: "/c/asset/" })).toThrow(
      TypeError,
    );
  });

  it("recommends the header set of the content route and of assets", () => {
    const h = contentHeaders({ nonce: NONCE, assetBaseUrl: BASE });
    expect(h["Content-Security-Policy"]).toBe(
      contentSecurityPolicy({ nonce: NONCE, assetBaseUrl: BASE }),
    );
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["Cache-Control"]).toBe("no-store");
    expect(h["Permissions-Policy"]).toContain("camera=()");
    expect(h["Content-Type"]).toBe("text/html; charset=utf-8");
    const a = assetHeaders();
    expect(a["Access-Control-Allow-Origin"]).toBe("*");
    expect(a["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("bundled fonts", () => {
  const FONT_BASE = "https://content.example/c/fonts/";
  const face = {
    family: "Inter",
    file: "inter/inter-latin-wght.woff2",
    weight: "100 900",
  } as const;

  it("emits @font-face rules before the theme CSS and allows the font path in font-src", () => {
    const built = buildDeckDocument(tiny(), {
      nonce: NONCE,
      assetBaseUrl: BASE,
      fontBaseUrl: FONT_BASE,
      fontFaces: [{ ...face, unicodeRange: "U+0000-00FF, U+0131" }],
    });
    expect(built.html).toContain(
      `@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:swap;src:url(${FONT_BASE}inter/inter-latin-wght.woff2) format("woff2");unicode-range:U+0000-00FF, U+0131;}`,
    );
    expect(built.csp).toContain(`font-src ${BASE} ${FONT_BASE}`);
    expect(built.csp).toContain(`img-src ${BASE};`);
  });

  it("works without an asset path: fonts only", () => {
    const csp = contentSecurityPolicy({ nonce: NONCE, fontBaseUrl: FONT_BASE });
    expect(csp).toContain(`font-src ${FONT_BASE}`);
    expect(csp).toContain("img-src 'none'");
  });

  it("validates every interpolated value", () => {
    const build = (fontFaces: unknown[], fontBaseUrl: string | null = FONT_BASE) =>
      buildDeckDocument(tiny(), {
        nonce: NONCE,
        fontBaseUrl: fontBaseUrl ?? undefined,
        fontFaces: fontFaces as never,
      });
    expect(() => build([{ ...face, family: "Comic Sans" }])).toThrow(/catalog/);
    expect(() => build([{ ...face, file: "../secret.woff2" }])).toThrow(/WOFF2 path/);
    expect(() => build([{ ...face, file: "a/b.woff2);}body{x:1}" }])).toThrow(/WOFF2 path/);
    expect(() => build([{ ...face, weight: "bold" }])).toThrow(/weight/);
    expect(() => build([{ ...face, style: "oblique" }])).toThrow(/style/);
    expect(() => build([{ ...face, unicodeRange: "U+0-FF;} x{y:z" }])).toThrow(/unicodeRange/);
    expect(() => build([face], null)).toThrow(/fontBaseUrl/);
    expect(() => build([face], "https://content.example/c/fonts")).toThrow(/ending in/);
  });

  it("adds nothing when no faces are given", () => {
    const built = buildDeckDocument(tiny(), { nonce: NONCE, assetBaseUrl: BASE });
    expect(built.html).not.toContain("@font-face");
    expect(built.csp).toContain(`font-src ${BASE};`);
  });
});
