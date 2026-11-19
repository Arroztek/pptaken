// SPDX-License-Identifier: AGPL-3.0-or-later
// Script error visibility (ADR-023): the owner's player reports author-script failures, the owner reads and clears
// them in the panel, agents read them (bounded, sanitized, labelled untrusted) to fix their scripts.
//
// Reports are human-only (the owner's panel session; the HTTP layer adds CSRF, same-origin and rate limits) and are
// ignored unless the deck's CURRENT digest is approved and equals the digest the page was served with: a page that
// ran older code, a revoked approval or a forged digest records nothing. At most 30 distinct errors are kept per deck
// and digest; when the code changes, only the most recent previous digest is kept ("from a previous version").
import { validationError } from "../errors.js";
import type { Repositories, ScriptErrorKind, ScriptErrorRecord } from "../ports.js";
import { type CallContext, type Principal, requireOwner, requireScope } from "../principal.js";
import {
  cleanErrorText,
  SCRIPT_ERROR_KINDS,
  SCRIPT_ERROR_LIMITS,
  type ScriptErrorHint,
  scriptErrorFingerprint,
  scriptErrorHint,
} from "../script-errors.js";
import {
  SCRIPTS_DIGEST_PATTERN,
  type ScriptsState,
  scriptsDigest,
  scriptsStateOf,
} from "../scripts.js";
import {
  audit,
  type Ctx,
  loadLiveDeck,
  requireObject,
  requireString,
  runRead,
  runWrite,
} from "./context.js";

/** One error as the panel and the agent see it. */
export interface ScriptErrorView {
  kind: ScriptErrorKind;
  slideId: string;
  /** The slide's title (owner-written deck data, not error text), or null for `deck`/unknown slides. */
  slideTitle: string | null;
  /** 0-based slide position in the current revision, or null. */
  slideIndex: number | null;
  name: string;
  message: string;
  stack: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  hint: ScriptErrorHint;
}

/**
 * `none`: the deck has no scripts. `no_errors`: nothing reported for the current code (and nothing kept from a
 * previous one). `errors`: errors reported for the current code. `previous_only`: none for the current code, some
 * kept from the previous version.
 */
export type ScriptErrorsStatus = "none" | "no_errors" | "errors" | "previous_only";

export interface ScriptErrorsResult {
  presentationId: string;
  revision: number;
  /** Digest of the current revision's scripts. */
  digest: string | null;
  state: ScriptsState;
  status: ScriptErrorsStatus;
  /** Errors reported for the current digest, most recently seen first. */
  current: ScriptErrorView[];
  /** Errors kept from the most recent previous digest (stale code), most recently seen first. */
  previous: ScriptErrorView[];
  previousDigest: string | null;
}

export interface ReportScriptErrorsResult {
  /** Entries stored (new or counted). */
  accepted: number;
  /** Entries dropped (invalid, unknown slide, over the per-report cap). */
  dropped: number;
  /** Why nothing was stored, when `accepted` is 0 because of the digest. */
  ignored?: "digest_mismatch" | "not_approved";
}

/** A validated report entry. Unknown keys and wrong types make the entry invalid (dropped), never an exception. */
interface Entry {
  kind: ScriptErrorKind;
  slideId: string;
  name: string;
  message: string;
  stack: string;
  count: number;
}

const ENTRY_KEYS = new Set(["kind", "slideId", "name", "message", "stack", "count"]);

function parseEntry(raw: unknown, slideIds: ReadonlySet<string>): Entry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!ENTRY_KEYS.has(key)) return null;
  if (typeof r.kind !== "string" || !(SCRIPT_ERROR_KINDS as readonly string[]).includes(r.kind))
    return null;
  if (typeof r.slideId !== "string" || (r.slideId !== "deck" && !slideIds.has(r.slideId)))
    return null;
  for (const key of ["name", "message", "stack"] as const) {
    if (r[key] !== undefined && typeof r[key] !== "string") return null;
  }
  const count = r.count === undefined ? 1 : r.count;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > SCRIPT_ERROR_LIMITS.countPerEntry
  )
    return null;
  const message = cleanErrorText(r.message, SCRIPT_ERROR_LIMITS.message);
  const name = cleanErrorText(r.name, SCRIPT_ERROR_LIMITS.name) || "Error";
  if (message === "" && name === "Error" && r.kind !== "watchdog") return null;
  return {
    kind: r.kind as ScriptErrorKind,
    slideId: r.slideId,
    name,
    message,
    stack: cleanErrorText(r.stack, SCRIPT_ERROR_LIMITS.stack, true),
    count,
  };
}

/**
 * Owner only (human). Stores what the owner's player reported for `digest`. Ignored (nothing stored, no error)
 * unless `digest` is the current revision's digest AND the approved one. Invalid entries are dropped one by one.
 */
export async function reportScriptErrors(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string; digest: string; errors: unknown },
  call?: CallContext,
): Promise<ReportScriptErrorsResult> {
  return runRead(call, async () => {
    requireScope(principal, "decks:write");
    requireOwner(principal, "report script errors");
    const input = requireObject(rawInput);
    const id = requireString(input.presentationId, "presentationId");
    const digest = requireString(input.digest, "digest", 64);
    if (!SCRIPTS_DIGEST_PATTERN.test(digest)) {
      throw validationError("digest must be 64 lowercase hex characters", { path: "digest" });
    }
    if (!Array.isArray(input.errors)) {
      throw validationError("errors must be an array", { path: "errors" });
    }
    const raw = input.errors as unknown[];
    const ws = principal.workspaceId;
    return ctx.store.transaction(async (tx) => {
      const deck = await loadLiveDeck(tx, principal, id);
      const revision = await tx.revisions.get(ws, id, deck.currentRevision);
      if (revision === null) throw validationError("The current revision is missing", { path: "" });
      const current = scriptsDigest(revision.document);
      if (current !== digest)
        return { accepted: 0, dropped: raw.length, ignored: "digest_mismatch" };
      const approval = await tx.scriptApprovals.get(ws, id);
      if (approval?.digest !== digest)
        return { accepted: 0, dropped: raw.length, ignored: "not_approved" };
      const slideIds = new Set(revision.document.slides.map((s) => s.id));
      let accepted = 0;
      let dropped = Math.max(0, raw.length - SCRIPT_ERROR_LIMITS.perReport);
      // Merge duplicates inside the report first.
      const merged = new Map<string, Entry>();
      for (const item of raw.slice(0, SCRIPT_ERROR_LIMITS.perReport)) {
        const entry = parseEntry(item, slideIds);
        if (entry === null) {
          dropped++;
          continue;
        }
        const fp = scriptErrorFingerprint(entry);
        const prior = merged.get(fp);
        if (prior) prior.count = Math.min(prior.count + entry.count, SCRIPT_ERROR_LIMITS.maxCount);
        else merged.set(fp, entry);
      }
      const now = ctx.clock.now();
      for (const [fingerprint, entry] of merged) {
        const existing = await tx.scriptErrors.get(ws, id, digest, fingerprint);
        if (existing === null) await evictIfFull(tx, ws, id, digest);
        await tx.scriptErrors.put({
          workspaceId: ws,
          deckId: id,
          digest,
          fingerprint,
          kind: entry.kind,
          slideId: entry.slideId,
          name: entry.name,
          message: entry.message,
          stack: existing === null || entry.stack !== "" ? entry.stack : existing.stack,
          count: Math.min((existing?.count ?? 0) + entry.count, SCRIPT_ERROR_LIMITS.maxCount),
          firstSeen: existing?.firstSeen ?? now,
          lastSeen: now,
        });
        accepted++;
      }
      return { accepted, dropped };
    });
  });
}

/** Keeps at most `perDigest` distinct errors for a digest: the least recently seen one goes. */
async function evictIfFull(
  tx: Repositories,
  ws: string,
  deckId: string,
  digest: string,
): Promise<void> {
  const rows = (await tx.scriptErrors.list(ws, deckId)).filter((r) => r.digest === digest);
  if (rows.length < SCRIPT_ERROR_LIMITS.perDigest) return;
  const oldest = [...rows].sort((a, b) => a.lastSeen - b.lastSeen)[0];
  if (oldest) await tx.scriptErrors.deleteOne(ws, deckId, digest, oldest.fingerprint);
}

/**
 * Pruning when a deck's code changes (called inside the write transaction of every new revision): keeps the
 * records of `currentDigest` and of the most recently seen other digest; deletes the rest.
 */
export async function pruneScriptErrors(
  tx: Repositories,
  ws: string,
  deckId: string,
  currentDigest: string | null,
): Promise<void> {
  const rows = await tx.scriptErrors.list(ws, deckId);
  if (rows.length === 0) return;
  const keep = new Set<string>();
  if (currentDigest !== null) keep.add(currentDigest);
  const previous = rows.find((r) => r.digest !== currentDigest);
  if (previous) keep.add(previous.digest);
  if (rows.some((r) => !keep.has(r.digest)))
    await tx.scriptErrors.deleteDigestsExcept(ws, deckId, [...keep]);
}

/** `decks:read`. The errors reported for the current code and the previous version, for the panel and agents. */
export async function getScriptErrors(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string },
  call?: CallContext,
): Promise<ScriptErrorsResult> {
  return runRead(call, async () => {
    requireScope(principal, "decks:read");
    const id = requireString(requireObject(rawInput).presentationId, "presentationId");
    const ws = principal.workspaceId;
    const deck = await loadLiveDeck(ctx.store, principal, id);
    const revision = await ctx.store.revisions.get(ws, id, deck.currentRevision);
    if (revision === null) throw validationError("The current revision is missing", { path: "" });
    const digest = scriptsDigest(revision.document);
    const approval = await ctx.store.scriptApprovals.get(ws, id);
    const rows = await ctx.store.scriptErrors.list(ws, id);
    const slides = revision.document.slides;
    const view = (r: ScriptErrorRecord): ScriptErrorView => {
      const index = slides.findIndex((s) => s.id === r.slideId);
      return {
        kind: r.kind,
        slideId: r.slideId,
        slideTitle: index >= 0 ? (slides[index]?.title ?? null) || null : null,
        slideIndex: index >= 0 ? index : null,
        name: r.name,
        message: r.message,
        stack: r.stack,
        count: r.count,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        hint: scriptErrorHint(r),
      };
    };
    const current = digest === null ? [] : rows.filter((r) => r.digest === digest).map(view);
    const previousDigest = rows.find((r) => r.digest !== digest)?.digest ?? null;
    const previous =
      previousDigest === null ? [] : rows.filter((r) => r.digest === previousDigest).map(view);
    const status: ScriptErrorsStatus =
      digest === null && previous.length === 0
        ? "none"
        : current.length > 0
          ? "errors"
          : previous.length > 0
            ? "previous_only"
            : "no_errors";
    return {
      presentationId: id,
      revision: deck.currentRevision,
      digest,
      state: scriptsStateOf(digest, approval?.digest ?? null),
      status,
      current,
      previous,
      previousDigest,
    };
  });
}

/** Owner only (human). Deletes every reported error of the deck (all digests). Audited. */
export async function clearScriptErrors(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string },
  call?: CallContext,
): Promise<{ deleted: number }> {
  const target = (() => {
    const id = (rawInput as { presentationId?: unknown } | null)?.presentationId;
    return typeof id === "string" && id.length <= 64 ? `deck:${id}` : null;
  })();
  return runWrite(ctx, principal, call, "presentation.script_errors_clear", target, async () => {
    requireScope(principal, "decks:write");
    requireOwner(principal, "clear script errors");
    const id = requireString(requireObject(rawInput).presentationId, "presentationId");
    return ctx.store.transaction(async (tx) => {
      await loadLiveDeck(tx, principal, id);
      const deleted = await tx.scriptErrors.deleteForDeck(principal.workspaceId, id);
      await audit(
        ctx,
        tx,
        principal,
        call,
        "presentation.script_errors_clear",
        `deck:${id}`,
        "ok",
        {
          deleted,
        },
      );
      return { deleted };
    });
  });
}
