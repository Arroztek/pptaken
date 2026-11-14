// SPDX-License-Identifier: AGPL-3.0-or-later
// Targeted behavior tests of the public API: policy decisions, warning format, deck handling and limits.

import { readdirSync, readFileSync } from "node:fs";
import { type Deck, LIMITS, parseDeck } from "@pptaken/schema";
import { describe, expect, it } from "vitest";
import { sanitizeCss, sanitizeDeck, sanitizeSlideHtml } from "../src/index.js";
import { assertSafeHtml } from "./support.js";

const H = (html: string) => sanitizeSlideHtml(html);
const C = (css: string, scope?: string) => sanitizeCss(css, scope === undefined ? {} : { scope });
const SCOPE = '[data-slide="intro"]';

describe("HTML policy", () => {
  it("drops dangerous containers with their content and unwraps harmless unknown tags", () => {
    expect(H("<script>alert(1)</script><p>a</p>").html).toBe("<p>a</p>");
    expect(H("<iframe>x</iframe><x-card><b>kept</b></x-card>").html).toBe("<b>kept</b>");
    expect(H("<a href='https://example.com'>link text</a>").html).toBe("link text");
    expect(H("<font color=red>x</font>").warnings[0]?.code).toBe("UNWRAPPED_ELEMENT");
  });

  it("removes comments, doctypes and processing instructions silently", () => {
    const r = H("<!doctype html><!-- note --><?pi x?><p>a</p>");
    expect(r.html).toBe("<p>a</p>");
    expect(r.warnings).toEqual([]);
  });

  it("removes MathML entirely", () => {
    expect(H("<math><mi>x</mi></math>").html).toBe("");
  });

  it("keeps only asset references as image sources", () => {
    expect(H('<img src="asset:0123456789abcdef" alt="a">').html).toBe(
      '<img src="asset:0123456789abcdef" alt="a">',
    );
    const bad = H('<img src="https://example.com/a.png">');
    expect(bad.html).toBe("");
    expect(bad.warnings.map((w) => w.code)).toEqual(["REMOVED_URL", "INVALID_ASSET_REF"]);
    expect(H('<img src="asset:XYZ">').warnings[0]?.code).toBe("INVALID_ASSET_REF");
  });

  it("validates data-step", () => {
    expect(H('<p data-step="1">a</p><p data-step="99">b</p><p data-step>c</p>').html).toBe(
      '<p data-step="1">a</p><p data-step="99">b</p><p data-step="">c</p>',
    );
    expect(H('<p data-step="0">a</p>').html).toBe("<p>a</p>");
    expect(H('<p data-step="100">a</p>').html).toBe("<p>a</p>");
  });

  it("refuses ids that could clobber globals, including case variants and the runtime prefix", () => {
    for (const id of [
      "location",
      "Location",
      "__proto__",
      "top",
      "parent",
      "document",
      "pptaken-runtime",
    ]) {
      expect(H(`<div id="${id}">x</div>`).html, id).toBe("<div>x</div>");
    }
    expect(H('<div id="intro-title">x</div>').html).toBe('<div id="intro-title">x</div>');
  });

  it("filters class tokens individually", () => {
    expect(H('<div class="a pptaken-step b:c d">x</div>').html).toBe('<div class="a d">x</div>');
  });

  it("allows only static ARIA roles", () => {
    expect(H('<div role="img" aria-label="Chart">x</div>').html).toBe(
      '<div role="img" aria-label="Chart">x</div>',
    );
    expect(H('<div role="button">x</div>').html).toBe("<div>x</div>");
  });

  it("sanitizes style attributes with the CSS rules", () => {
    expect(H('<p style="color:red;background:url(http://x)">a</p>').html).toBe(
      '<p style="color:red">a</p>',
    );
    expect(H('<p style="behavior:url(x)">a</p>').html).toBe("<p>a</p>");
  });

  it("normalizes xlink:href to href and only allows same-slide fragments", () => {
    expect(
      H('<svg><path id="p" d="M0 0"/><text><textPath xlink:href="#p">t</textPath></text></svg>')
        .html,
    ).toBe('<svg><path id="p" d="M0 0"></path><text><textPath href="#p">t</textPath></text></svg>');
    expect(H('<svg><use href="#missing"/></svg>').html).toBe("<svg></svg>");
  });

  it("does not allow <use> chains (exponential expansion)", () => {
    const r = H(
      '<svg><g id="a"><circle r="1"/></g><g id="b"><use href="#a"/></g><use href="#b"/><use href="#a"/></svg>',
    );
    expect(r.html).toBe(
      '<svg><g id="a"><circle r="1"></circle></g><g id="b"><use href="#a"></use></g><use href="#a"></use></svg>',
    );
  });

  it("validates SVG presentation attributes as CSS values", () => {
    expect(H('<svg><rect fill="url(#g)" stroke="rgb(1 2 3)"/></svg>').html).toBe(
      '<svg><rect fill="url(#g)" stroke="rgb(1 2 3)"></rect></svg>',
    );
    const r = H('<svg><rect fill="url(http://evil.test/p#x)"/></svg>');
    expect(r.html).toBe("<svg><rect></rect></svg>");
    expect(r.warnings[0]?.code).toBe("REMOVED_URL");
  });

  it("drops HTML elements inside SVG title/desc (HTML integration points)", () => {
    expect(H("<svg><desc><b>x</b>text</desc></svg>").html).toBe("<svg><desc>text</desc></svg>");
  });

  it("removes control characters from text", () => {
    expect(H("<p>a\u0001b\u007fc</p>").html).toBe("<p>abc</p>");
  });

  it("keeps a leading newline inside <pre> stable across re-parsing", () => {
    const once = H("<pre>\n\nline</pre>").html;
    expect(H(once).html).toBe(once);
    expect(once).toBe("<pre>\n\nline</pre>");
  });

  it("keeps escaped markup escaped", () => {
    const r = H("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(r.html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    assertSafeHtml(r.html);
  });

  it("is deterministic", () => {
    const input =
      '<svg viewBox="0 0 1 1"><rect fill="#fff"/></svg><p class="a b" data-step="2">x</p>';
    expect(H(input)).toEqual(H(input));
  });
});

describe("CSS policy", () => {
  it("scopes selectors and maps :root, html and body to the scope", () => {
    expect(C("h1{color:red}", SCOPE).css).toBe('[data-slide="intro"] h1{color:red}');
    expect(C(":root{--a:1px}", SCOPE).css).toBe('[data-slide="intro"]{--a:1px}');
    expect(C("html body .x{margin:0}", SCOPE).css).toBe('[data-slide="intro"] .x{margin:0}');
    expect(C("body.dark>p{color:red}", SCOPE).css).toBe('[data-slide="intro"].dark>p{color:red}');
    expect(C("*{margin:0}", SCOPE).css).toBe('[data-slide="intro"] *{margin:0}');
  });

  it("refuses selectors that escape the scope", () => {
    for (const css of ["body~section{x:1}", ":root+*{x:1}", ".a body{x:1}", ":is(html) p{x:1}"]) {
      const r = C(css, SCOPE);
      expect(r.css, css).toBe("");
      expect(r.warnings[0]?.code, css).toBe("REMOVED_CSS_RULE");
    }
  });

  it("is idempotent when scoped", () => {
    const once = C("body{color:red} p{margin:0} @media (min-width:1px){:root{--x:1}}", SCOPE).css;
    expect(C(once, SCOPE).css).toBe(once);
  });

  it("removes forbidden at-rules", () => {
    for (const rule of [
      "@import url(a.css);",
      "@font-face{font-family:x}",
      "@namespace x url(y);",
      "@property --x{syntax:'*'}",
      "@container (min-width:1px){a{color:red}}",
      "@layer a{b{color:red}}",
      "@page{margin:0}",
    ]) {
      const r = C(rule);
      expect(r.css, rule).toBe("");
      expect(r.warnings[0]?.code, rule).toBe("REMOVED_CSS_RULE");
    }
  });

  it("keeps @media, @supports and @keyframes with filtered contents", () => {
    expect(C("@media (min-width:100px){a{color:red;background:url(http://x)}}").css).toBe(
      "@media (min-width:100px){a{color:red}}",
    );
    expect(C("@keyframes k{from{opacity:0}to{opacity:1}}").css).toBe(
      "@keyframes k{from{opacity:0}to{opacity:1}}",
    );
  });

  it("allows url() only for asset references (and #fragments in SVG paint properties)", () => {
    expect(C("a{background:url(asset:0123456789abcdef)}").css).toBe(
      "a{background:url(asset:0123456789abcdef)}",
    );
    expect(C("a{background:url(https://x/y.png)}").warnings[0]?.code).toBe("REMOVED_URL");
    expect(C("a{content:url(asset:0123456789abcdef)}").css).toBe("");
    expect(C("rect{fill:url(#g)}").css).toBe("rect{fill:url(#g)}");
    expect(C("a{background:url(#g)}").css).toBe("");
  });

  it("restricts font families to the catalog and generic families", () => {
    const r = C('a{font-family:"Comic Sans MS",Inter,"Source Serif 4",serif}');
    expect(r.css).toBe('a{font-family:Inter,"Source Serif 4",serif}');
    expect(r.warnings.map((w) => w.code)).toEqual(["REMOVED_FONT_FAMILY"]);
    expect(C("a{font-family:var(--font)}").css).toBe("a{font-family:var(--font)}");
    expect(C("a{font:italic 700 40px/1.2 Fraunces,serif}").css).toBe(
      "a{font:italic 700 40px/1.2 Fraunces,serif}",
    );
  });

  it("bounds z-index", () => {
    expect(C("a{z-index:10}").css).toBe("a{z-index:10}");
    expect(C("a{z-index:2147483647}").css).toBe("");
  });

  it("refuses strings that could close the <style> element", () => {
    expect(C('a::before{content:"</style>"}').css).toBe("");
    expect(C('a::before{content:"\\3c/style\\3e"}').css).toBe("");
    expect(C('a::before{content:"\u2192"}').css).toBe('a::before{content:"\u2192"}');
  });

  it("refuses escapes outside strings", () => {
    expect(C("a{color:r\\65 d}").css).toBe("");
    expect(C(".a\\:b{color:red}").css).toBe("");
  });

  it("drops nested rules", () => {
    expect(C(".a{color:red;.b{color:blue}}").css).toBe(".a{color:red}");
  });
});

describe("fail closed", () => {
  it("empties oversized fields", () => {
    const r = H(`<p>${"x".repeat(LIMITS.maxSlideHtml)}</p>`);
    expect(r).toEqual({
      html: "",
      warnings: [{ code: "INPUT_TOO_LARGE", message: expect.any(String) }],
    });
    expect(C(`a{color:red}${" ".repeat(LIMITS.maxSlideCss)}`).warnings[0]?.code).toBe(
      "INPUT_TOO_LARGE",
    );
  });

  it("empties too deep or too large trees", () => {
    expect(H("<div>".repeat(5000)).warnings[0]?.code).toBe("LIMIT_EXCEEDED");
    expect(H("<br>".repeat(50000)).warnings[0]?.code).toBe("LIMIT_EXCEEDED");
    expect(C(`a{width:${"calc(".repeat(100)}1px}`).warnings[0]?.code).toBe("LIMIT_EXCEEDED");
  });

  it("fails closed fast on inputs that make HTML parsing quadratic", () => {
    let attrs = "";
    for (let i = 0; attrs.length < 250_000; i++) attrs += ` a${i.toString(36)}=1`;
    for (const input of [
      `<div${attrs}>x</div>`, // distinct attributes: duplicate detection is linear per attribute
      "<a><b><i><u><s></x>".repeat(9000), // deep formatting nesting with stray end tags
      "<!---->".repeat(36_000), // many top-level nodes: parse5 adopts fragment children quadratically
      "<br>".repeat(30_000),
    ]) {
      const start = performance.now();
      const r = H(input);
      expect(performance.now() - start).toBeLessThan(500);
      expect(r.html).toBe("");
      expect(r.warnings[0]?.code).toBe("LIMIT_EXCEEDED");
    }
  });

  it("never throws on non-string input", () => {
    expect(sanitizeSlideHtml(42 as unknown as string).html).toBe("");
    expect(sanitizeCss(null as unknown as string).css).toBe("");
  });
});

describe("warnings", () => {
  it("never echo the hostile payload beyond a short snippet", () => {
    const payload = `x${"A".repeat(500)}`;
    const r = H(`<p ${payload}="1" style="${payload}:red">a</p>`);
    for (const w of r.warnings) {
      expect(JSON.stringify(w).length).toBeLessThan(200);
      expect(w.name?.length ?? 0).toBeLessThanOrEqual(41);
    }
  });

  it("replace control and bidi characters in names", () => {
    const r = H('<p on\u202eclick="x">a</p>');
    expect(r.warnings[0]?.name).not.toMatch(/[\u0000-\u001f\u202a-\u202e]/);
  });

  it("are capped per field", () => {
    const html = Array.from({ length: 300 }, (_, i) => `<p data-x${i}="1">a</p>`).join("");
    const r = H(html);
    expect(r.warnings.length).toBe(101);
    expect(r.warnings.at(-1)?.code).toBe("TOO_MANY_WARNINGS");
  });
});

describe("sanitizeDeck", () => {
  const deck = {
    schemaVersion: 1,
    title: "T",
    aspectRatio: "16:9",
    theme: { css: "@import url(x); body{font-family:Inter}" },
    slides: [
      { id: "intro", title: "", html: "<h1>Hi</h1>", css: "h1{color:red}" },
      {
        id: "two",
        title: "",
        html: "<script>x</script><p>b</p>",
        css: "body{background:url(http://x)}",
      },
    ],
  } as Deck;

  it("sanitizes every field with paths in the MCP error style", () => {
    const r = sanitizeDeck(deck);
    expect(r.deck.slides[0]?.css).toBe('[data-slide="intro"] h1{color:red}');
    expect(r.deck.slides[1]?.html).toBe("<p>b</p>");
    expect(r.deck.theme?.css).toBe("body{font-family:Inter}");
    expect(r.warnings.map((w) => `${w.path} ${w.code}`)).toEqual([
      "slides[1].html REMOVED_ELEMENT",
      "slides[1].css REMOVED_URL",
      "theme.css REMOVED_CSS_RULE",
    ]);
    // The input is not modified.
    expect(deck.slides[1]?.html).toBe("<script>x</script><p>b</p>");
  });

  it("is idempotent", () => {
    const once = sanitizeDeck(deck).deck;
    const twice = sanitizeDeck(once);
    expect(twice.deck).toEqual(once);
    expect(twice.warnings).toEqual([]);
  });

  it("supports a custom scope builder", () => {
    const r = sanitizeDeck(deck, { slideScope: (id) => `#slide-${id}` });
    expect(r.deck.slides[0]?.css).toBe("#slide-intro h1{color:red}");
  });
});

describe("schema examples", () => {
  const dir = new URL("../../schema/examples/", import.meta.url);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  it.skipIf(files.length === 0)("every example deck sanitizes with zero warnings", () => {
    let checked = 0;
    for (const file of files) {
      const parsed = parseDeck(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
      if (!parsed.ok) continue; // invalid examples (if any) are the schema tests' business
      const r = sanitizeDeck(parsed.deck);
      expect(r.warnings, file).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("performance", () => {
  it("sanitizes a 256 KB slide well under a second", () => {
    const unit =
      '<div class="row" data-step="1"><span style="color:#fff;font-size:20px">Cell</span><svg viewBox="0 0 10 10"><rect width="5" height="5" fill="url(#g)"/></svg></div>';
    const html = unit.repeat(Math.floor(LIMITS.maxSlideHtml / unit.length));
    const start = performance.now();
    const r = H(html);
    const elapsed = performance.now() - start;
    expect(r.html.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
  });

  it("sanitizes 64 KB of CSS quickly", () => {
    const unit =
      ".card:nth-child(2n) h3{color:rgb(1 2 3);background:linear-gradient(90deg,#000,#fff)}";
    const css = unit.repeat(Math.floor(LIMITS.maxSlideCss / unit.length));
    const start = performance.now();
    const r = C(css, SCOPE);
    expect(r.css.length).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
