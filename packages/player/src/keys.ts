// SPDX-License-Identifier: Apache-2.0
// Keyboard mapping shared by the shell (parent page) and the runtime (inside the content iframe), so both sides
// recognise exactly the same keys. This module has no imports: it is also compiled into the runtime bundle.

/**
 * Closed set of key codes that the runtime forwards to the shell. They are logical names derived from
 * `KeyboardEvent.key` (layout aware), not physical `KeyboardEvent.code` values. The runtime does not need the
 * list itself, so the array (`KEY_CODES`) lives in `protocol.ts`, which checks it against this type.
 */
export type KeyCode =
  | "ArrowRight"
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowDown"
  | "PageDown"
  | "PageUp"
  | "Space"
  | "ShiftSpace"
  | "Enter"
  | "Backspace"
  | "Home"
  | "End"
  | "KeyB"
  | "Period"
  | "KeyF"
  | "KeyO"
  | "KeyS"
  | "KeyP"
  | "KeyT"
  | "KeyR"
  | "KeyK"
  | "ShiftKeyR"
  | "Escape"
  | "Question";

/** The subset of `KeyboardEvent` that the mapping reads. */
export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

/**
 * Maps a keyboard event to a key code, or `null` when the player must ignore it. Keys with Ctrl, Alt or Meta are
 * always ignored (they belong to the browser and the OS). Shift is ignored too, except Shift+Space (previous),
 * Shift+R (reset the presenter clock) and `?` (which needs Shift on most layouts).
 */
export function keyCodeOf(event: KeyLike): KeyCode | null {
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing === true) return null;
  const k = event.key;
  if (k === " " || k === "Spacebar") return event.shiftKey ? "ShiftSpace" : "Space";
  if (k === "?") return "Question";
  if (event.shiftKey) return k === "R" || k === "r" ? "ShiftKeyR" : null;
  switch (k) {
    case "ArrowRight":
    case "ArrowLeft":
    case "ArrowUp":
    case "ArrowDown":
    case "PageDown":
    case "PageUp":
    case "Enter":
    case "Backspace":
    case "Home":
    case "End":
    case "Escape":
      return k;
    case ".":
      return "Period";
    default:
      return LETTERS.get(k.toLowerCase()) ?? null;
  }
}

/** Letter keys, case-insensitive (Caps Lock on still works). */
const LETTERS = new Map<string, KeyCode>([
  ["b", "KeyB"],
  ["f", "KeyF"],
  ["o", "KeyO"],
  ["s", "KeyS"],
  ["p", "KeyP"],
  ["t", "KeyT"],
  ["r", "KeyR"],
  ["k", "KeyK"],
]);
