// SPDX-License-Identifier: AGPL-3.0-or-later
import { forbiddenActor, forbiddenScope } from "./errors.js";

/** Permission scopes of a token (`docs/foundation/04-security-and-auth.md` §3.3). */
export const SCOPES = [
  "decks:read",
  "decks:write",
  "quiz:draft",
  "share:write",
  "live:control",
  "admin",
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * Who is calling:
 * - `owner`: the human with a panel session (the only actor allowed to do human-only actions);
 * - `agent`: an API or OAuth token used by an AI agent or a script;
 * - `system`: internal maintenance jobs (retention, garbage collection).
 */
export type Actor = "owner" | "agent" | "system";

/**
 * The resolved identity of a call. Built by the auth layer (`AuthProvider`), never from user input. The owner's
 * session principal should carry every scope it is allowed to use (see {@link ownerPrincipal}).
 */
export interface Principal {
  readonly actor: Actor;
  readonly workspaceId: string;
  readonly scopes: ReadonlySet<Scope>;
  /** Id of the API token or OAuth grant used, for the audit log. */
  readonly tokenId?: string;
}

/** Per-call facts that are not identity: recorded in the audit log and in `INTERNAL` errors. */
export interface CallContext {
  readonly ip?: string;
  readonly requestId?: string;
}

/** Workspace id of the self-hosted edition. */
export const DEFAULT_WORKSPACE_ID = "default";

/** Principal of the owner's panel session, with every scope. */
export function ownerPrincipal(workspaceId: string = DEFAULT_WORKSPACE_ID): Principal {
  return { actor: "owner", workspaceId, scopes: new Set(SCOPES) };
}

/** Principal of internal maintenance jobs (retention, garbage collection). */
export function systemPrincipal(workspaceId: string = DEFAULT_WORKSPACE_ID): Principal {
  return { actor: "system", workspaceId, scopes: new Set(SCOPES) };
}

/** Throws `FORBIDDEN_SCOPE` unless the principal holds `scope`. */
export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.has(scope)) throw forbiddenScope(scope);
}

/** Throws `FORBIDDEN_ACTOR` unless the caller is the human owner (human-only actions, security §3.3). */
export function requireOwner(principal: Principal, action: string): void {
  if (principal.actor !== "owner") throw forbiddenActor(action);
}

/** Throws `FORBIDDEN_ACTOR` unless the caller is the owner or an internal job. */
export function requireOwnerOrSystem(principal: Principal, action: string): void {
  if (principal.actor !== "owner" && principal.actor !== "system") throw forbiddenActor(action);
}
