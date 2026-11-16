// SPDX-License-Identifier: Apache-2.0
// Pure navigation over a deck shape: which position comes next. No DOM, no state.
//
// A position is `{ slide, step }`: `slide` is a 0-based index and `step` is the number of revealed steps of that
// slide (0 = none revealed, `steps` = all revealed).

import type { KeyCode } from "./keys.js";

export type KeyAction =
  | "next"
  | "prev"
  | "first"
  | "last"
  | "black"
  | "fullscreen"
  | "overview"
  | "presenter"
  | "print"
  | "clock"
  | "clockReset"
  | "remote"
  | "kick"
  | "close"
  | "help";

/**
 * What each key does in present mode. HID clickers send PageDown/PageUp, and `b` or `.` for a black screen.
 * `clock` and `clockReset` act in the presenter view only; `remote` (the phone pairing panel) and `kick`
 * (disconnect every remote) are handled by the page through `onKey` (remote control, F4); the overview remaps
 * arrows, Enter and Escape.
 */
export const KEY_ACTIONS: Readonly<Record<KeyCode, KeyAction>> = {
  ArrowRight: "next",
  ArrowDown: "next",
  PageDown: "next",
  Space: "next",
  Enter: "next",
  ArrowLeft: "prev",
  ArrowUp: "prev",
  PageUp: "prev",
  Backspace: "prev",
  ShiftSpace: "prev",
  Home: "first",
  End: "last",
  KeyB: "black",
  Period: "black",
  KeyF: "fullscreen",
  KeyO: "overview",
  KeyS: "presenter",
  KeyP: "print",
  KeyT: "clock",
  ShiftKeyR: "clockReset",
  KeyR: "remote",
  KeyK: "kick",
  Escape: "close",
  Question: "help",
};

/**
 * Moves the overview highlight: ArrowLeft/ArrowRight by one slide, ArrowUp/ArrowDown by one row of `columns`,
 * Home/End to the ends (clamped). Returns `null` for keys the overview does not use for moving.
 */
export function overviewMove(
  count: number,
  columns: number,
  index: number,
  code: KeyCode,
): number | null {
  const last = Math.max(count - 1, 0);
  const at = (i: number) => Math.min(Math.max(i, 0), last);
  switch (code) {
    case "ArrowRight":
    case "PageDown":
    case "Space":
      return at(index + 1);
    case "ArrowLeft":
    case "PageUp":
    case "ShiftSpace":
    case "Backspace":
      return at(index - 1);
    case "ArrowDown":
      return index + columns <= last ? index + columns : index;
    case "ArrowUp":
      return index - columns >= 0 ? index - columns : index;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

export interface Position {
  slide: number;
  step: number;
}

export interface DeckShape {
  readonly slides: readonly { readonly steps: number }[];
}

function stepsOf(shape: DeckShape, slide: number): number {
  const steps = shape.slides[slide]?.steps ?? 0;
  return Number.isInteger(steps) && steps > 0 ? steps : 0;
}

function toInt(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** The nearest valid position. An empty deck has only `{ slide: 0, step: 0 }`. */
export function clamp(shape: DeckShape, position: Position): Position {
  const count = shape.slides.length;
  if (count === 0) return { slide: 0, step: 0 };
  const slide = Math.min(Math.max(toInt(position.slide), 0), count - 1);
  const step = Math.min(Math.max(toInt(position.step), 0), stepsOf(shape, slide));
  return { slide, step };
}

/** Reveals the next step, or moves to the next slide with no step revealed. Stays at the end. */
export function next(shape: DeckShape, position: Position): Position {
  const p = clamp(shape, position);
  if (p.step < stepsOf(shape, p.slide)) return { slide: p.slide, step: p.step + 1 };
  if (p.slide < shape.slides.length - 1) return { slide: p.slide + 1, step: 0 };
  return p;
}

/** Hides the last revealed step, or moves to the previous slide with all its steps revealed. Stays at the start. */
export function prev(shape: DeckShape, position: Position): Position {
  const p = clamp(shape, position);
  if (p.step > 0) return { slide: p.slide, step: p.step - 1 };
  if (p.slide > 0) return { slide: p.slide - 1, step: stepsOf(shape, p.slide - 1) };
  return p;
}

/** First slide, no step revealed. */
export function first(_shape: DeckShape): Position {
  return { slide: 0, step: 0 };
}

/** Last slide with all its steps revealed (the end of the talk). */
export function last(shape: DeckShape): Position {
  const slide = Math.max(shape.slides.length - 1, 0);
  return { slide, step: stepsOf(shape, slide) };
}

export function samePosition(a: Position, b: Position): boolean {
  return a.slide === b.slide && a.step === b.step;
}

/** True at the end of the talk: the last slide with all its steps revealed (`next` stays put). */
export function isEnd(shape: DeckShape, position: Position): boolean {
  if (shape.slides.length === 0) return false;
  return samePosition(clamp(shape, position), last(shape));
}

const HASH = /^#\/([0-9]{1,6})(?:\/([0-9]{1,6}))?\/?$/;

/**
 * Parses a URL hash `#/<slide>/<step>` (slide 1-based, step 0-based; the step is optional). Returns a 0-based
 * position that may still be out of range (use `clamp`), or `null` when the hash does not have that shape.
 */
export function parseHash(hash: string): Position | null {
  const m = HASH.exec(hash);
  if (!m) return null;
  return { slide: Number(m[1]) - 1, step: m[2] === undefined ? 0 : Number(m[2]) };
}

/** Formats a 0-based position as `#/<slide 1-based>/<step>`. */
export function formatHash(position: Position): string {
  return `#/${position.slide + 1}/${position.step}`;
}
