// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline copies of presentations (stored by the player's service worker, see @pptaken/player sw.ts) hold private
// content and speaker notes on this device. The web app deletes them all when the owner signs out, and offers a
// control to delete them on demand. Cache Storage exists only in secure contexts (HTTPS or localhost); elsewhere
// there is nothing to delete.

/** Prefix of every cache the player's service worker creates (`CACHE_PREFIX` in @pptaken/player). */
export const OFFLINE_CACHE_PREFIX = "pptaken-offline-";

interface CacheStorageLike {
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

function storage(): CacheStorageLike | null {
  const c = (globalThis as { caches?: CacheStorageLike }).caches;
  return c && typeof c.keys === "function" ? c : null;
}

/** Number of presentations with an offline copy on this device (0 when unknown). */
export async function countOfflineCopies(store = storage()): Promise<number> {
  if (!store) return 0;
  try {
    return (await store.keys()).filter((k) => k.startsWith(`${OFFLINE_CACHE_PREFIX}v1-deck-`))
      .length;
  } catch {
    return 0;
  }
}

/** Deletes every offline copy (and the player's cached files). Never throws. */
export async function forgetOfflineCopies(store = storage()): Promise<void> {
  if (!store) return;
  try {
    for (const name of await store.keys()) {
      if (name.startsWith(OFFLINE_CACHE_PREFIX)) await store.delete(name);
    }
  } catch {
    // Storage unavailable (private mode, blocked): nothing was stored either.
  }
}
