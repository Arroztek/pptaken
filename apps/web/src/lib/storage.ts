// SPDX-License-Identifier: AGPL-3.0-or-later
// localStorage for per-browser preferences only (language, theme). Never for secrets or session data.
// Storage can throw (private mode, blocked site data): every access is guarded.
import { type Locale, pickLocale } from "@pptaken/ui";

export const LANG_KEY = "pptaken.lang";
/** "collapsed" when the owner folded the desktop sidebar to icons. */
export const SIDEBAR_KEY = "pptaken.sidebar";

export function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Blocked: the choice still applies to this page view.
  }
}

/** A stored, valid choice wins; otherwise the browser's languages decide (English fallback). */
export function initialLocale(stored: string | null, languages: readonly string[]): Locale {
  if (stored === "en" || stored === "es") return stored;
  return pickLocale(languages);
}
