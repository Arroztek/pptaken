// SPDX-License-Identifier: Apache-2.0
// The postMessage protocol between the shell (trusted page) and the runtime (sandboxed content iframe), version 1.
// Hand-written strict validators, no dependencies. Message types and the shell -> iframe validator live in
// `messages.ts` (compiled into the runtime); this module adds the iframe -> shell validator used by the shell.
//
//   shell -> iframe   goto {slide, step}      mode {mode: "present"}  ("overview" | "print" reserved for F3)
//   iframe -> shell   ready {slides: [{id, steps}]}   key {code}   state {slide, step}
//
// All messages carry `v: 1` and `type`. Slides are 0-based indexes; `step` is the number of revealed steps.

import { KEY_CODES } from "./keys.js";
import {
  type ContentMessage,
  envelope,
  exactObject,
  isBoundedInt,
  MAX_SLIDES,
  MAX_STEPS,
  type SlideInfo,
  typeOf,
} from "./messages.js";

export {
  type ContentMessage,
  type GotoMessage,
  isBoundedInt,
  type KeyMessage,
  MAX_SLIDES,
  MAX_STEPS,
  MODES,
  type Mode,
  type ModeMessage,
  PROTOCOL_VERSION,
  parseShellMessage,
  type ReadyMessage,
  type ShellMessage,
  type SlideInfo,
  type StateMessage,
} from "./messages.js";

/** Slide id alphabet of `@pptaken/schema`. */
export const SLIDE_ID_PATTERN = /^[a-z0-9-]{1,40}$/;

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

/** Validates a message received by the shell. Returns a fresh copy, or `null` to drop it. */
export function parseContentMessage(data: unknown): ContentMessage | null {
  switch (typeOf(data)) {
    case "ready": {
      const m = envelope(data, "ready", ["slides"]);
      const slides = m ? parseSlides(m.slides) : null;
      return slides ? { v: 1, type: "ready", slides } : null;
    }
    case "key": {
      const m = envelope(data, "key", ["code"]);
      if (!m || !(KEY_CODES as readonly unknown[]).includes(m.code)) return null;
      return { v: 1, type: "key", code: m.code as (typeof KEY_CODES)[number] };
    }
    case "state": {
      const m = envelope(data, "state", ["slide", "step"]);
      if (!m || !isBoundedInt(m.slide, MAX_SLIDES - 1) || !isBoundedInt(m.step, MAX_STEPS)) {
        return null;
      }
      return { v: 1, type: "state", slide: m.slide, step: m.step };
    }
    default:
      return null;
  }
}
