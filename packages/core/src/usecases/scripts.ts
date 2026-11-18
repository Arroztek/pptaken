// SPDX-License-Identifier: AGPL-3.0-or-later
// Interactive mode (ADR-020): status, approval and revocation of a deck's author scripts. Approval is a human-only
// action (the owner's panel session); agents can write scripts but never approve them. Every approve and revoke
// is audited with the digest, and so is every refused attempt.
import { DomainError, validationError } from "../errors.js";
import type { Repositories } from "../ports.js";
import { type CallContext, type Principal, requireOwner, requireScope } from "../principal.js";
import {
  SCRIPTS_DIGEST_PATTERN,
  type ScriptsState,
  type ScriptsSummary,
  scriptsSummary,
} from "../scripts.js";
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
  };
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
      await tx.scriptApprovals.set({
        workspaceId: principal.workspaceId,
        deckId: id,
        digest,
        approvedAt: now,
        approvedBy: actorRef(principal),
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
