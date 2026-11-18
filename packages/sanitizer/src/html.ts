// SPDX-License-Identifier: AGPL-3.0-or-later
// HTML/SVG sanitizing: the input is parsed with parse5 (the WHATWG parsing algorithm, the same one browsers use)
// as the children of a <section>, a brand-new tree is built from allowlisted nodes only, and it is serialized
// with parse5. The output is then re-parsed and re-sanitized until it is a fixed point (mutation-XSS defense).

import { ASSET_REF_PATTERN } from "@pptaken/schema";
import {
  type DefaultTreeAdapterTypes,
  defaultTreeAdapter,
  html,
  parseFragment,
  serialize,
} from "parse5";
import { parseCssValue, sanitizeStyleAttribute, sanitizeValueFor } from "./css.js";
import {
  ARIA_ROLES,
  type AttributeKind,
  CLOBBER_DENYLIST,
  DATA_ATTRIBUTE_NAME,
  HTML_DROP_WITH_CONTENT,
  HTML_ELEMENT_ATTRIBUTES,
  HTML_ELEMENTS,
  HTML_GLOBAL_ATTRIBUTES,
  INTERACTIVE_BUTTON_TYPES,
  INTERACTIVE_ELEMENT_ATTRIBUTES,
  INTERACTIVE_HTML_ELEMENTS,
  INTERACTIVE_INPUT_TYPES,
  RESERVED_DATA_ATTRIBUTES,
  RESERVED_PREFIX,
  SANITIZER_LIMITS,
  type SanitizerProfile,
  SVG_ASSET_HREF_ELEMENTS,
  SVG_ATTRIBUTES,
  SVG_ELEMENTS,
  SVG_ENUM_VALUES,
  SVG_HREF_ELEMENTS,
  SVG_TEXT_ONLY,
  SVG_UNWRAP,
} from "./policy.js";
import { type Warning, WarningCollector } from "./warnings.js";

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Attribute = Element["attrs"][number];

const NS = html.NS;
const adapter = defaultTreeAdapter;

export interface HtmlOptions {
  /** Warning `path` to attach, e.g. `slides[2].html`. */
  path?: string;
  /** Size limit in UTF-16 code units. Defaults to the schema limit for slide HTML. */
  maxLength?: number;
  /**
   * `safe` (default) or `interactive` (decks with owner-approved author scripts, ADR-020): the latter also keeps
   * canvas, buttons, range/number/checkbox inputs, selects, labels, outputs, progress bars, meters and `data-*`.
   */
  profile?: SanitizerProfile;
}

export interface HtmlResult {
  html: string;
  warnings: Warning[];
}

class FailClosed extends Error {
  constructor(
    readonly code: "LIMIT_EXCEEDED" | "INTERNAL_ERROR",
    message: string,
  ) {
    super(message);
  }
}

/** Sanitizes the HTML of one slide. Never throws; on pathological input returns `""` and a warning. */
export function sanitizeSlideHtml(input: string, options: HtmlOptions = {}): HtmlResult {
  const w = new WarningCollector(options.path);
  const maxLength = options.maxLength ?? SANITIZER_LIMITS.maxHtmlLength;
  if (typeof input !== "string") {
    w.add("INTERNAL_ERROR", "HTML must be a string");
    return { html: "", warnings: w.result() };
  }
  if (input.length > maxLength) {
    w.add("INPUT_TOO_LARGE", `HTML exceeds ${maxLength} characters and was removed`);
    return { html: "", warnings: w.result() };
  }
  try {
    const profile: SanitizerProfile = options.profile === "interactive" ? "interactive" : "safe";
    let current = sanitizeOnce(input, w, profile);
    // The serialized output must re-parse into exactly the tree we built. If a second pass changes anything,
    // keep the re-sanitized result; if it still does not converge, fail closed.
    let stable = false;
    for (let pass = 0; pass < 2 && !stable; pass++) {
      const extra = new WarningCollector(options.path);
      const next = sanitizeOnce(current, extra, profile);
      stable = next === current;
      if (!stable) w.merge(extra);
      current = next;
    }
    if (!stable) {
      w.reset();
      w.add("UNSTABLE_OUTPUT", "HTML did not survive re-parsing unchanged and was removed");
      return { html: "", warnings: w.result() };
    }
    return { html: current, warnings: w.result() };
  } catch (error) {
    w.reset();
    if (error instanceof FailClosed) w.add(error.code, error.message);
    else w.add("INTERNAL_ERROR", "HTML could not be sanitized and was removed");
    return { html: "", warnings: w.result() };
  }
}

/** The context element: slide HTML is inserted as the children of a `<section>` in the deck document. */
function contextElement(): Element {
  return adapter.createElement("section", NS.HTML, []);
}

function sanitizeOnce(input: string, w: WarningCollector, profile: SanitizerProfile): string {
  precheckCost(input);
  const source = parseFragment(contextElement(), input, { scriptingEnabled: true });
  checkLimits(source);
  const out = adapter.createDocumentFragment();
  const state: State = { w, uses: [], ids: new Map(), profile };
  sanitizeChildren(source, out, "html", state, 0);
  validateUseReferences(state);
  return serialize(out);
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
  "param",
  "keygen",
  "basefont",
  "bgsound",
  "frame",
  "image",
]);

const isAsciiLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isSpace = (c: number): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;

/**
 * Resource guard run before parse5. It is NOT a parser and decides nothing about safety: it only estimates two
 * costs that make the HTML parsing algorithm quadratic (parse5 and browsers alike), and fails closed when they
 * are absurd: the number of attributes in one tag (duplicate detection is linear per attribute) and the nesting
 * of unclosed elements (the adoption agency algorithm walks the stack of open elements). The estimate errs on
 * the high side (it ignores raw-text elements), which can only reject more, never parse more.
 */
function precheckCost(input: string): void {
  const n = input.length;
  // Open element names; an end tag only closes something when that name is open (as in the parser), so
  // stray end tags cannot hide nesting.
  const open: string[] = [];
  const openCount = new Map<string, number>();
  let tags = 0;
  let topLevel = 0;
  let i = 0;
  while (i < n) {
    if (input.charCodeAt(i) !== 0x3c /* < */) {
      i++;
      continue;
    }
    // Comments are not skipped on purpose: markup inside them is counted too (over-estimate, never under).
    const closing = input.charCodeAt(i + 1) === 0x2f; /* / */
    let j = i + (closing ? 2 : 1);
    if (!isAsciiLetter(input.charCodeAt(j))) {
      // `<!...>`, `<?...>`, `</ ...>` can each produce a comment node: count them as top-level nodes too.
      if (open.length === 0 && ++topLevel > SANITIZER_LIMITS.maxTopLevelElements) {
        throw new FailClosed(
          "LIMIT_EXCEEDED",
          `More than ${SANITIZER_LIMITS.maxTopLevelElements} top-level nodes`,
        );
      }
      i++;
      continue;
    }
    if (!closing && ++tags > SANITIZER_LIMITS.maxNodes) {
      throw new FailClosed(
        "LIMIT_EXCEEDED",
        `HTML has more than ${SANITIZER_LIMITS.maxNodes} nodes`,
      );
    }
    // parse5 moves the fragment's top-level children one by one with indexOf+splice (quadratic).
    if (!closing && open.length === 0 && ++topLevel > SANITIZER_LIMITS.maxTopLevelElements) {
      throw new FailClosed(
        "LIMIT_EXCEEDED",
        `More than ${SANITIZER_LIMITS.maxTopLevelElements} top-level elements (wrap them in a container)`,
      );
    }
    const nameStart = j;
    while (j < n && !isSpace(input.charCodeAt(j)) && input[j] !== "/" && input[j] !== ">") j++;
    const name = input.slice(nameStart, j).toLowerCase();
    let attributes = 0;
    let selfClosing = false;
    while (j < n && input[j] !== ">") {
      const c = input.charCodeAt(j);
      if (isSpace(c)) {
        j++;
        continue;
      }
      if (c === 0x2f) {
        selfClosing = input[j + 1] === ">";
        j++;
        continue;
      }
      // An attribute name, then an optional value.
      attributes++;
      if (attributes > SANITIZER_LIMITS.maxAttributesPerTag) {
        throw new FailClosed(
          "LIMIT_EXCEEDED",
          `A tag has more than ${SANITIZER_LIMITS.maxAttributesPerTag} attributes`,
        );
      }
      j++;
      while (
        j < n &&
        !isSpace(input.charCodeAt(j)) &&
        input[j] !== "/" &&
        input[j] !== ">" &&
        input[j] !== "="
      )
        j++;
      while (j < n && isSpace(input.charCodeAt(j))) j++;
      if (input[j] !== "=") continue;
      j++;
      while (j < n && isSpace(input.charCodeAt(j))) j++;
      const quote = input[j];
      if (quote === '"' || quote === "'") {
        const end = input.indexOf(quote, j + 1);
        j = end < 0 ? n : end + 1;
      } else {
        while (j < n && !isSpace(input.charCodeAt(j)) && input[j] !== ">") j++;
      }
    }
    i = j + 1;
    if (closing) {
      if ((openCount.get(name) ?? 0) > 0) {
        for (let top = open.pop(); top !== undefined; top = open.pop()) {
          openCount.set(top, (openCount.get(top) ?? 1) - 1);
          if (top === name) break;
        }
      }
    } else if (!selfClosing && !VOID_ELEMENTS.has(name)) {
      open.push(name);
      openCount.set(name, (openCount.get(name) ?? 0) + 1);
      if (open.length > SANITIZER_LIMITS.maxUnclosedElements) {
        throw new FailClosed(
          "LIMIT_EXCEEDED",
          `More than ${SANITIZER_LIMITS.maxUnclosedElements} unclosed elements`,
        );
      }
    }
  }
}

/** Iterative pre-check of node count and depth, before any recursive processing. */
function checkLimits(root: ParentNode): void {
  let count = 0;
  const stack: [ChildNode, number][] = [];
  for (const child of root.childNodes) stack.push([child, 1]);
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const [node, depth] = item;
    if (++count > SANITIZER_LIMITS.maxNodes) {
      throw new FailClosed(
        "LIMIT_EXCEEDED",
        `HTML has more than ${SANITIZER_LIMITS.maxNodes} nodes`,
      );
    }
    if (depth > SANITIZER_LIMITS.maxDepth) {
      throw new FailClosed(
        "LIMIT_EXCEEDED",
        `HTML is nested deeper than ${SANITIZER_LIMITS.maxDepth} levels`,
      );
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) stack.push([child, depth + 1]);
    }
    if (node.nodeName === "template") {
      for (const child of (node as DefaultTreeAdapterTypes.Template).content.childNodes) {
        stack.push([child, depth + 1]);
      }
    }
  }
}

type Context = "html" | "svg" | "svg-text-only";

interface State {
  w: WarningCollector;
  uses: Element[];
  ids: Map<string, Element>;
  profile: SanitizerProfile;
}

function sanitizeChildren(
  src: ParentNode,
  dst: ParentNode,
  ctx: Context,
  state: State,
  depth: number,
): void {
  if (depth > SANITIZER_LIMITS.maxDepth) {
    throw new FailClosed(
      "LIMIT_EXCEEDED",
      `HTML is nested deeper than ${SANITIZER_LIMITS.maxDepth} levels`,
    );
  }
  for (const node of src.childNodes) {
    if (node.nodeName === "#text") {
      const text = (node as DefaultTreeAdapterTypes.TextNode).value;
      adapter.insertText(dst, stripControl(text));
      continue;
    }
    if (node.nodeName === "#comment" || node.nodeName === "#documentType") continue; // dropped silently
    if (!("tagName" in node)) continue;
    const el = node as Element;
    if (ctx === "svg-text-only") {
      state.w.add("REMOVED_ELEMENT", "Only text is allowed inside SVG title/desc", el.tagName);
      continue;
    }
    if (el.namespaceURI === NS.HTML) {
      if (ctx !== "html") {
        state.w.add("REMOVED_ELEMENT", "HTML elements are not allowed inside SVG", el.tagName);
        continue;
      }
      sanitizeHtmlElement(el, dst, state, depth);
    } else if (el.namespaceURI === NS.SVG) {
      if (ctx === "html" && el.tagName !== "svg") {
        state.w.add("REMOVED_ELEMENT", "SVG element outside <svg>", el.tagName);
        continue;
      }
      sanitizeSvgElement(el, dst, state, depth);
    } else {
      // MathML (and anything else): removed with its content. MathML is a classic mXSS vehicle.
      state.w.add("REMOVED_ELEMENT", "MathML is not allowed", el.tagName);
    }
  }
}

function sanitizeHtmlElement(el: Element, dst: ParentNode, state: State, depth: number): void {
  const tag = el.tagName;
  const interactive = state.profile === "interactive" && INTERACTIVE_HTML_ELEMENTS.has(tag);
  if (tag === "script") {
    state.w.add(
      "REMOVED_ELEMENT",
      "Scripts in slide HTML are removed; put the slide's code in its `script` field (interactive mode)",
      tag,
    );
    return;
  }
  if (!interactive && HTML_DROP_WITH_CONTENT.has(tag)) {
    state.w.add("REMOVED_ELEMENT", "Element is not allowed and was removed with its content", tag);
    return;
  }
  if (!interactive && !HTML_ELEMENTS.has(tag)) {
    state.w.add("UNWRAPPED_ELEMENT", "Element is not allowed; its content was kept", tag);
    sanitizeChildren(el, dst, "html", state, depth + 1);
    return;
  }
  const attrs = sanitizeAttributes(el, "html", state);
  if (attrs === null) return; // e.g. <img> without a valid asset reference
  const copy = adapter.createElement(tag, NS.HTML, attrs);
  adapter.appendChild(dst, copy);
  registerId(copy, state);
  sanitizeChildren(el, copy, "html", state, depth + 1);
  // The parser drops one newline right after <pre>; the serializer does not add it back. Re-add it so that a
  // leading newline in the content survives the re-parse instead of being eaten one pass at a time.
  if (tag === "pre") {
    const first = copy.childNodes[0];
    if (
      first?.nodeName === "#text" &&
      (first as DefaultTreeAdapterTypes.TextNode).value.startsWith("\n")
    ) {
      (first as DefaultTreeAdapterTypes.TextNode).value =
        `\n${(first as DefaultTreeAdapterTypes.TextNode).value}`;
    }
  }
}

function sanitizeSvgElement(el: Element, dst: ParentNode, state: State, depth: number): void {
  const tag = el.tagName;
  if (SVG_UNWRAP.has(tag)) {
    state.w.add("UNWRAPPED_ELEMENT", "SVG links are not allowed; the content was kept", tag);
    sanitizeChildren(el, dst, "svg", state, depth + 1);
    return;
  }
  if (!SVG_ELEMENTS.has(tag)) {
    state.w.add(
      "REMOVED_ELEMENT",
      "SVG element is not allowed and was removed with its content",
      tag,
    );
    return;
  }
  const attrs = sanitizeAttributes(el, "svg", state);
  if (attrs === null) return;
  const copy = adapter.createElement(tag, NS.SVG, attrs);
  adapter.appendChild(dst, copy);
  registerId(copy, state);
  if (tag === "use") state.uses.push(copy);
  sanitizeChildren(el, copy, SVG_TEXT_ONLY.has(tag) ? "svg-text-only" : "svg", state, depth + 1);
}

function registerId(el: Element, state: State): void {
  const id = el.attrs.find((a) => a.name === "id")?.value;
  if (id !== undefined && !state.ids.has(id)) state.ids.set(id, el);
}

// ---------------------------------------------------------------------------------------------------------------
// Attributes

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CLASS_TOKEN = /^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/;
const LANG = /^(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4})?$/;
const ARIA_NAME = /^aria-[a-z]{3,24}$/;
const UINT = /^\d{1,5}$/;
const INT = /^-?\d{1,9}$/;
const STEP = /^(?:[1-9]\d?)?$/;
const DATETIME = /^[0-9A-Za-z:+\-. ]{1,64}$/;
const NUMBER = /^-?(?:\d{1,15}(?:\.\d{1,15})?|\.\d{1,15})(?:[eE][+-]?\d{1,3})?$/;
const SVG_NUMBERS = /^[0-9A-Za-z.,%+\- ]{0,512}$/;
const SVG_PATH = /^[0-9MmZzLlHhVvCcSsQqTtAaEe.,+\-\s]*$/;
const SVG_POINTS = /^[0-9eE.,+\-\s]*$/;
const SVG_TRANSFORM = /^[A-Za-z0-9.,()+\-\s]*$/;
const SVG_TRANSFORM_WORDS = new Set([
  "matrix",
  "translate",
  "scale",
  "rotate",
  "skewX",
  "skewY",
  "e",
  "E",
]);
const SVG_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PRESERVE_ASPECT_RATIO = /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?: (?:meet|slice))?$/;
const FRAGMENT = /^#[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const UNIT_ATTRIBUTES = new Set([
  "gradientUnits",
  "patternUnits",
  "patternContentUnits",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "filterUnits",
  "primitiveUnits",
  "markerUnits",
]);

/** Attribute names that are expected noise from SVG copy-paste: dropped without a warning. */
const SILENT_SVG_ATTRIBUTES = new Set([
  "xmlns",
  "xmlns:xlink",
  "xml:space",
  "version",
  "baseProfile",
]);

/**
 * Returns the sanitized attribute list, or `null` when the element itself must be removed (an image whose
 * source is not a valid asset reference).
 */
function sanitizeAttributes(el: Element, kind: "html" | "svg", state: State): Attribute[] | null {
  const out: Attribute[] = [];
  const seen = new Set<string>();
  const tag = el.tagName;
  let hasValidSource = false;
  for (const attr of el.attrs) {
    if (out.length >= SANITIZER_LIMITS.maxAttributesPerElement) {
      state.w.add("REMOVED_ATTRIBUTE", "Too many attributes", tag);
      break;
    }
    const qualified = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
    // Namespaced attributes: only xlink:href on SVG, normalized to plain `href`.
    let name = attr.name;
    if (attr.namespace) {
      if (kind === "svg" && attr.namespace === NS.XLINK && attr.name === "href") {
        name = "href";
      } else {
        if (!(kind === "svg" && SILENT_SVG_ATTRIBUTES.has(qualified))) {
          state.w.add("REMOVED_ATTRIBUTE", "Namespaced attribute is not allowed", qualified);
        }
        continue;
      }
    }
    if (seen.has(name)) continue;
    let validator: AttributeKind | undefined;
    if (kind === "html") {
      validator =
        own(own(HTML_ELEMENT_ATTRIBUTES, tag) ?? {}, name) ?? own(HTML_GLOBAL_ATTRIBUTES, name);
      if (validator === undefined && state.profile === "interactive") {
        validator = own(own(INTERACTIVE_ELEMENT_ATTRIBUTES, tag) ?? {}, name);
      }
    } else {
      validator = own(SVG_ATTRIBUTES, name);
      if (name === "href" && !SVG_HREF_ELEMENTS.has(tag)) validator = undefined;
    }
    if (validator === undefined && ARIA_NAME.test(name)) validator = "aria";
    if (
      validator === undefined &&
      state.profile === "interactive" &&
      DATA_ATTRIBUTE_NAME.test(name) &&
      !RESERVED_DATA_ATTRIBUTES.has(name) &&
      !name.startsWith(`data-${RESERVED_PREFIX}`)
    ) {
      validator = "data";
    }
    if (validator === undefined) {
      if (!(kind === "svg" && SILENT_SVG_ATTRIBUTES.has(qualified))) {
        const reason = /^on/i.test(name)
          ? "Event handler attributes are not allowed"
          : "Attribute is not allowed";
        state.w.add("REMOVED_ATTRIBUTE", reason, qualified);
      }
      continue;
    }
    const value = validateAttribute(validator, name, attr.value, tag, kind, state);
    if (value === null) continue;
    if ((tag === "img" && name === "src") || (tag === "image" && name === "href"))
      hasValidSource = true;
    if (kind === "html" && tag === "input" && name === "type") hasValidSource = true;
    seen.add(name);
    out.push({ name, value });
  }
  if (kind === "html" && tag === "input" && !hasValidSource) {
    state.w.add("REMOVED_ELEMENT", "Inputs need type range, number or checkbox; removed", tag);
    return null;
  }
  if ((kind === "html" && tag === "img") || (kind === "svg" && tag === "image")) {
    if (!hasValidSource) {
      state.w.add(
        "INVALID_ASSET_REF",
        "Images need an asset:<hex> source; the image was removed",
        tag,
      );
      return null;
    }
  }
  return out;
}

/** Own-property lookup: attribute names such as `constructor` or `__proto__` never hit the prototype. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function validateAttribute(
  kind: AttributeKind,
  name: string,
  raw: string,
  tag: string,
  ns: "html" | "svg",
  state: State,
): string | null {
  const w = state.w;
  const reject = (reason = "Invalid attribute value"): null => {
    w.add("REMOVED_ATTRIBUTE", reason, name);
    return null;
  };
  const geometry = kind === "svgPath" || kind === "svgPoints" || kind === "svgNumbers";
  const max =
    kind === "style"
      ? SANITIZER_LIMITS.maxStyleAttributeLength
      : geometry
        ? SANITIZER_LIMITS.maxGeometryLength
        : SANITIZER_LIMITS.maxAttributeLength;
  if (raw.length > max) return reject("Attribute value too long");
  const value = raw;
  switch (kind) {
    case "class": {
      const tokens = value.split(/[\t\n\f\r ]+/).filter((t) => t !== "");
      const kept = tokens.filter(
        (t) => CLASS_TOKEN.test(t) && !t.toLowerCase().startsWith(RESERVED_PREFIX),
      );
      if (kept.length !== tokens.length)
        w.add("REMOVED_ATTRIBUTE", "Invalid or reserved class names removed", name);
      if (kept.length === 0) return null;
      return kept.slice(0, 32).join(" ");
    }
    case "id": {
      if (!ID.test(value)) return reject("Invalid id (use letters, digits, '-' and '_')");
      const lower = value.toLowerCase();
      if (CLOBBER_DENYLIST.has(lower) || lower.startsWith(RESERVED_PREFIX)) {
        return reject("This id could shadow a browser or runtime global (DOM clobbering)");
      }
      return value;
    }
    case "style": {
      const css = sanitizeStyleAttribute(value, w);
      return css === "" ? null : css;
    }
    case "lang":
      return LANG.test(value) ? value : reject();
    case "dir":
      return ["ltr", "rtl", "auto"].includes(value.toLowerCase()) ? value.toLowerCase() : reject();
    case "text":
      return stripControl(value);
    case "aria":
      return stripControl(value).slice(0, 512);
    case "role": {
      const roles = value
        .toLowerCase()
        .split(/[\t\n\f\r ]+/)
        .filter((r) => r !== "");
      if (roles.length !== 1 || !ARIA_ROLES.has(roles[0] ?? ""))
        return reject("Role is not allowed");
      return roles[0] ?? null;
    }
    case "step":
      return STEP.test(value)
        ? value
        : reject("data-step must be empty or an integer from 1 to 99");
    case "hidden":
      return value === "" ||
        value.toLowerCase() === "hidden" ||
        value.toLowerCase() === "until-found"
        ? value.toLowerCase()
        : reject();
    case "translate":
      return value === "yes" || value === "no" ? value : reject();
    case "boolean":
      return value === "" || value.toLowerCase() === name ? "" : reject();
    case "asset":
      if (ASSET_REF_PATTERN.test(value)) return value;
      w.add(
        ASSET_LIKE.test(value) ? "INVALID_ASSET_REF" : "REMOVED_URL",
        "Only asset:<hex> sources are allowed",
        name,
      );
      return null;
    case "uint":
      return UINT.test(value) && Number(value) <= 65534 ? value : reject();
    case "int":
      return INT.test(value) ? value : reject();
    case "thScope":
      return ["row", "col", "rowgroup", "colgroup"].includes(value.toLowerCase())
        ? value.toLowerCase()
        : reject();
    case "olType":
      return ["1", "a", "A", "i", "I"].includes(value) ? value : reject();
    case "datetime":
      return DATETIME.test(value) ? value : reject();
    case "svgNumbers":
      return SVG_NUMBERS.test(value) ? value : reject();
    case "svgPath":
      return SVG_PATH.test(value) ? value : reject();
    case "svgPoints":
      return SVG_POINTS.test(value) ? value : reject();
    case "svgTransform": {
      if (!SVG_TRANSFORM.test(value)) return reject();
      for (const word of value.match(/[A-Za-z]+/g) ?? []) {
        if (!SVG_TRANSFORM_WORDS.has(word)) return reject();
      }
      return value;
    }
    case "svgToken":
      return SVG_TOKEN.test(value) ? value : reject();
    case "svgEnum": {
      if (name === "preserveAspectRatio")
        return PRESERVE_ASPECT_RATIO.test(value) ? value : reject();
      const allowed = UNIT_ATTRIBUTES.has(name) ? SVG_ENUM_VALUES.units : SVG_ENUM_VALUES[name];
      return allowed?.has(value) ? value : reject();
    }
    case "svgFragment": {
      if (ns === "svg" && SVG_ASSET_HREF_ELEMENTS.has(tag)) {
        if (ASSET_REF_PATTERN.test(value)) return value;
        w.add(
          ASSET_LIKE.test(value) ? "INVALID_ASSET_REF" : "REMOVED_URL",
          "Only asset:<hex> sources are allowed",
          name,
        );
        return null;
      }
      if (FRAGMENT.test(value)) return value;
      w.add("REMOVED_URL", "Only same-document #id references are allowed", name);
      return null;
    }
    case "number":
      return NUMBER.test(value) ? value : reject();
    case "inputStep":
      return value === "any" || NUMBER.test(value) ? value : reject();
    case "inputType":
      return INTERACTIVE_INPUT_TYPES.has(value.toLowerCase())
        ? value.toLowerCase()
        : reject("Input type must be range, number or checkbox");
    case "buttonType":
      return INTERACTIVE_BUTTON_TYPES.has(value.toLowerCase())
        ? value.toLowerCase()
        : reject("Button type must be button");
    case "idref":
      return ID.test(value) ? value : reject();
    case "idrefs": {
      const ids = value.split(/[\t\n\f\r ]+/).filter((t) => t !== "");
      return ids.length > 0 && ids.length <= 16 && ids.every((t) => ID.test(t))
        ? ids.join(" ")
        : reject();
    }
    case "data":
      return stripControl(value);
    case "svgCss": {
      const parsed = parseCssValue(value);
      if (parsed === null) return reject();
      const probe = new WarningCollector();
      const text = sanitizeValueFor(name, parsed, probe);
      if (text === null) {
        const url = probe.list.some((x) => x.code === "REMOVED_URL");
        w.add(
          url ? "REMOVED_URL" : "REMOVED_ATTRIBUTE",
          "Invalid SVG presentation attribute value",
          name,
        );
        return null;
      }
      for (const x of probe.list) w.add(x.code, x.message, x.name);
      return text;
    }
    default:
      return reject();
  }
}

const ASSET_LIKE = /^\s*asset:/i;

/** Removes C0 controls (except tab/newline/CR) and NUL from text: they have no place in slide text. */
function stripControl(text: string): string {
  let out = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) {
      out += text.slice(start, i);
      start = i + 1;
    }
  }
  return start === 0 ? text : out + text.slice(start);
}

// ---------------------------------------------------------------------------------------------------------------
// SVG <use>: only references to elements of the same slide, and never chains of <use> (exponential expansion,
// the SVG "billion laughs").

function validateUseReferences(state: State): void {
  for (const [index, use] of state.uses.entries()) {
    const href = use.attrs.find((a) => a.name === "href")?.value;
    const target = href ? state.ids.get(href.slice(1)) : undefined;
    let reason: string | null = null;
    if (index >= SANITIZER_LIMITS.maxUseElements) reason = "Too many <use> elements";
    else if (!href || !target) reason = "<use> must reference an element of the same slide";
    else if (isAncestor(target, use)) reason = "<use> must not reference its own ancestor";
    else if (containsUse(target))
      reason = "<use> must not reference content that contains another <use>";
    if (reason !== null) {
      state.w.add("REMOVED_ELEMENT", reason, "use");
      detach(use);
    }
  }
}

function isAncestor(candidate: Element, node: Element): boolean {
  let p: ParentNode | null = node.parentNode;
  while (p) {
    if (p === candidate) return true;
    p = "parentNode" in p ? (p.parentNode as ParentNode | null) : null;
  }
  return false;
}

function containsUse(el: Element): boolean {
  const stack: ChildNode[] = [el];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) break;
    if ("tagName" in n && n.tagName === "use" && n.namespaceURI === NS.SVG) return true;
    if ("childNodes" in n) stack.push(...n.childNodes);
  }
  return false;
}

function detach(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  const i = parent.childNodes.indexOf(el);
  if (i >= 0) parent.childNodes.splice(i, 1);
  el.parentNode = null;
}
