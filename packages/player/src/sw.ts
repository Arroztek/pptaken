// SPDX-License-Identifier: Apache-2.0
// Offline layer 2: the service worker of the player pages (`/p/sw.js`, scope `/p/`), registered only in secure
// contexts (HTTPS or localhost). Built by `scripts/build-runtime.mjs` into one classic script together with
// `offline-cache.ts`; the server replaces BUILD_PLACEHOLDER with a hash of the shell files.
//
// - Network first: online, every request behaves as without the worker. The cache answers only when the network
//   fails, or (when a stored copy exists) does not answer within 2.5 s; after a failure, stored copies are served
//   at once for 15 s. It never touches routes outside the allowlist of `offline-cache.ts`.
// - The worker never writes deck entries while proxying: a page asks it (`keep`) after the deck has loaded, and it
//   stores the deck's player page, presenter page, offline document and presenter data together, all or nothing.
// - The sandboxed content frame is not controlled by any worker (spike S4); offline, the page mounts the stored
//   offline document through `srcdoc` instead.
// - Signed out (a `401` or a redirect on a deck route, or `forget` from the web app at logout): every offline copy
//   is deleted.
// - Updates: no `skipWaiting()` and no `clients.claim()`. A new version waits until no player page is open, so it
//   never takes over in the middle of a talk; on activation it deletes the caches of other builds and formats.

import {
  BUILD_PLACEHOLDER,
  bytesToFree,
  type ClientMessage,
  type DeckMeta,
  deckCacheName,
  deckOfCache,
  fontPathsIn,
  isCacheable,
  isQuotaError,
  isStaleCache,
  metaKey,
  parseClientMessage,
  parseMeta,
  parseOfflineBundle,
  pickEvictions,
  type Route,
  routeOf,
  SHELL_FILES,
  shellCacheName,
  signsOut,
  unavailablePage,
  type WorkerReply,
} from "./offline-cache.js";

declare const self: ServiceWorkerGlobalScope;

const BUILD: string = BUILD_PLACEHOLDER;
const ORIGIN = self.location.origin;
const SHELL = shellCacheName(BUILD);

async function fetchOwn(url: string): Promise<Response> {
  return fetch(url, { credentials: "same-origin", redirect: "manual", cache: "no-store" });
}

/** Stores the player's static files (modules, styles, UI fonts) for this build. Missing files are skipped. */
async function ensureShell(): Promise<void> {
  const cache = await caches.open(SHELL);
  const urls: string[] = SHELL_FILES.map((f) => `${ORIGIN}/_player/${f}`);
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i] as string;
    const route = routeOf(url, ORIGIN);
    if (!route) continue;
    try {
      const cached = await cache.match(route.key);
      const res = cached ?? (await fetchOwn(url));
      if (!cached && !isCacheable(res, route)) continue;
      if (url.endsWith(".css")) {
        for (const path of fontPathsIn(await res.clone().text())) urls.push(`${ORIGIN}${path}`);
      }
      if (!cached) await cache.put(route.key, res);
    } catch {
      // Offline or quota: the shell is completed on the next `keep`.
    }
  }
}

async function deckMetas(): Promise<DeckMeta[]> {
  const out: DeckMeta[] = [];
  for (const name of await caches.keys()) {
    const deck = deckOfCache(name);
    if (deck === null) continue;
    const res = await (await caches.open(name)).match(metaKey(ORIGIN, deck));
    const meta = parseMeta(res ? await res.json().catch(() => null) : null);
    out.push(meta ?? { deck, revision: 0, bytes: 0, usedAt: 0 });
  }
  return out;
}

async function forget(deck: string | null): Promise<void> {
  for (const name of await caches.keys()) {
    const d = deckOfCache(name);
    if (d !== null && (deck === null || d === deck)) await caches.delete(name);
  }
}

async function readMeta(deck: string): Promise<DeckMeta | null> {
  if (!(await caches.has(deckCacheName(deck)))) return null;
  const res = await (await caches.open(deckCacheName(deck))).match(metaKey(ORIGIN, deck));
  return parseMeta(res ? await res.json().catch(() => null) : null);
}

async function writeMeta(cache: Cache, meta: DeckMeta): Promise<void> {
  await cache.put(
    metaKey(ORIGIN, meta.deck),
    new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }),
  );
}

const fail: WorkerReply = { v: 1, type: "result", ok: false, revision: null };

/** Stores everything a deck needs offline, all or nothing. */
async function keep(deck: string): Promise<WorkerReply> {
  await ensureShell();
  const paths = [
    `/p/${deck}`,
    `/p/${deck}/presenter`,
    `/api/v1/decks/${deck}/offline`,
    `/api/v1/decks/${deck}/presenter`,
  ];
  const entries: [Route, Blob, Response][] = [];
  let revision = 0;
  let bytes = 0;
  for (const path of paths) {
    const route = routeOf(`${ORIGIN}${path}`, ORIGIN);
    if (!route) return fail;
    let res: Response;
    try {
      res = await fetchOwn(route.key);
    } catch {
      return fail;
    }
    if (signsOut(res, route)) {
      await forget(null);
      return fail;
    }
    if (!isCacheable(res, route)) return fail;
    const body = await res.blob();
    if (route.kind === "offline") {
      const bundle = parseOfflineBundle(JSON.parse(await body.text()), deck);
      if (!bundle) return fail;
      revision = bundle.revision;
    }
    bytes += body.size;
    entries.push([route, body, res]);
  }
  const evict = pickEvictions(
    await deckMetas(),
    deck,
    bytesToFree(await navigator.storage?.estimate?.().catch(() => null), bytes),
  );
  for (const d of evict) await forget(d);
  const store = async (): Promise<void> => {
    await caches.delete(deckCacheName(deck));
    const cache = await caches.open(deckCacheName(deck));
    for (const [route, body, res] of entries) {
      await cache.put(route.key, new Response(body, { status: 200, headers: res.headers }));
    }
    await writeMeta(cache, { deck, revision, bytes, usedAt: Date.now() });
  };
  for (;;) {
    try {
      await store();
      return { v: 1, type: "result", ok: true, revision };
    } catch (error) {
      await caches.delete(deckCacheName(deck));
      if (!isQuotaError(error)) return fail;
      // Out of quota: drop the least recently used other deck and try again, until none is left.
      const next = pickEvictions(await deckMetas(), deck, 1)[0];
      if (next === undefined) return fail;
      await forget(next);
    }
  }
}

async function run(message: ClientMessage): Promise<WorkerReply> {
  if (message.type === "keep") return keep(message.deck);
  if (message.type === "forget") {
    await forget(message.deck);
    return { v: 1, type: "result", ok: true, revision: null };
  }
  const meta = await readMeta(message.deck);
  return { v: 1, type: "result", ok: meta !== null, revision: meta?.revision ?? null };
}

/** Marks a deck as used now (eviction is least recently used first). Best effort. */
async function touch(deck: string): Promise<void> {
  const meta = await readMeta(deck);
  if (meta)
    await writeMeta(await caches.open(deckCacheName(deck)), { ...meta, usedAt: Date.now() });
}

async function fromCache(route: Route): Promise<Response | undefined> {
  if (route.deck === null) return (await caches.open(SHELL)).match(route.key);
  if (!(await caches.has(deckCacheName(route.deck)))) return undefined;
  return (await caches.open(deckCacheName(route.deck))).match(route.key);
}

/**
 * When a stored copy exists, the network gets this long to answer before the copy is used ("lie-fi": a venue
 * network that accepts connections and never answers, or a dead host whose connections fail slowly).
 */
const NETWORK_GRACE_MS = 2500;
/** After a network failure, stored copies are served at once for this long (the network is still tried). */
const NETWORK_DOWN_MS = 15_000;
let networkDownUntil = 0;

/** A network answer that arrives after a stored copy was served: it closes the breaker and still fails closed. */
async function settle(network: Promise<Response>, route: Route): Promise<void> {
  try {
    const res = await network;
    networkDownUntil = 0;
    if (signsOut(res, route)) await forget(null);
  } catch {
    // Still down.
  }
}

async function handle(event: FetchEvent, route: Route): Promise<Response> {
  const cachedCopy = await fromCache(route);
  const network = fetch(event.request);
  let res: Response;
  try {
    if (cachedCopy && Date.now() < networkDownUntil) throw new Error("network recently down");
    res = cachedCopy
      ? await Promise.race([
          network,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("network too slow")), NETWORK_GRACE_MS),
          ),
        ])
      : await network;
  } catch (error) {
    networkDownUntil = Date.now() + NETWORK_DOWN_MS;
    if (cachedCopy) {
      event.waitUntil(settle(network, route));
      if (route.kind === "page" && route.deck !== null) event.waitUntil(touch(route.deck));
      return cachedCopy;
    }
    if (route.kind === "page" || route.kind === "presenter-page") {
      return new Response(unavailablePage(self.navigator.language ?? "en"), {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "Cache-Control": "no-store",
        },
      });
    }
    throw error;
  }
  networkDownUntil = 0;
  if (signsOut(res, route)) event.waitUntil(forget(null));
  return res;
}

self.addEventListener("install", (event) => {
  event.waitUntil(ensureShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (isStaleCache(name, BUILD)) await caches.delete(name);
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const route = routeOf(event.request.url, ORIGIN);
  if (!route) return;
  event.respondWith(handle(event, route));
});

self.addEventListener("message", (event) => {
  const port = event.ports[0];
  const message = parseClientMessage(event.data);
  if (!port || !message) return;
  event.waitUntil(
    run(message)
      .catch((): WorkerReply => fail)
      .then((reply) => port.postMessage(reply)),
  );
});
