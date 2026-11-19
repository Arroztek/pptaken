// SPDX-License-Identifier: AGPL-3.0-or-later
// The single write path for new revisions: check the revision, insert the immutable snapshot, move the head.
import type { Deck } from "@pptaken/schema";
import type { CoreWarning } from "../deck.js";
import { presentationNotFound, revisionConflict } from "../errors.js";
import type { Repositories, ScriptApprovalRecord } from "../ports.js";
import type { CallContext, Principal } from "../principal.js";
import {
  libKey,
  lineageDecision,
  type ScriptsSummary,
  scriptsDigest,
  scriptsSummary,
} from "../scripts.js";
import { actorRef, audit, type Ctx } from "./context.js";
import { pruneScriptErrors } from "./script-errors.js";
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
  // ADR-024: the owner's setting is read before the transaction (it lives in the server's settings store).
  let autoApprove = false;
  if (ctx.trust !== undefined) {
    try {
      autoApprove = await ctx.trust.autoApproveUpdates(ws);
    } catch {
      autoApprove = false; // fail closed: the deck waits for the owner's click
    }
  }
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
    let approval = await tx.scriptApprovals.get(ws, args.deckId);
    const lineage = await continueLineage(ctx, tx, principal, call, {
      deckId: args.deckId,
      previousRevision: args.expectedRevision,
      next: args.document,
      approval,
      autoApprove,
      now,
    });
    if (lineage !== null) approval = lineage;
    const scripts = scriptsSummary(args.document, approval?.digest ?? null);
    // ADR-023: errors reported for code that is no longer current are stale; keep only the previous version.
    await pruneScriptErrors(tx, ws, args.deckId, scripts.digest);
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

/**
 * ADR-024, the trust lineage. Applied by the server itself inside the write's transaction: no tool or API can ask for
 * it. When the rule holds (see `lineageDecision`) the approval moves to the new digest with `mode: "auto"`, keeping
 * the owner's last explicit digest and the trusted libraries, and the decision is audited. Otherwise nothing changes
 * (the old approval stays, so the deck waits for the owner), and a broken lineage is audited with its reason.
 */
async function continueLineage(
  ctx: Ctx,
  tx: Repositories,
  principal: Principal,
  call: CallContext | undefined,
  args: {
    deckId: string;
    previousRevision: number;
    next: Deck;
    approval: ScriptApprovalRecord | null;
    autoApprove: boolean;
    now: number;
  },
): Promise<ScriptApprovalRecord | null> {
  const { approval } = args;
  if (approval === null) return null;
  const previous = await tx.revisions.get(
    principal.workspaceId,
    args.deckId,
    args.previousRevision,
  );
  if (previous === null) return null;
  const previousDigest = scriptsDigest(previous.document);
  const nextDigest = scriptsDigest(args.next);
  // The approved previous version's own libraries are approved by definition (covers approvals made before the
  // lineage existed, whose trusted list is empty).
  const trustedLibs = [
    ...new Set([...approval.trustedLibs, ...(previous.document.libs ?? []).map(libKey)]),
  ];
  const decision = lineageDecision({
    scriptsEnabled: ctx.config.scriptsEnabled,
    autoApprove: args.autoApprove,
    approvedDigest: approval.digest,
    previousDigest,
    nextDigest,
    next: args.next,
    trustedLibs,
  });
  const target = `deck:${args.deckId}`;
  if (!decision.continue) {
    if (decision.reason === "new_library" || decision.reason === "setting_off") {
      await audit(ctx, tx, principal, call, "presentation.scripts_lineage_break", target, "ok", {
        reason: decision.reason,
        previousDigest,
        digest: nextDigest,
        ...(decision.newLibs === undefined
          ? {}
          : {
              newLibs: decision.newLibs.map((l) => ({
                sha256: l.sha256,
                source: l.source ?? null,
              })),
            }),
      });
    }
    return null;
  }
  const record: ScriptApprovalRecord = {
    workspaceId: principal.workspaceId,
    deckId: args.deckId,
    digest: nextDigest as string,
    approvedAt: args.now,
    approvedBy: actorRef(principal),
    mode: "auto",
    ownerDigest: approval.ownerDigest,
    trustedLibs,
    previousRevision: args.previousRevision,
  };
  await tx.scriptApprovals.set(record);
  await audit(ctx, tx, principal, call, "presentation.scripts_auto_approve", target, "ok", {
    rule: "trust_lineage",
    digest: record.digest,
    previousDigest,
    ownerDigest: record.ownerDigest,
    revision: args.previousRevision + 1,
  });
  return record;
}

/** Clips a free-text revision summary. */
export function summaryOf(custom: unknown, fallback: string): string {
  const text = typeof custom === "string" && custom.trim() !== "" ? custom.trim() : fallback;
  return text.length > 280 ? `${text.slice(0, 279)}…` : text;
}
