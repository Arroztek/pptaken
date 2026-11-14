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

/** Display modes. Only `present` exists in F1; `overview` and `print` are reserved for F3. */
export const MODES = ["present"] as const;
export type Mode = (typeof MODES)[number];

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

/** Sent once when the runtime has read the document. */
export interface ReadyMessage {
  v: 1;
  type: "ready";
  slides: SlideInfo[];
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

export type ContentMessage = ReadyMessage | KeyMessage | StateMessage;

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
