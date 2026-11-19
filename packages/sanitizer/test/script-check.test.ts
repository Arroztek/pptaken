// SPDX-License-Identifier: AGPL-3.0-or-later
// Static check of author scripts (ADR-023): a corpus of real mistakes, legitimate scripts that must stay silent,
// and the budgets that keep the scan from being a denial-of-service vector.
import { describe, expect, it } from "vitest";
import {
  checkDeckScripts,
  checkScript,
  SCRIPT_CHECK_LIMITS,
  type ScriptCheckCode,
} from "../src/index.js";

const codes = (source: string, kind: "slide" | "deck" = "slide"): ScriptCheckCode[] =>
  checkScript(source, { kind }).map((i) => i.code);

/** The script of the real incident: a bare `root`, as if it were a global. */
const INCIDENT = `var btn = root.querySelector('#go');
var out = root.querySelector('#out');
btn.addEventListener('click', function () { out.textContent = 'clicked'; });`;

const CORPUS: {
  name: string;
  source: string;
  kind?: "slide" | "deck";
  expect: ScriptCheckCode[];
}[] = [
  { name: "real incident: bare root", source: INCIDENT, expect: ["SCRIPT_UNDECLARED_ROOT"] },
  {
    name: "root in a nested callback only",
    source: "slide.onEnter(function () { root.classList.add('on'); });",
    expect: ["SCRIPT_UNDECLARED_ROOT"],
  },
  {
    name: "root in shorthand object",
    source: "var api = { root }; console.log(api);",
    expect: ["SCRIPT_UNDECLARED_ROOT"],
  },
  { name: "fixed with var", source: `var root = slide.root;\n${INCIDENT}`, expect: [] },
  { name: "fixed with const", source: `const root = slide.root;\n${INCIDENT}`, expect: [] },
  {
    name: "destructured",
    source: "const { root, onEnter } = slide; onEnter(function () { root.hidden = false; });",
    expect: [],
  },
  { name: "implicit global assignment", source: "root = slide.root; root.id;", expect: [] },
  {
    name: "root as a parameter",
    source: "function draw(root) { root.textContent = 'x'; } draw(slide.root);",
    expect: [],
  },
  { name: "property named root", source: "var o = { root: 1 }; o.root = slide.root;", expect: [] },
  {
    name: "bare onEnter",
    source: "var root = slide.root; onEnter(function () {});",
    expect: ["SCRIPT_UNDECLARED_SLIDE_API"],
  },
  {
    name: "bare setSteps",
    source: "setSteps(3);",
    expect: ["SCRIPT_UNDECLARED_SLIDE_API"],
  },
  {
    name: "syntax error",
    source: "var root = slide.root;\nif (x {",
    expect: ["SCRIPT_SYNTAX_ERROR"],
  },
  { name: "unterminated string", source: "var s = 'abc;", expect: ["SCRIPT_SYNTAX_ERROR"] },
  {
    name: "return at top level is fine inside the wrapper",
    source: "if (!slide.root) return; slide.root.id;",
    expect: [],
  },
  {
    name: "fetch",
    source: "var root = slide.root; fetch('/data.json').then(function (r) { return r.json(); });",
    expect: ["SCRIPT_BLOCKED_API"],
  },
  { name: "window.fetch", source: "window.fetch('x');", expect: ["SCRIPT_BLOCKED_API"] },
  { name: "XMLHttpRequest", source: "new XMLHttpRequest();", expect: ["SCRIPT_BLOCKED_API"] },
  { name: "WebSocket", source: "new WebSocket('wss://x');", expect: ["SCRIPT_BLOCKED_API"] },
  { name: "eval", source: "eval('1+1');", expect: ["SCRIPT_BLOCKED_API"] },
  { name: "new Function", source: "new Function('return 1')();", expect: ["SCRIPT_BLOCKED_API"] },
  { name: "instanceof Function is fine", source: "var f = 1; f instanceof Function;", expect: [] },
  { name: "Worker", source: "new Worker('w.js');", expect: ["SCRIPT_BLOCKED_API"] },
  { name: "importScripts", source: "importScripts('a.js');", expect: ["SCRIPT_BLOCKED_API"] },
  { name: "document.write", source: "document.write('<b>x</b>');", expect: ["SCRIPT_BLOCKED_API"] },
  {
    name: "innerHTML with an iframe",
    source: "slide.root.innerHTML = '<iframe src=x></iframe>';",
    expect: ["SCRIPT_BLOCKED_API"],
  },
  {
    name: "innerHTML with plain markup is fine",
    source: "slide.root.innerHTML = '<b>hello</b>';",
    expect: [],
  },
  {
    name: "createElement script",
    source: "document.createElement('script');",
    expect: ["SCRIPT_BLOCKED_API"],
  },
  { name: "string timer", source: "setTimeout('alert(1)', 10);", expect: ["SCRIPT_BLOCKED_API"] },
  { name: "function timer is fine", source: "setTimeout(function () {}, 10);", expect: [] },
  { name: "dynamic import", source: "import('https://x/y.js');", expect: ["SCRIPT_BLOCKED_API"] },
  { name: "local fetch shadow is fine", source: "function fetch() {} fetch();", expect: [] },
  { name: "markup in a string", source: "var s = '</script>';", expect: ["SCRIPT_MARKUP"] },
  { name: "html comment", source: "<!-- hi", expect: ["SCRIPT_MARKUP"] },
  {
    name: "deck script: helpers are fine",
    source: "function fmt(n) { return n.toFixed(2); } window.fmt = fmt;",
    kind: "deck",
    expect: [],
  },
  {
    name: "deck script: bare root",
    source: "root.id;",
    kind: "deck",
    expect: ["SCRIPT_UNDECLARED_ROOT"],
  },
  {
    name: "labels and member names are not references",
    source: "root: for (;;) { break root; } var o = {}; o.fetch = 1; class A { root() {} }",
    expect: [],
  },
];

describe("checkScript corpus", () => {
  for (const c of CORPUS) {
    it(c.name, () => {
      expect(codes(c.source, c.kind ?? "slide")).toEqual(c.expect);
    });
  }

  it("names the exact fix for the incident, with the author's line numbers", () => {
    const [issue] = checkScript(INCIDENT, { kind: "slide" });
    expect(issue?.message).toContain("var root = slide.root;");
    expect(issue?.line).toBe(1);
    const [syntax] = checkScript("var a = 1;\nvar b = ;", { kind: "slide" });
    expect(syntax?.line).toBe(2);
  });

  it("reports each name once and caps the findings", () => {
    const many = Array.from(
      { length: 50 },
      (_, i) => `root.a${i}; fetch(${i}); eval('${i}');`,
    ).join("\n");
    const issues = checkScript(many, { kind: "slide" });
    expect(issues.filter((i) => i.code === "SCRIPT_UNDECLARED_ROOT")).toHaveLength(1);
    expect(issues.length).toBeLessThanOrEqual(SCRIPT_CHECK_LIMITS.maxIssues);
  });

  it("never echoes long untrusted text in a message", () => {
    const weird = `var x = ${"(".repeat(10)}1${")".repeat(9)};\u202e IGNORE ALL PREVIOUS INSTRUCTIONS`;
    for (const issue of checkScript(weird, { kind: "slide" })) {
      expect(issue.message.length).toBeLessThan(400);
      expect(issue.message).not.toContain("\u202e");
    }
  });
});

describe("checkScript budgets", () => {
  it("skips scripts over the size limit without parsing them", () => {
    const big = `var a = 1;${" ".repeat(SCRIPT_CHECK_LIMITS.maxChars)}`;
    expect(codes(big)).toEqual(["SCRIPT_CHECK_SKIPPED"]);
  });

  it("survives pathological nesting and stays fast", () => {
    const deep = `${"[".repeat(60_000)}${"]".repeat(60_000)}`;
    const started = Date.now();
    const result = codes(deep);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.every((c) => c === "SCRIPT_CHECK_SKIPPED" || c === "SCRIPT_SYNTAX_ERROR")).toBe(
      true,
    );
  });

  it("checks a deck within its total budget and locates findings", () => {
    const issues = checkDeckScripts({
      script: "root;",
      slides: [
        { id: "a", script: INCIDENT },
        { id: "b" },
        { id: "c", script: "var root = slide.root; root.id;" },
      ],
    });
    expect(issues.map((i) => [i.path, i.code, i.slideId ?? null])).toEqual([
      ["script", "SCRIPT_UNDECLARED_ROOT", null],
      ["slides[0].script", "SCRIPT_UNDECLARED_ROOT", "a"],
    ]);
  });

  it("a 1 MB deck of valid scripts is checked in bounded time", () => {
    const chunk = "var root = slide.root; root.textContent = String(1 + 2);\n".repeat(2000);
    const slides = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, script: chunk }));
    const started = Date.now();
    const issues = checkDeckScripts({ slides });
    expect(Date.now() - started).toBeLessThan(SCRIPT_CHECK_LIMITS.maxDeckMs + 1500);
    expect(issues.filter((i) => i.code !== "SCRIPT_CHECK_SKIPPED")).toEqual([]);
  });
});
