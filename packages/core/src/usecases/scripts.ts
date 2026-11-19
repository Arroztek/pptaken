// SPDX-License-Identifier: AGPL-3.0-or-later
// Interactive mode (ADR-020): status, approval and revocation of a deck's author scripts. Approval is a human-only
// action (the owner's panel session); agents can write scripts but never approve them. Every approve and revoke
// is audited with the digest, and so is every refused attempt.
import type { Deck, VendoredScript } from "@pptaken/schema";
import { DomainError, validationError } from "../errors.js";
import type { ApprovalMode, Repositories, ScriptApprovalRecord } from "../ports.js";
import { type CallContext, type Principal, requireOwner, requireScope } from "../principal.js";
import {
  libKey,
  SCRIPTS_DIGEST_PATTERN,
  type ScriptsState,
  type ScriptsSummary,
  scriptsSummary,
  untrustedLibs,
} from "../scripts.js";
import { sha256Hex, utf8Encode } from "../sha256.js";
import {
  actorRef,
  audit,
  type Ctx,
  loadLiveDeck,
  requireObject,
  requireString,
  runRead,
  runWrite,
} from "./context.js";

export interface ScriptsStatus extends ScriptsSummary {
  presentationId: string;
  /** Revision the digest was computed from (the current one). */
  revision: number;
  /** The instance switch (`PPTAKEN_SCRIPTS`); when false nothing runs, whatever the state. */
  enabled: boolean;
  /** The approved digest, when one is stored (it may belong to older code: then `state` is `pending`). */
  approvedDigest: string | null;
  approvedAt: number | null;
  /** ADR-024: how the stored approval was given (`null` without one). */
  approvalMode: ApprovalMode | null;
  /** True when the owner approved exactly the current code with a click (guest contexts need this). */
  ownerApproved: boolean;
  /** Libraries of the current code never approved for this deck (new third-party code): they always need a click. */
  newLibs: VendoredScript[];
  /** For an automatic approval: the revision whose approved code the current one replaced. */
  previousRevision: number | null;
}

function lineageFacts(
  doc: Deck,
  digest: string | null,
  approval: ScriptApprovalRecord | null,
): Pick<ScriptsStatus, "approvalMode" | "ownerApproved" | "newLibs" | "previousRevision"> {
  const current = approval !== null && digest !== null && approval.digest === digest;
  return {
    approvalMode: approval?.mode ?? null,
    ownerApproved: digest !== null && approval?.ownerDigest === digest,
    newLibs: current ? [] : untrustedLibs(doc, approval?.trustedLibs ?? []),
    previousRevision: current && approval?.mode === "auto" ? approval.previousRevision : null,
  };
}

async function statusOf(
  ctx: Ctx,
  repos: Repositories,
  principal: Principal,
  id: string,
): Promise<ScriptsStatus> {
  const deck = await loadLiveDeck(repos, principal, id);
  const revision = await repos.revisions.get(principal.workspaceId, id, deck.currentRevision);
  if (revision === null) throw validationError("The current revision is missing", { path: "" });
  const approval = await repos.scriptApprovals.get(principal.workspaceId, id);
  const summary = scriptsSummary(revision.document, approval?.digest ?? null);
  return {
    presentationId: id,
    revision: deck.currentRevision,
    enabled: ctx.config.scriptsEnabled,
    ...summary,
    approvedDigest: approval?.digest ?? null,
    approvedAt: approval?.approvedAt ?? null,
    ...lineageFacts(revision.document, summary.digest, approval),
  };
}

/** Every author script of a document, in deck order, with its hash and size. */
function sourcesOf(document: Deck): {
  sources: ScriptSource[];
  deckSource: ScriptsReview["deckSource"];
} {
  const sources: ScriptSource[] = [];
  document.slides.forEach((slide, index) => {
    if (slide.script === undefined) return;
    const bytes = utf8Encode(slide.script);
    sources.push({
      slideId: slide.id,
      index,
      source: slide.script,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
    });
  });
  const deckScript = document.script;
  const deckBytes = deckScript === undefined ? null : utf8Encode(deckScript);
  return {
    sources,
    deckSource:
      deckScript === undefined || deckBytes === null
        ? null
        : { source: deckScript, sha256: sha256Hex(deckBytes), bytes: deckBytes.length },
  };
}

/** One slide's author script as the owner reviews it (ADR-021: the approval screen shows every byte). */
export interface ScriptSource {
  slideId: string;
  /** 0-based position of the slide in the deck. */
  index: number;
  /** The exact code that runs (the digest covers its SHA-256). */
  source: string;
  /** SHA-256 (hex) of the UTF-8 code: the value the digest is computed from. */
  sha256: string;
  /** UTF-8 size. */
  bytes: number;
}

export interface ScriptsReview extends ScriptsStatus {
  /** Every slide script of the current revision, in deck order. */
  sources: ScriptSource[];
  /** The deck-level script (ADR-022), run once before the slide scripts, or null. */
  deckSource: { source: string; sha256: string; bytes: number } | null;
  /**
   * ADR-024 "Review changes": for an automatic approval, the code it replaced (the previously approved revision),
   * or null when there is none or that revision was pruned.
   */
  previous: {
    revision: number;
    sources: ScriptSource[];
    deckSource: ScriptsReview["deckSource"];
    libs: VendoredScript[];
  } | null;
}

/**
 * `decks:read`. The scripts status plus every script's source, hash and size: what the owner reads before approving.
 * Computed from the same revision as the digest, so what is shown is exactly what the digest binds.
 */
export async function getScriptsReview(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string },
  call?: CallContext,
): Promise<ScriptsReview> {
  return runRead(call, async () => {
    requireScope(principal, "decks:read");
    const id = requireString(requireObject(rawInput).presentationId, "presentationId");
    const deck = await loadLiveDeck(ctx.store, principal, id);
    const revision = await ctx.store.revisions.get(principal.workspaceId, id, deck.currentRevision);
    if (revision === null) throw validationError("The current revision is missing", { path: "" });
    const approval = await ctx.store.scriptApprovals.get(principal.workspaceId, id);
    const summary = scriptsSummary(revision.document, approval?.digest ?? null);
    const facts = lineageFacts(revision.document, summary.digest, approval);
    let previous: ScriptsReview["previous"] = null;
    if (facts.previousRevision !== null) {
      const old = await ctx.store.revisions.get(principal.workspaceId, id, facts.previousRevision);
      if (old !== null) {
        previous = {
          revision: facts.previousRevision,
          ...sourcesOf(old.document),
          libs: (old.document.libs ?? []).map((lib) => ({ ...lib })),
        };
      }
    }
    return {
      presentationId: id,
      revision: deck.currentRevision,
      enabled: ctx.config.scriptsEnabled,
      ...summary,
      approvedDigest: approval?.digest ?? null,
      approvedAt: approval?.approvedAt ?? null,
      ...facts,
      ...sourcesOf(revision.document),
      previous,
    };
  });
}

/** `decks:read`. The scripts digest of the current revision and its trust state. */
export async function getScriptsStatus(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string },
  call?: CallContext,
): Promise<ScriptsStatus> {
  return runRead(call, async () => {
    requireScope(principal, "decks:read");
    const id = requireString(requireObject(rawInput).presentationId, "presentationId");
    return statusOf(ctx, ctx.store, principal, id);
  });
}

function targetOf(input: unknown): string | null {
  const id = (input as { presentationId?: unknown } | null)?.presentationId;
  return typeof id === "string" && id.length <= 64 ? `deck:${id}` : null;
}

/**
 * Owner only. Approves the deck's current scripts. `digest` must be the digest the owner reviewed: if the scripts
 * changed in between (an agent edit), the approval is refused, so consent always binds to the code that was shown.
 */
export async function approveScripts(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string; digest: string },
  call?: CallContext,
): Promise<ScriptsStatus> {
  return runWrite(ctx, principal, call, "presentation.scripts_approve", targetOf(rawInput), () => {
    requireScope(principal, "decks:write");
    requireOwner(principal, "approve a presentation's scripts");
    const input = requireObject(rawInput);
    const id = requireString(input.presentationId, "presentationId");
    const digest = requireString(input.digest, "digest", 64);
    if (!SCRIPTS_DIGEST_PATTERN.test(digest)) {
      throw validationError("digest must be 64 lowercase hex characters", { path: "digest" });
    }
    if (!ctx.config.scriptsEnabled) {
      throw new DomainError("VALIDATION_ERROR", "Scripts are disabled on this instance", {
        path: "digest",
        hint: "The operator must set PPTAKEN_SCRIPTS=owner before any presentation's scripts can be approved.",
      });
    }
    return ctx.store.transaction(async (tx) => {
      const status = await statusOf(ctx, tx, principal, id);
      if (status.digest === null) {
        throw validationError("This presentation has no scripts to approve", { path: "digest" });
      }
      if (status.digest !== digest) {
        throw new DomainError("REVISION_CONFLICT", "The scripts changed since they were reviewed", {
          path: "digest",
          hint: "Reload the scripts, review them again and approve the new digest.",
          details: { currentDigest: status.digest, currentRevision: status.revision },
        });
      }
      const now = ctx.clock.now();
      // ADR-024: an explicit approval starts (or extends) the trust lineage: its libraries join the trusted set.
      const existing = await tx.scriptApprovals.get(principal.workspaceId, id);
      const trustedLibs = [
        ...new Set([...(existing?.trustedLibs ?? []), ...status.libs.map(libKey)]),
      ];
      await tx.scriptApprovals.set({
        workspaceId: principal.workspaceId,
        deckId: id,
        digest,
        approvedAt: now,
        approvedBy: actorRef(principal),
        mode: "owner",
        ownerDigest: digest,
        trustedLibs,
        previousRevision: null,
      });
      await audit(ctx, tx, principal, call, "presentation.scripts_approve", `deck:${id}`, "ok", {
        digest,
        revision: status.revision,
      });
      return {
        ...status,
        state: "approved" as ScriptsState,
        approvedDigest: digest,
        approvedAt: now,
        approvalMode: "owner" as const,
        ownerApproved: true,
        newLibs: [],
        previousRevision: null,
      };
    });
  });
}

/** Owner only. Withdraws the approval: the deck renders static until approved again. Idempotent. */
export async function revokeScripts(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string },
  call?: CallContext,
): Promise<ScriptsStatus> {
  return runWrite(ctx, principal, call, "presentation.scripts_revoke", targetOf(rawInput), () => {
    requireScope(principal, "decks:write");
    requireOwner(principal, "revoke a presentation's scripts");
    const id = requireString(requireObject(rawInput).presentationId, "presentationId");
    return ctx.store.transaction(async (tx) => {
      await loadLiveDeck(tx, principal, id);
      const removed = await tx.scriptApprovals.delete(principal.workspaceId, id);
      await audit(ctx, tx, principal, call, "presentation.scripts_revoke", `deck:${id}`, "ok", {
        removed,
      });
      return statusOf(ctx, tx, principal, id);
    });
  });
}
