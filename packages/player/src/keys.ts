// SPDX-License-Identifier: Apache-2.0
// Keyboard mapping shared by the shell (parent page) and the runtime (inside the content iframe), so both sides
// recognise exactly the same keys. This module has no imports: it is also compiled into the runtime bundle.

/**
 * Closed set of key codes that the runtime forwards to the shell. They are logical names derived from
 * `KeyboardEvent.key` (layout aware), not physical `KeyboardEvent.code` values.
 */
export const KEY_CODES = [
  "ArrowRight",
  "ArrowLeft",
  "ArrowUp",
  "ArrowDown",
  "PageDown",
  "PageUp",
  "Space",
  "ShiftSpace",
  "Enter",
  "Backspace",
  "Home",
  "End",
  "KeyB",
  "Period",
  "KeyF",
] as const;

export type KeyCode = (typeof KEY_CODES)[number];

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
 * always ignored (they belong to the browser and the OS); Shift is ignored too, except Shift+Space (previous).
 */
export function keyCodeOf(event: KeyLike): KeyCode | null {
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing === true) return null;
  if (event.key === " " || event.key === "Spacebar") return event.shiftKey ? "ShiftSpace" : "Space";
  if (event.shiftKey) return null;
  switch (event.key) {
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
      return event.key;
    case "b":
    case "B":
      return "KeyB";
    case ".":
      return "Period";
    case "f":
    case "F":
      return "KeyF";
    default:
      return null;
  }
}
