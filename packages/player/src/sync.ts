// SPDX-License-Identifier: Apache-2.0
// Window-to-window sync of the player and the presenter view over a same-origin `BroadcastChannel` (works without
// network). Both windows are trusted pages of the app origin; messages are still validated strictly, versioned,
// and anything unknown is ignored.
//
//   hello {}             a window joined; the others answer with their position (nav) and black screen (black)
//   nav {slide, step}    this window moved (by its own input); the others follow without echoing it back
//   black {on}           black screen on/off
//
// The channel never carries notes or anything else from the presenter data: only positions.

import { envelope, isBoundedInt, MAX_SLIDES, MAX_STEPS, typeOf } from "./messages.js";

export const SYNC_VERSION = 1;

export type SyncMessage =
  | { v: 1; type: "hello" }
  | { v: 1; type: "nav"; slide: number; step: number }
  | { v: 1; type: "black"; on: boolean };

/** Channel names: `pptaken:` plus a deck key (ULIDs and test keys fit). */
export const SYNC_CHANNEL_PATTERN = /^pptaken:[A-Za-z0-9_-]{1,64}$/;

/** The channel name of a deck, or `null` when the key does not fit the pattern. */
export function syncChannelName(deckKey: string): string | null {
  const name = `pptaken:${deckKey}`;
  return SYNC_CHANNEL_PATTERN.test(name) ? name : null;
}

/** Validates a message received on the channel. Returns a fresh copy, or `null` to drop it. */
export function parseSyncMessage(data: unknown): SyncMessage | null {
  switch (typeOf(data)) {
    case "hello":
      return envelope(data, "hello", []) ? { v: 1, type: "hello" } : null;
    case "nav": {
      const m = envelope(data, "nav", ["slide", "step"]);
      if (!m || !isBoundedInt(m.slide, MAX_SLIDES - 1) || !isBoundedInt(m.step, MAX_STEPS))
        return null;
      return { v: 1, type: "nav", slide: m.slide, step: m.step };
    }
    case "black": {
      const m = envelope(data, "black", ["on"]);
      return m && typeof m.on === "boolean" ? { v: 1, type: "black", on: m.on } : null;
    }
    default:
      return null;
  }
}

export interface Sync {
  send(message: SyncMessage): void;
  close(): void;
}

/**
 * Opens the channel and calls `onMessage` with every valid message from other windows. Returns `null` when the
 * name is not valid or the browser has no `BroadcastChannel`; the player then simply works alone.
 */
export function openSync(name: string, onMessage: (message: SyncMessage) => void): Sync | null {
  if (!SYNC_CHANNEL_PATTERN.test(name) || typeof BroadcastChannel !== "function") return null;
  const channel = new BroadcastChannel(name);
  channel.onmessage = (event: MessageEvent) => {
    const message = parseSyncMessage(event.data);
    if (message) onMessage(message);
  };
  return {
    send: (message) => {
      const valid = parseSyncMessage(message);
      if (valid) channel.postMessage(valid);
    },
    close: () => channel.close(),
  };
}
