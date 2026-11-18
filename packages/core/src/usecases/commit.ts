// SPDX-License-Identifier: AGPL-3.0-or-later
// The single write path for new revisions: check the revision, insert the immutable snapshot, move the head.
import type { Deck } from "@pptaken/schema";
import type { CoreWarning } from "../deck.js";
import { presentationNotFound, revisionConflict } from "../errors.js";
import type { CallContext, Principal } from "../principal.js";
import { type ScriptsSummary, scriptsSummary } from "../scripts.js";
import { actorRef, audit, type Ctx } from "./context.js";
import { linkVendoredAssets, type VendoredAsset, type VendorReportEntry } from "./vendoring.js";

/** Result of every use case that writes a new revision. */
export interface RevisionWriteResult {
  presentationId: string;
  /** The new current revision. */
  revision: number;
  slideCount: number;
  /** What the sanitizer removed and other non-fatal problems. The write succeeded. */
  warnings: CoreWarning[];
  /** The author scripts of the new revision and their trust state (interactive mode, ADR-020). */
  scripts: ScriptsSummary;
  /** External resources this write vendored, reused or failed to vendor (ADR-022); empty when none. */
  vendored: VendorReportEntry[];
}

/**
 * Atomically: verifies the deck is live and at `expectedRevision`, inserts revision `expectedRevision + 1`
 * and moves the head (compare-and-set). Throws `NOT_FOUND` or `REVISION_CONFLICT` (with the current revision).
 */
export async function commitRevision(
  ctx: Ctx,
  principal: Principal,
  call: CallContext | undefined,
  args: {
    deckId: string;
    expectedRevision: number;
    document: Deck;
    warnings: CoreWarning[];
    summary: string;
    action: string;
    detail?: Record<string, unknown>;
    /** Vendored assets to insert and link in the same transaction (ADR-022). */
    assets?: readonly VendoredAsset[];
    report?: VendorReportEntry[];
  },
): Promise<RevisionWriteResult> {
  const ws = principal.workspaceId;
  const number = args.expectedRevision + 1;
  return ctx.store.transaction(async (tx) => {
    const now = ctx.clock.now();
    const deck = await tx.decks.get(ws, args.deckId);
    if (deck === null || deck.deletedAt !== null) throw presentationNotFound(args.deckId);
    if (deck.currentRevision !== args.expectedRevision) {
      throw revisionConflict(args.expectedRevision, deck.currentRevision);
    }
    const moved = await tx.decks.updateHead(ws, args.deckId, args.expectedRevision, {
      currentRevision: number,
      title: args.document.title,
      lang: args.document.lang ?? null,
      slideCount: args.document.slides.length,
      updatedAt: now,
    });
    if (!moved) {
      const current = await tx.decks.get(ws, args.deckId);
      if (current === null || current.deletedAt !== null) throw presentationNotFound(args.deckId);
      throw revisionConflict(args.expectedRevision, current.currentRevision);
    }
    await linkVendoredAssets(ctx, tx, ws, args.deckId, args.assets ?? [], now);
    await tx.revisions.insert({
      workspaceId: ws,
      deckId: args.deckId,
      number,
      document: args.document,
      title: args.document.title,
      slideCount: args.document.slides.length,
      summary: args.summary,
      createdAt: now,
      createdBy: actorRef(principal),
    });
    const approval = await tx.scriptApprovals.get(ws, args.deckId);
    const scripts = scriptsSummary(args.document, approval?.digest ?? null);
    await audit(ctx, tx, principal, call, args.action, `deck:${args.deckId}`, "ok", {
      revision: number,
      ...args.detail,
      ...(scripts.digest === null
        ? {}
        : { scriptsDigest: scripts.digest, scriptsState: scripts.state }),
    });
    return {
      presentationId: args.deckId,
      revision: number,
      slideCount: args.document.slides.length,
      warnings: args.warnings,
      scripts,
      vendored: args.report ?? [],
    };
  });
}

/** Clips a free-text revision summary. */
export function summaryOf(custom: unknown, fallback: string): string {
  const text = typeof custom === "string" && custom.trim() !== "" ? custom.trim() : fallback;
  return text.length > 280 ? `${text.slice(0, 279)}…` : text;
}
