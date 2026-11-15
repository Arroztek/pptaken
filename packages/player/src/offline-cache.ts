// SPDX-License-Identifier: Apache-2.0
// Offline layer 2, pure logic shared by the service worker (`sw.ts`), the page client (`offline-client.ts`) and
// the unit tests: which routes may be cached and under which key, which responses may be stored, when a response
// means "signed out", cache names and versions, eviction under a storage quota, and the page <-> worker messages.
// No DOM or worker types: it compiles into both the browser modules and the classic worker script.
//
// What is cached (an explicit allowlist, everything else is never touched by the worker):
//   shell   /_player/<module or stylesheet>, /_player/fonts/<family>/<file>.woff2   (one cache per build)
//   deck    /p/<id>, /p/<id>/presenter, /api/v1/decks/<id>/offline, /api/v1/decks/<id>/presenter (one cache per deck)
// Never: /api/v1/auth/*, /api/v1/decks/<id>/content-url (a short-lived signed URL, useless offline), /c/* (signed
// tokens; and the sandboxed content frame is not controlled by the worker anyway, spike S4), any other route.
// Keys are origin + path: the query and fragment are dropped, so no token or other parameter is ever part of a key.

/** Prefix of every cache this feature creates (the web app deletes them all on logout). */
export const CACHE_PREFIX = "pptaken-offline-";
/** Layout version of the deck caches. Bump it when their entries change shape; old ones are then deleted. */
export const DECK_FORMAT = "v1";
/** The worker script and its scope: the narrowest scope that controls the player and presenter pages. */
export const SW_URL = "/p/sw.js";
export const SW_SCOPE = "/p/";
/** Placeholder the server replaces with a hash of the shell files, so any shell change installs a new worker. */
export const BUILD_PLACEHOLDER = "__PPTAKEN_BUILD__";

/** Static files of the player and presenter pages (served from `/_player/`). */
export const SHELL_FILES = [
  "page.js",
  "page.css",
  "presenter-page.js",
  "presenter.css",
  "shell.js",
  "keys.js",
  "navigation.js",
  "laser.js",
  "protocol.js",
  "messages.js",
  "i18n.js",
  "sync.js",
  "pace.js",
  "presenter.js",
  "presenter-data.js",
  "offline.js",
  "offline-cache.js",
  "offline-client.js",
] as const;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FONT_PATH = /^\/_player\/fonts\/[a-z0-9-]{1,40}\/[a-z0-9-]{1,80}\.woff2$/;

export type RouteKind = "page" | "presenter-page" | "offline" | "presenter-data" | "shell" | "font";

export interface Route {
  kind: RouteKind;
  /** Deck id (ULID) for deck routes, `null` for shell routes. */
  deck: string | null;
  /** Cache key: origin + path, never a query. */
  key: string;
}

/** The cacheable route of a URL, or `null` when the worker must leave the request alone. */
export function routeOf(url: string, origin: string): Route | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== origin || u.username !== "" || u.password !== "") return null;
  const path = u.pathname;
  const key = `${u.origin}${path}`;
  const p = /^\/p\/([^/]+)(\/presenter)?$/.exec(path);
  if (p) {
    const deck = p[1] ?? "";
    if (!ULID.test(deck)) return null;
    return { kind: p[2] ? "presenter-page" : "page", deck, key };
  }
  const a = /^\/api\/v1\/decks\/([^/]+)\/(offline|presenter)$/.exec(path);
  if (a) {
    const deck = a[1] ?? "";
    if (!ULID.test(deck)) return null;
    return { kind: a[2] === "offline" ? "offline" : "presenter-data", deck, key };
  }
  if (path.startsWith("/_player/")) {
    const file = path.slice("/_player/".length);
    if ((SHELL_FILES as readonly string[]).includes(file))
      return { kind: "shell", deck: null, key };
    if (FONT_PATH.test(path)) return { kind: "font", deck: null, key };
  }
  return null;
}

/** Cache key of a URL (origin + path), or `null` when the URL is not cacheable at all. */
export function cacheKeyOf(url: string, origin: string): string | null {
  return routeOf(url, origin)?.key ?? null;
}

const EXPECTED_TYPE: Readonly<Record<RouteKind, RegExp>> = {
  page: /^text\/html\b/i,
  "presenter-page": /^text\/html\b/i,
  offline: /^application\/json\b/i,
  "presenter-data": /^application\/json\b/i,
  shell: /^(text\/javascript|text\/css)\b/i,
  font: /^font\/woff2\b/i,
};

/** The parts of a fetch `Response` these checks look at. */
export interface ResponseLike {
  status: number;
  type: string;
  redirected: boolean;
  url: string;
  headers: { get(name: string): string | null };
}

/**
 * Only a direct `200` from our own origin with the expected media type is ever stored: never an error, a redirect
 * (for example to the login page), an opaque response, or anything else.
 */
export function isCacheable(res: ResponseLike, route: Route): boolean {
  return (
    res.status === 200 &&
    res.type === "basic" &&
    !res.redirected &&
    EXPECTED_TYPE[route.kind].test(res.headers.get("content-type") ?? "")
  );
}

/**
 * A response that says the owner is not signed in (any more): `401`, or a redirect of a deck route (the pages
 * redirect to `/login` or `/welcome`). The worker then deletes every offline copy (fail closed).
 */
export function signsOut(res: ResponseLike, route: Route): boolean {
  if (route.deck === null) return false;
  return res.status === 401 || res.type === "opaqueredirect" || res.redirected;
}

export function shellCacheName(build: string): string {
  return `${CACHE_PREFIX}shell-${build}`;
}

export function deckCacheName(deck: string): string {
  return `${CACHE_PREFIX}${DECK_FORMAT}-deck-${deck}`;
}

/** The deck id of a deck cache name of the current format, or `null`. */
export function deckOfCache(name: string): string | null {
  const prefix = `${CACHE_PREFIX}${DECK_FORMAT}-deck-`;
  if (!name.startsWith(prefix)) return null;
  const deck = name.slice(prefix.length);
  return ULID.test(deck) ? deck : null;
}

/** Caches of this feature that a worker of `build` deletes on activation: other shell builds, other formats. */
export function isStaleCache(name: string, build: string): boolean {
  if (!name.startsWith(CACHE_PREFIX)) return false;
  return name !== shellCacheName(build) && deckOfCache(name) === null;
}

/** Bookkeeping stored next to each deck's entries (synthetic key `metaKey`). */
export interface DeckMeta {
  deck: string;
  revision: number;
  bytes: number;
  usedAt: number;
}

export function metaKey(origin: string, deck: string): string {
  return `${origin}${SW_SCOPE}__offline-meta/${deck}`;
}

export function parseMeta(value: unknown): DeckMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  if (typeof m.deck !== "string" || !ULID.test(m.deck)) return null;
  for (const n of [m.revision, m.bytes, m.usedAt]) {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
  }
  return {
    deck: m.deck,
    revision: m.revision as number,
    bytes: m.bytes as number,
    usedAt: m.usedAt as number,
  };
}

/** Share of the storage quota the offline copies may fill before older decks are evicted. */
export const QUOTA_SHARE = 0.8;

/** Bytes to free before storing `incoming` more bytes (0 when it fits, or when the quota is unknown). */
export function bytesToFree(
  estimate: { usage?: number | undefined; quota?: number | undefined } | null,
  incoming: number,
): number {
  const quota = estimate?.quota;
  if (quota === undefined || !Number.isFinite(quota) || quota <= 0) return 0;
  const usage = estimate?.usage ?? 0;
  return Math.max(0, Math.ceil(usage + incoming - quota * QUOTA_SHARE));
}

/**
 * Least recently used decks to evict to free `need` bytes, oldest first, never `keep`. Returns fewer decks than
 * needed when even evicting all others is not enough (the caller then fails without storing).
 */
export function pickEvictions(decks: readonly DeckMeta[], keep: string, need: number): string[] {
  const out: string[] = [];
  let freed = 0;
  const candidates = decks
    .filter((d) => d.deck !== keep)
    .sort((a, b) => a.usedAt - b.usedAt || (a.deck < b.deck ? -1 : 1));
  for (const d of candidates) {
    if (freed >= need) break;
    out.push(d.deck);
    freed += d.bytes;
  }
  return out;
}

/** True for a storage quota error (`QuotaExceededError`, also the legacy Firefox name). */
export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

// Page <-> worker messages (over a MessageChannel; only same-origin pages can message the worker). Exact keys.

export type ClientMessage =
  | { v: 1; type: "keep"; deck: string }
  | { v: 1; type: "status"; deck: string }
  | { v: 1; type: "forget"; deck: string | null };

export interface WorkerReply {
  v: 1;
  type: "result";
  ok: boolean;
  /** The stored revision, or `null` when nothing is stored. */
  revision: number | null;
}

function exact(data: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  if (Object.getPrototypeOf(data) !== Object.prototype) return null;
  const fields = data as Record<string, unknown>;
  if (Object.keys(fields).length !== keys.length) return null;
  for (const k of keys) if (!Object.hasOwn(fields, k)) return null;
  return fields.v === 1 ? fields : null;
}

export function parseClientMessage(data: unknown): ClientMessage | null {
  const m = exact(data, ["v", "type", "deck"]);
  if (!m) return null;
  if (m.type === "forget" && m.deck === null) return { v: 1, type: "forget", deck: null };
  if (typeof m.deck !== "string" || !ULID.test(m.deck)) return null;
  if (m.type === "keep" || m.type === "status" || m.type === "forget") {
    return { v: 1, type: m.type, deck: m.deck };
  }
  return null;
}

export function parseWorkerReply(data: unknown): WorkerReply | null {
  const m = exact(data, ["v", "type", "ok", "revision"]);
  if (!m || m.type !== "result" || typeof m.ok !== "boolean") return null;
  const r = m.revision;
  if (r !== null && !(typeof r === "number" && Number.isSafeInteger(r) && r > 0)) return null;
  return { v: 1, type: "result", ok: m.ok, revision: r };
}

/** The offline document response of `GET /api/v1/decks/:id/offline`. */
export interface OfflineBundle {
  id: string;
  revision: number;
  html: string;
}

export function parseOfflineBundle(value: unknown, deck: string): OfflineBundle | null {
  if (typeof value !== "object" || value === null) return null;
  const b = value as Record<string, unknown>;
  if (b.id !== deck || typeof b.html !== "string") return null;
  if (typeof b.revision !== "number" || !Number.isSafeInteger(b.revision) || b.revision < 1)
    return null;
  return { id: deck, revision: b.revision, html: b.html };
}

/** The UI font URLs (`/_player/fonts/...`) referenced by a stylesheet of ours. */
export function fontPathsIn(css: string): string[] {
  const out = new Set<string>();
  for (const m of css.matchAll(
    /url\((\/_player\/fonts\/[a-z0-9-]{1,40}\/[a-z0-9-]{1,80}\.woff2)\)/g,
  )) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/** The page the worker answers with when a deck that was never kept offline is opened without a network. */
export function unavailablePage(lang: string): string {
  const es = lang.toLowerCase().startsWith("es");
  const text = es
    ? "Esta presentación no está disponible sin conexión. Ábrela una vez con conexión para guardar una copia en este dispositivo."
    : "This presentation is not available offline. Open it once with a connection to keep a copy on this device.";
  return `<!doctype html><html lang="${es ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PPTaken</title><style>html,body{margin:0;height:100%;background:#000;color:#8B8FA0;font:16px system-ui,sans-serif}p{position:fixed;left:16px;bottom:16px;margin:0}</style></head><body data-state="unavailable" data-offline="unavailable"><p id="status" role="status">${text}</p></body></html>`;
}
