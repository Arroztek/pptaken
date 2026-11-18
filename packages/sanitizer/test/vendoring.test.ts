// SPDX-License-Identifier: AGPL-3.0-or-later
// Ingest-time vendoring and the HTML-artifact importer (ADR-022), pure parts.
import { readFileSync } from "node:fs";
import { embeddableScript, parseDeck, scriptProblem } from "@pptaken/schema";
import { describe, expect, it } from "vitest";
import {
  ArtifactImportError,
  adaptArtifactCss,
  bestSrcsetCandidate,
  externalUrlOf,
  importHtmlArtifact,
  sanitizeDeck,
  sanitizeSlideHtml,
  transformCssExternals,
  transformHtmlExternals,
} from "../src/index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const canvas = { width: 1920, height: 1080 };
const asset = (n: number) => `asset:${n.toString(16).padStart(64, "0")}`;

describe("external URLs", () => {
  it("resolves only http(s) URLs, protocol-relative to https", () => {
    expect(externalUrlOf("//cdn.example/x.js")).toBe("https://cdn.example/x.js");
    expect(externalUrlOf(" https://a.example/p.png#frag ")).toBe("https://a.example/p.png");
    for (const raw of [
      "asset:abc",
      "#x",
      "data:image/png;base64,AA",
      "javascript:alert(1)",
      "img/a.png",
      "ftp://x/y",
    ]) {
      expect(externalUrlOf(raw)).toBeNull();
    }
    expect(externalUrlOf("fonts/a.woff2", "https://cdn.example/css/k.css")).toBe(
      "https://cdn.example/css/fonts/a.woff2",
    );
  });

  it("picks the largest srcset candidate", () => {
    expect(bestSrcsetCandidate("a.png 1x, b.png 2x")).toBe("b.png");
    expect(bestSrcsetCandidate("s.png 480w, l.png 1200w, m.png 800w")).toBe("l.png");
  });
});

describe("HTML externals", () => {
  const html =
    '<img alt="a" src="https://i.example/a.png"><picture><source srcset="https://i.example/b.webp 2x"><img alt="b"></picture>' +
    '<svg><image href="https://i.example/c.png"/></svg><div style="background:url(https://i.example/d.png)"></div>' +
    '<link rel="stylesheet" href="https://css.example/s.css"><link rel="preconnect" href="https://fonts.gstatic.com">' +
    '<script src="https://cdn.example/lib.js"></script><script type="module" src="https://esm.sh/x"></script>' +
    '<video src="https://v.example/a.mp4"></video><iframe src="https://maps.example"></iframe><img alt="r" src="rel.png">';

  it("finds images, stylesheets, scripts and unsupported elements", () => {
    const r = transformHtmlExternals(html);
    expect(r.refs.map((x) => x.url).sort()).toEqual(
      [
        "https://i.example/a.png",
        "https://i.example/b.webp",
        "https://i.example/c.png",
        "https://i.example/d.png",
      ].sort(),
    );
    expect(r.stylesheets).toEqual(["https://css.example/s.css"]);
    expect(r.scripts).toEqual(["https://cdn.example/lib.js"]);
    expect(r.unsupported.map((u) => u.what).sort()).toEqual([
      "iframe",
      "script type=module",
      "video",
    ]);
    expect(r.relative).toBe(1);
    expect(r.html).toBe(html); // a scan never rewrites
  });

  it("rewrites to asset references and removes link/script elements", () => {
    let n = 0;
    const map = new Map<string, string>();
    const r = transformHtmlExternals(html, (_kind, url) => {
      if (url.endsWith("d.png")) return null;
      if (!map.has(url)) map.set(url, asset(++n));
      return map.get(url) ?? null;
    });
    expect(r.html).not.toMatch(/<link|<script|https:\/\/i\.example\/[abc]/);
    expect(r.html).toMatch(/src="asset:0{63}1"/);
    // The unresolved one stays absolute: the sanitizer removes it.
    const clean = sanitizeSlideHtml(r.html);
    expect(clean.html).not.toContain("https://");
    expect(clean.html).toContain("asset:");
  });

  it("leaves HTML without external references untouched", () => {
    const plain = '<p class="x">hello <b>world</b></p>';
    expect(transformHtmlExternals(plain, () => null).html).toBe(plain);
  });

  it("refuses to parse pathological input before parse5 (same guard as the sanitizer)", () => {
    const bomb = `${"<div>".repeat(5000)}<img src="https://i.example/a.png">`;
    expect(transformHtmlExternals(bomb).refs).toEqual([]);
  });
});

describe("CSS externals", () => {
  const google = `/* latin-ext */
@font-face { font-family: 'Lora'; font-style: italic; font-weight: 400 700; font-display: swap;
  src: url(https://fonts.gstatic.com/l/ext.woff2) format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+1E00-1E9F; }
/* latin */
@font-face { font-family: 'Lora'; font-style: italic; font-weight: 400 700; font-display: swap;
  src: local('Lora'), url(https://fonts.gstatic.com/l/latin.woff) format('woff'), url(https://fonts.gstatic.com/l/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+2000-206F; }`;

  it("extracts @font-face rules with subsets, weights, styles and the best format", () => {
    const r = transformCssExternals(google, { extractFontFaces: true, resolve: () => null });
    expect(r.fontFaces).toHaveLength(2);
    expect(r.fontFaces[1]).toEqual({
      family: "Lora",
      style: "italic",
      weight: "400 700",
      unicodeRange: "U+0000-00FF, U+0131, U+2000-206F",
      sources: [
        { url: "https://fonts.gstatic.com/l/latin.woff2", format: "woff2" },
        { url: "https://fonts.gstatic.com/l/latin.woff", format: "woff" },
      ],
    });
    expect(r.css).not.toContain("@font-face");
  });

  it("resolves relative url() and @import against the stylesheet's own URL", () => {
    const r = transformCssExternals('@import "theme.css";.k{background:url(../img/k.png)}', {
      base: "https://cdn.example/pkg/css/main.css",
    });
    expect(r.imports).toEqual(["https://cdn.example/pkg/css/theme.css"]);
    expect(r.urls).toEqual([{ kind: "image", url: "https://cdn.example/pkg/img/k.png" }]);
  });

  it("inlines imports from the map and drops failed ones", () => {
    const r = transformCssExternals(
      '@import url("https://a.example/a.css");@import url(https://b.example/b.css);.x{color:red}',
      {
        imports: new Map([
          ["https://a.example/a.css", ".a{color:blue}"],
          ["https://b.example/b.css", ""],
        ]),
      },
    );
    expect(r.css).toContain(".a{color:blue}");
    expect(r.css).not.toContain("@import");
  });

  it("converts viewport units to canvas pixels for the importer", () => {
    const r = transformCssExternals(".a{width:50vw;height:100vh;font-size:2vmin;margin:10dvh}", {
      viewport: canvas,
    });
    expect(r.css).toBe(".a{width:960px;height:1080px;font-size:21.6px;margin:108px}");
  });
});

describe("vendored font families in the sanitizer", () => {
  it("keeps a family declared in theme.fontFaces and removes undeclared ones", () => {
    const parsed = parseDeck({
      schemaVersion: 1,
      title: "F",
      theme: {
        css: ".t{font-family:'Lora','Comic Neue',serif}",
        fontFaces: [{ family: "Lora", src: asset(1), format: "woff2" }],
      },
      slides: [{ id: "a", html: "<p style=\"font-family:'Lora',serif\">x</p>" }],
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const r = sanitizeDeck(parsed.deck);
    expect(r.deck.theme?.css).toBe(".t{font-family:Lora,serif}");
    expect(r.deck.slides[0]?.html).toContain("font-family:Lora,serif");
    expect(r.warnings.map((w) => w.name)).toEqual(["Comic Neue"]);
  });
});

describe("embeddable scripts", () => {
  it("escapes script-closing sequences without changing meaning in strings", () => {
    const text = embeddableScript("var s='</script><script>'; var c='<!--';");
    expect(text).toBe("var s='<\\/script><\\u0073cript>'; var c='<\\!--';");
    expect(scriptProblem(text ?? "")).toBeNull();
    // Same value once evaluated as JavaScript.
    expect(new Function(`${text}; return s + c;`)()).toBe("</script><script><!--");
  });

  it("refuses NUL", () => {
    expect(embeddableScript("a\u0000b")).toBeNull();
  });
});

describe("HTML artifact importer", () => {
  it("(i) static slides with Google Fonts: .slide heuristic, fonts as @import, navigation neutralized", () => {
    const r = importHtmlArtifact(fixture("artifact-static-fonts.html"), { canvas, maxSlides: 200 });
    expect(r.heuristic).toBe("slide-class");
    expect(r.title).toBe("Quantum Computing 101");
    expect(r.lang).toBe("en");
    expect(r.slides.map((s) => s.title)).toEqual([
      "Quantum Computing 101",
      "Superposition",
      "Entanglement",
    ]);
    expect(r.themeCss).toContain(
      "@import url(https://fonts.googleapis.com/css2?family=Playfair+Display",
    );
    // body → each slide; vw/vh → canvas px; `.slide{display:none}` neutralized; `active` added to every slide.
    expect(r.themeCss).toContain("section[data-slide]{");
    expect(r.themeCss).toMatch(/\.slide\{position:absolute;inset:0;flex-direction:column/);
    expect(r.themeCss).not.toMatch(/\.slide\{[^}]*display:none/);
    expect(r.themeCss).toContain("height:1080px");
    for (const s of r.slides) expect(s.html).toMatch(/class="slide active"/);
    // The image stays as an https URL for the vendoring stage.
    expect(r.slides[1]?.html).toContain("https://images.example.org/bloch-sphere.png");
    // Navigation outside the slides is kept hidden for the script; handlers converted.
    expect(r.slides[0]?.html).toContain('style="display:none!important"');
    expect(r.slides[0]?.html).toContain('id="counter"');
    expect(r.script).toContain("function showSlide");
    expect(r.script).toContain('addEventListener("click"');
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "IMPORT_NAVIGATION_HANDLERS",
        "IMPORT_INLINE_HANDLERS",
        "IMPORT_DROPPED_OUTSIDE",
        "IMPORT_SPLIT",
      ]),
    );
    expect(scriptProblem(r.script ?? "")).toBeNull();
  });

  it("(ii) Chart.js from a CDN and an interactive widget: sections heuristic, libs, handlers", () => {
    const r = importHtmlArtifact(fixture("artifact-chart-widget.html"), { canvas, maxSlides: 200 });
    expect(r.heuristic).toBe("sections");
    expect(r.lang).toBe("es");
    expect(r.slides).toHaveLength(3);
    expect(r.libs).toEqual(["https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"]);
    expect(r.themeCss).toContain("@import url(");
    expect(r.themeCss).toContain("width:1344px"); // 70vw
    expect(r.slides[2]?.html).toContain('type="range"');
    expect(r.slides[2]?.html).not.toContain("oninput");
    expect(r.script).toContain("new Chart(");
    expect(r.script).toContain('getElementById("growth")');
    expect(r.script).toContain('addEventListener("input"');
    expect(scriptProblem(r.script ?? "")).toBeNull();
  });

  it("(iii) an app-like single page: one slide, data block kept, honest warning", () => {
    const r = importHtmlArtifact(fixture("artifact-app.html"), { canvas, maxSlides: 200 });
    expect(r.heuristic).toBe("single");
    expect(r.slides).toHaveLength(1);
    expect(r.libs).toEqual(["https://unpkg.com/dayjs@1.11.10/dayjs.min.js"]);
    expect(r.slides[0]?.html).toContain('id="presets"');
    expect(r.slides[0]?.html).toContain("{&quot;tips&quot;:[10,15,20]}".replace(/&quot;/g, '"'));
    expect(r.themeCss).toContain("section[data-slide]{display:flex");
    expect(r.warnings.map((w) => w.code)).toContain("IMPORT_FIDELITY");
  });

  it("splits by h1/h2 when nothing marks the slides", () => {
    const r = importHtmlArtifact(
      "<html><body><main><h1>One</h1><p>a</p><h2>Two</h2><p>b</p><h2>Three</h2></main></body></html>",
      { canvas, maxSlides: 200 },
    );
    expect(r.heuristic).toBe("headings");
    expect(r.slides.map((s) => s.title)).toEqual(["One", "Two", "Three"]);
  });

  it("honours split=single and the slide limit", () => {
    const html = `<body>${"<section><h2>x</h2></section>".repeat(5)}</body>`;
    expect(
      importHtmlArtifact(html, { canvas, maxSlides: 200, split: "single" }).slides,
    ).toHaveLength(1);
    const capped = importHtmlArtifact(html, { canvas, maxSlides: 2 });
    expect(capped.slides).toHaveLength(2);
    expect(capped.warnings.map((w) => w.code)).toContain("IMPORT_TOO_MANY_SLIDES");
  });

  it("refuses JSX/React artifacts that need a runtime transpiler", () => {
    const jsx =
      '<html><head><script src="https://unpkg.com/@babel/standalone/babel.min.js"></script></head><body><div id="root"></div><script type="text/babel">ReactDOM.render(<App/>, root)</script></body></html>';
    expect(() => importHtmlArtifact(jsx, { canvas, maxSlides: 200 })).toThrow(ArtifactImportError);
  });

  it("skips ES modules with imports and keeps classic ones", () => {
    const r = importHtmlArtifact(
      '<body><p>x</p><script type="module">import * as d3 from "https://esm.sh/d3";</script><script type="module" src="https://esm.sh/x"></script></body>',
      { canvas, maxSlides: 200 },
    );
    expect(r.script).toBeNull();
    expect(r.libs).toEqual([]);
    expect(r.warnings.filter((w) => w.code === "IMPORT_MODULE_SCRIPT")).toHaveLength(2);
  });

  it("neutralises the CSS that hides inactive slides", () => {
    const r = adaptArtifactCss(
      ".slide{display:none;opacity:0;transform:translateX(100%)}.slide.current{display:block;opacity:1}.slide:not(.shown){visibility:hidden}",
      { kind: "class", name: "slide" },
      canvas,
    );
    expect(r.css).toBe(".slide{}.slide.current{display:block;opacity:1}.slide:not(.shown){}");
    expect(r.activeClasses.sort()).toEqual(["current", "shown"]);
  });

  it("escapes </script inside inline scripts so the deck script stays embeddable", () => {
    const r = importHtmlArtifact(
      "<body><p>x</p><script>var t = '<scr' + 'ipt>'; var u = \"<\\/script>\"; var s = '<script';</script></body>",
      { canvas, maxSlides: 200 },
    );
    expect(scriptProblem(r.script ?? "")).toBeNull();
    expect(r.script).toContain("<\\u0073cript");
  });
});
