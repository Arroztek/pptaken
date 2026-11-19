// SPDX-License-Identifier: AGPL-3.0-or-later
// The Presentations page shows a list or a grid of covers. The owner's choice is remembered in this browser only
// (localStorage, guarded: it can throw or be empty). Without a stored choice the page is the list.
import { readStored, writeStored } from "./storage";

export type DeckView = "list" | "grid";

export const DECK_VIEW_KEY = "pptaken.decks.view";

/** A stored value that is exactly "grid" or "list"; anything else (absent, old, tampered) is the list. */
export function parseDeckView(stored: string | null): DeckView {
  return stored === "grid" ? "grid" : "list";
}

export function readDeckView(read: (key: string) => string | null = readStored): DeckView {
  return parseDeckView(read(DECK_VIEW_KEY));
}

export function saveDeckView(
  view: DeckView,
  write: (key: string, value: string) => void = writeStored,
): void {
  write(DECK_VIEW_KEY, view);
}
