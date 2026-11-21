// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared plumbing of the use cases: dependencies, error wrapping, audit, input guards.
import type { CoreConfig } from "../config.js";
import {
  internalError,
  isDomainError,
  presentationNotFound,
  revisionConflict,
  validationError,
} from "../errors.js";
import type {
  ActorRef,
  AuditResult,
  BlobStore,
  Clock,
  DeckRecord,
  IdGenerator,
  Repositories,
  ShareLinkSecrets,
  UnitOfWork,
  VendorFetcher,
} from "../ports.js";
import type { CallContext, Principal } from "../principal.js";

export interface Ctx {
  store: UnitOfWork;
  blobs: BlobStore;
  clock: Clock;
  ids: IdGenerator;
  config: CoreConfig;
  /** Ingest-time vendoring (ADR-022); without it external references are left to the sanitizer. */
  vendor?: VendorFetcher | undefined;
  /** Trust lineage policy (ADR-024); without it no edit is ever approved automatically. */
  trust?: TrustPolicy | undefined;
  /** Public-link secrets (ADR-026); without it links cannot be created and no secret resolves. */
  shareSecrets?: ShareLinkSecrets | undefined;
}

/**
 * The owner's setting that lets edits of already-approved code keep their approval (ADR-024). Read by the server
 * from its own settings store; there is no agent-callable way to change it.
 */
export interface TrustPolicy {
  autoApproveUpdates(workspaceId: string): Promise<boolean>;
}

export function actorRef(principal: Principal): ActorRef {
  return { actor: principal.actor, tokenId: principal.tokenId ?? null };
}

/** Appends an audit entry; never fails the operation (best effort). */
export async function audit(
  ctx: Ctx,
  repos: Repositories,
  principal: Principal,
  call: CallContext | undefined,
  action: string,
  target: string | null,
  result: AuditResult,
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  try {
    await repos.audit.append({
      workspaceId: principal.workspaceId,
      id: ctx.ids.ulid(),
      at: ctx.clock.now(),
      actor: principal.actor,
      tokenId: principal.tokenId ?? null,
      action,
      target,
      ip: call?.ip ?? null,
      result,
      detail,
    });
  } catch {
    // Best effort: the audit log must not turn a successful write into a failure.
  }
}

/** Runs a read use case: domain errors pass through, anything else becomes `INTERNAL`. */
export async function runRead<T>(
  call: CallContext | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw internalError(error, call?.requestId);
  }
}

/**
 * Runs a write use case. Successful writes audit themselves inside their transaction; failures are audited here
 * (`denied` for permission errors, `error` otherwise), outside any transaction and best effort.
 */
export async function runWrite<T>(
  ctx: Ctx,
  principal: Principal,
  call: CallContext | undefined,
  action: string,
  target: string | null,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const domain = isDomainError(error) ? error : internalError(error, call?.requestId);
    const result: AuditResult =
      domain.code === "FORBIDDEN_SCOPE" || domain.code === "FORBIDDEN_ACTOR" ? "denied" : "error";
    await audit(ctx, ctx.store, principal, call, action, target, result, { code: domain.code });
    throw domain;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Input guards (inputs come from MCP/REST after schema validation, but the core does not rely on it).

export function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("The input must be an object", { path: "" });
  }
  return input as Record<string, unknown>;
}

export function requireString(value: unknown, path: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw validationError(`${path} must be a non-empty string of at most ${max} characters`, {
      path,
    });
  }
  return value;
}

export function requireRevision(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw validationError(`${path} must be a positive integer`, {
      path,
      hint: "Send the revision number returned by your last call (or by `get_presentation`).",
    });
  }
  return value as number;
}

export function optionalLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw validationError(`limit must be an integer from 1 to ${max}`, { path: "limit" });
  }
  return value as number;
}

/** Loads a live (not trashed) deck or throws `NOT_FOUND`. */
export async function loadLiveDeck(
  repos: Repositories,
  principal: Principal,
  id: string,
): Promise<DeckRecord> {
  const deck = await repos.decks.get(principal.workspaceId, id);
  if (deck === null || deck.deletedAt !== null) throw presentationNotFound(id);
  return deck;
}

export function assertExpected(deck: DeckRecord, expected: number): void {
  if (deck.currentRevision !== expected) throw revisionConflict(expected, deck.currentRevision);
}

/** Opaque cursor helpers: `<kind>.<value>`. */
export function encodeCursor(kind: string, value: string | number): string {
  return `${kind}.${value}`;
}

export function decodeCursor(cursor: unknown, kind: string): string | undefined {
  if (cursor === undefined || cursor === null) return undefined;
  if (typeof cursor !== "string" || !cursor.startsWith(`${kind}.`) || cursor.length > 100) {
    throw validationError("Invalid cursor", {
      path: "cursor",
      hint: "Pass the `nextCursor` value of the previous page unchanged, or omit it to start over.",
    });
  }
  return cursor.slice(kind.length + 1);
}
