// SPDX-License-Identifier: AGPL-3.0-or-later
// Static check of author scripts (interactive mode, ADR-023). A conservative, bounded scan with a real JavaScript
// parser (acorn, MIT, pinned) that finds the mistakes a context-free agent makes most often, so the write result can
// tell it right away instead of the owner discovering a silently static deck:
//
//   SCRIPT_SYNTAX_ERROR          the script does not parse (it never runs)
//   SCRIPT_UNDECLARED_ROOT       a bare `root` with no declaration (ReferenceError at setup: the real incident)
//   SCRIPT_UNDECLARED_SLIDE_API  a bare `onEnter`/`onLeave`/`onStep`/`setSteps` (they are properties of `slide`)
//   SCRIPT_BLOCKED_API           fetch, XMLHttpRequest, WebSocket, eval, Function, workers, document.write, script
//                                markup through innerHTML... (blocked by the player's lockdown, CSP or Trusted Types)
//   SCRIPT_MARKUP                "<script", "</script" or "<!--" in the text (the schema refuses them anyway)
//   SCRIPT_CHECK_SKIPPED         the check gave up (size, node or time budget, parser recursion limit)
//
// Every finding is a non-fatal warning. "Conservative" means it prefers missing a mistake to reporting a false one:
// a name declared ANYWHERE in the script (any scope) is treated as declared. It never executes the code.
import { parse } from "acorn";

export const SCRIPT_CHECK_CODES = [
  "SCRIPT_SYNTAX_ERROR",
  "SCRIPT_UNDECLARED_ROOT",
  "SCRIPT_UNDECLARED_SLIDE_API",
  "SCRIPT_BLOCKED_API",
  "SCRIPT_MARKUP",
  "SCRIPT_CHECK_SKIPPED",
] as const;

export type ScriptCheckCode = (typeof SCRIPT_CHECK_CODES)[number];

export interface ScriptIssue {
  code: ScriptCheckCode;
  /** One sentence with the fix, safe to show to an agent or a person (no script text beyond a short name). */
  message: string;
  /** 1-based line in the author's script (the wrapper line is not counted). */
  line?: number;
  /** 0-based column. */
  column?: number;
  /** The offending identifier or API, when there is one. */
  name?: string;
}

/** Budgets: the scan is bounded in input size, AST nodes, findings and wall-clock time (no DoS through writes). */
export const SCRIPT_CHECK_LIMITS = {
  /** Characters checked per script; longer scripts are skipped (the schema allows 128 KB per slide). */
  maxChars: 256 * 1024,
  /** Characters checked per deck; the rest is skipped. */
  maxDeckChars: 1_200_000,
  /** AST nodes visited per script. */
  maxNodes: 200_000,
  /** Findings reported per script. */
  maxIssues: 10,
  /** Milliseconds for one deck; scripts after the budget are skipped. */
  maxDeckMs: 750,
} as const;

/** Slide-API names that exist only as properties of the `slide` argument. */
const SLIDE_API = new Set(["onEnter", "onLeave", "onStep", "setSteps"]);

/** Globals the player removes or makes throw (lockdown.ts, CSP, Trusted Types). */
const BLOCKED_GLOBALS: ReadonlyMap<string, string> = new Map([
  ["fetch", "network"],
  ["XMLHttpRequest", "network"],
  ["WebSocket", "network"],
  ["EventSource", "network"],
  ["WebTransport", "network"],
  ["RTCPeerConnection", "network"],
  ["webkitRTCPeerConnection", "network"],
  ["BroadcastChannel", "network"],
  ["Request", "network"],
  ["Worker", "workers"],
  ["SharedWorker", "workers"],
  ["importScripts", "workers"],
  ["eval", "eval"],
  ["Function", "eval"],
]);

/** Reported only when called (`new Function(…)`), not for `x instanceof Function`. */
const CALLEE_ONLY = new Set(["Function", "Request"]);

/** `<object>.<member>` uses that are blocked. */
const BLOCKED_MEMBERS: ReadonlyMap<string, string> = new Map([
  ["document.write", "document.write"],
  ["document.writeln", "document.write"],
  ["document.open", "document.write"],
  ["navigator.sendBeacon", "network"],
  ["window.open", "popups"],
]);

/** Global objects through which a blocked global can be reached (`window.fetch`). */
const GLOBAL_OBJECTS = new Set(["window", "self", "globalThis", "top", "parent", "frames"]);

/** Element names the lockdown and the Trusted Types policy refuse to create or parse. */
const BLOCKED_TAGS =
  /<\s*(?:script|link|meta|base|iframe|frame|object|embed|portal|fencedframe)\b/i;
const BLOCKED_TAG_NAMES = new Set([
  "script",
  "link",
  "meta",
  "base",
  "iframe",
  "frame",
  "object",
  "embed",
  "portal",
  "fencedframe",
]);

const HTML_SINKS = new Set(["innerHTML", "outerHTML"]);
const HTML_SINK_CALLS = new Set([
  "insertAdjacentHTML",
  "setHTMLUnsafe",
  "createContextualFragment",
]);

const WHY: Readonly<Record<string, string>> = {
  network: "the network is disabled in the player",
  workers: "workers are disabled in the player",
  eval: "eval and new Function are blocked by the content security policy",
  "document.write": "document.write is disabled in the player",
  popups: "popups are disabled in the player",
  markup: "script, link, meta, base, iframe, object and embed elements are refused",
  module: "dynamic import() is not supported (no ES modules, no network)",
  "string-timer": "string code in timers is blocked by the content security policy",
};

type AstNode = {
  type: string;
  start: number;
  loc?: { start: { line: number; column: number } };
} & Record<string, unknown>;

const isNode = (v: unknown): v is AstNode =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** Text of a string literal or a template literal without expressions' text (only the static parts). */
function staticText(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
    return (node.quasis as AstNode[])
      .map((q) => ((q.value as { cooked?: string | null } | undefined)?.cooked ?? "") as string)
      .join(" ");
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const l = staticText(node.left);
    const r = staticText(node.right);
    if (l === null && r === null) return null;
    return `${l ?? ""}${r ?? ""}`;
  }
  return null;
}

/** Name of `a.b` when both parts are plain identifiers (`a["b"]` with a string literal counts too). */
function memberName(node: AstNode): [string, string] | null {
  if (node.type !== "MemberExpression") return null;
  const object = node.object;
  const property = node.property;
  if (!isNode(object) || object.type !== "Identifier" || !isNode(property)) return null;
  if (!node.computed && property.type === "Identifier")
    return [object.name as string, property.name as string];
  if (node.computed && property.type === "Literal" && typeof property.value === "string")
    return [object.name as string, property.value];
  return null;
}

/** Adds every name bound by a pattern (`a`, `{a, b: c}`, `[d, ...e]`, `f = 1`). */
function bindNames(pattern: unknown, into: Set<string>): void {
  const stack: unknown[] = [pattern];
  let guard = 0;
  while (stack.length > 0 && guard++ < 10_000) {
    const p = stack.pop();
    if (!isNode(p)) continue;
    switch (p.type) {
      case "Identifier":
        into.add(p.name as string);
        break;
      case "ObjectPattern":
        for (const prop of (p.properties as AstNode[]) ?? []) {
          stack.push(prop.type === "RestElement" ? prop.argument : prop.value);
        }
        break;
      case "ArrayPattern":
        for (const el of (p.elements as unknown[]) ?? []) stack.push(el);
        break;
      case "AssignmentPattern":
        stack.push(p.left);
        break;
      case "RestElement":
        stack.push(p.argument);
        break;
    }
  }
}

/** Is this Identifier (reached from `parent[key]`) a reference to a variable, not a property name or label? */
function isReference(parent: AstNode | null, key: string): boolean {
  if (parent === null) return true;
  switch (parent.type) {
    case "MemberExpression":
      return key !== "property" || parent.computed === true;
    case "Property":
      // In an object pattern the value is a binding; shorthand values are references in expressions.
      return key === "value" || (key === "key" && parent.computed === true);
    case "MethodDefinition":
    case "PropertyDefinition":
      return key !== "key" || parent.computed === true;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return false;
    case "MetaProperty":
      return false;
    default:
      return true;
  }
}

interface Use {
  name: string;
  line: number;
  column: number;
  why?: string;
  kind: "free" | "blocked";
}

class Budget {
  nodes = 0;
  constructor(
    readonly maxNodes: number,
    readonly deadline: number,
  ) {}
}

class Skip extends Error {}

/**
 * Checks one author script. `kind: "slide"` parses it as the body of `function (slide) { … }` (exactly how the
 * player wraps it); `"deck"` as a classic script in the global scope. Never throws.
 */
export function checkScript(
  source: string,
  options: { kind: "slide" | "deck"; deadline?: number } = { kind: "slide" },
): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const lower = source.toLowerCase();
  if (lower.includes("<script") || lower.includes("</script") || lower.includes("<!--")) {
    issues.push({
      code: "SCRIPT_MARKUP",
      message:
        'The script contains "<script", "</script" or "<!--": it could escape its element and is refused. Inside strings write "<\\/script>" or build the text in parts.',
    });
    return issues;
  }
  if (source.length > SCRIPT_CHECK_LIMITS.maxChars) {
    return [skipped("the script is too long to check")];
  }
  const deadline = options.deadline ?? Date.now() + SCRIPT_CHECK_LIMITS.maxDeckMs;
  const slide = options.kind === "slide";
  // Same shape as the player's wrapper: the author's line 1 is line 2 of the parsed text.
  const text = slide ? `(function(slide){\n${source}\n})` : source;
  const offset = slide ? 1 : 0;
  let ast: AstNode;
  try {
    ast = parse(text, {
      ecmaVersion: "latest",
      sourceType: "script",
      locations: true,
      allowHashBang: false,
    }) as unknown as AstNode;
  } catch (error) {
    if (error instanceof SyntaxError) {
      const loc = (error as SyntaxError & { loc?: { line: number; column: number } }).loc;
      const raw = error.message.replace(/\s*\(\d+:\d+\)\s*$/, "");
      const line = loc ? Math.max(1, loc.line - offset) : undefined;
      const where = line === undefined ? "" : ` at line ${line}, column ${(loc?.column ?? 0) + 1}`;
      return [
        {
          code: "SCRIPT_SYNTAX_ERROR",
          message: `Syntax error${where}: ${raw.slice(0, 120)}. The script cannot run until it parses (check brackets, quotes and commas).`,
          ...(line === undefined ? {} : { line, column: loc?.column ?? 0 }),
        },
      ];
    }
    return [skipped("the parser reached its nesting limit")];
  }
  try {
    const uses = scan(ast, new Budget(SCRIPT_CHECK_LIMITS.maxNodes, deadline), offset);
    const seen = new Set<string>();
    for (const use of uses) {
      const issue = issueOf(use, slide);
      if (issue === null) continue;
      const key = `${issue.code}\u0000${use.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
      if (issues.length >= SCRIPT_CHECK_LIMITS.maxIssues) break;
    }
  } catch (error) {
    if (error instanceof Skip) return [...issues, skipped(error.message)];
    return [...issues, skipped("internal error")];
  }
  return issues;
}

function skipped(why: string): ScriptIssue {
  return {
    code: "SCRIPT_CHECK_SKIPPED",
    message: `The static check of this script was skipped (${why}). It was saved; test it in the player.`,
  };
}

function issueOf(use: Use, slide: boolean): ScriptIssue | null {
  const at = { line: use.line, column: use.column, name: use.name };
  if (use.kind === "blocked") {
    return {
      code: "SCRIPT_BLOCKED_API",
      message: `"${use.name}" (line ${use.line}) is blocked: ${WHY[use.why ?? ""] ?? "it is disabled in the player"}. The call throws at run time; put the data in the deck or remove the call.`,
      ...at,
    };
  }
  if (use.name === "root") {
    return {
      code: "SCRIPT_UNDECLARED_ROOT",
      message: slide
        ? `"root" is used at line ${use.line} but never declared: it throws "ReferenceError: root is not defined" and the slide stays static. Start the script with: var root = slide.root;`
        : `"root" is used at line ${use.line} in the deck script but never declared: the deck script has no slide; query the document instead.`,
      ...at,
    };
  }
  if (SLIDE_API.has(use.name)) {
    return {
      code: "SCRIPT_UNDECLARED_SLIDE_API",
      message: slide
        ? `"${use.name}" is used at line ${use.line} as a free variable: it is a property of the slide argument. Write slide.${use.name}(…).`
        : `"${use.name}" is used at line ${use.line} in the deck script: it exists only in slide scripts, as slide.${use.name}(…).`,
      ...at,
    };
  }
  return null;
}

/** Walks the tree once: collects declared names, free uses of slide-API names and blocked API uses. */
function scan(ast: AstNode, budget: Budget, offset: number): Use[] {
  const declared = new Set<string>();
  const candidates: Use[] = [];
  const blocked: Use[] = [];
  const pos = (n: AstNode) => ({
    line: Math.max(1, (n.loc?.start.line ?? 1) - offset),
    column: n.loc?.start.column ?? 0,
  });
  const stack: [AstNode, AstNode | null, string][] = [[ast, null, ""]];
  while (stack.length > 0) {
    const [node, parent, key] = stack.pop() as [AstNode, AstNode | null, string];
    if (++budget.nodes > budget.maxNodes) throw new Skip("too many syntax nodes");
    if ((budget.nodes & 1023) === 0 && Date.now() > budget.deadline) throw new Skip("time budget");
    switch (node.type) {
      case "VariableDeclarator":
        bindNames(node.id, declared);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (isNode(node.id)) bindNames(node.id, declared);
        for (const p of (node.params as unknown[]) ?? []) bindNames(p, declared);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (isNode(node.id)) bindNames(node.id, declared);
        break;
      case "CatchClause":
        if (isNode(node.param)) bindNames(node.param, declared);
        break;
      case "AssignmentExpression":
        // Sloppy-mode implicit globals (`root = slide.root`) work: count them as declarations.
        if (isNode(node.left) && node.left.type === "Identifier")
          declared.add(node.left.name as string);
        checkSink(node, blocked, pos);
        break;
      case "ImportExpression":
        blocked.push({ name: "import()", ...pos(node), why: "module", kind: "blocked" });
        break;
      case "CallExpression":
      case "NewExpression":
        checkCall(node, blocked, pos);
        break;
      case "MemberExpression": {
        const m = memberName(node);
        if (m !== null) {
          const why = BLOCKED_MEMBERS.get(`${m[0]}.${m[1]}`);
          if (why !== undefined)
            blocked.push({ name: `${m[0]}.${m[1]}`, ...pos(node), why, kind: "blocked" });
          else if (GLOBAL_OBJECTS.has(m[0]) && BLOCKED_GLOBALS.has(m[1])) {
            blocked.push({
              name: `${m[0]}.${m[1]}`,
              ...pos(node),
              why: BLOCKED_GLOBALS.get(m[1]) as string,
              kind: "blocked",
            });
          }
        }
        break;
      }
      case "Identifier": {
        if (!isReference(parent, key)) break;
        const name = node.name as string;
        if (name === "root" || SLIDE_API.has(name)) {
          candidates.push({ name, ...pos(node), kind: "free" });
        } else if (
          BLOCKED_GLOBALS.has(name) &&
          (!CALLEE_ONLY.has(name) ||
            ((parent?.type === "CallExpression" || parent?.type === "NewExpression") &&
              key === "callee"))
        ) {
          candidates.push({
            name,
            ...pos(node),
            why: BLOCKED_GLOBALS.get(name) as string,
            kind: "blocked",
          });
        }
        break;
      }
    }
    // Children, in source order (pushed reversed onto the stack).
    const children: [AstNode, AstNode, string][] = [];
    for (const k of Object.keys(node)) {
      if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const item of v) if (isNode(item)) children.push([item, node, k]);
      } else if (isNode(v)) {
        children.push([v, node, k]);
      }
    }
    for (let i = children.length - 1; i >= 0; i--)
      stack.push(children[i] as [AstNode, AstNode, string]);
  }
  const free = candidates.filter((u) => !declared.has(u.name));
  return [...free, ...blocked].sort((a, b) => a.line - b.line || a.column - b.column);
}

/** `el.innerHTML = "<script…"`, `el.outerHTML = …` with refused markup. */
function checkSink(
  node: AstNode,
  out: Use[],
  pos: (n: AstNode) => { line: number; column: number },
): void {
  const left = node.left;
  if (!isNode(left) || left.type !== "MemberExpression" || left.computed === true) return;
  const property = left.property;
  if (!isNode(property) || property.type !== "Identifier") return;
  if (!HTML_SINKS.has(property.name as string)) return;
  const text = staticText(node.right);
  if (text !== null && BLOCKED_TAGS.test(text)) {
    out.push({ name: property.name as string, ...pos(node), why: "markup", kind: "blocked" });
  }
}

/** `createElement("script")`, `insertAdjacentHTML(…, "<iframe…")`, `setTimeout("code")`, `document.write(…)`. */
function checkCall(
  node: AstNode,
  out: Use[],
  pos: (n: AstNode) => { line: number; column: number },
): void {
  const callee = node.callee;
  const args = (node.arguments as unknown[]) ?? [];
  if (!isNode(callee)) return;
  let name: string | null = null;
  if (callee.type === "Identifier") name = callee.name as string;
  else if (
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isNode(callee.property) &&
    callee.property.type === "Identifier"
  )
    name = callee.property.name as string;
  if (name === null) return;
  if (name === "createElement" || name === "createElementNS") {
    const tag = staticText(args[name === "createElement" ? 0 : 1]);
    if (tag !== null && BLOCKED_TAG_NAMES.has(tag.trim().toLowerCase())) {
      out.push({
        name: `${name}("${tag.trim().toLowerCase()}")`,
        ...pos(node),
        why: "markup",
        kind: "blocked",
      });
    }
  } else if (HTML_SINK_CALLS.has(name)) {
    const text = staticText(args[name === "insertAdjacentHTML" ? 1 : 0]);
    if (text !== null && BLOCKED_TAGS.test(text))
      out.push({ name, ...pos(node), why: "markup", kind: "blocked" });
  } else if (
    (name === "setTimeout" || name === "setInterval") &&
    callee.type === "Identifier" &&
    staticText(args[0]) !== null
  ) {
    out.push({ name: `${name}("…")`, ...pos(node), why: "string-timer", kind: "blocked" });
  }
}

/** One finding of {@link checkDeckScripts}, located in the deck. */
export interface DeckScriptIssue extends ScriptIssue {
  /** `script` (the deck-level script) or `slides[<index>].script`. */
  path: string;
  slideId?: string;
}

/**
 * Checks every script of a deck within the deck budgets (size and time): the deck-level script first, then each
 * slide script in deck order. Never throws.
 */
export function checkDeckScripts(deck: {
  script?: string | undefined;
  slides: readonly { id: string; script?: string | undefined }[];
}): DeckScriptIssue[] {
  const out: DeckScriptIssue[] = [];
  const deadline = Date.now() + SCRIPT_CHECK_LIMITS.maxDeckMs;
  let chars = 0;
  const run = (source: string, kind: "slide" | "deck", path: string, slideId?: string) => {
    chars += source.length;
    const issues =
      chars > SCRIPT_CHECK_LIMITS.maxDeckChars || Date.now() > deadline
        ? [skipped("the deck's check budget is used up")]
        : checkScript(source, { kind, deadline });
    for (const issue of issues)
      out.push({ ...issue, path, ...(slideId === undefined ? {} : { slideId }) });
  };
  if (deck.script !== undefined) run(deck.script, "deck", "script");
  deck.slides.forEach((slide, index) => {
    if (slide.script !== undefined) run(slide.script, "slide", `slides[${index}].script`, slide.id);
  });
  return out;
}
