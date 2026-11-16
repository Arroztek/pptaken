// SPDX-License-Identifier: AGPL-3.0-or-later
// LocalAuth: the self-hosted AuthProvider. One owner per workspace (created with the install code), panel
// sessions (cookie), API tokens (Bearer) and the agent-connection status. Fails closed: anything malformed,
// unknown, expired or revoked authenticates as nobody.
import {
  DEFAULT_WORKSPACE_ID,
  ownerPrincipal,
  type Principal,
  SCOPES,
  type Scope,
} from "@pptaken/core";
import { constantTimeEqual, deriveKey, hmacHex } from "./crypto.js";
import type { OAuthService } from "./oauth.js";
import { OAUTH_ACCESS_PREFIX } from "./oauth-primitives.js";
import {
  checkPasswordPolicy,
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  needsRehash,
  type ScryptParams,
  verifyPassword,
} from "./password.js";
import type { ApiTokenRecord, AuthStore } from "./store.js";
import {
  generateApiToken,
  generateInstallCode,
  generateSessionId,
  hashSecret,
  isApiTokenFormat,
  normalizeInstallCode,
  SESSION_ID_PATTERN,
} from "./tokens.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * DAY_MS;
/** A session's expiry is pushed forward at most this often (fewer writes). */
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** A token's `last_used_at` is written at most this often. */
const TOKEN_TOUCH_INTERVAL_MS = 60 * 1000;

/** Scopes an owner can put on an API token in phase F2. */
export const ASSIGNABLE_SCOPES = [
  "decks:read",
  "decks:write",
  "quiz:draft",
] as const satisfies readonly Scope[];
export const DEFAULT_TOKEN_SCOPES: readonly Scope[] = ["decks:read", "decks:write", "quiz:draft"];
export const MAX_TOKEN_NAME_LENGTH = 100;
export const MAX_TOKEN_EXPIRY_DAYS = 3650;

const INSTALL_CODE_SETTING = "install_code";

export type AuthErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SETUP_REQUIRED"
  | "ALREADY_SETUP";

/** Errors of the auth flows, mapped 1:1 to the panel API error codes. Messages never echo secrets. */
export class AuthError extends Error {
  override readonly name = "AuthError";
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** A request as the auth layer sees it: the raw `Authorization` header and the session cookie value. */
export interface AuthRequest {
  authorization?: string | null | undefined;
  sessionId?: string | null | undefined;
}

export type Authenticated =
  | { kind: "session"; principal: Principal; ownerId: string; refreshed: boolean }
  | {
      kind: "token";
      principal: Principal;
      /** For OAuth access tokens: a view of the grant (id = grant id, name = client name). */
      token: TokenView;
      via: "api_token" | "oauth";
    };

/** The port the HTTP layer uses (architecture §9): resolve a request to a principal, or to nobody. */
export interface AuthProvider {
  authenticate(request: AuthRequest): Promise<Authenticated | null>;
}

/** An API token as shown to the owner (never the secret or its hash). */
export interface TokenView {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface McpStatus {
  lastCallAt: number;
  lastTool: string | null;
  clientName: string | null;
}

export interface LocalAuthOptions {
  store: AuthStore;
  /** The instance secret (`secret.key`); subkeys are derived from it. */
  secret: Uint8Array;
  ids: { ulid(): string };
  clock?: { now(): number };
  workspaceId?: string;
  /** Password hashing cost (tests use cheaper parameters). */
  scrypt?: ScryptParams;
  sessionTtlMs?: number;
  /** The OAuth authorization server (ADR-0018): `ppto_` access tokens and grant revocation. */
  oauth?: OAuthService;
}

function toView(t: ApiTokenRecord): TokenView {
  return {
    id: t.id,
    name: t.name,
    scopes: t.scopes.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s)),
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
  };
}

/** Parses `Authorization: Bearer <token>`; `null` for any other shape. */
export function bearerTokenOf(authorization: string | null | undefined): string | null {
  if (typeof authorization !== "string" || authorization.length > 200) return null;
  const m = /^Bearer[ ]+([^\s]+)[ ]*$/i.exec(authorization);
  return m === null ? null : (m[1] as string);
}

export class LocalAuth implements AuthProvider {
  private readonly store: AuthStore;
  private readonly ws: string;
  private readonly clock: { now(): number };
  private readonly installKey: Buffer;
  private readonly ids: { ulid(): string };
  private readonly scryptParams: ScryptParams;
  private readonly sessionTtlMs: number;
  private readonly oauth: OAuthService | undefined;

  constructor(options: LocalAuthOptions) {
    if (options.secret.length < 32) throw new RangeError("The instance secret must be 256 bits");
    this.store = options.store;
    this.ws = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.installKey = deriveKey(options.secret, "install-code");
    this.ids = options.ids;
    this.scryptParams = options.scrypt ?? DEFAULT_SCRYPT_PARAMS;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.oauth = options.oauth;
  }

  get workspaceId(): string {
    return this.ws;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Install and owner

  async isInstalled(): Promise<boolean> {
    return (await this.store.getOwner(this.ws)) !== null;
  }

  /**
   * At startup: when no owner exists, generates a fresh single-use install code (only its HMAC is stored,
   * replacing the previous boot's code) and returns it for the startup log. Returns `null` once installed.
   */
  async ensureInstallCode(): Promise<string | null> {
    if (await this.isInstalled()) {
      await this.store.deleteSetting(this.ws, INSTALL_CODE_SETTING);
      return null;
    }
    const code = generateInstallCode();
    const normalized = normalizeInstallCode(code) as string;
    await this.store.putSetting(
      this.ws,
      INSTALL_CODE_SETTING,
      hmacHex(this.installKey, normalized),
      this.clock.now(),
    );
    return code;
  }

  /**
   * Creates the owner from a password supplied by the operator at startup (`PPTAKEN_ADMIN_PASSWORD`), so no
   * install code is needed. Does nothing when an owner already exists (it never overwrites or resets a password).
   * Returns true when the owner was created. Throws when the password does not meet the policy.
   */
  async bootstrapOwner(password: string): Promise<boolean> {
    if (await this.isInstalled()) return false;
    const policy = checkPasswordPolicy(password);
    if (!policy.ok) {
      throw new AuthError(
        "VALIDATION_ERROR",
        "The admin password does not meet the policy",
        policy.hint,
      );
    }
    const now = this.clock.now();
    const owner = {
      workspaceId: this.ws,
      id: this.ids.ulid(),
      passwordHash: await hashPassword(password, this.scryptParams),
      createdAt: now,
      updatedAt: now,
    };
    // completeSetup is the atomic "create the owner if none exists" step; it consumes a marker in place of a code.
    const marker = "bootstrap";
    await this.store.putSetting(this.ws, INSTALL_CODE_SETTING, marker, now);
    const outcome = await this.store.completeSetup(owner, marker);
    await this.store.deleteSetting(this.ws, INSTALL_CODE_SETTING);
    if (outcome !== "ok") return false;
    return true;
  }

  /** Creates the owner with the install code and returns a new session. */
  async setup(input: {
    installCode: unknown;
    password: unknown;
  }): Promise<{ ownerId: string; sessionId: string }> {
    if (await this.isInstalled())
      throw new AuthError("ALREADY_SETUP", "This instance is already set up");
    const policy = checkPasswordPolicy(input.password);
    // The install code is checked first: only a caller who holds the code learns anything about the password.
    const code = normalizeInstallCode(input.installCode);
    const stored = await this.store.getSetting(this.ws, INSTALL_CODE_SETTING);
    const provided = code === null ? "" : hmacHex(this.installKey, code);
    const codeOk = code !== null && stored !== null && constantTimeEqual(provided, stored);
    if (!codeOk) {
      throw new AuthError(
        "FORBIDDEN",
        "The install code is not valid",
        "Copy the install code from the server logs (it changes on every restart until it is used).",
      );
    }
    if (!policy.ok) {
      throw new AuthError("VALIDATION_ERROR", "The password does not meet the policy", policy.hint);
    }
    const now = this.clock.now();
    const owner = {
      workspaceId: this.ws,
      id: this.ids.ulid(),
      passwordHash: await hashPassword(input.password as string, this.scryptParams),
      createdAt: now,
      updatedAt: now,
    };
    const outcome = await this.store.completeSetup(owner, stored as string);
    if (outcome === "already_setup")
      throw new AuthError("ALREADY_SETUP", "This instance is already set up");
    if (outcome === "code_mismatch") {
      throw new AuthError(
        "FORBIDDEN",
        "The install code is not valid",
        "Restart and use the new code.",
      );
    }
    return { ownerId: owner.id, sessionId: await this.createSession(owner.id) };
  }

  /** Verifies the owner's password and returns a new session (session rotation: always a fresh id). */
  async login(input: { password: unknown }): Promise<{ ownerId: string; sessionId: string }> {
    const owner = await this.store.getOwner(this.ws);
    if (owner === null)
      throw new AuthError("SETUP_REQUIRED", "Nobody has set up this instance yet");
    const password = input.password;
    const ok =
      typeof password === "string" &&
      password.length > 0 &&
      password.length <= MAX_PASSWORD_LENGTH &&
      (await verifyPassword(password, owner.passwordHash));
    if (!ok) throw new AuthError("UNAUTHENTICATED", "Wrong password");
    if (needsRehash(owner.passwordHash, this.scryptParams)) {
      await this.store.setOwnerPassword(
        this.ws,
        owner.id,
        await hashPassword(password as string, this.scryptParams),
        this.clock.now(),
      );
    }
    await this.store.deleteExpiredSessions(this.ws, this.clock.now());
    return { ownerId: owner.id, sessionId: await this.createSession(owner.id) };
  }

  /**
   * Sets a new password (CLI `pptaken reset-password`), signs out every session and disconnects every OAuth
   * application (ADR-0018: a reset means the owner may have lost control, so every grant goes too). Returns the
   * number of applications disconnected.
   */
  async resetPassword(password: unknown): Promise<number> {
    const owner = await this.store.getOwner(this.ws);
    if (owner === null)
      throw new AuthError("SETUP_REQUIRED", "Nobody has set up this instance yet");
    const policy = checkPasswordPolicy(password);
    if (!policy.ok)
      throw new AuthError("VALIDATION_ERROR", "The password does not meet the policy", policy.hint);
    await this.store.setOwnerPassword(
      this.ws,
      owner.id,
      await hashPassword(password as string, this.scryptParams),
      this.clock.now(),
    );
    await this.store.deleteAllSessions(this.ws);
    return (await this.oauth?.revokeAllGrants()) ?? 0;
  }

  /**
   * Changes the password from the panel: checks the current one, signs out every session and returns a fresh one
   * for the caller. With `disconnectApps`, every OAuth application is disconnected too.
   */
  async changePassword(input: {
    currentPassword: unknown;
    newPassword: unknown;
    disconnectApps?: boolean;
  }): Promise<{ sessionId: string; disconnected: number }> {
    const owner = await this.store.getOwner(this.ws);
    if (owner === null)
      throw new AuthError("SETUP_REQUIRED", "Nobody has set up this instance yet");
    const current = input.currentPassword;
    const ok =
      typeof current === "string" &&
      current.length > 0 &&
      current.length <= MAX_PASSWORD_LENGTH &&
      (await verifyPassword(current, owner.passwordHash));
    if (!ok) throw new AuthError("UNAUTHENTICATED", "Wrong password");
    const policy = checkPasswordPolicy(input.newPassword);
    if (!policy.ok)
      throw new AuthError("VALIDATION_ERROR", "The password does not meet the policy", policy.hint);
    await this.store.setOwnerPassword(
      this.ws,
      owner.id,
      await hashPassword(input.newPassword as string, this.scryptParams),
      this.clock.now(),
    );
    await this.store.deleteAllSessions(this.ws);
    const disconnected =
      input.disconnectApps === true ? ((await this.oauth?.revokeAllGrants()) ?? 0) : 0;
    return { sessionId: await this.createSession(owner.id), disconnected };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Sessions

  private async createSession(ownerId: string): Promise<string> {
    const id = generateSessionId();
    const now = this.clock.now();
    await this.store.insertSession({
      workspaceId: this.ws,
      idHash: hashSecret(id),
      ownerId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.sessionTtlMs,
    });
    return id;
  }

  /** Resolves a session id; slides its expiry. `refreshed` tells the HTTP layer to re-send the cookie. */
  async resolveSession(
    sessionId: unknown,
  ): Promise<{ ownerId: string; refreshed: boolean } | null> {
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return null;
    const hash = hashSecret(sessionId);
    const session = await this.store.getSession(this.ws, hash);
    if (session === null || !constantTimeEqual(session.idHash, hash)) return null;
    const now = this.clock.now();
    if (session.expiresAt <= now) {
      await this.store.deleteSession(this.ws, hash);
      return null;
    }
    const owner = await this.store.getOwner(this.ws);
    if (owner === null || owner.id !== session.ownerId) return null;
    let refreshed = false;
    if (now - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
      await this.store.touchSession(this.ws, hash, now, now + this.sessionTtlMs);
      refreshed = true;
    }
    return { ownerId: session.ownerId, refreshed };
  }

  async logout(sessionId: unknown): Promise<void> {
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return;
    await this.store.deleteSession(this.ws, hashSecret(sessionId));
  }

  /** "Sign out of all sessions". */
  async revokeAllSessions(): Promise<number> {
    return this.store.deleteAllSessions(this.ws);
  }

  // -------------------------------------------------------------------------------------------------------------
  // API tokens

  async createToken(input: {
    name: unknown;
    scopes?: unknown;
    expiresInDays?: unknown;
  }): Promise<{ token: TokenView; secret: string }> {
    if (typeof input.name !== "string") throw new AuthError("VALIDATION_ERROR", "name is required");
    const name = input.name.trim();
    if (
      name.length < 1 ||
      name.length > MAX_TOKEN_NAME_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(name)
    ) {
      throw new AuthError(
        "VALIDATION_ERROR",
        `name must be 1 to ${MAX_TOKEN_NAME_LENGTH} characters without control characters`,
      );
    }
    let scopes: Scope[] = [...DEFAULT_TOKEN_SCOPES];
    if (input.scopes !== undefined) {
      if (
        !Array.isArray(input.scopes) ||
        input.scopes.length === 0 ||
        input.scopes.length > SCOPES.length
      ) {
        throw new AuthError("VALIDATION_ERROR", "scopes must be a non-empty list of scopes");
      }
      const set = new Set<Scope>();
      for (const s of input.scopes) {
        if (!(ASSIGNABLE_SCOPES as readonly unknown[]).includes(s)) {
          throw new AuthError(
            "VALIDATION_ERROR",
            `Scope ${JSON.stringify(String(s).slice(0, 40))} cannot be assigned to a token`,
            `Assignable scopes: ${ASSIGNABLE_SCOPES.join(", ")}.`,
          );
        }
        set.add(s as Scope);
      }
      scopes = SCOPES.filter((s) => set.has(s));
    }
    let expiresAt: number | null = null;
    const now = this.clock.now();
    if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
      const days = input.expiresInDays;
      if (
        typeof days !== "number" ||
        !Number.isInteger(days) ||
        days < 1 ||
        days > MAX_TOKEN_EXPIRY_DAYS
      ) {
        throw new AuthError(
          "VALIDATION_ERROR",
          `expiresInDays must be an integer from 1 to ${MAX_TOKEN_EXPIRY_DAYS}`,
        );
      }
      expiresAt = now + days * DAY_MS;
    }
    const secret = generateApiToken();
    const record: ApiTokenRecord = {
      workspaceId: this.ws,
      id: this.ids.ulid(),
      name,
      tokenHash: hashSecret(secret),
      scopes,
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.store.insertToken(record);
    return { token: toView(record), secret };
  }

  async listTokens(): Promise<TokenView[]> {
    return (await this.store.listTokens(this.ws)).map(toView);
  }

  /** Revokes immediately. Throws `NOT_FOUND` for an unknown id. */
  async revokeToken(id: unknown): Promise<void> {
    if (
      typeof id !== "string" ||
      id.length > 64 ||
      !(await this.store.revokeToken(this.ws, id, this.clock.now()))
    ) {
      throw new AuthError("NOT_FOUND", "No API token has this id");
    }
  }

  /**
   * Resolves `Authorization: Bearer …` to an agent principal. Dispatches by prefix: `ppt_` API tokens anywhere;
   * `ppto_` OAuth access tokens only when `resource` names the audience they were issued for (`/mcp`), so
   * callers that pass no resource (the panel API) never accept them.
   */
  async authenticateBearer(
    authorization: string | null | undefined,
    options: { resource?: string } = {},
  ): Promise<Authenticated | null> {
    const secret = bearerTokenOf(authorization);
    if (secret === null) return null;
    if (secret.startsWith(OAUTH_ACCESS_PREFIX)) {
      if (this.oauth === undefined || options.resource === undefined) return null;
      const access = await this.oauth.authenticateAccessToken(secret, options.resource);
      if (access === null) return null;
      const g = access.grant;
      return {
        kind: "token",
        via: "oauth",
        principal: {
          actor: "agent",
          workspaceId: this.ws,
          scopes: new Set<Scope>(access.scopes),
          // The grant id: stable across refreshes, so rate limits and the audit log follow the connection.
          tokenId: g.id,
        },
        token: {
          id: g.id,
          name: g.clientName ?? g.clientId,
          scopes: [...access.scopes],
          createdAt: g.createdAt,
          expiresAt: access.expiresAt,
          lastUsedAt: g.lastUsedAt,
          revokedAt: null,
        },
      };
    }
    if (!isApiTokenFormat(secret)) return null;
    const hash = hashSecret(secret);
    const token = await this.store.getTokenByHash(hash);
    if (token === null || !constantTimeEqual(token.tokenHash, hash)) return null;
    const now = this.clock.now();
    if (token.workspaceId !== this.ws || token.revokedAt !== null) return null;
    if (token.expiresAt !== null && token.expiresAt <= now) return null;
    if (token.lastUsedAt === null || now - token.lastUsedAt >= TOKEN_TOUCH_INTERVAL_MS) {
      await this.store.touchToken(this.ws, token.id, now);
      token.lastUsedAt = now;
    }
    const view = toView(token);
    const principal: Principal = {
      actor: "agent",
      workspaceId: this.ws,
      scopes: new Set(view.scopes),
      tokenId: token.id,
    };
    return { kind: "token", via: "api_token", principal, token: view };
  }

  /**
   * The {@link AuthProvider}: a Bearer token (agent) when an `Authorization` header is present, otherwise the
   * session (owner). A present but invalid `Authorization` header never falls back to the cookie.
   */
  async authenticate(request: AuthRequest): Promise<Authenticated | null> {
    if (request.authorization !== undefined && request.authorization !== null) {
      return this.authenticateBearer(request.authorization);
    }
    const session = await this.resolveSession(request.sessionId);
    if (session === null) return null;
    return {
      kind: "session",
      principal: ownerPrincipal(this.ws),
      ownerId: session.ownerId,
      refreshed: session.refreshed,
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Agent connection status

  async recordMcpCall(input: {
    tool: string | null;
    clientName: string | null;
    tokenId: string | null;
  }) {
    const clean = (v: string | null, max: number) =>
      v === null ? null : v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) || null;
    // A request without a tool (initialize, tools/list) or without a client name keeps the previous values.
    const previous = await this.store.getMcpActivity(this.ws);
    await this.store.recordMcpActivity({
      workspaceId: this.ws,
      lastCallAt: this.clock.now(),
      lastTool: clean(input.tool, 64) ?? previous?.lastTool ?? null,
      clientName: clean(input.clientName, 120) ?? previous?.clientName ?? null,
      tokenId: input.tokenId ?? previous?.tokenId ?? null,
    });
  }

  async mcpStatus(): Promise<McpStatus | null> {
    const a = await this.store.getMcpActivity(this.ws);
    return a === null
      ? null
      : { lastCallAt: a.lastCallAt, lastTool: a.lastTool, clientName: a.clientName };
  }
}

export function createLocalAuth(options: LocalAuthOptions): LocalAuth {
  return new LocalAuth(options);
}
