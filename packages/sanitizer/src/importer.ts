// SPDX-License-Identifier: AGPL-3.0-or-later
// HTML-artifact importer, pure part (ADR-022): turns a whole HTML document, as an agent writes it in a Claude
// artifact, into the parts of a deck (slides, theme CSS, library URLs, one deck script), best effort and with
// explicit warnings. The document is parsed with parse5 (never with regular expressions). External resources are
// left as URLs: the core vendors them afterwards exactly like any other write, and everything still goes through
// the sanitizer. Nothing here runs or evaluates code.
//
// Slide splitting heuristics, in order (the result says which one was used):
//   1. elements with a `data-slide` attribute (outermost ones);
//   2. elements with the class `slide` (outermost ones; covers `section.slide`, `div.slide`);
//   3. the largest group (at least 2) of sibling `<section>` elements;
//   4. `<h1>`/`<h2>` boundaries among the children of the content root (body, or its only wrapper element);
//   5. a single slide with the whole body.

import { embeddableScript, LIMITS } from "@pptaken/schema";
import * as csstree from "css-tree";
import { type DefaultTreeAdapterTypes, parse, serializeOuter } from "parse5";
import { exceedsNesting } from "./css.js";
import { externalUrlOf, isRelativeUrl, transformCssExternals } from "./external.js";
import { RESERVED_PREFIX, SANITIZER_LIMITS } from "./policy.js";

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type CssNode = any;

/** How the importer splits the body into slides. `auto` tries every heuristic in order. */
export type SplitMode = "auto" | "slides" | "headings" | "single";
/** The heuristic that produced the slides. */
export type SplitHeuristic = "data-slide" | "slide-class" | "sections" | "headings" | "single";

export const IMPORT_WARNING_CODES = [
  "IMPORT_SPLIT",
  "IMPORT_DROPPED_OUTSIDE",
  "IMPORT_NAVIGATION_HANDLERS",
  "IMPORT_INLINE_HANDLERS",
  "IMPORT_HANDLER_DROPPED",
  "IMPORT_MODULE_SCRIPT",
  "IMPORT_DATA_SCRIPT",
  "IMPORT_RELATIVE_URL",
  "IMPORT_TOO_MANY_SLIDES",
  "IMPORT_THEME_CSS_TRIMMED",
  "IMPORT_FIDELITY",
] as const;
export type ImportWarningCode = (typeof IMPORT_WARNING_CODES)[number];

export interface ImportWarning {
  code: ImportWarningCode;
  message: string;
}

/** Why a document cannot be imported at all. */
export class ArtifactImportError extends Error {
  override readonly name = "ArtifactImportError";
  constructor(
    readonly code: "JSX_UNSUPPORTED" | "EMPTY_DOCUMENT" | "TOO_LARGE",
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export interface ArtifactImportOptions {
  split?: SplitMode;
  /** The deck canvas (viewport units are converted to px for it). */
  canvas: { width: number; height: number };
  /** Most slides to produce (the rest are dropped with a warning). */
  maxSlides: number;
}

export interface ArtifactDeck {
  title: string | null;
  lang: string | null;
  heuristic: SplitHeuristic;
  slides: { title: string; html: string }[];
  /** CSS of every `<style>` (and `@import` lines for `<link rel=stylesheet>`), adapted to the deck. */
  themeCss: string;
  /** Classic `<script src>` URLs in document order (vendored into `libs`). */
  libs: string[];
  /** Inline scripts and converted inline handlers, in document order (the deck-level `script`), or null. */
  script: string | null;
  warnings: ImportWarning[];
}

/** Largest document accepted (UTF-16 code units). */
export const MAX_ARTIFACT_HTML = 2 * 1024 * 1024;

const DROP_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "title",
  "base",
  "noscript",
  "template",
]);
const DATA_SCRIPT_TYPES =
  /^(?:application\/(?:ld\+)?json|text\/(?:template|x-template|plain|html))$/;
const CLASSIC_TYPES = new Set(["", "text/javascript", "application/javascript", "text/ecmascript"]);
const JSX_TYPES = new Set(["text/babel", "text/jsx", "text/tsx", "text/typescript"]);
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EVENT = /^on[a-z]{2,30}$/;
const WINDOW_EVENTS = new Set([
  "load",
  "resize",
  "keydown",
  "keyup",
  "keypress",
  "hashchange",
  "beforeunload",
  "unload",
  "pageshow",
]);

function isElement(node: ChildNode): node is Element {
  return (node as Element).tagName !== undefined;
}

function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function classes(el: Element): string[] {
  return (attr(el, "class") ?? "").split(/\s+/).filter((c) => c !== "");
}

function textOf(node: ParentNode): string {
  let out = "";
  const stack: ChildNode[] = [
    ...((node as { childNodes?: ChildNode[] }).childNodes ?? []),
  ].reverse();
  while (stack.length > 0 && out.length < 100_000) {
    const n = stack.pop() as ChildNode;
    if (n.nodeName === "#text") out += (n as TextNode).value;
    else if (isElement(n)) stack.push(...[...n.childNodes].reverse());
  }
  return out;
}

/** Elements in document order (pre-order), with a node budget. */
function elementsOf(root: ParentNode): Element[] {
  const out: Element[] = [];
  const stack: ChildNode[] = [
    ...((root as { childNodes?: ChildNode[] }).childNodes ?? []),
  ].reverse();
  while (stack.length > 0) {
    const n = stack.pop() as ChildNode;
    if (!isElement(n)) continue;
    out.push(n);
    if (out.length > SANITIZER_LIMITS.maxNodes * 4) break;
    stack.push(...[...n.childNodes].reverse());
  }
  return out;
}

function detach(el: Element): void {
  const parent = el.parentNode as { childNodes: ChildNode[] } | null;
  if (parent === null) return;
  const at = parent.childNodes.indexOf(el);
  if (at >= 0) parent.childNodes.splice(at, 1);
  el.parentNode = null;
}

function hasContent(nodes: readonly ChildNode[]): boolean {
  return nodes.some((n) =>
    isElement(n) ? true : n.nodeName === "#text" && (n as TextNode).value.trim() !== "",
  );
}

/** Collapses whitespace and clips a title. */
function cleanTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > LIMITS.maxTitleLength ? `${t.slice(0, LIMITS.maxTitleLength - 1)}…` : t;
}

function outermost(list: Element[]): Element[] {
  const set = new Set(list);
  return list.filter((el) => {
    let p = el.parentNode as Element | null;
    while (p !== null && p.tagName !== undefined) {
      if (set.has(p)) return false;
      p = p.parentNode as Element | null;
    }
    return true;
  });
}

/** Removes hiding declarations (`display:none` and friends) from an inline `style` value. */
function unhideStyle(style: string): string {
  return style
    .split(";")
    .filter((d) => {
      const [prop, ...rest] = d.split(":");
      const p = (prop ?? "").trim().toLowerCase();
      const v = rest
        .join(":")
        .trim()
        .toLowerCase()
        .replace(/\s*!important$/, "");
      return !(
        (p === "display" && v === "none") ||
        (p === "visibility" && v === "hidden") ||
        (p === "opacity" && Number(v) === 0)
      );
    })
    .join(";");
}

// ---------------------------------------------------------------------------------------------------------------
// CSS adaptation

interface CssAdaptation {
  css: string;
  /** Classes that mark the "current" slide in the artifact (`.slide.active`): added to every slide. */
  activeClasses: string[];
}

const ROOT_LIKE = (n: CssNode): boolean =>
  (n.type === "TypeSelector" && /^(?:html|body)$/i.test(String(n.name))) ||
  (n.type === "PseudoClassSelector" && String(n.name).toLowerCase() === "root");

/**
 * Adapts an artifact's stylesheet to the deck: `html`, `body` and `:root` selectors are rewritten to
 * `section[data-slide]` (each slide is the artifact's page), rules that hide inactive slides lose their hiding
 * declarations, and viewport units become canvas pixels. Unparsable CSS is returned unchanged.
 */
export function adaptArtifactCss(
  css: string,
  slideToken: { kind: "class" | "type" | "attribute"; name: string } | null,
  canvas: { width: number; height: number },
): CssAdaptation {
  const active = new Set<string>();
  const vp = transformCssExternals(css, { viewport: canvas });
  const source = vp.css;
  if (exceedsNesting(source, SANITIZER_LIMITS.maxCssNesting))
    return { css: source, activeClasses: [] };
  let ast: CssNode;
  try {
    ast = csstree.parse(source, {
      parseValue: true,
      parseRulePrelude: true,
      parseAtrulePrelude: true,
      positions: false,
    } as csstree.ParseOptions);
  } catch {
    return { css: source, activeClasses: [] };
  }
  const isSlide = (n: CssNode): boolean => {
    if (slideToken === null) return false;
    if (slideToken.kind === "class")
      return n.type === "ClassSelector" && n.name === slideToken.name;
    if (slideToken.kind === "type")
      return n.type === "TypeSelector" && String(n.name).toLowerCase() === slideToken.name;
    return n.type === "AttributeSelector" && n.name?.name === slideToken.name;
  };
  csstree.walk(ast, {
    visit: "Rule",
    enter(rule: CssNode) {
      if (rule.prelude?.type !== "SelectorList") return;
      let targetsSlide = false;
      const rewritten: string[] = [];
      rule.prelude.children.forEach((selector: CssNode) => {
        const nodes: CssNode[] = selector.children.toArray();
        // Compounds and the combinators between them.
        const compounds: CssNode[][] = [[]];
        const combinators: string[] = [];
        for (const n of nodes) {
          if (n.type === "Combinator") {
            combinators.push(String(n.name));
            compounds.push([]);
          } else compounds[compounds.length - 1]?.push(n);
        }
        const last = compounds[compounds.length - 1] ?? [];
        if (last.some(isSlide)) {
          targetsSlide = true;
          for (const n of last) {
            if (n.type === "ClassSelector" && !isSlide(n)) active.add(String(n.name));
            if (n.type === "PseudoClassSelector" && String(n.name).toLowerCase() === "not") {
              csstree.walk(n, {
                visit: "ClassSelector",
                enter(c: CssNode) {
                  active.add(String(c.name));
                },
              });
            }
          }
        }
        let roots = 0;
        while (roots < compounds.length && (compounds[roots] ?? []).some(ROOT_LIKE)) roots++;
        if (roots === 0) {
          rewritten.push(csstree.generate(selector));
          return;
        }
        const extra = compounds
          .slice(0, roots)
          .flat()
          .filter((n) => !ROOT_LIKE(n) && !(n.type === "TypeSelector" && n.name === "*"))
          .map((n) => csstree.generate(n))
          .join("");
        let text = `section[data-slide]${extra}`;
        for (let i = roots; i < compounds.length; i++) {
          const comb = combinators[i - 1] ?? " ";
          text += `${comb === " " ? " " : comb}${(compounds[i] ?? []).map((n) => csstree.generate(n)).join("")}`;
        }
        rewritten.push(text);
      });
      rule.prelude = { type: "Raw", value: rewritten.join(",") };
      if (targetsSlide && rule.block) {
        rule.block.children.forEach((decl: CssNode, item: CssNode, list: CssNode) => {
          if (decl.type !== "Declaration") return;
          const prop = String(decl.property).toLowerCase();
          const value = csstree.generate(decl.value).trim().toLowerCase();
          const hides =
            (prop === "display" && value === "none") ||
            (prop === "visibility" && (value === "hidden" || value === "collapse")) ||
            (prop === "opacity" && Number(value) === 0) ||
            (prop === "pointer-events" && value === "none") ||
            (prop === "transform" && /translate|scale\(\s*0/.test(value));
          if (hides) list.remove(item);
        });
      }
    },
  });
  return { css: csstree.generate(ast), activeClasses: [...active].filter((c) => ID.test(c)) };
}

/** Keeps whole rules from the start of `css` until `max` characters (cut at a top-level rule boundary). */
function trimCss(css: string, max: number): string {
  try {
    const ast = csstree.parse(css, {
      parseValue: false,
      parseRulePrelude: false,
    } as csstree.ParseOptions);
    let out = "";
    for (const node of (ast as CssNode).children.toArray()) {
      const text = csstree.generate(node);
      if (out.length + text.length > max) break;
      out += text;
    }
    return out;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Import

interface Handler {
  target: "window" | string;
  event: string;
  code: string;
}

/**
 * Parses an HTML document and returns the parts of a deck. Throws {@link ArtifactImportError} when the document
 * cannot be imported (JSX/React with a runtime transpiler, empty body, too large).
 */
export function importHtmlArtifact(html: string, options: ArtifactImportOptions): ArtifactDeck {
  if (typeof html !== "string" || html.trim() === "") {
    throw new ArtifactImportError(
      "EMPTY_DOCUMENT",
      "The HTML document is empty",
      "Send the complete HTML document of the artifact.",
    );
  }
  if (html.length > MAX_ARTIFACT_HTML) {
    throw new ArtifactImportError(
      "TOO_LARGE",
      `The HTML document exceeds ${MAX_ARTIFACT_HTML / 1024 / 1024} MB`,
      "Move large images to https URLs (they are vendored) and large libraries to <script src> on a CDN.",
    );
  }
  const warnings: ImportWarning[] = [];
  const warn = (code: ImportWarningCode, message: string) => {
    if (!warnings.some((w) => w.code === code && w.message === message))
      warnings.push({ code, message });
  };
  const doc = parse(html, { scriptingEnabled: true });
  const all = elementsOf(doc);
  const htmlEl = all.find((e) => e.tagName === "html");
  const lang = htmlEl === undefined ? null : (attr(htmlEl, "lang") ?? null);
  const titleEl = all.find((e) => e.tagName === "title");
  const title = titleEl === undefined ? null : cleanTitle(textOf(titleEl)) || null;
  const body = all.find((e) => e.tagName === "body");
  if (body === undefined) {
    throw new ArtifactImportError(
      "EMPTY_DOCUMENT",
      "The document has no body",
      "Send a complete HTML document.",
    );
  }

  // 1. Head and body resources, in document order.
  const cssParts: string[] = [];
  const libs: string[] = [];
  const code: string[] = [];
  const dataBlocks: { id: string; text: string }[] = [];
  let relative = 0;
  for (const el of all) {
    const tag = el.tagName;
    if (tag === "style") {
      cssParts.push(textOf(el));
    } else if (tag === "link") {
      const rel = (attr(el, "rel") ?? "").toLowerCase().split(/\s+/);
      const href = attr(el, "href");
      if (rel.includes("stylesheet") && href !== undefined) {
        const url = externalUrlOf(href);
        if (url !== null) cssParts.push(`@import url(${JSON.stringify(url)});`);
        else if (isRelativeUrl(href)) relative++;
      }
    } else if (tag === "script") {
      const type = (attr(el, "type") ?? "").trim().toLowerCase();
      const src = attr(el, "src");
      const text = textOf(el);
      const jsx =
        JSX_TYPES.has(type) ||
        (src !== undefined &&
          /@babel\/standalone|\/babel(?:\.min)?\.js|babel-standalone/i.test(src));
      if (jsx) {
        throw new ArtifactImportError(
          "JSX_UNSUPPORTED",
          "This artifact needs a runtime JSX/TypeScript transpiler (Babel), which cannot run in a deck",
          "React/JSX artifacts are out of scope. Ask for a plain HTML/CSS/JS version (no JSX, no build step, libraries as UMD <script src> from a CDN) and import that.",
        );
      }
      if (src !== undefined) {
        const url = externalUrlOf(src);
        if (url === null) {
          if (isRelativeUrl(src)) relative++;
        } else if (type === "module") {
          warn(
            "IMPORT_MODULE_SCRIPT",
            `ES module script ${url.slice(0, 120)} cannot be vendored: use the library's UMD/IIFE build instead.`,
          );
        } else if (CLASSIC_TYPES.has(type)) {
          if (!libs.includes(url)) libs.push(url);
        }
      } else if (CLASSIC_TYPES.has(type) || type === "module") {
        if (type === "module" && /(?:^|[\n;])\s*(?:import\s*[\w{*"'(]|export\s)/.test(text)) {
          warn(
            "IMPORT_MODULE_SCRIPT",
            "An inline ES module with import/export statements was skipped: modules cannot be vendored. Use classic scripts and UMD builds.",
          );
        } else if (text.trim() !== "") {
          if (type === "module") {
            warn(
              "IMPORT_MODULE_SCRIPT",
              "An inline module script without imports was kept as a classic script (module scoping and top-level await do not apply).",
            );
          }
          code.push(text);
        }
      } else if (DATA_SCRIPT_TYPES.test(type) || type === "importmap") {
        const id = attr(el, "id");
        if (type !== "importmap" && id !== undefined && ID.test(id)) dataBlocks.push({ id, text });
        else
          warn(
            "IMPORT_DATA_SCRIPT",
            `A <script type="${type.slice(0, 40)}"> data block without a usable id was dropped.`,
          );
      }
    }
  }
  if (relative > 0) {
    warn(
      "IMPORT_RELATIVE_URL",
      `${relative} relative URL(s) cannot be resolved (there is no base) and were dropped: use absolute https URLs.`,
    );
  }
  for (const el of all) if (DROP_TAGS.has(el.tagName)) detach(el);

  // 2. Inline event handlers (on*): converted to addEventListener calls in the deck script.
  const handlers: Handler[] = [];
  const usedIds = new Set(
    all.flatMap((e) => (attr(e, "id") === undefined ? [] : [attr(e, "id") as string])),
  );
  let nextId = 1;
  for (const el of all) {
    const on = el.attrs.filter((a) => EVENT.test(a.name.toLowerCase()));
    if (on.length === 0) continue;
    el.attrs = el.attrs.filter((a) => !EVENT.test(a.name.toLowerCase()));
    const event = (a: { name: string }) => a.name.toLowerCase().slice(2);
    if (el.tagName === "body" || el.tagName === "html") {
      for (const a of on) {
        if (WINDOW_EVENTS.has(event(a)))
          handlers.push({ target: "window", event: event(a), code: a.value });
      }
      continue;
    }
    let id = attr(el, "id");
    if (id === undefined || !ID.test(id) || id.toLowerCase().startsWith(RESERVED_PREFIX)) {
      while (usedIds.has(`imp-on-${nextId}`)) nextId++;
      id = `imp-on-${nextId++}`;
      usedIds.add(id);
      el.attrs = el.attrs.filter((a) => a.name !== "id");
      el.attrs.push({ name: "id", value: id });
    }
    for (const a of on) handlers.push({ target: id, event: event(a), code: a.value });
  }

  // 3. Split the body into slides.
  const mode = options.split ?? "auto";
  let heuristic: SplitHeuristic = "single";
  let slideEls: Element[] = [];
  let token: { kind: "class" | "type" | "attribute"; name: string } | null = null;
  const bodyEls = elementsOf(body);
  if (mode === "auto" || mode === "slides") {
    const data = outermost(bodyEls.filter((e) => attr(e, "data-slide") !== undefined));
    const byClass = outermost(bodyEls.filter((e) => classes(e).includes("slide")));
    if (data.length > 0) {
      heuristic = "data-slide";
      slideEls = data;
      token = { kind: "attribute", name: "data-slide" };
      // Artifacts that mark slides with both usually style the class.
      if (data.every((e) => classes(e).includes("slide"))) token = { kind: "class", name: "slide" };
    } else if (byClass.length > 0) {
      heuristic = "slide-class";
      slideEls = byClass;
      token = { kind: "class", name: "slide" };
    } else {
      let best: Element[] = [];
      for (const parent of [body, ...bodyEls]) {
        const sections = parent.childNodes.filter(
          (n): n is Element => isElement(n) && n.tagName === "section",
        );
        if (sections.length > best.length) best = sections;
      }
      if (best.length >= 2) {
        heuristic = "sections";
        slideEls = best;
        token = { kind: "type", name: "section" };
      }
    }
  }
  let slides: { title: string; html: string }[] = [];
  let outside: ChildNode[] = [];
  if (slideEls.length > 0) {
    const set = new Set(slideEls);
    // Content of the body that is not inside a slide (navigation bars, counters, progress…).
    const keepPath = new Set<Element>();
    for (const s of slideEls) {
      let p = s.parentNode as Element | null;
      while (p !== null && p.tagName !== undefined && p !== body) {
        keepPath.add(p);
        p = p.parentNode as Element | null;
      }
    }
    const collectOutside = (parent: ParentNode) => {
      for (const child of (parent as { childNodes: ChildNode[] }).childNodes) {
        if (isElement(child) && set.has(child)) continue;
        if (isElement(child) && keepPath.has(child)) collectOutside(child);
        else outside.push(child);
      }
    };
    collectOutside(body);
    outside = outside.filter((n) => hasContent([n]));
  } else if (mode !== "single") {
    // Headings: the content root is the body, or its only wrapper element.
    let root: Element = body;
    for (let depth = 0; depth < 5; depth++) {
      const kids = root.childNodes.filter(isElement);
      const only = kids[0];
      if (kids.length !== 1 || only === undefined || /^h[12]$/.test(only.tagName)) break;
      if (hasContent(root.childNodes.filter((n) => !isElement(n)))) break;
      root = only;
    }
    const kids = root.childNodes;
    const headings = kids.filter((n): n is Element => isElement(n) && /^h[12]$/.test(n.tagName));
    if (headings.length >= 2) {
      heuristic = "headings";
      const groups: ChildNode[][] = [[]];
      for (const n of kids) {
        if (
          isElement(n) &&
          /^h[12]$/.test(n.tagName) &&
          hasContent(groups[groups.length - 1] ?? [])
        ) {
          groups.push([]);
        }
        groups[groups.length - 1]?.push(n);
      }
      slides = groups.filter(hasContent).map((group, i) => {
        const html = group.map((n) => serializeOuterNode(n)).join("");
        const heading = group.find((n): n is Element => isElement(n) && /^h[1-3]$/.test(n.tagName));
        return {
          title: cleanTitle(heading === undefined ? "" : textOf(heading)) || `Slide ${i + 1}`,
          html,
        };
      });
    }
  }
  if (slideEls.length === 0 && slides.length === 0) {
    heuristic = "single";
    const html = body.childNodes.map((n) => serializeOuterNode(n)).join("");
    const heading = elementsOf(body).find((e) => /^h[1-3]$/.test(e.tagName));
    slides = [
      {
        title: cleanTitle(heading === undefined ? "" : textOf(heading)) || title || "Slide 1",
        html,
      },
    ];
    warn(
      "IMPORT_FIDELITY",
      'The document was imported as one slide: content taller than the canvas is clipped and nothing scrolls. Mark slides with class="slide" or <section> elements to split it.',
    );
  }

  // 4. CSS adaptation (needs the slide token for the active classes).
  const adapted = adaptArtifactCss(cssParts.join("\n"), token, options.canvas);
  let themeCss = adapted.css;
  if (themeCss.length > LIMITS.maxThemeCss) {
    themeCss = trimCss(themeCss, LIMITS.maxThemeCss);
    warn(
      "IMPORT_THEME_CSS_TRIMMED",
      `The artifact's CSS exceeds ${LIMITS.maxThemeCss / 1024} KB; rules after the limit were dropped.`,
    );
  }
  if (slideEls.length > 0) {
    slides = slideEls.map((el, i) => {
      el.attrs = el.attrs.filter((a) => a.name !== "hidden" && a.name !== "aria-hidden");
      const style = attr(el, "style");
      if (style !== undefined) {
        el.attrs = el.attrs.map((a) =>
          a.name === "style" ? { ...a, value: unhideStyle(style) } : a,
        );
      }
      if (adapted.activeClasses.length > 0) {
        const cls = new Set([...classes(el), ...adapted.activeClasses]);
        el.attrs = el.attrs.filter((a) => a.name !== "class");
        el.attrs.push({ name: "class", value: [...cls].join(" ") });
      }
      const heading = elementsOf(el).find((e) => /^h[1-3]$/.test(e.tagName));
      return {
        title: cleanTitle(heading === undefined ? "" : textOf(heading)) || `Slide ${i + 1}`,
        html: serializeOuter(el),
      };
    });
  }

  // 5. Scripts: inline code, data blocks and handlers form the deck script.
  const hasCode = code.length > 0 || handlers.length > 0;
  const holder: string[] = [];
  if (outside.length > 0) {
    if (hasCode) {
      holder.push(...outside.map((n) => serializeOuterNode(n)));
      warn(
        "IMPORT_DROPPED_OUTSIDE",
        `${outside.length} element(s) outside the slides (navigation, counters…) were kept hidden in the first slide so that the scripts can still find them; the PPTaken player provides navigation.`,
      );
    } else {
      warn(
        "IMPORT_DROPPED_OUTSIDE",
        `${outside.length} element(s) outside the slides (navigation, counters…) were dropped; the PPTaken player provides navigation.`,
      );
    }
  }
  for (const block of dataBlocks) {
    if (hasCode) {
      holder.push(`<div id="${block.id}">${escapeText(block.text)}</div>`);
    }
  }
  if (holder.length > 0 && slides[0] !== undefined) {
    slides[0] = {
      ...slides[0],
      html: `${slides[0].html}<div style="display:none!important" aria-hidden="true">${holder.join("")}</div>`,
    };
  }
  const bindings: string[] = [];
  let dropped = 0;
  for (const h of handlers) {
    const fn = embeddableScript(h.code);
    if (fn === null) {
      dropped++;
      continue;
    }
    const target =
      h.target === "window" ? "window" : `document.getElementById(${JSON.stringify(h.target)})`;
    bindings.push(
      `(function(){var t=${target};if(t)t.addEventListener(${JSON.stringify(h.event)},function(event){\n${fn}\n});})();`,
    );
  }
  if (handlers.length > 0) {
    warn(
      "IMPORT_INLINE_HANDLERS",
      `${handlers.length} inline event handler(s) (onclick=…) were converted to addEventListener calls in the deck script.`,
    );
  }
  if (dropped > 0) {
    warn(
      "IMPORT_HANDLER_DROPPED",
      `${dropped} inline handler(s) could not be embedded and were dropped.`,
    );
  }
  const pieces: string[] = [];
  let unembeddable = 0;
  for (const c of code) {
    const text = embeddableScript(c);
    if (text === null) unembeddable++;
    else pieces.push(text);
  }
  if (unembeddable > 0) {
    warn(
      "IMPORT_HANDLER_DROPPED",
      `${unembeddable} inline script(s) contain NUL or invalid characters and were dropped.`,
    );
  }
  const all_ = [...pieces, ...bindings];
  const script = all_.length === 0 ? null : all_.join("\n;\n");
  if (script !== null && script.length > LIMITS.maxDeckScript) {
    throw new ArtifactImportError(
      "TOO_LARGE",
      `The artifact's inline scripts exceed ${LIMITS.maxDeckScript / 1024} KB`,
      "Load large libraries with <script src> from a CDN (they are vendored as libs) instead of inlining them.",
    );
  }
  if (
    script !== null &&
    /addEventListener\(\s*["']key(?:down|up|press)["']|onkey(?:down|up|press)\s*=/.test(script) &&
    /Arrow(?:Left|Right|Up|Down)|PageDown|PageUp|showSlide|goToSlide|nextSlide|prevSlide/.test(
      script,
    )
  ) {
    warn(
      "IMPORT_NAVIGATION_HANDLERS",
      "The artifact has its own slide navigation (arrow-key handlers, showSlide…). It is kept but the PPTaken player drives navigation; the CSS that hid inactive slides was neutralized, so those handlers cannot hide the current slide. Remove that code if it misbehaves.",
    );
  }
  if (slides.length > options.maxSlides) {
    warn(
      "IMPORT_TOO_MANY_SLIDES",
      `The document has ${slides.length} slides; only the first ${options.maxSlides} were imported.`,
    );
    slides = slides.slice(0, options.maxSlides);
  }
  if (heuristic !== "single") {
    warn("IMPORT_SPLIT", `Split into ${slides.length} slide(s) by ${heuristic}.`);
  }
  return { title, lang, heuristic, slides, themeCss, libs, script, warnings };
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeOuterNode(node: ChildNode): string {
  if (isElement(node)) return serializeOuter(node);
  if (node.nodeName === "#text") return escapeText((node as TextNode).value);
  return "";
}
