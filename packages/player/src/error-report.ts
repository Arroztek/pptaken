// SPDX-License-Identifier: Apache-2.0
// Script error visibility, page side (ADR-023): the owner's player page sends the author-script failures the shell
// reported (`onScriptError`) to `POST /api/v1/decks/:id/script-errors`, so the owner sees them in the panel and the
// agent can read them with `get_presentation`. Only the owner's page runs it (never a guest page, never the offline
// copy), only for a scripted document, and always with the digest the page was served with.
//
// Bounded on purpose: occurrences are batched (first report after 1.5 s, then at most one request every 5 s), at
// most 20 entries per request and 30 requests per page load; a 429 pauses it for the time the server asks; every
// failure is ignored (reporting must never disturb the presentation). The server validates everything again.

import type { ScriptErrorReport } from "./shell.js";

export interface ErrorReporterOptions {
  deckId: string;
  /** The scripts digest the content-url endpoint returned with the scripted document. */
  digest: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Timers (tests inject fakes). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
}

export interface ErrorReporter {
  /** Call from `onScriptError`: the report's `count` is cumulative; the reporter sends the growth. */
  add(report: ScriptErrorReport): void;
  /** Sends what is pending now (on `pagehide`), with `keepalive`. */
  flush(): void;
  /** Requests sent so far (tests). */
  readonly sent: number;
}

export const REPORT_FIRST_DELAY_MS = 1500;
export const REPORT_MIN_INTERVAL_MS = 5000;
export const REPORT_MAX_ENTRIES = 20;
export const REPORT_MAX_REQUESTS = 30;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DIGEST = /^[0-9a-f]{64}$/;

interface Pending {
  report: ScriptErrorReport;
  /** Cumulative count already sent. */
  sentCount: number;
}

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter | null {
  if (!ULID.test(options.deckId) || !DIGEST.test(options.digest)) return null;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const later = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const now = options.now ?? (() => Date.now());
  const url = `/api/v1/decks/${encodeURIComponent(options.deckId)}/script-errors`;
  const entries = new Map<string, Pending>();
  let timer = false;
  let lastSent = 0;
  let pausedUntil = 0;
  let sent = 0;

  const due = (): Pending[] => [...entries.values()].filter((p) => p.report.count > p.sentCount);

  const send = (keepalive: boolean): void => {
    timer = false;
    if (sent >= REPORT_MAX_REQUESTS || now() < pausedUntil) return;
    const batch = due().slice(0, REPORT_MAX_ENTRIES);
    if (batch.length === 0) return;
    const errors = batch.map((p) => ({
      kind: p.report.kind,
      slideId: p.report.slideId,
      name: p.report.name,
      message: p.report.message,
      stack: p.report.stack,
      count: Math.min(Math.max(p.report.count - p.sentCount, 1), 10_000),
    }));
    for (const p of batch) p.sentCount = p.report.count;
    sent++;
    lastSent = now();
    doFetch(url, {
      method: "POST",
      credentials: "same-origin",
      keepalive,
      headers: { "Content-Type": "application/json", "X-PPTaken-CSRF": "1" },
      body: JSON.stringify({ digest: options.digest, errors }),
    }).then(
      (res) => {
        if (res.status === 429) {
          const after = Number(res.headers.get("Retry-After"));
          pausedUntil = now() + (Number.isFinite(after) && after > 0 ? after * 1000 : 60_000);
        }
        if (due().length > 0) schedule();
      },
      () => {
        // Offline or the server is gone: the presentation carries on.
      },
    );
  };

  const schedule = (): void => {
    if (timer || sent >= REPORT_MAX_REQUESTS) return;
    timer = true;
    const wait =
      sent === 0
        ? REPORT_FIRST_DELAY_MS
        : Math.max(REPORT_MIN_INTERVAL_MS - (now() - lastSent), 0, pausedUntil - now());
    later(() => send(false), wait);
  };

  return {
    add(report) {
      const key = JSON.stringify([report.kind, report.slideId, report.name, report.message]);
      const prior = entries.get(key);
      if (prior) {
        if (report.count > prior.report.count) prior.report = { ...report };
      } else {
        if (entries.size >= 50) return;
        entries.set(key, { report: { ...report }, sentCount: 0 });
      }
      schedule();
    },
    flush() {
      if (due().length > 0) send(true);
    },
    get sent() {
      return sent;
    },
  };
}
