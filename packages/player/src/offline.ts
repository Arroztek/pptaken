// SPDX-License-Identifier: Apache-2.0
// Offline presenting, shell side (pure): the indicator state machine and the shape check of an offline deck
// document (the one delivered through `srcdoc` when the content route cannot be reached).
//
//   loading ──preload ok──▶ ready ──offline copy stored──▶ service-worker
//      └────preload with failures──▶ partial   (stays partial: something is missing from memory)
//
// Layer 1 (in-memory preload, every browser) decides ready/partial; layer 2 (the service worker's offline copy,
// secure contexts only) upgrades `ready` to `service-worker`.

import type { LabelKey } from "./i18n.js";
import type { PreloadFailure, PreloadMessage } from "./messages.js";

export const OFFLINE_STATES = ["loading", "ready", "partial", "service-worker"] as const;
export type OfflineState = (typeof OFFLINE_STATES)[number];

export interface OfflineStatus {
  state: OfflineState;
  /** Images decoded and kept in memory (0 until the preload report). */
  images: number;
  /** Font faces loaded (0 until the preload report). */
  fonts: number;
  /** Short failure reasons from the preload report (closed set, at most 16). */
  failed: readonly PreloadFailure[];
  /** An offline copy of this deck is stored by the service worker (or the page runs from it). */
  copy: boolean;
}

/** The indicator state for a preload report (or none yet) and the offline-copy flag. */
export function offlineStateOf(preload: PreloadMessage | null, copy: boolean): OfflineState {
  if (preload === null) return "loading";
  if (!preload.ok) return "partial";
  return copy ? "service-worker" : "ready";
}

export function offlineStatus(preload: PreloadMessage | null, copy: boolean): OfflineStatus {
  return {
    state: offlineStateOf(preload, copy),
    images: preload?.images ?? 0,
    fonts: preload?.fonts ?? 0,
    failed: preload ? [...preload.failed] : [],
    copy,
  };
}

/** The readable text of each state (shown on demand: help overlay, presenter header, HUD). */
export const OFFLINE_LABEL: Readonly<Record<OfflineState, LabelKey>> = {
  loading: "offlineLoading",
  ready: "offlineReady",
  partial: "offlinePartial",
  "service-worker": "offlineCopy",
};

/**
 * Color of the 8 px status dot. It sits in the letterbox corner, outside the canvas, so semantic colors are
 * allowed there (brand decision 10): chrome gray while loading, Success when ready (memory or offline copy),
 * Warning when something could not be loaded.
 */
export const OFFLINE_DOT: Readonly<Record<OfflineState, string>> = {
  loading: "#8B8FA0",
  ready: "#3DD68C",
  partial: "#FF9F43",
  "service-worker": "#3DD68C",
};

/** The `<meta>` CSP every offline deck document starts with: no network at all, data: images and fonts only. */
export const OFFLINE_DOCUMENT_CSP =
  "default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";

/** Largest offline document accepted by the shell (about 200 slides of 256 KB plus inlined assets). */
export const MAX_OFFLINE_DOCUMENT = 96 * 1024 * 1024;

const HEAD = new RegExp(
  `^<!doctype html>\\n<html(?: lang="[A-Za-z0-9-]{2,100}")?>\\n<head>\\n<meta http-equiv="Content-Security-Policy" content="${OFFLINE_DOCUMENT_CSP.replace(
    "{nonce}",
    "[A-Za-z0-9+/_-]{22,128}={0,2}",
  )}">\\n`,
);

/**
 * True for a string shaped like an offline deck document: the exact no-network CSP `<meta>` must come first in
 * `<head>`, before anything the content controls. The shell refuses anything else (fail closed).
 */
export function isOfflineDocument(html: unknown): html is string {
  return typeof html === "string" && html.length <= MAX_OFFLINE_DOCUMENT && HEAD.test(html);
}
