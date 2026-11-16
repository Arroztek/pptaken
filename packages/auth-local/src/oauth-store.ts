// SPDX-License-Identifier: AGPL-3.0-or-later
// The storage port of the OAuth authorization server (ADR-0018). Implemented by `createSqliteOAuthStore` in
// @pptaken/storage-sqlite (production, migration 0004_oauth) and by `MemoryOAuthStore` below (tests). Same
// conventions as `AuthStore`: async, explicit workspace, epoch-millisecond timestamps, copies. Secrets are stored
// only as SHA-256 hex (authorization codes, access and refresh tokens).

export type OAuthClientKind = "cimd" | "dcr";

/** A client known to this server: registered through DCR, or a CIMD client stored when the owner approved it. */
export interface OAuthClientRecord {
  workspaceId: string;
  /** `pptc_…` for DCR clients; the metadata document URL for CIMD clients. */
  id: string;
  kind: OAuthClientKind;
  /** The client-supplied name, as given (sanitized only for display). */
  name: string | null;
  redirectUris: string[];
  /** The registration metadata echoed back by `POST /oauth/register` (JSON). */
  metadata: string;
  createdAt: number;
}

/** One approval by the owner. Its id is the `Principal.tokenId` of every token issued under it. */
export interface OAuthGrantRecord {
  workspaceId: string;
  id: string;
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  scopes: string[];
  /** Canonical resource (audience) the tokens are bound to: `<issuer>/mcp`. */
  resource: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** When the grant stops being usable unless refreshed (the newest refresh token's expiry). */
  expiresAt: number;
  revokedAt: number | null;
}

export interface OAuthCodeRecord {
  workspaceId: string;
  codeHash: string;
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export type OAuthTokenKind = "access" | "refresh";

export interface OAuthTokenRecord {
  workspaceId: string;
  tokenHash: string;
  grantId: string;
  kind: OAuthTokenKind;
  createdAt: number;
  expiresAt: number;
  /** Refresh tokens: hash of the token that replaced this one at rotation. */
  replacedBy: string | null;
  rotatedAt: number | null;
}

export interface OAuthPurgeOptions {
  /** Grants revoked or expired before this instant are deleted (with their codes and tokens). */
  deadGrantsBefore: number;
  /** Clients without any grant created before this instant are deleted. */
  clientsWithoutGrantBefore: number;
}

export interface OAuthStore {
  /** Inserts or replaces a client. */
  upsertClient(client: OAuthClientRecord): Promise<void>;
  getClient(workspaceId: string, id: string): Promise<OAuthClientRecord | null>;
  /** Clients with no grant at all (the DCR cap counts these). */
  countClientsWithoutGrant(workspaceId: string): Promise<number>;

  /** The client must exist. */
  insertGrant(grant: OAuthGrantRecord): Promise<void>;
  getGrant(workspaceId: string, id: string): Promise<OAuthGrantRecord | null>;
  /** Newest first. */
  listGrants(workspaceId: string): Promise<OAuthGrantRecord[]>;
  updateGrant(
    workspaceId: string,
    id: string,
    patch: { lastUsedAt?: number; expiresAt?: number },
  ): Promise<void>;
  /**
   * Sets `revokedAt` (once) and deletes the grant's codes and tokens. Returns false if the grant does not exist.
   */
  revokeGrant(workspaceId: string, id: string, at: number): Promise<boolean>;
  /** Revokes every grant that is not revoked yet; returns how many. */
  revokeAllGrants(workspaceId: string, at: number): Promise<number>;

  insertCode(code: OAuthCodeRecord): Promise<void>;
  /**
   * Atomically marks the code used. Returns the record (as it was before) and whether this was its first use, or
   * `null` when no code has this hash.
   */
  consumeCode(
    codeHash: string,
    at: number,
  ): Promise<{ code: OAuthCodeRecord; firstUse: boolean } | null>;

  /** The grant must exist. */
  insertToken(token: OAuthTokenRecord): Promise<void>;
  getTokenByHash(tokenHash: string): Promise<OAuthTokenRecord | null>;
  /**
   * Atomically: if the refresh token `oldHash` exists and has not been replaced, records `next` as its replacement
   * and inserts `next` (another refresh token of the same grant). Returns false otherwise (nothing changes).
   */
  rotateRefreshToken(oldHash: string, next: OAuthTokenRecord, at: number): Promise<boolean>;
  deleteToken(tokenHash: string): Promise<void>;

  /** Deletes expired codes and tokens; returns how many rows went away. */
  deleteExpired(workspaceId: string, now: number): Promise<number>;
  purge(
    workspaceId: string,
    options: OAuthPurgeOptions,
  ): Promise<{ grants: number; clients: number }>;
}

const copy = <T>(value: T): T => structuredClone(value);

/** In-memory {@link OAuthStore} for tests and examples. */
export class MemoryOAuthStore implements OAuthStore {
  private readonly clients = new Map<string, OAuthClientRecord>();
  private readonly grants = new Map<string, OAuthGrantRecord>();
  private readonly codes = new Map<string, OAuthCodeRecord>();
  private readonly tokens = new Map<string, OAuthTokenRecord>();

  private static key(ws: string, id: string): string {
    return `${ws}\u0000${id}`;
  }

  async upsertClient(client: OAuthClientRecord): Promise<void> {
    this.clients.set(MemoryOAuthStore.key(client.workspaceId, client.id), copy(client));
  }
  async getClient(ws: string, id: string): Promise<OAuthClientRecord | null> {
    const c = this.clients.get(MemoryOAuthStore.key(ws, id));
    return c === undefined ? null : copy(c);
  }
  async countClientsWithoutGrant(ws: string): Promise<number> {
    let n = 0;
    for (const c of this.clients.values()) {
      if (c.workspaceId !== ws) continue;
      if (![...this.grants.values()].some((g) => g.workspaceId === ws && g.clientId === c.id)) n++;
    }
    return n;
  }

  async insertGrant(grant: OAuthGrantRecord): Promise<void> {
    if (!this.clients.has(MemoryOAuthStore.key(grant.workspaceId, grant.clientId)))
      throw new Error("unknown client");
    const key = MemoryOAuthStore.key(grant.workspaceId, grant.id);
    if (this.grants.has(key)) throw new Error("duplicate grant");
    this.grants.set(key, copy(grant));
  }
  async getGrant(ws: string, id: string): Promise<OAuthGrantRecord | null> {
    const g = this.grants.get(MemoryOAuthStore.key(ws, id));
    return g === undefined ? null : copy(g);
  }
  async listGrants(ws: string): Promise<OAuthGrantRecord[]> {
    return [...this.grants.values()]
      .filter((g) => g.workspaceId === ws)
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map(copy);
  }
  async updateGrant(
    ws: string,
    id: string,
    patch: { lastUsedAt?: number; expiresAt?: number },
  ): Promise<void> {
    const g = this.grants.get(MemoryOAuthStore.key(ws, id));
    if (g === undefined) return;
    if (patch.lastUsedAt !== undefined) g.lastUsedAt = patch.lastUsedAt;
    if (patch.expiresAt !== undefined) g.expiresAt = patch.expiresAt;
  }
  private dropSecretsOf(grantId: string): void {
    for (const [k, c] of this.codes) if (c.grantId === grantId) this.codes.delete(k);
    for (const [k, t] of this.tokens) if (t.grantId === grantId) this.tokens.delete(k);
  }
  async revokeGrant(ws: string, id: string, at: number): Promise<boolean> {
    const g = this.grants.get(MemoryOAuthStore.key(ws, id));
    if (g === undefined) return false;
    if (g.revokedAt === null) g.revokedAt = at;
    this.dropSecretsOf(id);
    return true;
  }
  async revokeAllGrants(ws: string, at: number): Promise<number> {
    let n = 0;
    for (const g of this.grants.values()) {
      if (g.workspaceId !== ws) continue;
      if (g.revokedAt === null) {
        g.revokedAt = at;
        n++;
      }
      this.dropSecretsOf(g.id);
    }
    return n;
  }

  async insertCode(code: OAuthCodeRecord): Promise<void> {
    if (this.codes.has(code.codeHash)) throw new Error("duplicate code");
    this.codes.set(code.codeHash, copy(code));
  }
  async consumeCode(hash: string, at: number) {
    const c = this.codes.get(hash);
    if (c === undefined) return null;
    const before = copy(c);
    if (c.usedAt === null) c.usedAt = at;
    return { code: before, firstUse: before.usedAt === null };
  }

  async insertToken(token: OAuthTokenRecord): Promise<void> {
    if (!this.grants.has(MemoryOAuthStore.key(token.workspaceId, token.grantId)))
      throw new Error("unknown grant");
    if (this.tokens.has(token.tokenHash)) throw new Error("duplicate token");
    this.tokens.set(token.tokenHash, copy(token));
  }
  async getTokenByHash(hash: string): Promise<OAuthTokenRecord | null> {
    const t = this.tokens.get(hash);
    return t === undefined ? null : copy(t);
  }
  async rotateRefreshToken(oldHash: string, next: OAuthTokenRecord, at: number) {
    const old = this.tokens.get(oldHash);
    if (old === undefined || old.kind !== "refresh" || old.replacedBy !== null) return false;
    if (this.tokens.has(next.tokenHash)) return false;
    old.replacedBy = next.tokenHash;
    old.rotatedAt = at;
    this.tokens.set(next.tokenHash, copy(next));
    return true;
  }
  async deleteToken(hash: string): Promise<void> {
    this.tokens.delete(hash);
  }

  async deleteExpired(ws: string, now: number): Promise<number> {
    let n = 0;
    for (const [k, c] of this.codes) {
      if (c.workspaceId === ws && c.expiresAt <= now) {
        this.codes.delete(k);
        n++;
      }
    }
    for (const [k, t] of this.tokens) {
      if (t.workspaceId === ws && t.expiresAt <= now) {
        this.tokens.delete(k);
        n++;
      }
    }
    return n;
  }

  async purge(ws: string, o: OAuthPurgeOptions) {
    let grants = 0;
    let clients = 0;
    for (const [k, g] of this.grants) {
      if (g.workspaceId !== ws) continue;
      const dead =
        (g.revokedAt !== null && g.revokedAt < o.deadGrantsBefore) ||
        g.expiresAt < o.deadGrantsBefore;
      if (dead) {
        this.dropSecretsOf(g.id);
        this.grants.delete(k);
        grants++;
      }
    }
    for (const [k, c] of this.clients) {
      if (c.workspaceId !== ws || c.createdAt >= o.clientsWithoutGrantBefore) continue;
      if (![...this.grants.values()].some((g) => g.workspaceId === ws && g.clientId === c.id)) {
        this.clients.delete(k);
        clients++;
      }
    }
    return { grants, clients };
  }
}
