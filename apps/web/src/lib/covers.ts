// SPDX-License-Identifier: AGPL-3.0-or-later
// Cover thumbnails of the grid view: a cache of the signed cover URLs (one request per page of decks, URLs reused
// until shortly before they expire) and a small concurrency limiter so a long list never loads every cover at once.
// Framework-free; the card component (components/DeckCover.svelte) draws the result.
import type { DeckCover } from "./api";

/** What the page knows about a deck's cover. `failed` is remembered only briefly (COVER_RETRY_MS), then asked again. */
export type CoverState =
  | { status: "ready"; url: string; width: number; height: number; expiresAt: number }
  | { status: "none" }
  | { status: "failed" };

/** Most ids one request carries (the server accepts up to 24; a page of the list is 20). */
export const COVER_CHUNK = 20;
/** A cached URL is replaced this long before it expires, so a frame never starts with a dead link. */
export const COVER_EXPIRY_MARGIN_MS = 60_000;
/** After a failed request the same decks are not asked again for this long (a dead endpoint is not hammered). */
export const COVER_RETRY_MS = 15_000;
/** Covers that load at the same time. */
export const COVER_CONCURRENCY = 4;

export interface CoverRequest {
  id: string;
  revision: number;
}

export interface CoverStore {
  /** The state to use now (a cached one that is still fresh), or undefined when the deck was never asked about. */
  peek(request: CoverRequest): CoverState | undefined;
  /** Makes sure every deck has a fresh state, asking the server once for all that need it; never throws. */
  resolve(requests: readonly CoverRequest[]): Promise<void>;
  /** `resolve` for one deck, then its state. */
  get(request: CoverRequest, siblings?: readonly CoverRequest[]): Promise<CoverState>;
  clear(): void;
}

const keyOf = (r: CoverRequest) => `${r.id}:${r.revision}`;

export function createCoverStore(
  fetchCovers: (ids: readonly string[]) => Promise<DeckCover[]>,
  options: { now?: () => number; chunk?: number } = {},
): CoverStore {
  const now = options.now ?? Date.now;
  const chunk = options.chunk ?? COVER_CHUNK;
  const cache = new Map<string, CoverState>();
  const inFlight = new Map<string, Promise<void>>();
  const failedUntil = new Map<string, number>();

  const fresh = (state: CoverState | undefined): state is CoverState =>
    state !== undefined &&
    (state.status !== "ready" || state.expiresAt - COVER_EXPIRY_MARGIN_MS > now());

  const backingOff = (request: CoverRequest) => (failedUntil.get(keyOf(request)) ?? 0) > now();

  function peek(request: CoverRequest): CoverState | undefined {
    const state = cache.get(keyOf(request));
    return fresh(state) ? state : undefined;
  }

  function load(requests: CoverRequest[]): Promise<void> {
    const ids = [...new Set(requests.map((r) => r.id))];
    const done = Promise.resolve()
      .then(() => fetchCovers(ids))
      .then(
        (covers) => {
          const byId = new Map(covers.map((c) => [c.id, c]));
          for (const request of requests) {
            const cover = byId.get(request.id);
            // The server answers for the CURRENT revision: a list a little behind an edit shows the newer cover.
            if (cover === undefined) {
              cache.set(keyOf(request), { status: "none" });
              continue;
            }
            cache.set(keyOf(request), {
              status: "ready",
              url: cover.url,
              width: cover.width,
              height: cover.height,
              expiresAt: Date.parse(cover.expiresAt),
            });
          }
        },
        () => {
          // Offline, signed out, server error: no cover now; asked again after a short pause.
          for (const request of requests) failedUntil.set(keyOf(request), now() + COVER_RETRY_MS);
        },
      );
    return done;
  }

  async function resolve(requests: readonly CoverRequest[]): Promise<void> {
    const wanted = new Map<string, CoverRequest>();
    for (const r of requests)
      if (!fresh(cache.get(keyOf(r))) && !backingOff(r)) wanted.set(keyOf(r), r);
    const waits: Promise<void>[] = [];
    const missing: CoverRequest[] = [];
    for (const [key, r] of wanted) {
      const pending = inFlight.get(key);
      if (pending) waits.push(pending);
      else missing.push(r);
    }
    for (let i = 0; i < missing.length; i += chunk) {
      const part = missing.slice(i, i + chunk);
      const run = load(part).finally(() => {
        for (const r of part) inFlight.delete(keyOf(r));
      });
      for (const r of part) inFlight.set(keyOf(r), run);
      waits.push(run);
    }
    await Promise.all(waits);
  }

  return {
    peek,
    resolve,
    async get(request, siblings = []) {
      await resolve([request, ...siblings]);
      return peek(request) ?? { status: "failed" };
    },
    clear() {
      cache.clear();
    },
  };
}

export interface Limiter {
  /**
   * Asks for a slot. `granted` runs (maybe at once) with a `release` that must be called exactly once when the work
   * is over. Returns a cancel function: it withdraws a request that was not granted yet, and releases one that was.
   */
  acquire(granted: (release: () => void) => void): () => void;
  readonly active: number;
  readonly waiting: number;
}

export function createLimiter(max: number = COVER_CONCURRENCY): Limiter {
  let active = 0;
  interface Entry {
    granted: (release: () => void) => void;
    live: boolean;
    release?: () => void;
  }
  const queue: Entry[] = [];

  function pump() {
    while (active < max) {
      const next = queue.shift();
      if (next === undefined) return;
      if (!next.live) continue;
      active++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        pump();
      };
      next.release = release;
      next.granted(release);
    }
  }

  return {
    acquire(granted) {
      const entry: Entry = { granted, live: true };
      queue.push(entry);
      pump();
      return () => {
        entry.live = false;
        entry.release?.();
      };
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.filter((e) => e.live).length;
    },
  };
}
