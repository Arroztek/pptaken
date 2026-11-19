// SPDX-License-Identifier: AGPL-3.0-or-later
// Script error visibility in the panel (ADR-023): labels and the plain-text summary the owner copies for an agent.
// Error text comes from code that ran in the sandboxed frame: it is untrusted. The summary labels it as data, quotes
// every message as a JSON string (clear boundaries, no raw line breaks or control characters), caps each one and
// lists at most 10. The panel shows the same text only through Svelte text interpolation, never as HTML.
import type { ScriptError } from "./api";
import type { T } from "./translate";

export const SUMMARY_MAX_ITEMS = 10;
const SUMMARY_MAX_MESSAGE = 200;

/** Invisible and control characters removed from anything copied (defense in depth: the server cleaned it). */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export function plain(text: string, max: number): string {
  const clean = text.replace(UNSAFE, " ").replace(/ {2,}/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** "Slide 2 · Intro", "Slide 2", or "Deck script". */
export function slideLabel(t: T, e: Pick<ScriptError, "slideIndex" | "slideTitle">): string {
  if (e.slideIndex === null) return t("scriptErrors.deckScript");
  return e.slideTitle
    ? t("scriptErrors.slideLabel", { n: e.slideIndex + 1, title: e.slideTitle })
    : t("scriptErrors.slideUntitled", { n: e.slideIndex + 1 });
}

export function hintText(t: T, hint: ScriptError["hint"]): string | null {
  return hint === null ? null : t(`scriptErrors.hint_${hint}`);
}

/**
 * The short, safe, plain-text message the owner pastes into their agent's chat: what to do, then each error as
 * `- <slide> (<id>), <kind>: <name> "<message>" ×<count>` with the hint when there is one.
 */
export function agentSummary(
  t: T,
  deck: { id: string; title: string },
  errors: readonly ScriptError[],
): string {
  const lines = [t("scriptErrors.copyIntro", { title: plain(deck.title, 120), id: deck.id })];
  for (const e of errors.slice(0, SUMMARY_MAX_ITEMS)) {
    const where = e.slideIndex === null ? "deck" : `slide ${e.slideIndex + 1} (${e.slideId})`;
    const message = JSON.stringify(plain(e.message, SUMMARY_MAX_MESSAGE));
    lines.push(`- ${where}, ${e.kind}: ${plain(e.name, 60)} ${message} x${e.count}`);
    const hint = hintText(t, e.hint);
    if (hint) lines.push(`  ${t("scriptErrors.copyHint", { hint })}`);
  }
  if (errors.length > SUMMARY_MAX_ITEMS) {
    lines.push(t("scriptErrors.copyMore", { n: errors.length - SUMMARY_MAX_ITEMS }));
  }
  return lines.join("\n");
}
