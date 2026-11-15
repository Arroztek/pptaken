// SPDX-License-Identifier: AGPL-3.0-or-later
// The storage port of @pptaken/auth-local. Implemented by `createSqliteAuthStore` in @pptaken/storage-sqlite (the
// production adapter) and by `MemoryAuthStore` below (tests). Conventions follow the core's ports: async methods,
// explicit `workspaceId`, epoch-millisecond timestamps, plain records returned as copies. No secret is ever stored
// in clear: session ids and API tokens as SHA-256 hex, the password as an scrypt string, the install code as an
// HMAC.

export interface OwnerRecord {
  workspaceId: string;
  id: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRecord {
  workspaceId: string;
  /** SHA-256 hex of the session id. */
  idHash: string;
  ownerId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface ApiTokenRecord {
  workspaceId: string;
  id: string;
  name: string;
  /** SHA-256 hex of the secret. */
  tokenHash: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface McpActivityRecord {
  workspaceId: string;
  lastCallAt: number;
  lastTool: string | null;
  clientName: string | null;
  tokenId: string | null;
}

export type SetupOutcome = "ok" | "already_setup" | "code_mismatch";

export interface AuthStore {
  getOwner(workspaceId: string): Promise<OwnerRecord | null>;
  /**
   * Atomically: if no owner exists and the stored install code equals `installCodeHash`, deletes the install code
   * and inserts the owner. Never inserts a second owner.
   */
  completeSetup(owner: OwnerRecord, installCodeHash: string): Promise<SetupOutcome>;
  setOwnerPassword(
    workspaceId: string,
    ownerId: string,
    passwordHash: string,
    at: number,
  ): Promise<boolean>;

  getSetting(workspaceId: string, key: string): Promise<string | null>;
  putSetting(workspaceId: string, key: string, value: string, at: number): Promise<void>;
  deleteSetting(workspaceId: string, key: string): Promise<void>;

  insertSession(session: SessionRecord): Promise<void>;
  getSession(workspaceId: string, idHash: string): Promise<SessionRecord | null>;
  touchSession(
    workspaceId: string,
    idHash: string,
    lastSeenAt: number,
    expiresAt: number,
  ): Promise<void>;
  deleteSession(workspaceId: string, idHash: string): Promise<boolean>;
  /** Returns how many sessions were deleted. */
  deleteAllSessions(workspaceId: string): Promise<number>;
  deleteExpiredSessions(workspaceId: string, now: number): Promise<number>;

  insertToken(token: ApiTokenRecord): Promise<void>;
  /** Looks a token up by the hash of its secret (instance-wide). */
  getTokenByHash(tokenHash: string): Promise<ApiTokenRecord | null>;
  /** Newest first. */
  listTokens(workspaceId: string): Promise<ApiTokenRecord[]>;
  /** Sets `revokedAt` if the token exists and is not revoked yet. Returns false if it does not exist. */
  revokeToken(workspaceId: string, id: string, at: number): Promise<boolean>;
  touchToken(workspaceId: string, id: string, at: number): Promise<void>;

  recordMcpActivity(activity: McpActivityRecord): Promise<void>;
  getMcpActivity(workspaceId: string): Promise<McpActivityRecord | null>;
}

const copy = <T>(value: T): T => structuredClone(value);

/** In-memory {@link AuthStore} for tests and examples. */
export class MemoryAuthStore implements AuthStore {
  private readonly owners = new Map<string, OwnerRecord>();
  private readonly settings = new Map<string, string>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tokens = new Map<string, ApiTokenRecord>();
  private readonly activity = new Map<string, McpActivityRecord>();

  async getOwner(ws: string): Promise<OwnerRecord | null> {
    const owner = this.owners.get(ws);
    return owner === undefined ? null : copy(owner);
  }

  async completeSetup(owner: OwnerRecord, installCodeHash: string): Promise<SetupOutcome> {
    if (this.owners.has(owner.workspaceId)) return "already_setup";
    const key = `${owner.workspaceId}\u0000install_code`;
    if (this.settings.get(key) !== installCodeHash) return "code_mismatch";
    this.settings.delete(key);
    this.owners.set(owner.workspaceId, copy(owner));
    return "ok";
  }

  async setOwnerPassword(ws: string, id: string, hash: string, at: number): Promise<boolean> {
    const owner = this.owners.get(ws);
    if (owner === undefined || owner.id !== id) return false;
    owner.passwordHash = hash;
    owner.updatedAt = at;
    return true;
  }

  async getSetting(ws: string, key: string): Promise<string | null> {
    return this.settings.get(`${ws}\u0000${key}`) ?? null;
  }
  async putSetting(ws: string, key: string, value: string): Promise<void> {
    this.settings.set(`${ws}\u0000${key}`, value);
  }
  async deleteSetting(ws: string, key: string): Promise<void> {
    this.settings.delete(`${ws}\u0000${key}`);
  }

  async insertSession(session: SessionRecord): Promise<void> {
    const key = `${session.workspaceId}\u0000${session.idHash}`;
    if (this.sessions.has(key)) throw new Error("duplicate session");
    this.sessions.set(key, copy(session));
  }
  async getSession(ws: string, idHash: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(`${ws}\u0000${idHash}`);
    return s === undefined ? null : copy(s);
  }
  async touchSession(ws: string, idHash: string, lastSeenAt: number, expiresAt: number) {
    const s = this.sessions.get(`${ws}\u0000${idHash}`);
    if (s !== undefined) {
      s.lastSeenAt = lastSeenAt;
      s.expiresAt = expiresAt;
    }
  }
  async deleteSession(ws: string, idHash: string): Promise<boolean> {
    return this.sessions.delete(`${ws}\u0000${idHash}`);
  }
  async deleteAllSessions(ws: string): Promise<number> {
    let n = 0;
    for (const [key, s] of this.sessions) {
      if (s.workspaceId === ws) {
        this.sessions.delete(key);
        n++;
      }
    }
    return n;
  }
  async deleteExpiredSessions(ws: string, now: number): Promise<number> {
    let n = 0;
    for (const [key, s] of this.sessions) {
      if (s.workspaceId === ws && s.expiresAt <= now) {
        this.sessions.delete(key);
        n++;
      }
    }
    return n;
  }

  async insertToken(token: ApiTokenRecord): Promise<void> {
    for (const t of this.tokens.values()) {
      if (t.tokenHash === token.tokenHash) throw new Error("duplicate token hash");
    }
    this.tokens.set(`${token.workspaceId}\u0000${token.id}`, copy(token));
  }
  async getTokenByHash(hash: string): Promise<ApiTokenRecord | null> {
    for (const t of this.tokens.values()) if (t.tokenHash === hash) return copy(t);
    return null;
  }
  async listTokens(ws: string): Promise<ApiTokenRecord[]> {
    return [...this.tokens.values()]
      .filter((t) => t.workspaceId === ws)
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map(copy);
  }
  async revokeToken(ws: string, id: string, at: number): Promise<boolean> {
    const t = this.tokens.get(`${ws}\u0000${id}`);
    if (t === undefined) return false;
    if (t.revokedAt === null) t.revokedAt = at;
    return true;
  }
  async touchToken(ws: string, id: string, at: number): Promise<void> {
    const t = this.tokens.get(`${ws}\u0000${id}`);
    if (t !== undefined) t.lastUsedAt = at;
  }

  async recordMcpActivity(a: McpActivityRecord): Promise<void> {
    this.activity.set(a.workspaceId, copy(a));
  }
  async getMcpActivity(ws: string): Promise<McpActivityRecord | null> {
    const a = this.activity.get(ws);
    return a === undefined ? null : copy(a);
  }
}
