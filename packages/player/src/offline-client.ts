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
): Promise<ContentSource> {
  let firstError: unknown;
  try {
    const res = await fetchImpl(`${deckPath(deck)}/content-url`, { credentials: "same-origin" });
    if (res.status === 401) throw new SignedOutError();
    if (!res.ok) throw new Error(`content-url ${res.status}`);
    const body = (await res.json()) as { url?: unknown };
    if (typeof body.url !== "string") throw new Error("content-url: no url");
    return { contentUrl: body.url, fromCopy: false };
  } catch (error) {
    if (error instanceof SignedOutError) throw error;
    firstError = error;
  }
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
