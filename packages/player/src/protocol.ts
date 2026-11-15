// SPDX-License-Identifier: Apache-2.0
// The postMessage protocol between the shell (trusted page) and the runtime (sandboxed content iframe), version 1.
// Hand-written strict validators, no dependencies. Message types and the shell -> iframe validator live in
// `messages.ts` (compiled into the runtime); this module adds the iframe -> shell validator used by the shell.
//
//   shell -> iframe   goto {slide, step}      mode {mode: "present" | "overview" | "print"}
//   iframe -> shell   ready {slides: [{id, steps}], width, height}   key {code}   state {slide, step}
//                     select {slide}   (a slide clicked in the overview)
//                     preload {ok, images, fonts, failed}   (once, after ready: what is in memory)
//
// All messages carry `v: 1` and `type`. Slides are 0-based indexes; `step` is the number of revealed steps.

import type { KeyCode } from "./keys.js";
import {
  type ContentMessage,
  envelope,
  exactObject,
  isBoundedInt,
  MAX_PRELOAD_COUNT,
  MAX_PRELOAD_FAILED,
  MAX_SLIDES,
  MAX_STEPS,
  PRELOAD_FAILURES,
  type PreloadFailure,
  type SlideInfo,
  typeOf,
} from "./messages.js";

export {
  type ContentMessage,
  type GotoMessage,
  isBoundedInt,
  type KeyMessage,
  MAX_PRELOAD_COUNT,
  MAX_PRELOAD_FAILED,
  MAX_SLIDES,
  MAX_STEPS,
  MODES,
  type Mode,
  type ModeMessage,
  overviewColumns,
  PRELOAD_FAILURES,
  PROTOCOL_VERSION,
  type PreloadFailure,
  type PreloadMessage,
  parseShellMessage,
  type ReadyMessage,
  type SelectMessage,
  type ShellMessage,
  type SlideInfo,
  type StateMessage,
} from "./messages.js";

/** Slide id alphabet of `@pptaken/schema`. */
export const SLIDE_ID_PATTERN = /^[a-z0-9-]{1,40}$/;

/** Largest canvas side accepted in `ready` (the schema's canvases are 1920×1080 and 1440×1080). */
export const MAX_CANVAS = 4096;

// Every key code exactly once: the Record type makes a missing or unknown code a compile error.
const KEY_SET: Readonly<Record<KeyCode, true>> = {
  ArrowRight: true,
  ArrowLeft: true,
  ArrowUp: true,
  ArrowDown: true,
  PageDown: true,
  PageUp: true,
  Space: true,
  ShiftSpace: true,
  Enter: true,
  Backspace: true,
  Home: true,
  End: true,
  KeyB: true,
  Period: true,
  KeyF: true,
  KeyO: true,
  KeyS: true,
  KeyP: true,
  KeyT: true,
  ShiftKeyR: true,
  Escape: true,
  Question: true,
};

/** The closed set of key codes the runtime may forward (`key` messages). */
export const KEY_CODES: readonly KeyCode[] = Object.freeze(Object.keys(KEY_SET) as KeyCode[]);

function parseSlides(value: unknown): SlideInfo[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SLIDES) return null;
  const seen = new Set<string>();
  const slides: SlideInfo[] = [];
  for (const item of value) {
    const s = exactObject(item, ["id", "steps"]);
    if (!s || typeof s.id !== "string" || !SLIDE_ID_PATTERN.test(s.id) || seen.has(s.id))
      return null;
    if (!isBoundedInt(s.steps, MAX_STEPS)) return null;
    seen.add(s.id);
    slides.push({ id: s.id, steps: s.steps });
  }
  return slides;
}

const isSide = (value: unknown): value is number => isBoundedInt(value, MAX_CANVAS) && value > 0;

/** Validates a message received by the shell. Returns a fresh copy, or `null` to drop it. */
export function parseContentMessage(data: unknown): ContentMessage | null {
  switch (typeOf(data)) {
    case "ready": {
      const m = envelope(data, "ready", ["slides", "width", "height"]);
      const slides = m ? parseSlides(m.slides) : null;
      if (!m || !slides || !isSide(m.width) || !isSide(m.height)) return null;
      return { v: 1, type: "ready", slides, width: m.width, height: m.height };
    }
    case "key": {
      const m = envelope(data, "key", ["code"]);
      if (!m || !(KEY_CODES as readonly unknown[]).includes(m.code)) return null;
      return { v: 1, type: "key", code: m.code as KeyCode };
    }
    case "state": {
      const m = envelope(data, "state", ["slide", "step"]);
      if (!m || !isBoundedInt(m.slide, MAX_SLIDES - 1) || !isBoundedInt(m.step, MAX_STEPS)) {
        return null;
      }
      return { v: 1, type: "state", slide: m.slide, step: m.step };
    }
    case "select": {
      const m = envelope(data, "select", ["slide"]);
      if (!m || !isBoundedInt(m.slide, MAX_SLIDES - 1)) return null;
      return { v: 1, type: "select", slide: m.slide };
    }
    case "preload": {
      const m = envelope(data, "preload", ["ok", "images", "fonts", "failed"]);
      if (!m || typeof m.ok !== "boolean") return null;
      if (!isBoundedInt(m.images, MAX_PRELOAD_COUNT) || !isBoundedInt(m.fonts, MAX_PRELOAD_COUNT))
        return null;
      const failed = parseFailures(m.failed);
      if (!failed || m.ok !== (failed.length === 0)) return null;
      return { v: 1, type: "preload", ok: m.ok, images: m.images, fonts: m.fonts, failed };
    }
    default:
      return null;
  }
}

function parseFailures(value: unknown): PreloadFailure[] | null {
  if (!Array.isArray(value) || value.length > MAX_PRELOAD_FAILED) return null;
  const out: PreloadFailure[] = [];
  for (const item of value) {
    if (!(PRELOAD_FAILURES as readonly unknown[]).includes(item)) return null;
    out.push(item as PreloadFailure);
  }
  return out;
}
