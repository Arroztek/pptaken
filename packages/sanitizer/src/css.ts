// SPDX-License-Identifier: AGPL-3.0-or-later
// CSS sanitizing: the input is parsed with css-tree and the output is rebuilt from allowlisted nodes only.
// Nothing from the input reaches the output unless it was parsed into a node type we understand and validated.

import { ASSET_REF_PATTERN, FONT_CATALOG } from "@pptaken/schema";
import * as csstree from "css-tree";
import {
  CATALOG_FONTS,
  CSS_ASSET_URL_PROPERTIES,
  CSS_AT_RULES,
  CSS_FRAGMENT_URL_PROPERTIES,
  CSS_FUNCTIONS,
  CSS_PROPERTIES,
  CSS_PSEUDO_CLASSES,
  CSS_PSEUDO_ELEMENTS,
  CSS_WIDE_KEYWORDS,
  GENERIC_FONT_FAMILIES,
  RESERVED_PREFIX,
  SANITIZER_LIMITS,
} from "./policy.js";
import { type Warning, WarningCollector } from "./warnings.js";

// Loose structural view of css-tree nodes (a large discriminated union): fields are only read after checking
// `type`, and every value read is validated before it can reach the output.
type Node = any;

/** Token validators. Regular expressions are only used on single, already-tokenized values. */
const IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]{1,64}$/;
const NUMBER = /^[+-]?(?:\d{1,12}(?:\.\d{0,12})?|\.\d{1,12})(?:[eE][+-]?\d{1,3})?$/;
const UNIT = /^[A-Za-z]{1,8}$/;
const HEX_COLOR = /^(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FRAGMENT_REF = /^#[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SELECTOR_NAME = /^-?[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const TYPE_SELECTOR = /^(?:\*|[A-Za-z][A-Za-z0-9-]{0,40})$/;
const KEYFRAME_SELECTOR = /^(?:from|to|\d{1,3}(?:\.\d{1,4})?%)$/i;
const OPERATORS = new Set([",", "/", "+", "-", "*"]);
const ATTRIBUTE_MATCHERS = new Set(["=", "~=", "|=", "^=", "$=", "*="]);

export interface CssOptions {
  /**
   * Selector of the element that contains the slide, e.g. `[data-slide="intro"]`. When set, every selector is
   * rewritten to match only inside it, and `:root`, `html` and `body` map to the scope element itself.
   */
  scope?: string;
  /** Warning `path` to attach, e.g. `slides[2].css`. */
  path?: string;
  /** Size limit in UTF-16 code units. Defaults to the schema limit for slide/theme CSS. */
  maxLength?: number;
}

export interface CssResult {
  css: string;
  warnings: Warning[];
}

interface Ctx {
  w: WarningCollector;
  scope: Node[] | null;
  rules: number;
}

/** Thrown internally when a limit is exceeded; caught at the API boundary, which fails closed. */
export class LimitError extends Error {}

/** Checks bracket nesting before handing the text to a recursive-descent parser. Strings count too (conservative). */
export function exceedsNesting(text: string, max: number): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x28 || c === 0x5b || c === 0x7b) {
      if (++depth > max) return true;
    } else if ((c === 0x29 || c === 0x5d || c === 0x7d) && depth > 0) {
      depth--;
    }
  }
  return false;
}

function parse(text: string, context: string): Node {
  return csstree.parse(text, {
    context,
    parseValue: true,
    parseCustomProperty: true,
    parseAtrulePrelude: true,
    parseRulePrelude: true,
    positions: false,
  } as csstree.ParseOptions);
}

const gen = (node: Node): string => csstree.generate(node);

/** Sanitizes a stylesheet (slide CSS or theme CSS). Never throws. */
export function sanitizeCss(css: string, options: CssOptions = {}): CssResult {
  const w = new WarningCollector(options.path);
  const maxLength = options.maxLength ?? SANITIZER_LIMITS.maxCssLength;
  if (typeof css !== "string") {
    w.add("INTERNAL_ERROR", "CSS must be a string");
    return { css: "", warnings: w.result() };
  }
  if (css.length > maxLength) {
    w.add("INPUT_TOO_LARGE", `CSS exceeds ${maxLength} characters and was removed`);
    return { css: "", warnings: w.result() };
  }
  let scope: Node[] | null = null;
  if (options.scope !== undefined) {
    scope = compileScope(options.scope);
    if (scope === null) {
      w.add("INTERNAL_ERROR", "Invalid scope selector; CSS was removed");
      return { css: "", warnings: w.result() };
    }
  }
  try {
    // Re-sanitize the output until it is a fixed point (at most two extra passes), otherwise fail closed.
    // This makes the function idempotent and catches parser/serializer differentials.
    let current = sanitizeStylesheetOnce(css, { w, scope, rules: 0 });
    let stable = false;
    for (let pass = 0; pass < 2 && !stable; pass++) {
      const extra = new WarningCollector(options.path);
      const next = sanitizeStylesheetOnce(current, { w: extra, scope, rules: 0 });
      stable = next === current;
      if (!stable) w.merge(extra);
      current = next;
    }
    if (!stable) {
      w.reset();
      w.add("UNSTABLE_OUTPUT", "CSS did not survive re-parsing unchanged and was removed");
      return { css: "", warnings: w.result() };
    }
    assertEmbeddable(current);
    return { css: current, warnings: w.result() };
  } catch (error) {
    w.reset();
    if (error instanceof LimitError) w.add("LIMIT_EXCEEDED", error.message);
    else w.add("INTERNAL_ERROR", "CSS could not be sanitized and was removed");
    return { css: "", warnings: w.result() };
  }
}

/**
 * The output is placed inside a `<style>` element, a raw-text element that ends at `</style`. Strings with `<`
 * are refused earlier; this is a last line of defense.
 */
function assertEmbeddable(css: string): void {
  if (css.includes("</") || css.includes("<!") || css.includes("\u0000")) {
    throw new Error("unembeddable CSS output");
  }
}

function sanitizeStylesheetOnce(css: string, ctx: Ctx): string {
  if (exceedsNesting(css, SANITIZER_LIMITS.maxCssNesting)) {
    throw new LimitError(`CSS nesting deeper than ${SANITIZER_LIMITS.maxCssNesting} levels`);
  }
  const ast = parse(css, "stylesheet");
  return sanitizeBlockItems(ast.children, ctx, 0, false);
}

/** Sanitizes the items of a stylesheet or of a conditional at-rule block. */
function sanitizeBlockItems(
  children: Node,
  ctx: Ctx,
  atDepth: number,
  insideKeyframes: boolean,
): string {
  let out = "";
  children.forEach((node: Node) => {
    if (++ctx.rules > SANITIZER_LIMITS.maxCssRules) {
      throw new LimitError(`More than ${SANITIZER_LIMITS.maxCssRules} CSS rules`);
    }
    if (node.type === "Rule") {
      out += insideKeyframes ? sanitizeKeyframe(node, ctx) : sanitizeRule(node, ctx);
    } else if (node.type === "Atrule" && !insideKeyframes) {
      out += sanitizeAtrule(node, ctx, atDepth);
    } else if (node.type === "Atrule") {
      ctx.w.add("REMOVED_CSS_RULE", "At-rules are not allowed inside @keyframes", `@${node.name}`);
    } else if (node.type === "Raw") {
      ctx.w.add("REMOVED_CSS_RULE", "Unparseable CSS was removed", node.value);
    }
    // Comments, CDO/CDC (`<!--`, `-->`) and whitespace are dropped silently.
  });
  return out;
}

function sanitizeRule(node: Node, ctx: Ctx): string {
  const selector = sanitizeSelectorList(node.prelude, ctx);
  if (selector === null) return "";
  const body = sanitizeDeclarationBlock(node.block, ctx.w);
  if (body === "") return "";
  return `${selector}{${body}}`;
}

function sanitizeKeyframe(node: Node, ctx: Ctx): string {
  const prelude = node.prelude;
  let ok = prelude && (prelude.type === "SelectorList" || prelude.type === "Raw");
  const parts: string[] = [];
  if (ok && prelude.type === "SelectorList") {
    prelude.children.forEach((sel: Node) => {
      const text = gen(sel).trim();
      if (KEYFRAME_SELECTOR.test(text)) parts.push(text.toLowerCase());
      else ok = false;
    });
  } else {
    ok = false;
  }
  if (!ok || parts.length === 0) {
    ctx.w.add("REMOVED_CSS_RULE", "Invalid keyframe selector");
    return "";
  }
  const body = sanitizeDeclarationBlock(node.block, ctx.w);
  return `${parts.join(",")}{${body}}`;
}

function sanitizeAtrule(node: Node, ctx: Ctx, atDepth: number): string {
  const name = String(node.name ?? "").toLowerCase();
  if (!CSS_AT_RULES.has(name)) {
    ctx.w.add("REMOVED_CSS_RULE", `@${name} is not allowed`, `@${node.name}`);
    return "";
  }
  if (!node.block) {
    ctx.w.add("REMOVED_CSS_RULE", `@${name} without a block was removed`, `@${name}`);
    return "";
  }
  if (atDepth >= SANITIZER_LIMITS.maxAtRuleNesting) {
    ctx.w.add("REMOVED_CSS_RULE", "At-rules nested too deeply", `@${name}`);
    return "";
  }
  if (name === "keyframes") {
    const prelude = node.prelude;
    const id = prelude?.type === "AtrulePrelude" ? prelude.children.toArray() : [];
    const ident = id.length === 1 && id[0].type === "Identifier" ? String(id[0].name) : "";
    if (!IDENT.test(ident) || CSS_WIDE_KEYWORDS.has(ident.toLowerCase()) || ident === "none") {
      ctx.w.add("REMOVED_CSS_RULE", "Invalid @keyframes name", "@keyframes");
      return "";
    }
    const body = sanitizeBlockItems(node.block.children, ctx, atDepth + 1, true);
    return `@keyframes ${ident}{${body}}`;
  }
  const prelude = node.prelude;
  if (!prelude || prelude.type !== "AtrulePrelude" || !validConditionPrelude(prelude)) {
    ctx.w.add("REMOVED_CSS_RULE", `Unsupported @${name} condition`, `@${name}`);
    return "";
  }
  const body = sanitizeBlockItems(node.block.children, ctx, atDepth + 1, false);
  if (body === "") return "";
  return `@${name} ${gen(prelude)}{${body}}`;
}

/**
 * Media and supports conditions cannot load or run anything; still, only node types we know are accepted, so
 * nothing unparsed (Raw) or URL-bearing passes through.
 */
function validConditionPrelude(prelude: Node): boolean {
  let ok = true;
  const probe = new WarningCollector();
  csstree.walk(prelude, {
    enter(node: Node) {
      if (!ok) return;
      switch (node.type) {
        case "AtrulePrelude":
        case "MediaQueryList":
        case "MediaQuery":
        case "Condition":
        case "Feature":
        case "FeatureRange":
        case "Ratio":
        case "Number":
        case "Dimension":
        case "Percentage":
        case "Parentheses":
        case "Value":
        case "WhiteSpace":
          return;
        case "Identifier":
          if (!IDENT.test(String(node.name))) ok = false;
          return;
        case "SupportsDeclaration":
          if (sanitizeDeclaration(node.declaration, probe) === null) ok = false;
          return csstree.walk.skip;
        case "Declaration":
          // Inside @supports (legacy representation)
          if (sanitizeDeclaration(node, probe) === null) ok = false;
          return csstree.walk.skip;
        default:
          ok = false;
      }
    },
  });
  return ok;
}

// ---------------------------------------------------------------------------------------------------------------
// Selectors

/** Parses the scope selector given by the caller. It must be a single compound selector without a type selector. */
function compileScope(scope: string): Node[] | null {
  try {
    const ast = parse(scope, "selector");
    if (ast.type !== "Selector") return null;
    const nodes: Node[] = ast.children.toArray();
    if (nodes.length === 0) return null;
    for (const n of nodes) {
      if (n.type !== "AttributeSelector" && n.type !== "ClassSelector" && n.type !== "IdSelector")
        return null;
    }
    return nodes;
  } catch {
    return null;
  }
}

function sanitizeSelectorList(prelude: Node, ctx: Ctx): string | null {
  if (!prelude || prelude.type !== "SelectorList") {
    ctx.w.add(
      "REMOVED_CSS_RULE",
      "Unparseable selector",
      prelude?.type === "Raw" ? prelude.value : undefined,
    );
    return null;
  }
  const selectors: Node[] = prelude.children.toArray();
  if (selectors.length > SANITIZER_LIMITS.maxSelectorsPerRule) {
    ctx.w.add("REMOVED_CSS_RULE", "Too many selectors in one rule");
    return null;
  }
  const out: string[] = [];
  for (const selector of selectors) {
    const text = sanitizeSelector(selector, ctx);
    if (text !== null) out.push(text);
  }
  return out.length > 0 ? out.join(",") : null;
}

/** Returns the validated, optionally scoped, selector text; `null` drops this selector. */
function sanitizeSelector(selector: Node, ctx: Ctx): string | null {
  if (selector.type !== "Selector") {
    ctx.w.add("REMOVED_CSS_RULE", "Unparseable selector");
    return null;
  }
  const nodes: Node[] = selector.children.toArray();
  for (const n of nodes) {
    const problem = selectorNodeProblem(n, 0);
    if (problem !== null) {
      ctx.w.add("REMOVED_CSS_RULE", `Selector removed: ${problem}`, gen(selector));
      return null;
    }
  }
  if (!ctx.scope) return nodes.map(genSelectorNode).join("");

  // Split into compounds separated by combinators.
  const compounds: Node[][] = [[]];
  const combinators: string[] = [];
  for (const n of nodes) {
    if (n.type === "Combinator") {
      combinators.push(n.name);
      compounds.push([]);
    } else {
      compounds[compounds.length - 1]?.push(n);
    }
  }
  const scopeText = ctx.scope.map(genSelectorNode).join("");
  const escapes = (): null => {
    ctx.w.add("REMOVED_CSS_RULE", "Selector would match outside the slide", gen(selector));
    return null;
  };
  // Already scoped (for example when re-sanitizing our own output): keep it, with the same restrictions.
  const head = compounds[0] ?? [];
  if (
    head.length >= ctx.scope.length &&
    head.slice(0, ctx.scope.length).map(genSelectorNode).join("") === scopeText
  ) {
    if (compounds.some((c) => c.some(isRootLike))) return escapes();
    if (compounds.length > 1 && combinators[0] !== " " && combinators[0] !== ">") return escapes();
    return nodes.map(genSelectorNode).join("");
  }
  // A leading run of root-like compounds (`html body`, `:root`, `body.dark`) collapses onto the scope element.
  let rootCount = 0;
  const rootRest: Node[] = [];
  while (rootCount < compounds.length) {
    const compound = compounds[rootCount] ?? [];
    if (!compound.some(isRootLike)) break;
    if (rootCount > 0 && combinators[rootCount - 1] !== " " && combinators[rootCount - 1] !== ">")
      break;
    rootRest.push(
      ...compound.filter((n) => !isRootLike(n) && !(n.type === "TypeSelector" && n.name === "*")),
    );
    rootCount++;
  }
  // Root-like parts after the leading run would match outside the slide.
  for (let i = rootCount; i < compounds.length; i++) {
    if ((compounds[i] ?? []).some(isRootLike)) return escapes();
  }
  let text: string;
  if (rootCount > 0) {
    // Sibling combinators right after the scope would reach other slides.
    const next = combinators[rootCount - 1];
    if (rootCount < compounds.length && next !== " " && next !== ">") return escapes();
    text = scopeText + rootRest.map(genSelectorNode).join("");
    for (let i = rootCount; i < compounds.length; i++) {
      text +=
        genCombinator(combinators[i - 1] ?? " ") +
        (compounds[i] ?? []).map(genSelectorNode).join("");
    }
  } else {
    text = `${scopeText} ${nodes.map(genSelectorNode).join("")}`;
  }
  return text;
}

function isRootLike(n: Node): boolean {
  if (n.type === "TypeSelector") {
    const name = String(n.name).toLowerCase();
    return name === "html" || name === "body";
  }
  return n.type === "PseudoClassSelector" && String(n.name).toLowerCase() === "root";
}

function genCombinator(name: string): string {
  return name === " " ? " " : name;
}

function genSelectorNode(n: Node): string {
  if (n.type === "Combinator") return genCombinator(n.name);
  return gen(n);
}

/** Returns a reason when a selector node is not allowed, otherwise `null`. */
function selectorNodeProblem(n: Node, depth: number): string | null {
  if (depth > 4) return "nested too deeply";
  switch (n.type) {
    case "TypeSelector":
      return TYPE_SELECTOR.test(String(n.name)) ? null : "invalid type selector";
    case "ClassSelector":
    case "IdSelector":
      if (!SELECTOR_NAME.test(String(n.name))) return "invalid name";
      return String(n.name).toLowerCase().startsWith(RESERVED_PREFIX) ? "reserved name" : null;
    case "Combinator":
      return n.name === " " || n.name === ">" || n.name === "+" || n.name === "~"
        ? null
        : "invalid combinator";
    case "AttributeSelector": {
      if (n.name?.type !== "Identifier" || !SELECTOR_NAME.test(String(n.name.name)))
        return "invalid attribute";
      if (n.matcher !== null && !ATTRIBUTE_MATCHERS.has(n.matcher))
        return "invalid attribute matcher";
      if (n.value !== null) {
        if (n.value.type === "String") {
          if (!safeCssString(String(n.value.value))) return "invalid attribute value";
        } else if (n.value.type !== "Identifier" || !IDENT.test(String(n.value.name))) {
          return "invalid attribute value";
        }
      }
      if (n.flags !== null && n.flags !== "i" && n.flags !== "s") return "invalid attribute flag";
      return null;
    }
    case "PseudoClassSelector": {
      const name = String(n.name).toLowerCase();
      if (!CSS_PSEUDO_CLASSES.has(name)) return `pseudo-class :${safeName(n.name)} is not allowed`;
      if (!n.children) {
        return ["not", "is", "where", "has", "lang", "dir"].includes(name) || name.startsWith("nth")
          ? "missing argument"
          : null;
      }
      if (name === "root") return "invalid :root";
      for (const child of n.children.toArray()) {
        const problem = pseudoArgumentProblem(child, depth + 1);
        if (problem !== null) return problem;
      }
      return null;
    }
    case "PseudoElementSelector": {
      const name = String(n.name).toLowerCase();
      if (!CSS_PSEUDO_ELEMENTS.has(name) || n.children) {
        return `pseudo-element ::${safeName(n.name)} is not allowed`;
      }
      return null;
    }
    default:
      return `unsupported selector part (${safeName(n.type)})`;
  }
}

function pseudoArgumentProblem(n: Node, depth: number): string | null {
  switch (n.type) {
    case "SelectorList":
      for (const s of n.children.toArray()) {
        const p = pseudoArgumentProblem(s, depth);
        if (p !== null) return p;
      }
      return null;
    case "Selector":
      for (const part of n.children.toArray()) {
        if (isRootLike(part)) return "html, body and :root are not allowed inside pseudo-classes";
        const p = selectorNodeProblem(part, depth);
        if (p !== null) return p;
      }
      return null;
    case "Nth": {
      const nth = n.nth;
      if (nth?.type === "AnPlusB") {
        const a = nth.a === null ? "" : String(nth.a);
        const b = nth.b === null ? "" : String(nth.b);
        if (!/^[+-]?\d{0,4}$/.test(a) || !/^[+-]?\d{0,4}$/.test(b)) return "invalid nth";
      } else if (nth?.type === "Identifier") {
        if (!["odd", "even"].includes(String(nth.name).toLowerCase())) return "invalid nth";
      } else {
        return "invalid nth";
      }
      return n.selector ? pseudoArgumentProblem(n.selector, depth) : null;
    }
    case "Identifier":
      return IDENT.test(String(n.name)) ? null : "invalid identifier";
    case "Raw":
      return "unparseable pseudo-class argument";
    default:
      return `unsupported pseudo-class argument (${safeName(n.type)})`;
  }
}

function safeName(v: unknown): string {
  const s = String(v);
  return /^[A-Za-z0-9-]{1,30}$/.test(s) ? s : "?";
}

// ---------------------------------------------------------------------------------------------------------------
// Declarations

/** Sanitizes the content of a `style` attribute. Returns the declarations text (possibly empty). */
export function sanitizeStyleAttribute(value: string, w: WarningCollector): string {
  if (value.length > SANITIZER_LIMITS.maxStyleAttributeLength) {
    w.add("REMOVED_ATTRIBUTE", "style attribute too long", "style");
    return "";
  }
  if (exceedsNesting(value, SANITIZER_LIMITS.maxCssNesting)) {
    w.add("REMOVED_ATTRIBUTE", "style attribute nested too deeply", "style");
    return "";
  }
  let ast: Node;
  try {
    ast = parse(value, "declarationList");
  } catch {
    w.add("REMOVED_ATTRIBUTE", "Unparseable style attribute", "style");
    return "";
  }
  return sanitizeDeclarationList(ast.children, w);
}

function sanitizeDeclarationBlock(block: Node, w: WarningCollector): string {
  if (!block || block.type !== "Block") return "";
  return sanitizeDeclarationList(block.children, w);
}

function sanitizeDeclarationList(children: Node, w: WarningCollector): string {
  const out: string[] = [];
  children.forEach((node: Node) => {
    if (node.type === "Declaration") {
      const text = sanitizeDeclaration(node, w);
      if (text !== null) out.push(text);
    } else if (node.type === "Rule" || node.type === "Atrule") {
      w.add(
        "REMOVED_CSS_RULE",
        "Nested rules are not allowed",
        node.type === "Atrule" ? `@${node.name}` : undefined,
      );
    } else if (node.type === "Raw") {
      w.add("REMOVED_CSS_PROPERTY", "Unparseable CSS declaration was removed", node.value);
    }
  });
  return out.join(";");
}

/**
 * Validates one declaration and returns its normalized text, or `null` (with a warning) when it is removed.
 * Exported for the SVG presentation-attribute validator.
 */
export function sanitizeDeclaration(node: Node, w: WarningCollector): string | null {
  const rawProperty = String(node.property ?? "");
  const isCustom = rawProperty.startsWith("--");
  const property = isCustom ? rawProperty : rawProperty.toLowerCase();
  if (isCustom ? !CUSTOM_PROPERTY.test(property) : !CSS_PROPERTIES.has(property)) {
    w.add("REMOVED_CSS_PROPERTY", "CSS property is not allowed", rawProperty);
    return null;
  }
  if (node.important !== true && node.important !== false) {
    w.add("REMOVED_CSS_PROPERTY", "Invalid !important flag", rawProperty);
    return null;
  }
  const value = sanitizeValueFor(property, node.value, w);
  if (value === null) return null;
  return `${property}:${value}${node.important ? "!important" : ""}`;
}

/** Validates a parsed value for a property; returns its text or `null` (warning added). */
export function sanitizeValueFor(
  property: string,
  value: Node,
  w: WarningCollector,
): string | null {
  if (!value || value.type !== "Value") {
    w.add("REMOVED_CSS_PROPERTY", "Unparseable CSS value", property);
    return null;
  }
  const isCustom = property.startsWith("--");
  const problem = valueProblem(value.children, property, isCustom, 0);
  if (problem !== null) {
    if (problem.url) w.add("REMOVED_URL", problem.message, property);
    else w.add("REMOVED_CSS_PROPERTY", problem.message, property);
    return null;
  }
  if (property === "font-family" || property === "font")
    return sanitizeFontValue(property, value, w);
  if (property === "z-index") {
    const items: Node[] = value.children.toArray().filter((n: Node) => n.type !== "WhiteSpace");
    const only = items[0];
    if (items.length === 1 && only.type === "Number" && Math.abs(Number(only.value)) > 9999) {
      w.add("REMOVED_CSS_PROPERTY", "z-index must be between -9999 and 9999", property);
      return null;
    }
  }
  const text = gen(value).trim();
  if (text === "" && !isCustom) {
    w.add("REMOVED_CSS_PROPERTY", "Empty CSS value", property);
    return null;
  }
  return text;
}

interface Problem {
  message: string;
  url?: boolean;
}

function valueProblem(
  children: Node,
  property: string,
  isCustom: boolean,
  depth: number,
): Problem | null {
  if (depth > 16) return { message: "CSS value nested too deeply" };
  let problem: Problem | null = null;
  children.forEach((n: Node) => {
    if (problem === null) problem = valueNodeProblem(n, property, isCustom, depth);
  });
  return problem;
}

function valueNodeProblem(
  n: Node,
  property: string,
  isCustom: boolean,
  depth: number,
): Problem | null {
  switch (n.type) {
    case "WhiteSpace":
      return null;
    case "Identifier":
      return IDENT.test(String(n.name)) || CUSTOM_PROPERTY.test(String(n.name))
        ? null
        : { message: "Invalid identifier in CSS value" };
    case "Number":
      return NUMBER.test(String(n.value)) ? null : { message: "Invalid number in CSS value" };
    case "Percentage":
      return NUMBER.test(String(n.value)) ? null : { message: "Invalid percentage in CSS value" };
    case "Dimension":
      return NUMBER.test(String(n.value)) && UNIT.test(String(n.unit))
        ? null
        : { message: "Invalid dimension in CSS value" };
    case "Hash":
      return HEX_COLOR.test(String(n.value)) ? null : { message: "Invalid color in CSS value" };
    case "String":
      return safeCssString(String(n.value)) ? null : { message: "Invalid string in CSS value" };
    case "Operator":
      return OPERATORS.has(String(n.value).trim())
        ? null
        : { message: "Invalid operator in CSS value" };
    case "Parentheses":
      return valueProblem(n.children, property, isCustom, depth + 1);
    case "Url": {
      const url = String(n.value);
      if (ASSET_REF_PATTERN.test(url) && (isCustom || CSS_ASSET_URL_PROPERTIES.has(property)))
        return null;
      if (FRAGMENT_REF.test(url) && (isCustom || CSS_FRAGMENT_URL_PROPERTIES.has(property)))
        return null;
      return { message: "Only asset: references are allowed in url()", url: true };
    }
    case "Function": {
      const name = String(n.name).toLowerCase();
      if (!CSS_FUNCTIONS.has(name)) {
        const loads = [
          "url",
          "image",
          "image-set",
          "-webkit-image-set",
          "src",
          "element",
          "cross-fade",
        ];
        return {
          message: `CSS function ${safeName(n.name)}() is not allowed`,
          url: loads.includes(name),
        };
      }
      if (name === "var") {
        const first = n.children.first;
        if (!first || first.type !== "Identifier" || !CUSTOM_PROPERTY.test(String(first.name))) {
          return { message: "Invalid var() reference" };
        }
      }
      return valueProblem(n.children, property, isCustom, depth + 1);
    }
    default:
      return { message: `Unsupported CSS value (${safeName(n.type)})` };
  }
}

/** Strings end up inside a `<style>` element or an attribute: refuse `<`, control characters and huge strings. */
function safeCssString(s: string): boolean {
  if (s.length > SANITIZER_LIMITS.maxCssStringLength) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x3c || c === 0x5c) return false;
  }
  return true;
}

/** Keeps only catalog and generic font families in `font-family` and in the family part of `font`. */
function sanitizeFontValue(property: string, value: Node, w: WarningCollector): string | null {
  const items: Node[] = value.children.toArray().filter((n: Node) => n.type !== "WhiteSpace");
  if (items.length === 1) {
    const only = items[0];
    if (only.type === "Function") return gen(value).trim(); // var(...) etc., validated already
    if (only.type === "Identifier" && CSS_WIDE_KEYWORDS.has(String(only.name).toLowerCase())) {
      return String(only.name);
    }
  }
  let prefix: Node[] = [];
  let families: Node[] = items;
  if (property === "font") {
    if (items.length === 1 && items[0].type === "Identifier") {
      const system = ["caption", "icon", "menu", "message-box", "small-caption", "status-bar"];
      if (system.includes(String(items[0].name).toLowerCase())) return String(items[0].name);
    }
    if (items.some((n) => n.type === "Function" && String(n.name).toLowerCase() === "var")) {
      return gen(value).trim();
    }
    const sizeAt = items.findIndex(
      (n) =>
        n.type === "Dimension" ||
        n.type === "Percentage" ||
        (n.type === "Function" && String(n.name).toLowerCase() !== "var") ||
        (n.type === "Identifier" &&
          /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller)$/i.test(
            String(n.name),
          )),
    );
    if (sizeAt < 0) {
      w.add("REMOVED_CSS_PROPERTY", "font shorthand without a size", property);
      return null;
    }
    let familyStart = sizeAt + 1;
    if (
      items[familyStart]?.type === "Operator" &&
      String(items[familyStart].value).trim() === "/"
    ) {
      familyStart += 2;
    }
    prefix = items.slice(0, familyStart);
    families = items.slice(familyStart);
  }
  const groups: Node[][] = [[]];
  for (const n of families) {
    if (n.type === "Operator" && String(n.value).trim() === ",") groups.push([]);
    else groups[groups.length - 1]?.push(n);
  }
  const kept: string[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    let name: string | null = null;
    if (group.length === 1 && group[0].type === "String") name = String(group[0].value);
    else if (group.every((n) => n.type === "Identifier"))
      name = group.map((n) => String(n.name)).join(" ");
    else if (group.length === 1 && group[0].type === "Function") {
      kept.push(gen(group[0]));
      continue;
    }
    if (name === null) {
      w.add("REMOVED_FONT_FAMILY", "Invalid font family", property);
      continue;
    }
    const lower = name.toLowerCase();
    if (GENERIC_FONT_FAMILIES.has(lower) && group[0].type === "Identifier") kept.push(lower);
    else if (CATALOG_FONTS.has(lower) || vendoredFonts?.has(lower) === true) {
      // Single-word names stay unquoted (`Inter`); multi-word names are quoted (`"Source Serif 4"`).
      const canonical = canonicalFont(lower);
      kept.push(IDENT.test(canonical) ? canonical : JSON.stringify(canonical));
    } else
      w.add(
        "REMOVED_FONT_FAMILY",
        "Font is not in the bundled catalog and was not vendored (add it with theme.googleFonts or a stylesheet URL)",
        name,
      );
  }
  if (kept.length === 0) {
    w.add("REMOVED_CSS_PROPERTY", "No allowed font family left", property);
    return null;
  }
  let prefixText = "";
  let afterOperator = false;
  for (const n of prefix) {
    if (n.type === "Operator") {
      prefixText += String(n.value).trim();
      afterOperator = true;
    } else {
      prefixText += (prefixText && !afterOperator ? " " : "") + gen(n);
      afterOperator = false;
    }
  }
  return (prefixText ? `${prefixText} ` : "") + kept.join(",");
}

function canonicalFont(lower: string): string {
  return FONT_CATALOG.find((f) => f.toLowerCase() === lower) ?? vendoredFonts?.get(lower) ?? lower;
}

/**
 * Families vendored into the deck (`theme.fontFaces`, ADR-022), lowercase name → canonical name, accepted like
 * the bundled catalog while {@link withVendoredFonts} runs. Sanitizing is synchronous, so a scoped module value is
 * enough and keeps every internal signature unchanged.
 */
let vendoredFonts: ReadonlyMap<string, string> | null = null;

const VENDORED_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

/** Runs `work` with `families` accepted in `font-family`/`font` values (invalid names are ignored). */
export function withVendoredFonts<T>(families: readonly string[], work: () => T): T {
  const previous = vendoredFonts;
  const map = new Map<string, string>();
  for (const family of families) {
    if (typeof family === "string" && VENDORED_FAMILY.test(family)) {
      map.set(family.toLowerCase(), family);
    }
  }
  vendoredFonts = map.size > 0 ? map : null;
  try {
    return work();
  } finally {
    vendoredFonts = previous;
  }
}

/** Parses a standalone CSS value (used for SVG presentation attributes). */
export function parseCssValue(text: string): Node | null {
  if (exceedsNesting(text, SANITIZER_LIMITS.maxCssNesting)) return null;
  try {
    const ast = parse(text, "value");
    return ast.type === "Value" ? ast : null;
  } catch {
    return null;
  }
}
