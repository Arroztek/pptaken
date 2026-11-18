// SPDX-License-Identifier: Apache-2.0
// Offline presenting, page side (`@pptaken/player/offline-client`), used by the server's player and presenter
// pages: where the deck document comes from (the signed content URL online, the stored offline document when the
// network is gone), and the conversation with the service worker (layer 2, secure contexts only).
//
// The online path never depends on the worker: `loadContent` asks for the signed content URL first and only
// falls back to the offline document when that request fails.

import { isOfflineDocument } from "./offline.js";
import {
  type ClientMessage,
  parseOfflineBundle,
  parseWorkerReply,
  SW_SCOPE,
  SW_URL,
  type WorkerReply,
} from "./offline-cache.js";

/** The server said the owner is not signed in (`401`): the page should go to the login page. */
export class SignedOutError extends Error {
  constructor() {
    super("signed out");
    this.name = "SignedOutError";
  }
}

export interface ContentSource {
  /** The signed content URL (online path). */
  contentUrl?: string;
  /** The offline deck document (stored copy, delivered with `srcdoc`). */
  contentHtml?: string;
  /** True when the page runs from the stored offline copy. */
  fromCopy: boolean;
  /** Revision of the stored copy, when `fromCopy`. */
  revision?: number;
  /**
   * Interactive mode (ADR-020), online only: `running` when the server signed the scripted document (owner
   * session, instance switch on, approved digest); otherwise why the static version is served.
   */
  scripts?: ScriptsMode;
  /** With `scripts: "running"`: the slide ids and canvas the shell must find in `ready`. */
  expect?: { slides: string[]; width: number; height: number };
  /** Guest pages (ADR-021): the unlock token sent was refused (expired, deck edited, password changed). */
  unlockRejected?: boolean;
}

/**
 * What the content-url endpoint says about author scripts. `locked` (pages without an owner session, ADR-021): the
 * deck's approved scripts would run after a presenter-password unlock; the static version is served meanwhile.
 */
export type ScriptsMode = "running" | "none" | "off" | "pending" | "safe" | "locked";
const SCRIPTS_MODES: readonly string[] = ["running", "none", "off", "pending", "safe", "locked"];

export interface LoadOptions {
  /** Ask for the static version even when the deck's scripts are approved (`?safe=1`, presenter previews). */
  safe?: boolean;
  /**
   * Extra request headers: a guest page's view grant and unlock token (ADR-021). Never cookies, never the URL.
   */
  headers?: Record<string, string>;
  /** Fall back to the stored offline copy when the network request fails. Default `true` (owner pages). */
  offline?: boolean;
}

function parseExpect(value: unknown): ContentSource["expect"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { slides?: unknown; width?: unknown; height?: unknown };
  if (!Array.isArray(v.slides) || v.slides.length > 200) return undefined;
  if (!v.slides.every((id) => typeof id === "string" && /^[a-z0-9-]{1,40}$/.test(id)))
    return undefined;
  if (!Number.isInteger(v.width) || !Number.isInteger(v.height)) return undefined;
  return { slides: v.slides as string[], width: v.width as number, height: v.height as number };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const deckPath = (deck: string): string => `/api/v1/decks/${encodeURIComponent(deck)}`;

/**
 * Where to load the deck from: the signed content URL, or (when that request fails, for example offline) the
 * offline document served by the service worker's cache. Throws `SignedOutError` on `401`.
 */
export async function loadContent(
  deck: string,
  fetchImpl: FetchLike = fetch,
  options: LoadOptions = {},
): Promise<ContentSource> {
  let firstError: unknown;
  try {
    const query = options.safe === true ? "?safe=1" : "";
    const res = await fetchImpl(`${deckPath(deck)}/content-url${query}`, {
      credentials: "same-origin",
      ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
    });
    if (res.status === 401) throw new SignedOutError();
    if (!res.ok) throw new Error(`content-url ${res.status}`);
    const body = (await res.json()) as {
      url?: unknown;
      scripts?: unknown;
      expect?: unknown;
      unlockRejected?: unknown;
    };
    if (typeof body.url !== "string") throw new Error("content-url: no url");
    const source: ContentSource = { contentUrl: body.url, fromCopy: false };
    if (typeof body.scripts === "string" && SCRIPTS_MODES.includes(body.scripts)) {
      source.scripts = body.scripts as ScriptsMode;
    }
    if (body.unlockRejected === true) source.unlockRejected = true;
    if (source.scripts === "running") {
      const expected = parseExpect(body.expect);
      // Script mode without the server's expectations would trust the frame's `ready`: refuse it.
      if (expected === undefined) throw new Error("content-url: script mode without expect");
      source.expect = expected;
    }
    return source;
  } catch (error) {
    if (error instanceof SignedOutError) throw error;
    firstError = error;
  }
  if (options.offline === false) throw firstError;
  const res = await fetchImpl(`${deckPath(deck)}/offline`, { credentials: "same-origin" }).catch(
    () => null,
  );
  if (res?.status === 401) throw new SignedOutError();
  const bundle = res?.ok ? parseOfflineBundle(await res.json().catch(() => null), deck) : null;
  if (!bundle || !isOfflineDocument(bundle.html)) throw firstError;
  return { contentHtml: bundle.html, fromCopy: true, revision: bundle.revision };
}

/** Layer 2 is possible here: a secure context (HTTPS or localhost) with service workers. */
export function offlineCapable(): boolean {
  return (
    typeof globalThis.isSecureContext === "boolean" &&
    globalThis.isSecureContext &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator
  );
}

async function activeWorker(timeoutMs: number): Promise<ServiceWorker | null> {
  if (!offlineCapable()) return null;
  await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE, updateViaCache: "none" });
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]);
  return reg?.active ?? null;
}

async function ask(message: ClientMessage, timeoutMs: number): Promise<WorkerReply | null> {
  const worker = await activeWorker(Math.min(timeoutMs, 15_000));
  if (!worker) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(parseWorkerReply(event.data));
    };
    worker.postMessage(message, [channel.port2]);
  });
}

export interface CopyStatus {
  /** An offline copy is stored on this device. */
  kept: boolean;
  revision: number | null;
}

const none: CopyStatus = { kept: false, revision: null };

/**
 * Registers the service worker (secure contexts only) and asks it to store this deck for offline use: player
 * page, presenter page, offline document, presenter data. Resolves `{ kept: false }` when not possible.
 */
export async function keepOfflineCopy(deck: string, timeoutMs = 120_000): Promise<CopyStatus> {
  try {
    const reply = await ask({ v: 1, type: "keep", deck }, timeoutMs);
    return reply?.ok ? { kept: true, revision: reply.revision } : none;
  } catch {
    return none;
  }
}

/** Whether an offline copy of this deck is stored (without storing one). */
export async function offlineCopyStatus(deck: string, timeoutMs = 10_000): Promise<CopyStatus> {
  try {
    const reply = await ask({ v: 1, type: "status", deck }, timeoutMs);
    return reply?.ok ? { kept: true, revision: reply.revision } : none;
  } catch {
    return none;
  }
}
