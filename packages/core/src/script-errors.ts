// SPDX-License-Identifier: AGPL-3.0-or-later
// Script error visibility (ADR-023), pure part: bounds, the text cleaner applied to every field reported by the
// owner's player, the dedupe fingerprint and the plain-language hint codes. Every text here comes from code running
// in the sandboxed frame: it is untrusted data, never instructions, and is only ever shown as plain text.
import type { ScriptErrorKind } from "./ports.js";
import { sha256Hex, utf8Encode } from "./sha256.js";

export const SCRIPT_ERROR_KINDS: readonly ScriptErrorKind[] = [
  "setup",
  "handler",
  "rejection",
  "script-load",
  "watchdog",
];

export const SCRIPT_ERROR_LIMITS = {
  /** Characters kept of an error name. */
  name: 60,
  /** Characters kept of a message. */
  message: 300,
  /** Characters kept of the first stack line(s). */
  stack: 400,
  /** Distinct errors kept per deck and digest (the oldest seen is evicted). */
  perDigest: 30,
  /** Errors accepted in one report. */
  perReport: 20,
  /** Largest occurrence count added by one entry of a report. */
  countPerEntry: 10_000,
  /** Counts saturate here. */
  maxCount: 1_000_000,
  /** Items returned to an agent (`get_presentation`) per list. */
  forAgent: 10,
  /** Characters of a message returned to an agent. */
  agentMessage: 200,
} as const;

/** Bidi controls, zero-width and other invisible format characters (Trojan-source style text). */
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/**
 * URLs in stack traces carry the signed content token (`?ct=…`). Every URL becomes `<deck>`, keeping the
 * `:line:column` suffix.
 */
const URLS =
  /\b(?:(?:blob:)?(?:https?|blob|file):\/\/|(?:data|about):(?=\S))[^\s)'"<>]*?((?::\d+){1,2})?(?=[\s)'"<>]|$)/g;

/**
 * Makes untrusted error text safe to store and show: only strings; URLs redacted; control, bidi and invisible
 * characters removed (newlines too, unless `keepLines`); whitespace collapsed; truncated to `max` with an ellipsis.
 */
export function cleanErrorText(value: unknown, max: number, keepLines = false): string {
  if (typeof value !== "string") return "";
  let text = value.length > max * 4 ? value.slice(0, max * 4) : value;
  text = text
    .replace(LONE_SURROGATE, "")
    .replace(INVISIBLE, "")
    .replace(URLS, (_m, pos: string | undefined) => `<deck>${pos ?? ""}`);
  if (keepLines) {
    text = text
      .split(/\r\n?|\n/)
      .map((line) => line.replace(/\t/g, " ").replace(CONTROL, "").replace(/ {2,}/g, " ").trim())
      .filter((line) => line !== "")
      .slice(0, 4)
      .join("\n");
  } else {
    text = text
      .replace(/[\t\r\n]/g, " ")
      .replace(CONTROL, "")
      .replace(/ {2,}/g, " ")
      .trim();
  }
  if (text.length > max) text = `${text.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "")}…`;
  return text;
}

/** The dedupe key of an error within a digest. */
export function scriptErrorFingerprint(e: {
  kind: string;
  slideId: string;
  name: string;
  message: string;
}): string {
  return sha256Hex(utf8Encode(JSON.stringify([e.kind, e.slideId, e.name, e.message])));
}

/** Plain-language hint codes for the most common mistakes (the panel and the agent map them to text). */
export type ScriptErrorHint =
  | "declare-root"
  | "slide-api"
  | "selector-missed"
  | "network-disabled"
  | "blocked-api"
  | "syntax"
  | "frozen"
  | null;

export function scriptErrorHint(e: {
  kind: string;
  name: string;
  message: string;
}): ScriptErrorHint {
  const m = e.message;
  if (e.kind === "watchdog") return "frozen";
  if (/\broot\b/.test(m) && /not defined|undefined variable|Can't find variable/i.test(m))
    return "declare-root";
  if (/\b(onEnter|onLeave|onStep|setSteps)\b/.test(m) && /not defined|Can't find variable/i.test(m))
    return "slide-api";
  // Lower-case match: the names are only data here (the core does no I/O; see its dependency rules test).
  if (
    /\b(fetch|xmlhttprequest|websocket|eventsource|sendbeacon|rtcpeerconnection|webtransport)\b/.test(
      m.toLowerCase(),
    )
  )
    return "network-disabled";
  if (
    /\b(eval|Function|Worker|importScripts|document\.write|Trusted ?Type|TrustedScript|TrustedHTML|content security policy|Content Security Policy|blocked by the player)\b/i.test(
      m,
    )
  )
    return "blocked-api";
  if (
    /of null|is null|null \(reading|null has no properties|undefined \(reading|of undefined|is undefined/i.test(
      m,
    )
  )
    return "selector-missed";
  if (e.name === "SyntaxError") return "syntax";
  return null;
}

/** English text of each hint, for the agent (`get_presentation`) and the copied summary. */
export const SCRIPT_ERROR_HINT_TEXT: Readonly<Record<Exclude<ScriptErrorHint, null>, string>> = {
  "declare-root":
    "root is a property of the slide argument: start the slide script with `var root = slide.root;`.",
  "slide-api":
    "onEnter, onLeave, onStep and setSteps are properties of slide: call slide.onEnter(…).",
  "selector-missed":
    "A selector did not match an element in the slide html (querySelector returned null): check the ids and classes the script looks for.",
  "network-disabled":
    "The network is disabled in the player: put the data in the deck instead of fetching it.",
  "blocked-api":
    "This API is blocked in the player (eval, new Function, workers, document.write, script/iframe markup).",
  syntax: "The script does not parse: fix the syntax error (brackets, quotes, commas).",
  frozen:
    "The script kept the page busy for more than 3 seconds (an endless or very long loop): the player switched to the static version.",
};
