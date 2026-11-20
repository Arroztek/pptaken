// SPDX-License-Identifier: Apache-2.0
// Speaker notes renderer: features, a hostile vector corpus, output invariants checked by parsing the output
// (a strict tokenizer here, plus the content sanitizer's HTML parser), and time on adversarial input.

import { sanitizeSlideHtml } from "@pptaken/sanitizer";
import { describe, expect, it } from "vitest";
import { NOTES_MAX_INPUT, NOTES_TAGS, renderInline, renderNotes } from "../dist/index.js";

const ALLOWED = new Set<string>(NOTES_TAGS);
const VOID = new Set(["br"]);

/**
 * Parses renderer output with a strict grammar: text without `<`/`>`, only the five entities, and tags from the
 * allowlist without attributes (except `ol start="<digits>"`), properly nested. Returns the text content.
 */
function parseOutput(html: string): string {
  const stack: string[] = [];
  let text = "";
  const tag = /<(\/?)([a-z0-9]+)((?: start="[0-9]{1,9}")?)>/y;
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      tag.lastIndex = i;
      const m = tag.exec(html);
      if (!m) throw new Error(`bad tag at ${i}: ${html.slice(i, i + 40)}`);
      const [all, close, name = "", attrs] = m;
      if (!ALLOWED.has(name)) throw new Error(`tag not allowed: ${name}`);
      if (attrs && (name !== "ol" || close)) throw new Error(`attribute on ${name}`);
      if (close) {
        if (stack.pop() !== name) throw new Error(`mismatched </${name}>`);
      } else if (!VOID.has(name)) {
        stack.push(name);
      }
      i += all.length;
    } else if (ch === ">") {
      throw new Error(`raw > at ${i}`);
    } else if (ch === "&") {
      const m = /&(amp|lt|gt|quot|#39);/y;
      m.lastIndex = i;
      const e = m.exec(html);
      if (!e) throw new Error(`bad entity at ${i}`);
      text += { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e[1] as string];
      i += e[0].length;
    } else {
      text += ch;
      i += 1;
    }
  }
  if (stack.length > 0) throw new Error(`unclosed: ${stack.join(",")}`);
  return text;
}

function safe(markdown: string): string {
  const html = renderNotes(markdown);
  parseOutput(html);
  const s = sanitizeSlideHtml(html);
  expect(s.warnings, `sanitizer removed something from: ${html.slice(0, 200)}`).toEqual([]);
  // Nothing executable or URL-like ever appears as markup.
  expect(html).not.toMatch(/<(?!\/?(p|br|strong|em|code|pre|ul|ol|li|h3|h4|blockquote)[ >])/);
  // The only attribute inside a tag is `start` on `ol`.
  for (const tag of html.match(/<[^>]*>/g) ?? [])
    expect(tag).toMatch(/^<\/?[a-z0-9]+( start="[0-9]+")?>$/);
  return html;
}

describe("renderNotes: features", () => {
  it("renders paragraphs and line breaks", () => {
    expect(renderNotes("Hello\nworld\n\nSecond")).toBe("<p>Hello<br>world</p><p>Second</p>");
    expect(renderNotes("a\r\nb\rc")).toBe("<p>a<br>b<br>c</p>");
    expect(renderNotes("")).toBe("");
    expect(renderNotes("   \n\n ")).toBe("");
    expect(renderNotes(undefined)).toBe("");
    expect(renderNotes(42)).toBe("");
  });

  it("renders bold, italic and code", () => {
    expect(renderNotes("**bold** and *it* and `x < y`")).toBe(
      "<p><strong>bold</strong> and <em>it</em> and <code>x &lt; y</code></p>",
    );
    expect(renderNotes("**bold *nested* here**")).toBe(
      "<p><strong>bold <em>nested</em> here</strong></p>",
    );
    expect(renderNotes("``a ` b``")).toBe("<p><code>a ` b</code></p>");
    expect(renderNotes("`` `tick` ``")).toBe("<p><code>`tick`</code></p>");
    expect(renderNotes("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
    expect(renderNotes("\\*literal\\* and 2 * 3 * 4")).toBe("<p>*literal* and 2 * 3 * 4</p>");
  });

  it("renders fenced code blocks verbatim", () => {
    expect(renderNotes("```js\nif (a < b) {\n  **x**\n}\n```\nafter")).toBe(
      "<pre><code>if (a &lt; b) {\n  **x**\n}</code></pre><p>after</p>",
    );
    expect(renderNotes("~~~\n# not a heading\n~~~")).toBe(
      "<pre><code># not a heading</code></pre>",
    );
    expect(renderNotes("````\n```\n````")).toBe("<pre><code>```</code></pre>");
    expect(renderNotes("```\nunclosed")).toBe("<pre><code>unclosed</code></pre>");
  });

  it("renders lists, nested one level", () => {
    expect(renderNotes("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderNotes("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
    expect(renderNotes("3) three\n4) four")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(renderNotes("- a\n  - a1\n  - a2\n- b")).toBe(
      "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>",
    );
    expect(renderNotes("- a\n  1. x\n      - deeper is flattened")).toBe(
      "<ul><li>a<ol><li>x</li></ol><ul><li>deeper is flattened</li></ul></li></ul>",
    );
    expect(renderNotes("- a\n  continued\n- b")).toBe("<ul><li>a<br>continued</li><li>b</li></ul>");
    expect(renderNotes("* star **bold**\n+ plus")).toBe(
      "<ul><li>star <strong>bold</strong></li><li>plus</li></ul>",
    );
    expect(renderNotes("- a\n\n- b\n\ntext")).toBe("<ul><li>a</li><li>b</li></ul><p>text</p>");
    expect(renderNotes("- a\n1. b")).toBe("<ul><li>a</li></ul><ol><li>b</li></ol>");
  });

  it("renders h3 and h4 headings only", () => {
    expect(renderNotes("# Title")).toBe("<h3>Title</h3>");
    expect(renderNotes("## Sub ##")).toBe("<h4>Sub</h4>");
    expect(renderNotes("###### Deep")).toBe("<h4>Deep</h4>");
    expect(renderNotes("#nospace")).toBe("<p>#nospace</p>");
    expect(renderNotes("# C#")).toBe("<h3>C#</h3>");
  });

  it("renders blockquotes", () => {
    expect(renderNotes("> quoted *text*\n> more\n\nafter")).toBe(
      "<blockquote><p>quoted <em>text</em><br>more</p></blockquote><p>after</p>",
    );
    expect(renderNotes("> - item\n> > not nested")).toBe(
      "<blockquote><ul><li>item</li></ul><p>&gt; not nested</p></blockquote>",
    );
  });

  it("shows links, images, autolinks and raw HTML as text", () => {
    expect(renderNotes("[site](https://example.com) ![img](x.png) <https://a.b>")).toBe(
      "<p>[site](https://example.com) ![img](x.png) &lt;https://a.b&gt;</p>",
    );
    expect(renderNotes("<b>hi</b>")).toBe("<p>&lt;b&gt;hi&lt;/b&gt;</p>");
  });
});

describe("renderNotes: hostile corpus", () => {
  const corpus = [
    "<script>alert(1)</script>",
    "<SCRIPT SRC=//evil></SCRIPT>",
    '<img src=x onerror="alert(1)">',
    "<svg/onload=alert(1)>",
    "<iframe src=javascript:alert(1)>",
    "[click](javascript:alert(1))",
    "[click]( javascript:alert(1) )",
    "![x](javascript:alert(1))",
    "<a href='javascript:alert(1)'>x</a>",
    "**<img src=x onerror=alert(1)>**",
    "`<script>`",
    "```\n</code></pre><script>alert(1)</script>\n```",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "&#60;script&#62;",
    "&#x3C;img src=x onerror=alert(1)&#x3E;",
    "&amp;lt;",
    '"><script>alert(1)</script>',
    "' onmouseover='alert(1)",
    "<style>body{display:none}</style>",
    '<p style="background:url(javascript:alert(1))">x</p>',
    "<!-- comment --> <![CDATA[x]]> <?php ?>",
    "<math><mi xlink:href=javascript:alert(1)>x</mi></math>",
    "# <h1>heading</h1>",
    "> <blockquote onclick=alert(1)>",
    "- <li onclick=alert(1)>",
    "1. <ol start=1 onclick=alert(1)>",
    "** unbalanced *** markers * ** *",
    "*a **b* c**",
    "**a *b** c*",
    "***x***",
    "\u0000\u0001<x>\u001f\u007f",
    "\\<script\\>",
    "`` ` `` ` ``` `",
    "  <script>",
    "<",
    ">",
    "&",
    "\"'",
  ];

  it("never emits markup from the input", () => {
    for (const vector of corpus) {
      const html = safe(vector);
      expect(html.toLowerCase(), vector).not.toContain("<script");
      expect(html.toLowerCase(), vector).not.toContain("<img");
      expect(html.toLowerCase(), vector).not.toContain("<a ");
      expect(html, vector).not.toMatch(/<[a-z0-9]+ (?!start="[0-9]+">)/);
    }
  });

  it("keeps the visible text of the input (escaped, not decoded)", () => {
    const text = parseOutput(renderNotes("&lt;b&gt; & <i>"));
    expect(text).toBe("&lt;b&gt; & <i>");
  });

  it("is safe and stable under random input", () => {
    const pieces = [
      "*",
      "**",
      "`",
      "``",
      "```\n",
      "\n",
      "\n\n",
      "- ",
      "  - ",
      "1. ",
      "# ",
      "> ",
      "\\",
      "<",
      ">",
      "&",
      '"',
      "a",
      " ",
      "x y",
      "~~~\n",
      "\t",
    ];
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let n = 0; n < 2000; n++) {
      let s = "";
      const len = Math.floor(rand() * 40);
      for (let k = 0; k < len; k++) s += pieces[Math.floor(rand() * pieces.length)];
      const html = safe(s);
      // Deterministic.
      expect(renderNotes(s)).toBe(html);
      // Re-rendering the output (as Markdown text) never produces markup from it: it is shown as text.
      parseOutput(renderNotes(html));
    }
  });

  it("caps very long input", () => {
    const html = renderNotes("a".repeat(NOTES_MAX_INPUT + 100));
    expect(parseOutput(html)).toBe(`${"a".repeat(NOTES_MAX_INPUT)}…`);
  });
});

describe("renderNotes: time on adversarial input", () => {
  const time = (input: string): number => {
    const t0 = performance.now();
    renderNotes(input);
    return performance.now() - t0;
  };
  const best = (input: string): number => Math.min(time(input), time(input), time(input));

  const shapes: [string, (n: number) => string][] = [
    ["open stars", (n) => "*a ".repeat(n)],
    ["open double stars", (n) => "**a ".repeat(n)],
    ["star runs", (n) => "*".repeat(n)],
    ["alternating", (n) => "*a **b ".repeat(n)],
    ["backticks", (n) => "`a ``b ```c ".repeat(n)],
    [
      "growing backtick runs",
      (n) => Array.from({ length: Math.sqrt(n) | 0 }, (_, i) => "`".repeat(i + 1)).join(" a "),
    ],
    ["escapes", (n) => "\\*\\".repeat(n)],
    ["heading hashes", (n) => `# ${" #".repeat(n)}x`],
    ["list markers", (n) => "- ".repeat(n)],
    ["nested lists", (n) => "- a\n  - b\n".repeat(n / 8)],
    ["blockquotes", (n) => "> a\n".repeat(n / 4)],
    ["fences", (n) => "```\n".repeat(n / 4)],
    ["entities", (n) => "&lt;".repeat(n / 4)],
    ["newlines", (n) => "a\n".repeat(n / 2)],
  ];

  it("grows about linearly (4x input stays well under 16x time)", () => {
    const small = 4000;
    for (const [name, make] of shapes) {
      // Warm up the JIT on this shape.
      renderNotes(make(small));
      // Millisecond-scale timings are noisy on shared CI runners (a ratio of 10.1 was seen on linear code), so the
      // floor is not tiny and the bound sits between linear (4x) and quadratic (16x).
      const a = Math.max(best(make(small)), 0.25);
      const b = best(make(small * 4));
      expect(b / a, `${name}: ${a.toFixed(2)} ms -> ${b.toFixed(2)} ms`).toBeLessThan(13);
    }
  });

  it("renders the largest notes (64 KB of hostile markers) quickly", () => {
    for (const [name, make] of shapes) {
      const input = make(NOTES_MAX_INPUT).slice(0, NOTES_MAX_INPUT);
      expect(best(input), name).toBeLessThan(250);
    }
  });
});

describe("renderInline", () => {
  it("does not let emphasis nest deeper than four levels", () => {
    const deep = `${"**a *".repeat(10)}x${"* a**".repeat(10)}`;
    const html = renderInline(deep);
    parseOutput(html);
    expect((html.match(/<(strong|em)>/g) ?? []).length).toBeLessThanOrEqual(10);
  });
});
