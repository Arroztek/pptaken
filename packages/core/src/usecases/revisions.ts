// SPDX-License-Identifier: AGPL-3.0-or-later
// Revision history: list, read, restore (human only) and retention.
import type { Deck } from "@pptaken/schema";
import { sanitizeAndCheck } from "../deck.js";
import { notFound, validationError } from "../errors.js";
import type { ActorRef, DeckRecord } from "../ports.js";
import {
  type CallContext,
  type Principal,
  requireOwner,
  requireOwnerOrSystem,
  requireScope,
} from "../principal.js";
import { commitRevision, type RevisionWriteResult, summaryOf } from "./commit.js";
import {
  assertExpected,
  audit,
  type Ctx,
  decodeCursor,
  encodeCursor,
  loadLiveDeck,
  optionalLimit,
  requireObject,
  requireRevision,
  requireString,
  runRead,
  runWrite,
} from "./context.js";
import type { Page } from "./presentations.js";

export interface RevisionInfo {
  revision: number;
  title: string;
  slideCount: number;
  summary: string;
  createdAt: number;
  createdBy: ActorRef;
  /** True for the presentation's current revision. */
  current: boolean;
}

export interface RevisionDetail extends RevisionInfo {
  presentationId: string;
  /** Full deck envelope, including speaker notes. */
  document: Deck;
}

export async function listRevisions(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string; limit?: number; cursor?: string },
  call?: CallContext,
): Promise<Page<RevisionInfo>> {
  return runRead(call, async () => {
    requireScope(principal, "decks:read");
    const input = requireObject(rawInput);
    const id = requireString(input.presentationId, "presentationId");
    const limit = optionalLimit(input.limit, 20, 100);
    const cursor = decodeCursor(input.cursor, "r");
    const before = cursor === undefined ? undefined : Number(cursor);
    if (before !== undefined && !(Number.isSafeInteger(before) && before > 0)) {
      throw validationError("Invalid cursor", { path: "cursor" });
    }
    const deck = await loadLiveDeck(ctx.store, principal, id);
    const rows = await ctx.store.revisions.list(principal.workspaceId, id, {
      limit: limit + 1,
      ...(before === undefined ? {} : { beforeNumber: before }),
    });
    const items = rows.slice(0, limit).map(
      (r): RevisionInfo => ({
        revision: r.number,
        title: r.title,
        slideCount: r.slideCount,
        summary: r.summary,
        createdAt: r.createdAt,
        createdBy: r.createdBy,
        current: r.number === deck.currentRevision,
      }),
    );
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor("r", last.revision) : null,
    };
  });
}

export async function getRevision(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string; revision: number },
  call?: CallContext,
): Promise<RevisionDetail> {
  return runRead(call, async () => {
    requireScope(principal, "decks:read");
    const input = requireObject(rawInput);
    const id = requireString(input.presentationId, "presentationId");
    const number = requireRevision(input.revision, "revision");
    const deck = await loadLiveDeck(ctx.store, principal, id);
    const r = await ctx.store.revisions.get(principal.workspaceId, id, number);
    if (r === null) {
      throw notFound(`Revision ${number} does not exist`, {
        path: "revision",
        hint: "Call `list_revisions` to see the revisions that are kept.",
      });
    }
    return {
      presentationId: id,
      revision: r.number,
      title: r.title,
      slideCount: r.slideCount,
      summary: r.summary,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      current: r.number === deck.currentRevision,
      document: r.document,
    };
  });
}

/** Human only. Creates a new revision whose content is a copy of an older one. */
export async function restoreRevision(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string; revision: number; expectedRevision: number },
  call?: CallContext,
): Promise<RevisionWriteResult> {
  const pid = (rawInput as { presentationId?: unknown } | null)?.presentationId;
  const target = typeof pid === "string" && pid.length <= 64 ? `deck:${pid}` : null;
  return runWrite(ctx, principal, call, "revision.restore", target, async () => {
    requireScope(principal, "decks:write");
    requireOwner(principal, "restore an old revision");
    const input = requireObject(rawInput);
    const id = requireString(input.presentationId, "presentationId");
    const number = requireRevision(input.revision, "revision");
    const expected = requireRevision(input.expectedRevision, "expectedRevision");
    const ws = principal.workspaceId;
    const deck = await loadLiveDeck(ctx.store, principal, id);
    assertExpected(deck, expected);
    const old = await ctx.store.revisions.get(ws, id, number);
    if (old === null) {
      throw notFound(`Revision ${number} does not exist`, {
        path: "revision",
        hint: "Call `list_revisions` to see the revisions that are kept.",
      });
    }
    const linked = await ctx.store.assets.listForDeck(ws, id);
    const { deck: clean, warnings } = sanitizeAndCheck(
      old.document,
      ctx.config.limits.maxSlides,
      linked.map((a) => a.sha256),
      linked.filter((a) => a.mediaType === "text/javascript").map((a) => a.sha256),
    );
    return commitRevision(ctx, principal, call, {
      deckId: id,
      expectedRevision: expected,
      document: clean,
      warnings,
      summary: summaryOf(undefined, `Restored revision ${number}`),
      action: "revision.restore",
      detail: { restoredFrom: number },
    });
  });
}

/**
 * Owner or system job. Keeps the newest `keep` revisions (default `CoreConfig.revisionsKept`) of one presentation,
 * or of every presentation in the workspace (including the trash) when `presentationId` is omitted. The current
 * revision is never deleted.
 */
export async function pruneRevisions(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId?: string; keep?: number } = {},
  call?: CallContext,
): Promise<{ decks: number; revisionsDeleted: number }> {
  return runWrite(ctx, principal, call, "maintenance.prune_revisions", null, async () => {
    requireOwnerOrSystem(principal, "prune revisions");
    const input = requireObject(rawInput);
    const keep = optionalLimit(input.keep, ctx.config.revisionsKept, 100_000);
    const ws = principal.workspaceId;
    const decks: DeckRecord[] = [];
    if (input.presentationId !== undefined) {
      const id = requireString(input.presentationId, "presentationId");
      const deck = await ctx.store.decks.get(ws, id);
      if (deck !== null) decks.push(deck);
    } else {
      for (const trash of ["exclude", "only"] as const) {
        let beforeId: string | undefined;
        for (;;) {
          const page = await ctx.store.decks.list({
            workspaceId: ws,
            trash,
            limit: 500,
            ...(beforeId === undefined ? {} : { beforeId }),
          });
          decks.push(...page);
          if (page.length < 500) break;
          beforeId = page[page.length - 1]?.id;
        }
      }
    }
    let revisionsDeleted = 0;
    for (const deck of decks) {
      revisionsDeleted += await ctx.store.transaction(async (tx) => {
        const fresh = await tx.decks.get(ws, deck.id);
        if (fresh === null) return 0;
        const numbers = await tx.revisions.listNumbers(ws, deck.id);
        const keepSet = new Set(numbers.slice(-keep));
        keepSet.add(fresh.currentRevision);
        const doomed = numbers.filter((n) => !keepSet.has(n));
        if (doomed.length === 0) return 0;
        const n = await tx.revisions.deleteMany(ws, deck.id, doomed);
        await audit(ctx, tx, principal, call, "revision.prune", `deck:${deck.id}`, "ok", {
          deleted: n,
        });
        return n;
      });
    }
    return { decks: decks.length, revisionsDeleted };
  });
}
