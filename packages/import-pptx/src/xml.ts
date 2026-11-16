// SPDX-License-Identifier: AGPL-3.0-or-later
// Safe XML parsing for the parts of a .pptx package. Every part is hostile:
// - a part containing `<!DOCTYPE` or `<!ENTITY` is refused before parsing (no DTD, so no entity expansion, no
//   "billion laughs", no external entities);
// - the parser is `saxes` (non-validating, never fetches anything, does not expand DTD entities);
// - the input must be valid UTF-8 (or UTF-16 with a BOM, which PowerPoint never writes but the format allows);
// - element depth, element count and text size are capped, so a part cannot exhaust memory or the stack later.
// The result is a small immutable tree with namespace URIs mapped to the canonical OOXML prefixes, so documents
// written with unusual prefixes (or the "Strict" namespaces) read the same as PowerPoint's.

import { SaxesParser } from "saxes";

export class XmlError extends Error {
  override readonly name = "XmlError";
}

export interface XmlElement {
  /** Canonical qualified name, e.g. `p:sp`, `a:t`. Unknown namespaces become `x:<local>`. */
  readonly name: string;
  /** Attributes by canonical qualified name (`r:id`, `type`...). */
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** Concatenated text directly inside this element (not its descendants). */
  readonly text: string;
}

export interface XmlLimits {
  maxDepth: number;
  maxElements: number;
  maxTextChars: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxDepth: 256,
  maxElements: 400_000,
  maxTextChars: 8 * 1024 * 1024,
};

const NAMESPACES: Record<string, string> = {
  "http://schemas.openxmlformats.org/presentationml/2006/main": "p",
  "http://purl.oclc.org/ooxml/presentationml/main": "p",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
  "http://purl.oclc.org/ooxml/drawingml/main": "a",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
  "http://purl.oclc.org/ooxml/officeDocument/relationships": "r",
  "http://schemas.openxmlformats.org/package/2006/relationships": "rel",
  "http://schemas.openxmlformats.org/package/2006/content-types": "ct",
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties": "cp",
  "http://purl.org/dc/elements/1.1/": "dc",
  "http://schemas.openxmlformats.org/markup-compatibility/2006": "mc",
  "http://schemas.microsoft.com/office/powerpoint/2010/main": "p14",
  "http://schemas.microsoft.com/office/powerpoint/2012/main": "p15",
  "http://schemas.openxmlformats.org/drawingml/2006/chart": "c",
  "http://schemas.openxmlformats.org/drawingml/2006/diagram": "dgm",
  "http://schemas.openxmlformats.org/drawingml/2006/picture": "pic",
  "http://schemas.microsoft.com/office/drawing/2010/main": "a14",
};

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF16LE = new TextDecoder("utf-16le", { fatal: true });
const UTF16BE = new TextDecoder("utf-16be", { fatal: true });

/** Decodes a part as text; throws {@link XmlError} on malformed encodings. */
export function decodeXml(bytes: Uint8Array): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return UTF16LE.decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return UTF16BE.decode(bytes.subarray(2));
    const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    return UTF8.decode(bytes.subarray(start));
  } catch {
    throw new XmlError("is not valid UTF-8 text");
  }
}

interface Building {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string[];
}

function canonical(uri: string | undefined, prefix: string, local: string): string {
  if (uri === undefined || uri === "") return prefix === "" ? local : `x:${local}`;
  const mapped = NAMESPACES[uri];
  return `${mapped ?? "x"}:${local}`;
}

/** Parses one part into a tree. Throws {@link XmlError} with a short, safe reason. */
export function parseXml(bytes: Uint8Array, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlElement {
  const source = decodeXml(bytes);
  // No DTD at all: refuses entity declarations (internal or external) before the parser sees them.
  if (/<!DOCTYPE/i.test(source) || /<!ENTITY/i.test(source)) {
    throw new XmlError("contains a DOCTYPE or ENTITY declaration, which is not allowed");
  }
  const parser = new SaxesParser({ xmlns: true, position: false });
  const stack: Building[] = [];
  let root: XmlElement | null = null;
  let elements = 0;
  let textChars = 0;
  let failure: string | null = null;

  parser.on("error", (error) => {
    failure ??= error.message.slice(0, 120);
  });
  parser.on("doctype", () => {
    failure ??= "contains a DOCTYPE";
  });
  parser.on("opentag", (tag) => {
    if (failure !== null) return;
    elements++;
    if (elements > limits.maxElements) {
      failure = "has too many elements";
      return;
    }
    if (stack.length >= limits.maxDepth) {
      failure = "is nested too deeply";
      return;
    }
    const attrs: Record<string, string> = Object.create(null);
    for (const attr of Object.values(tag.attributes)) {
      if (attr.prefix === "xmlns" || attr.name === "xmlns") continue;
      attrs[canonical(attr.uri, attr.prefix, attr.local)] = attr.value;
    }
    stack.push({ name: canonical(tag.uri, tag.prefix, tag.local), attrs, children: [], text: [] });
  });
  const onText = (text: string) => {
    if (failure !== null) return;
    const top = stack[stack.length - 1];
    if (top === undefined) return;
    textChars += text.length;
    if (textChars > limits.maxTextChars) {
      failure = "has too much text";
      return;
    }
    top.text.push(text);
  };
  parser.on("text", onText);
  parser.on("cdata", onText);
  parser.on("closetag", () => {
    if (failure !== null) return;
    const done = stack.pop();
    if (done === undefined) return;
    const element: XmlElement = {
      name: done.name,
      attrs: done.attrs,
      children: done.children,
      text: done.text.join(""),
    };
    const parent = stack[stack.length - 1];
    if (parent === undefined) root = element;
    else parent.children.push(element);
  });

  try {
    parser.write(source).close();
  } catch (error) {
    failure ??= error instanceof Error ? error.message.slice(0, 120) : "is not well-formed XML";
  }
  if (failure !== null) throw new XmlError(failure);
  if (root === null) throw new XmlError("has no root element");
  return root;
}

// ---------------------------------------------------------------------------------------------------------------
// Navigation helpers (all tolerate missing nodes).

export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  if (el === undefined) return undefined;
  for (const c of el.children) if (c.name === name) return c;
  return undefined;
}

export function children(el: XmlElement | undefined, name: string): XmlElement[] {
  if (el === undefined) return [];
  return el.children.filter((c) => c.name === name);
}

/** Follows a path of child names. */
export function path(el: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
  let at = el;
  for (const n of names) at = child(at, n);
  return at;
}

/** Depth-first search for the first descendant with this name (bounded by the tree, which is bounded). */
export function find(el: XmlElement | undefined, name: string): XmlElement | undefined {
  if (el === undefined) return undefined;
  const stack: XmlElement[] = [...el.children].reverse();
  while (stack.length > 0) {
    const at = stack.pop() as XmlElement;
    if (at.name === name) return at;
    for (let i = at.children.length - 1; i >= 0; i--) stack.push(at.children[i] as XmlElement);
  }
  return undefined;
}

export function findAll(el: XmlElement | undefined, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  if (el === undefined) return out;
  const stack: XmlElement[] = [...el.children].reverse();
  while (stack.length > 0) {
    const at = stack.pop() as XmlElement;
    if (at.name === name) out.push(at);
    for (let i = at.children.length - 1; i >= 0; i--) stack.push(at.children[i] as XmlElement);
  }
  return out;
}

export function attr(el: XmlElement | undefined, name: string): string | undefined {
  return el?.attrs[name];
}

/** Integer attribute, or the fallback when absent or not a finite integer. */
export function intAttr(el: XmlElement | undefined, name: string, fallback: number): number;
export function intAttr(
  el: XmlElement | undefined,
  name: string,
  fallback?: undefined,
): number | undefined;
export function intAttr(
  el: XmlElement | undefined,
  name: string,
  fallback?: number,
): number | undefined {
  const v = el?.attrs[name];
  if (v === undefined || !/^-?\d{1,15}$/.test(v.trim())) return fallback;
  return Number(v.trim());
}

export function boolAttr(el: XmlElement | undefined, name: string): boolean | undefined {
  const v = el?.attrs[name];
  if (v === undefined) return undefined;
  return v === "1" || v === "true" || v === "on";
}

/**
 * Resolves `mc:AlternateContent` blocks: takes the `mc:Fallback` (the representation every consumer understands)
 * or, without one, the first `mc:Choice`. Returns the element list with the blocks replaced by their content.
 */
export function resolveAlternates(list: readonly XmlElement[]): XmlElement[] {
  const out: XmlElement[] = [];
  for (const el of list) {
    if (el.name !== "mc:AlternateContent") {
      out.push(el);
      continue;
    }
    const chosen = child(el, "mc:Fallback") ?? child(el, "mc:Choice");
    if (chosen !== undefined) out.push(...resolveAlternates(chosen.children));
  }
  return out;
}
