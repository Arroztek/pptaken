// SPDX-License-Identifier: Apache-2.0
// Core of the postMessage protocol between the shell (trusted page) and the runtime (sandboxed content iframe):
// message types, limits and the validator of shell -> iframe messages. No dependencies besides types: this
// module is compiled into the runtime bundle. The public module is `protocol.ts`, which re-exports it and adds
// the validator of iframe -> shell messages.
//
// Every message is a plain object with exactly the listed keys, `v: 1` and a known `type`. Anything else
// (unknown type, extra key, wrong version, out-of-range number) is dropped by the receiver.

import type { KeyCode } from "./keys.js";

export const PROTOCOL_VERSION = 1;

/** Maximum number of slides in a deck (same as `LIMITS.maxSlides` in `@pptaken/schema`; a unit test checks it). */
export const MAX_SLIDES = 200;

/** Maximum number of steps of one slide. The runtime merges any extra steps into the last one. */
export const MAX_STEPS = 255;

/**
 * Display modes, set only by the shell: `present` (one slide, steps revealed one by one), `overview` (every slide
 * as a thumbnail, fully revealed; `goto` moves the highlight) and `print` (every slide with every step, stacked one
 * canvas per page).
 */
export const MODES = ["present", "overview", "print"] as const;
export type Mode = (typeof MODES)[number];

/**
 * Columns of the overview grid for a deck of `count` slides. Shared by the runtime (layout) and the shell
 * (ArrowUp/ArrowDown move by one row), so it depends on the slide count only.
 */
export function overviewColumns(count: number): number {
  return Math.max(Math.min(Math.ceil(Math.sqrt(count * 1.2)), 6, count), 1);
}

export interface SlideInfo {
  id: string;
  /** Number of steps (advances) of the slide; 0 when it has no `data-step` elements. */
  steps: number;
}

// shell -> iframe

/** Show `slide` (0-based index) with its first `step` steps revealed. */
export interface GotoMessage {
  v: 1;
  type: "goto";
  slide: number;
  step: number;
}

export interface ModeMessage {
  v: 1;
  type: "mode";
  mode: Mode;
}

export type ShellMessage = GotoMessage | ModeMessage;

// iframe -> shell

/** Sent once when the runtime has read the document. `width`/`height`: the logical canvas in CSS pixels. */
export interface ReadyMessage {
  v: 1;
  type: "ready";
  slides: SlideInfo[];
  width: number;
  height: number;
}

/** A slide clicked in the overview. The shell accepts it only while it has the overview open. */
export interface SelectMessage {
  v: 1;
  type: "select";
  slide: number;
}

/** A key pressed while the iframe has focus. */
export interface KeyMessage {
  v: 1;
  type: "key";
  code: KeyCode;
}

/** Sent after a `goto` was applied: what the iframe now shows. */
export interface StateMessage {
  v: 1;
  type: "state";
  slide: number;
  step: number;
}

/** What a preload failure can be. A closed set: no URL or other content-controlled text ever travels. */
export const PRELOAD_FAILURES = [
  "image-error",
  "image-timeout",
  "font-error",
  "font-timeout",
] as const;
export type PreloadFailure = (typeof PRELOAD_FAILURES)[number];
/** At most this many entries in `failed` (the runtime stops listing after it; `ok` stays false). */
export const MAX_PRELOAD_FAILED = 16;
/** Largest `images` / `fonts` count accepted in `preload`. */
export const MAX_PRELOAD_COUNT = 10_000;

/**
 * Sent once after `ready`, when every image of every slide has been decoded and every declared font face has
 * loaded (or failed, or the preload budget ran out). `images` and `fonts` count the resources now in memory;
 * `ok` is true exactly when `failed` is empty.
 */
export interface PreloadMessage {
  v: 1;
  type: "preload";
  ok: boolean;
  images: number;
  fonts: number;
  failed: PreloadFailure[];
}

/**
 * Script mode only (ADR-020): the runtime's first message, posted on `window` from `<head>` before any author
 * script exists, transfers a private `MessagePort`. Every later runtime message travels on that port; the shell
 * ignores every other message from the frame.
 */
export interface HelloMessage {
  v: 1;
  type: "hello";
}

/** Script mode only: the runtime's heartbeat, every second (the shell's watchdog). */
export interface BeatMessage {
  v: 1;
  type: "beat";
}

/**
 * Where an author-script failure happened (ADR-023): `setup` (the slide's `function (slide) {…}` threw),
 * `handler` (an event handler, a timer, onEnter/onLeave/onStep, or a script/worker the content security policy
 * blocked), `rejection` (an unhandled promise rejection) and `script-load` (a script that did not parse or threw at
 * its top level, the deck-level script included). The shell adds `watchdog` itself.
 */
export const ERROR_KINDS = ["setup", "handler", "rejection", "script-load"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** Bounds of the text of an `error` message (UTF-16 code units) and of its counter. */
export const MAX_ERROR_NAME = 60;
export const MAX_ERROR_MESSAGE = 300;
export const MAX_ERROR_STACK = 400;
export const MAX_ERROR_COUNT = 1_000_000;

/**
 * Script mode only: author code failed (ADR-023). `slide` is the 0-based slide index, or `-1` for the deck-level
 * script and failures that cannot be attributed. `name`, `message` and `stack` (first lines) are bounded, cleaned
 * text produced by UNTRUSTED code: the shell validates and cleans them again and only ever shows them as text.
 * `count` is the number of occurrences of this same error (kind, slide, name, message) so far in this page.
 */
export interface ErrorMessage {
  v: 1;
  type: "error";
  slide: number;
  kind: ErrorKind;
  name: string;
  message: string;
  stack: string;
  count: number;
}

/** Bidi controls, zero-width and other invisible format characters. */
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** URLs in stacks carry the signed content token: each becomes `<deck>`, keeping `:line:column`. */
const URLS =
  /\b(?:(?:blob:)?(?:https?|blob|file):\/\/|(?:data|about):(?=\S))[^\s)'"<>]*?((?::\d+){1,2})?(?=[\s)'"<>]|$)/g;

/**
 * Makes untrusted error text safe to carry and show: strings only; URLs redacted; control, bidi and invisible
 * characters removed (line breaks too unless `keepLines`, which keeps at most 4 lines); truncated to `max`.
 * Used by the runtime (best effort: author code shares its realm) and again by the shell (the real check).
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

export type ContentMessage =
  | ReadyMessage
  | KeyMessage
  | StateMessage
  | SelectMessage
  | PreloadMessage
  | BeatMessage
  | ErrorMessage;

export type Fields = Record<string, unknown>;

/** A plain object (as produced by structured clone) with exactly these own keys. */
export function exactObject(data: unknown, keys: readonly string[]): Fields | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  if (Object.getPrototypeOf(data) !== Object.prototype) return null;
  const fields = data as Fields;
  if (Object.keys(fields).length !== keys.length) return null;
  for (const key of keys) if (!Object.hasOwn(fields, key)) return null;
  return fields;
}

/** An exact object with `v: 1`, this `type` and these other keys. */
export function envelope(data: unknown, type: string, keys: readonly string[]): Fields | null {
  const fields = exactObject(data, ["v", "type", ...keys]);
  return fields && fields.v === PROTOCOL_VERSION && fields.type === type ? fields : null;
}

export function typeOf(data: unknown): unknown {
  return typeof data === "object" && data !== null ? (data as Fields).type : undefined;
}

/** Integer in `[0, max]`. */
export function isBoundedInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/** Validates a message received by the runtime. Returns a fresh copy, or `null` to drop it. */
export function parseShellMessage(data: unknown): ShellMessage | null {
  const type = typeOf(data);
  if (type === "goto") {
    const m = envelope(data, type, ["slide", "step"]);
    if (!m || !isBoundedInt(m.slide, MAX_SLIDES - 1) || !isBoundedInt(m.step, MAX_STEPS))
      return null;
    return { v: 1, type, slide: m.slide, step: m.step };
  }
  if (type === "mode") {
    const m = envelope(data, type, ["mode"]);
    if (!m || !(MODES as readonly unknown[]).includes(m.mode)) return null;
    return { v: 1, type, mode: m.mode as Mode };
  }
  return null;
}
