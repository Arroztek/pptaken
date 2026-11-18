// SPDX-License-Identifier: Apache-2.0
// Shape of the presenter data (`GET /api/v1/decks/:id/presenter`, owner session only) and its validator. The
// server builds it from the stored deck (notes rendered by `renderNotes`); the presenter view validates it again
// before use. It is never sent to the content iframe or over the window sync channel.

import { isBoundedInt, MAX_SLIDES, MAX_STEPS } from "./messages.js";
import { SLIDE_ID_PATTERN } from "./protocol.js";

export interface PresenterSlide {
  id: string;
  title: string;
  section?: string;
  durationHintSec?: number;
  /** Speaker notes as safe HTML (allowlist of `renderNotes`). Empty when the slide has none. */
  notesHtml: string;
  /** Number of steps, when the server knows it; otherwise the presenter view takes it from the player. */
  steps?: number;
}

export interface PresenterData {
  title: string;
  revision?: number;
  aspectRatio?: "16:9" | "4:3";
  targetMinutes?: number;
  slides: PresenterSlide[];
  /**
   * The deck's approved scripts can run online (ADR-021). The presenter view running from the offline copy says
   * that interactive mode needs a connection.
   */
  interactive?: boolean;
}

/** Generous bounds over the schema limits (title 200, section 100, notes 16 KB rendered with escaping). */
const MAX_TEXT = 1000;
const MAX_NOTES_HTML = 512 * 1024;
const MAX_SECONDS = 24 * 3600;

const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function only(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

/** Validates presenter data. Returns a fresh copy, or `null` when anything is off. */
export function parsePresenterData(data: unknown): PresenterData | null {
  if (!isObject(data)) return null;
  if (!only(data, ["title", "revision", "aspectRatio", "targetMinutes", "slides", "interactive"]))
    return null;
  if (!isText(data.title, MAX_TEXT)) return null;
  const out: PresenterData = { title: data.title, slides: [] };
  if (data.interactive !== undefined) {
    if (typeof data.interactive !== "boolean") return null;
    if (data.interactive) out.interactive = true;
  }
  if (data.revision !== undefined) {
    if (!isBoundedInt(data.revision, 1e9)) return null;
    out.revision = data.revision;
  }
  if (data.aspectRatio !== undefined) {
    if (data.aspectRatio !== "16:9" && data.aspectRatio !== "4:3") return null;
    out.aspectRatio = data.aspectRatio;
  }
  if (data.targetMinutes !== undefined) {
    if (!isBoundedInt(data.targetMinutes, MAX_SECONDS / 60) || data.targetMinutes < 1) return null;
    out.targetMinutes = data.targetMinutes;
  }
  if (!Array.isArray(data.slides) || data.slides.length < 1 || data.slides.length > MAX_SLIDES)
    return null;
  const ids = new Set<string>();
  for (const s of data.slides) {
    if (!isObject(s)) return null;
    if (!only(s, ["id", "title", "section", "durationHintSec", "notesHtml", "steps"])) return null;
    if (typeof s.id !== "string" || !SLIDE_ID_PATTERN.test(s.id) || ids.has(s.id)) return null;
    if (!isText(s.title, MAX_TEXT) || !isText(s.notesHtml, MAX_NOTES_HTML)) return null;
    ids.add(s.id);
    const slide: PresenterSlide = { id: s.id, title: s.title, notesHtml: s.notesHtml };
    if (s.section !== undefined) {
      if (!isText(s.section, MAX_TEXT)) return null;
      slide.section = s.section;
    }
    if (s.durationHintSec !== undefined) {
      if (!isBoundedInt(s.durationHintSec, MAX_SECONDS) || s.durationHintSec < 1) return null;
      slide.durationHintSec = s.durationHintSec;
    }
    if (s.steps !== undefined) {
      if (!isBoundedInt(s.steps, MAX_STEPS)) return null;
      slide.steps = s.steps;
    }
    out.slides.push(slide);
  }
  return out;
}
