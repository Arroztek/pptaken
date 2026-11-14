// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared test support: corpus loading and output invariants. The invariants re-parse the sanitized output with
// the same parsers (parse5 for HTML, css-tree for CSS) and walk the trees; they never grep the output text.

import { readdirSync, readFileSync } from "node:fs";
import { ASSET_REF_PATTERN } from "@pptaken/schema";
import * as csstree from "css-tree";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html, parseFragment } from "parse5";
import { policy } from "../src/index.js";

export interface Generator {
  prefix: string;
  unit: string;
  times: number;
  suffix: string;
}

export interface Vector {
  id: string;
  category: string;
  source: string;
  notes: string;
  html?: string;
  css?: string;
  htmlGenerator?: Generator;
  cssGenerator?: Generator;
  scoped?: boolean;
  rawNetworkLeak?: string;
}

export interface LegitCase {
  id: string;
  notes: string;
  html: string;
  css?: string;
  expectHtml?: string[];
  expectCss?: string[];
}

const CORPUS_DIR = new URL("../corpus/", import.meta.url);

const expand = (g: Generator): string => g.prefix + g.unit.repeat(g.times) + g.suffix;

/** Loads every hostile vector, with generated inputs expanded. */
export function loadVectors(): (Vector & { html?: string; css?: string })[] {
  const out: Vector[] = [];
  for (const file of readdirSync(CORPUS_DIR).sort()) {
    if (!file.endsWith(".json") || file === "legit.json") continue;
    const list = JSON.parse(readFileSync(new URL(file, CORPUS_DIR), "utf8")) as Vector[];
    for (const v of list) {
      const copy: Vector = { ...v };
      if (v.htmlGenerator) copy.html = expand(v.htmlGenerator);
      if (v.cssGenerator) copy.css = expand(v.cssGenerator);
      out.push(copy);
    }
  }
  return out;
}

export function loadLegit(): LegitCase[] {
  return JSON.parse(readFileSync(new URL("legit.json", CORPUS_DIR), "utf8")) as LegitCase[];
}

export const SCOPE = '[data-slide="legit"]';

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const FRAGMENT = /^#[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const URL_ATTRIBUTES = new Set([
  "src",
  "href",
  "xlink:href",
  "action",
  "formaction",
  "data",
  "poster",
  "srcset",
  "background",
  "cite",
  "ping",
  "srcdoc",
]);

/** Parses sanitized HTML exactly like the sanitizer does (children of a `<section>`). */
export function parseOutput(text: string): DefaultTreeAdapterTypes.DocumentFragment {
  return parseFragment(defaultTreeAdapter.createElement("section", html.NS.HTML, []), text, {
    scriptingEnabled: true,
  });
}

/**
 * Asserts the structural safety invariants of sanitized HTML. Throws with a description on violation.
 */
export function assertSafeHtml(output: string): void {
  // We check the tree a browser builds from the output text (same algorithm, same context element).
  const tree = parseOutput(output);
  const walk = (parent: ParentNode, parentNs: string | null): void => {
    for (const node of parent.childNodes) {
      if (node.nodeName === "#comment") throw new Error("comment in output");
      if (node.nodeName === "#documentType") throw new Error("doctype in output");
      if (!("tagName" in node)) continue;
      const el = node as Element;
      const ns = el.namespaceURI;
      if (ns === html.NS.HTML) {
        if (parentNs === html.NS.SVG) throw new Error(`HTML <${el.tagName}> inside SVG`);
        if (!policy.HTML_ELEMENTS.has(el.tagName))
          throw new Error(`HTML element <${el.tagName}> not allowed`);
      } else if (ns === html.NS.SVG) {
        if (parentNs !== html.NS.SVG && el.tagName !== "svg")
          throw new Error(`SVG <${el.tagName}> outside svg`);
        if (!policy.SVG_ELEMENTS.has(el.tagName))
          throw new Error(`SVG element <${el.tagName}> not allowed`);
        if (
          parentNs === html.NS.SVG &&
          policy.SVG_TEXT_ONLY.has((el.parentNode as Element).tagName)
        ) {
          throw new Error("element inside SVG title/desc");
        }
      } else {
        throw new Error(`foreign namespace element <${el.tagName}>`);
      }
      for (const attr of el.attrs) {
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        if (/^on/i.test(attr.name)) throw new Error(`event handler ${name}`);
        if (attr.namespace) throw new Error(`namespaced attribute ${name}`);
        if (URL_ATTRIBUTES.has(name)) {
          const ok =
            (name === "src" && el.tagName === "img" && ASSET_REF_PATTERN.test(attr.value)) ||
            (name === "href" &&
              ns === html.NS.SVG &&
              el.tagName === "image" &&
              ASSET_REF_PATTERN.test(attr.value)) ||
            (name === "href" &&
              ns === html.NS.SVG &&
              el.tagName !== "image" &&
              FRAGMENT.test(attr.value));
          if (!ok)
            throw new Error(
              `URL attribute ${name}="${attr.value.slice(0, 40)}" on <${el.tagName}>`,
            );
        }
        const known =
          ns === html.NS.HTML
            ? Object.hasOwn(policy.HTML_GLOBAL_ATTRIBUTES, name) ||
              Object.hasOwn(policy.HTML_ELEMENT_ATTRIBUTES[el.tagName] ?? {}, name) ||
              /^aria-[a-z]+$/.test(name)
            : Object.hasOwn(policy.SVG_ATTRIBUTES, name) || /^aria-[a-z]+$/.test(name);
        if (!known) throw new Error(`attribute ${name} not allowed on <${el.tagName}>`);
        if (name === "style") assertSafeDeclarations(attr.value);
        if (/url\s*\(/i.test(attr.value) && name !== "style") {
          const m = /^url\((#[A-Za-z][A-Za-z0-9_-]*)\)$/.exec(attr.value.trim());
          if (!m) throw new Error(`url() in attribute ${name}`);
        }
      }
      walk(el, ns);
    }
  };
  walk(tree, null);
}

const ALLOWED_AT_RULES = new Set(["media", "supports", "keyframes"]);

function assertSafeCssNodes(ast: csstree.CssNode): void {
  csstree.walk(ast, (node) => {
    switch (node.type) {
      case "Atrule":
        if (!ALLOWED_AT_RULES.has(node.name.toLowerCase()))
          throw new Error(`at-rule @${node.name}`);
        break;
      case "Url":
        if (!ASSET_REF_PATTERN.test(node.value) && !FRAGMENT.test(node.value)) {
          throw new Error(`url(${node.value.slice(0, 40)})`);
        }
        break;
      case "Function":
        if (!policy.CSS_FUNCTIONS.has(node.name.toLowerCase()))
          throw new Error(`function ${node.name}()`);
        break;
      case "Raw":
        if (node.value.trim() !== "") throw new Error(`raw CSS: ${node.value.slice(0, 40)}`);
        break;
      case "Declaration": {
        const p = node.property;
        if (!p.startsWith("--") && !policy.CSS_PROPERTIES.has(p)) throw new Error(`property ${p}`);
        break;
      }
      case "Identifier":
      case "Hash":
      case "Dimension":
        if (JSON.stringify(node).includes("\\\\")) throw new Error("escape sequence in CSS token");
        break;
      case "String":
        if (node.value.includes("<")) throw new Error("< inside a CSS string");
        break;
    }
  });
}

/** Asserts the invariants of sanitized stylesheet text; with `scope`, every style rule must be scoped. */
export function assertSafeCss(css: string, scope?: string): void {
  if (css.includes("</") || css.includes("<!")) throw new Error("markup in CSS output");
  const ast = csstree.parse(css, { parseValue: true, parseCustomProperty: true });
  assertSafeCssNodes(ast);
  if (scope) {
    csstree.walk(ast, {
      visit: "Rule",
      enter(node) {
        // Rules inside @keyframes have keyframe selectors, not element selectors.
        if (this.atrule && this.atrule.name.toLowerCase() === "keyframes") return;
        if (node.prelude.type !== "SelectorList") throw new Error("unparsed selector");
        node.prelude.children.forEach((sel) => {
          const text = csstree.generate(sel);
          if (!text.startsWith(scope)) throw new Error(`unscoped selector ${text}`);
          const rest = text.slice(scope.length);
          if (/^\s*[+~]/.test(rest)) throw new Error(`sibling escape ${text}`);
        });
      },
    });
  }
}

export function assertSafeDeclarations(text: string): void {
  if (text.includes("<")) throw new Error("markup in style attribute");
  const ast = csstree.parse(text, {
    context: "declarationList",
    parseValue: true,
    parseCustomProperty: true,
  });
  assertSafeCssNodes(ast);
}

/** Small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
