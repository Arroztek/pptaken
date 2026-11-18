// SPDX-License-Identifier: AGPL-3.0-or-later
// Ingest-time vendoring, pure part (ADR-022): finds the external resources a slide's HTML or a stylesheet refers to
// and rewrites them to `asset:<sha256>` references once the server has fetched and stored them. Parsing is done
// with parse5 and css-tree, never with regular expressions over markup. Nothing here touches the network: the core
// orchestrates the fetches through a port and calls these functions twice (scan, then rewrite with the results).
// The output still goes through the normal sanitizer afterwards; this module only moves URLs, it never decides what
// is safe to render.

import { FONT_FAMILY_PATTERN, FONT_WEIGHT_PATTERN, UNICODE_RANGE_PATTERN } from "@pptaken/schema";
import * as csstree from "css-tree";
import { type DefaultTreeAdapterTypes, parseFragment, serialize } from "parse5";
import { exceedsNesting } from "./css.js";
import { contextElement, precheckCost } from "./html.js";
import { SANITIZER_LIMITS } from "./policy.js";

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
// css-tree nodes: a large union; fields are read only after checking `type`.
type CssNode = any;

/** The WHATWG URL parser (a global in Node and browsers; this package compiles without DOM or Node types). */
interface ParsedUrl {
  protocol: string;
  hash: string;
  href: string;
  pathname: string;
}
const URL = (globalThis as unknown as { URL: new (input: string, base?: string) => ParsedUrl }).URL;

/** What an external resource is used as. */
export type ExternalKind = "script" | "stylesheet" | "font" | "image";

/** One external resource found in content. `url` is absolute (https, or http to be refused later). */
export interface ExternalRef {
  kind: ExternalKind;
  url: string;
}

/** A reference to something that cannot be vendored (video, iframe, ES moduleâ€¦), with the reason. */
export interface UnsupportedRef {
  /** Element or construct, e.g. `video`, `iframe`, `script type=module`. */
  what: string;
  url: string | null;
  message: string;
}

/**
 * Resolves a URL as written in content to an absolute http(s) URL, or `null` when it is not external (an `asset:`
 * reference, a fragment, `data:`, a relative URL without a base, another scheme). Protocol-relative URLs
 * (`//cdn.example/x.js`) become https.
 */
export function externalUrlOf(raw: string, base?: string): string | null {
  const text = raw.trim();
  if (text === "" || text.length > 2048) return null;
  if (/^(?:asset:|#|data:|blob:|javascript:|about:)/i.test(text)) return null;
  const candidate = text.startsWith("//") ? `https:${text}` : text;
  let url: ParsedUrl;
  try {
    url = base === undefined ? new URL(candidate) : new URL(candidate, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.hash = "";
  return url.href;
}

/** True for a URL that names a resource outside the instance but is not resolvable (relative, no base). */
export function isRelativeUrl(raw: string): boolean {
  const text = raw.trim();
  if (text === "" || /^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith("//")) return false;
  return !text.startsWith("#");
}

/** `asset:` reference of a stored resource, or `null` when it could not be vendored (the reference is dropped). */
export type ExternalResolver = (kind: ExternalKind, url: string) => string | null;

// ---------------------------------------------------------------------------------------------------------------
// HTML

const UNSUPPORTED_ELEMENTS: Record<string, string> = {
  video:
    "Video is not supported in slides; use a poster image (an <img> with an https URL is vendored) or link it in the notes.",
  audio: "Audio is not supported in slides; mention it in the speaker notes.",
  iframe:
    "Embedded pages (iframe) cannot work: slides have no network. Use a screenshot image instead.",
  embed: "Embedded content (embed) cannot work: slides have no network. Use an image instead.",
  object: "Embedded content (object) cannot work: slides have no network. Use an image instead.",
  track: "Media tracks are not supported.",
  portal: "Embedded pages cannot work: slides have no network.",
};

export interface HtmlExternals {
  /** The rewritten HTML (unchanged when nothing external was found or no resolver was given). */
  html: string;
  /** Images (`img`, `picture source`, SVG `image`) and CSS `url()` in `style` attributes. */
  refs: ExternalRef[];
  /** `<link rel=stylesheet href>` URLs, in document order. The elements are removed by a rewrite. */
  stylesheets: string[];
  /** `<script src>` URLs (classic scripts), in document order. The elements are removed by a rewrite. */
  scripts: string[];
  unsupported: UnsupportedRef[];
  /** Count of relative URLs that cannot be resolved (no base): they are dropped by the sanitizer. */
  relative: number;
}

function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name && a.prefix === undefined)?.value ?? undefined;
}

function hrefOf(el: Element): string | undefined {
  return el.attrs.find((a) => a.name === "href")?.value;
}

function setAttr(el: Element, name: string, value: string): void {
  const existing = el.attrs.find((a) => a.name === name && a.prefix === undefined);
  if (existing) existing.value = value;
  else el.attrs.push({ name, value });
}

function removeAttr(el: Element, name: string): void {
  el.attrs = el.attrs.filter((a) => !(a.name === name && a.prefix === undefined));
}

/** Picks the largest candidate of a `srcset` value (by `w`, then `x` descriptor; else the first). */
export function bestSrcsetCandidate(srcset: string): string | null {
  let best: { url: string; score: number } | null = null;
  for (const part of srcset.split(/,(?=\s|[^,]*\s)|,\s*/)) {
    const tokens = part.trim().split(/\s+/);
    const url = tokens[0];
    if (url === undefined || url === "") continue;
    const descriptor = tokens[1] ?? "1x";
    const m = /^(\d+(?:\.\d+)?)([wx])$/.exec(descriptor);
    const score = m === null ? 1 : Number(m[1]) * (m[2] === "w" ? 1 : 1000);
    if (best === null || score > best.score) best = { url, score };
  }
  return best?.url ?? null;
}

function isElement(node: ChildNode): node is Element {
  return (node as Element).tagName !== undefined;
}

function walkElements(parent: ParentNode, visit: (el: Element) => void): void {
  const stack: ParentNode[] = [parent];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop() as ParentNode;
    const children = (node as { childNodes?: ChildNode[] }).childNodes ?? [];
    for (const child of children) {
      if (!isElement(child)) continue;
      if (++count > SANITIZER_LIMITS.maxNodes) return;
      visit(child);
      stack.push(child);
      const content = (child as unknown as { content?: ParentNode }).content;
      if (content !== undefined) stack.push(content);
    }
  }
}

/**
 * Finds the external resources of a slide's HTML fragment and, with a `resolve` function, rewrites them: images
 * become `asset:` references (or lose their source when `resolve` returns null), `srcset` collapses to the largest
 * candidate, `<link rel=stylesheet>` and `<script src>` elements are removed (the caller vendors them into CSS and
 * `libs`), and other `<link>` elements (preconnect, preload, icons) are dropped silently.
 */
export function transformHtmlExternals(input: string, resolve?: ExternalResolver): HtmlExternals {
  const result: HtmlExternals = {
    html: input,
    refs: [],
    stylesheets: [],
    scripts: [],
    unsupported: [],
    relative: 0,
  };
  if (typeof input !== "string" || input.length > SANITIZER_LIMITS.maxHtmlLength) return result;
  // Fast path: no URL-bearing construct at all.
  if (!/(?:https?:)?\/\/|<link|<script|<video|<audio|<iframe|<embed|<object/i.test(input)) {
    return result;
  }
  // The same cost guard as the sanitizer, before parse5 sees hostile input; on failure leave it to the sanitizer
  // (which fails closed on the same input).
  try {
    precheckCost(input);
  } catch {
    return result;
  }
  const fragment = parseFragment(contextElement(), input, { scriptingEnabled: true });
  let changed = false;
  const toRemove: Element[] = [];
  const image = (raw: string | undefined, apply: (value: string | null) => void) => {
    if (raw === undefined) return;
    const url = externalUrlOf(raw);
    if (url === null) {
      if (isRelativeUrl(raw)) result.relative++;
      return;
    }
    result.refs.push({ kind: "image", url });
    if (resolve !== undefined) {
      apply(resolve("image", url));
      changed = true;
    }
  };
  walkElements(fragment, (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag in UNSUPPORTED_ELEMENTS) {
      const src = attr(el, "src") ?? attr(el, "data") ?? null;
      result.unsupported.push({
        what: tag,
        url: src === null ? null : externalUrlOf(src),
        message: UNSUPPORTED_ELEMENTS[tag] as string,
      });
      return;
    }
    if (tag === "link") {
      const rel = (attr(el, "rel") ?? "").toLowerCase().split(/\s+/);
      const href = hrefOf(el);
      const url = href === undefined ? null : externalUrlOf(href);
      if (rel.includes("stylesheet") && url !== null) result.stylesheets.push(url);
      toRemove.push(el);
      return;
    }
    if (tag === "script") {
      const src = attr(el, "src");
      if (src === undefined) return; // inline: the sanitizer removes it with a warning that points to `script`
      const url = externalUrlOf(src);
      const type = (attr(el, "type") ?? "").trim().toLowerCase();
      if (url === null) {
        if (isRelativeUrl(src)) result.relative++;
      } else if (type === "module") {
        result.unsupported.push({
          what: "script type=module",
          url,
          message:
            "ES modules cannot be vendored: use the library's UMD/IIFE build (for example the .umd.js or .min.js file on jsDelivr/unpkg/cdnjs) in libs.",
        });
      } else {
        result.scripts.push(url);
      }
      toRemove.push(el);
      return;
    }
    if (tag === "img") {
      const srcset = attr(el, "srcset");
      if (srcset !== undefined) {
        const best = bestSrcsetCandidate(srcset);
        if (best !== null && attr(el, "src") === undefined) setAttr(el, "src", best);
        if (resolve !== undefined) {
          removeAttr(el, "srcset");
          changed = true;
        }
      }
      image(attr(el, "src"), (v) => (v === null ? removeAttr(el, "src") : setAttr(el, "src", v)));
    } else if (tag === "picture") {
      // Visited before its children: give the <img> the first <source> when it has no src of its own; the
      // <source> elements are removed (the sanitizer would drop them anyway).
      const children = el.childNodes.filter(isElement);
      const img = children.find((n) => n.tagName === "img");
      for (const source of children.filter((n) => n.tagName === "source")) {
        const raw = attr(source, "srcset") ?? attr(source, "src");
        if (raw !== undefined && img !== undefined && attr(img, "src") === undefined) {
          const best = bestSrcsetCandidate(raw);
          if (best !== null) setAttr(img, "src", best);
        }
        toRemove.push(source);
      }
    } else if (tag === "image") {
      const href = el.attrs.find((a) => a.name === "href");
      if (href !== undefined) {
        image(href.value, (v) => {
          if (v === null) el.attrs = el.attrs.filter((a) => a !== href);
          else href.value = v;
        });
      }
    }
    const style = attr(el, "style");
    if (style !== undefined && /url\s*\(/i.test(style)) {
      const css = transformCssExternals(style, {
        context: "declarationList",
        ...(resolve === undefined ? {} : { resolve }),
      });
      for (const ref of css.urls) result.refs.push(ref);
      result.relative += css.relative;
      if (resolve !== undefined && css.css !== style) {
        setAttr(el, "style", css.css);
        changed = true;
      }
    }
  });
  if (resolve !== undefined && (changed || toRemove.length > 0)) {
    for (const el of toRemove) {
      const parent = el.parentNode as ParentNode | null;
      if (parent === null) continue;
      const list = (parent as { childNodes: ChildNode[] }).childNodes;
      const at = list.indexOf(el);
      if (at >= 0) list.splice(at, 1);
    }
    result.html = serialize(fragment);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// CSS

/** An `@font-face` rule found in a stylesheet, with its sources in order of preference. */
export interface ExtractedFontFace {
  family: string;
  /** Candidate files, best format first (woff2, woff, truetype, opentype). */
  sources: { url: string; format: "woff2" | "woff" | "truetype" | "opentype" }[];
  weight?: string;
  style?: "normal" | "italic" | "oblique";
  unicodeRange?: string;
}

export interface CssExternalsOptions {
  /** Parse as a stylesheet (default) or as a `style` attribute. */
  context?: "stylesheet" | "declarationList";
  /** Base URL to resolve relative `url()` and `@import` (a fetched stylesheet's own URL). */
  base?: string;
  /** Rewrites `url()` values; `null` leaves the URL in place (the sanitizer then removes the declaration). */
  resolve?: ExternalResolver;
  /** Removes `@font-face` rules from the output (they are returned in `fontFaces`). */
  extractFontFaces?: boolean;
  /**
   * Replaces `@import` rules: the CSS to put in place of an imported URL (already processed), `""` to drop the
   * rule. Imports not in the map stay as they are (the sanitizer removes them).
   */
  imports?: ReadonlyMap<string, string>;
  /** Converts viewport units (vw, vh, vmin, vmax and their s/l/d variants) to px for this canvas (importer). */
  viewport?: { width: number; height: number };
}

export interface CssExternals {
  css: string;
  /** `@import` URLs, in order. */
  imports: string[];
  /** `url()` references outside `@font-face` (images). */
  urls: ExternalRef[];
  fontFaces: ExtractedFontFace[];
  /** `@font-face` rules that could not be used (invalid family, no usable source). */
  skippedFontFaces: number;
  relative: number;
  /** True when the text could not be parsed (it is returned unchanged). */
  unparsable: boolean;
}

const FORMAT_RANK = { woff2: 0, woff: 1, truetype: 2, opentype: 3 } as const;
type FontFormat = keyof typeof FORMAT_RANK;

function formatOf(declared: string | null, url: string): FontFormat | null {
  const d = (declared ?? "").toLowerCase();
  if (d === "woff2" || d === "woff") return d;
  if (d === "truetype" || d === "ttf") return "truetype";
  if (d === "opentype" || d === "otf") return "opentype";
  if (d !== "") return null; // embedded-opentype, svg, collectionâ€¦: not used
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (path.endsWith(".woff2")) return "woff2";
  if (path.endsWith(".woff")) return "woff";
  if (path.endsWith(".ttf")) return "truetype";
  if (path.endsWith(".otf")) return "opentype";
  return null;
}

const VIEWPORT_UNITS = /^(?:[sld]?v(?:w|h|min|max|i|b))$/i;

function viewportPx(value: number, unit: string, vp: { width: number; height: number }): number {
  const u = unit.toLowerCase().replace(/^[sld]/, "");
  const base =
    u === "vw" || u === "vi"
      ? vp.width
      : u === "vh" || u === "vb"
        ? vp.height
        : u === "vmin"
          ? Math.min(vp.width, vp.height)
          : Math.max(vp.width, vp.height);
  return Math.round(((value * base) / 100) * 100) / 100;
}

function stringOrUrl(node: CssNode): string | null {
  if (node?.type === "String") return String(node.value);
  if (node?.type === "Url") return String(node.value);
  return null;
}

function fontFaceOf(block: CssNode, base: string | undefined): ExtractedFontFace | null {
  let family: string | null = null;
  const sources: ExtractedFontFace["sources"] = [];
  const face: Partial<ExtractedFontFace> = {};
  block.children.forEach((decl: CssNode) => {
    if (decl.type !== "Declaration") return;
    const prop = String(decl.property).toLowerCase();
    const value = decl.value;
    const text = csstree.generate(value).trim();
    if (prop === "font-family") {
      const items = value.type === "Value" ? value.children.toArray() : [];
      const first = items.find((n: CssNode) => n.type !== "WhiteSpace");
      if (first?.type === "String") family = String(first.value);
      else
        family = items
          .filter((n: CssNode) => n.type === "Identifier")
          .map((n: CssNode) => String(n.name))
          .join(" ");
    } else if (prop === "src" && value.type === "Value") {
      let url: string | null = null;
      let format: string | null = null;
      let local = false;
      const flush = () => {
        if (url !== null && !local) {
          const abs = externalUrlOf(url, base);
          const fmt = abs === null ? null : formatOf(format, abs);
          if (abs !== null && fmt !== null) sources.push({ url: abs, format: fmt });
        }
        url = null;
        format = null;
        local = false;
      };
      value.children.forEach((n: CssNode) => {
        if (n.type === "Operator" && String(n.value).trim() === ",") flush();
        else if (n.type === "Url") url = String(n.value);
        else if (n.type === "Function") {
          const name = String(n.name).toLowerCase();
          if (name === "local") local = true;
          else if (name === "format") {
            const arg = n.children.toArray().find((c: CssNode) => c.type !== "WhiteSpace");
            format = stringOrUrl(arg) ?? (arg?.type === "Identifier" ? String(arg.name) : null);
          } else if (name === "url") {
            const arg = n.children.toArray().find((c: CssNode) => c.type !== "WhiteSpace");
            url = stringOrUrl(arg);
          }
        }
      });
      flush();
    } else if (prop === "font-weight") {
      const w = text.toLowerCase().replace(/\s+/g, " ");
      const mapped = w === "normal" ? "400" : w === "bold" ? "700" : w;
      if (FONT_WEIGHT_PATTERN.test(mapped)) face.weight = mapped;
    } else if (prop === "font-style") {
      const s = text.toLowerCase();
      if (s === "normal" || s === "italic") face.style = s;
      else if (s.startsWith("oblique")) face.style = "oblique";
    } else if (prop === "unicode-range") {
      const r = text
        .replace(/\s*,\s*/g, ", ")
        .toUpperCase()
        .replace(/^U\+/, "U+");
      if (r.length <= 4000 && UNICODE_RANGE_PATTERN.test(r)) face.unicodeRange = r;
    }
  });
  const name = (family ?? "").trim();
  if (!FONT_FAMILY_PATTERN.test(name) || sources.length === 0) return null;
  sources.sort((a, b) => FORMAT_RANK[a.format] - FORMAT_RANK[b.format]);
  return { family: name, sources, ...face };
}

/**
 * Finds the external resources of CSS (`@import`, `url()`, `@font-face` sources) and, with options, rewrites it:
 * `url()` through `resolve`, `@import` rules from `imports`, `@font-face` rules extracted, viewport units to px.
 * Unparsable or too deeply nested CSS is returned unchanged with `unparsable: true` (the sanitizer then decides).
 */
export function transformCssExternals(
  input: string,
  options: CssExternalsOptions = {},
): CssExternals {
  const out: CssExternals = {
    css: input,
    imports: [],
    urls: [],
    fontFaces: [],
    skippedFontFaces: 0,
    relative: 0,
    unparsable: false,
  };
  if (typeof input !== "string") return out;
  const needsWork =
    /url\s*\(|@import|@font-face/i.test(input) ||
    (options.viewport !== undefined && /\d(?:[sld]?v(?:w|h|min|max|i|b))\b/i.test(input));
  if (!needsWork) return out;
  if (exceedsNesting(input, SANITIZER_LIMITS.maxCssNesting)) {
    out.unparsable = true;
    return out;
  }
  let ast: CssNode;
  try {
    ast = csstree.parse(input, {
      context: options.context ?? "stylesheet",
      parseValue: true,
      parseCustomProperty: true,
      parseAtrulePrelude: true,
      parseRulePrelude: false,
      positions: false,
    } as csstree.ParseOptions);
  } catch {
    out.unparsable = true;
    return out;
  }
  let changed = false;
  const base = options.base;
  csstree.walk(ast, {
    enter(node: CssNode, item: CssNode, list: CssNode) {
      if (node.type === "Atrule") {
        const name = String(node.name).toLowerCase();
        if (name === "import") {
          const first = node.prelude?.children
            ?.toArray?.()
            .find((n: CssNode) => n.type !== "WhiteSpace");
          const raw = stringOrUrl(first);
          const url = raw === null ? null : externalUrlOf(raw, base);
          if (url !== null) {
            out.imports.push(url);
            const replacement = options.imports?.get(url);
            if (replacement !== undefined && list !== null && item !== null) {
              if (replacement !== "") {
                list.insert(list.createItem({ type: "Raw", value: replacement }), item);
              }
              list.remove(item);
              changed = true;
            }
          } else if (raw !== null && isRelativeUrl(raw)) out.relative++;
          return csstree.walk.skip;
        }
        if (name === "font-face" && node.block) {
          const face = fontFaceOf(node.block, base);
          if (face === null) out.skippedFontFaces++;
          else out.fontFaces.push(face);
          if (options.extractFontFaces === true && list !== null && item !== null) {
            list.remove(item);
            changed = true;
          }
          return csstree.walk.skip;
        }
      }
      if (node.type === "Url") {
        const raw = String(node.value);
        const url = externalUrlOf(raw, base);
        if (url === null) {
          if (isRelativeUrl(raw)) out.relative++;
          return;
        }
        out.urls.push({ kind: "image", url });
        if (options.resolve !== undefined) {
          const ref = options.resolve("image", url);
          // An unresolved URL stays absolute: the sanitizer removes the declaration with a REMOVED_URL warning.
          node.value = ref ?? url;
          changed = true;
        } else if (base !== undefined && url !== raw) {
          node.value = url;
          changed = true;
        }
        return;
      }
      if (node.type === "Dimension" && options.viewport !== undefined) {
        if (VIEWPORT_UNITS.test(String(node.unit))) {
          const px = viewportPx(Number(node.value), String(node.unit), options.viewport);
          if (Number.isFinite(px)) {
            node.value = String(px);
            node.unit = "px";
            changed = true;
          }
        }
      }
    },
  });
  if (changed) out.css = csstree.generate(ast);
  return out;
}

/** True for a font format the vendoring stage stores (woff2, woff, truetype, opentype). */
export function isVendorableFontFormat(format: string): format is FontFormat {
  return Object.hasOwn(FORMAT_RANK, format);
}
