// SPDX-License-Identifier: AGPL-3.0-or-later
// SQLite adapter of the auth storage port of @pptaken/auth-local (`AuthStore`), on the tables of migration
// 0002_auth. This package does not depend on @pptaken/auth-local: the records below mirror its port types and
// TypeScript's structural typing checks the match where the two are wired (apps/server). Keeping the dependency
// out preserves the rule "adapters depend on core only".
import type { Kysely, Selectable } from "kysely";
import type {
  ApiTokenTable,
  AuthOwnerTable,
  AuthSessionTable,
  Database,
  McpActivityTable,
} from "./repositories.js";
import type { SqliteStorage } from "./storage.js";

export interface SqliteOwnerRecord {
  workspaceId: string;
  id: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface SqliteSessionRecord {
  workspaceId: string;
  idHash: string;
  ownerId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface SqliteApiTokenRecord {
  workspaceId: string;
  id: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface SqliteMcpActivityRecord {
  workspaceId: string;
  lastCallAt: number;
  lastTool: string | null;
  clientName: string | null;
  tokenId: string | null;
}

const INSTALL_CODE_KEY = "install_code";

const toOwner = (r: Selectable<AuthOwnerTable>): SqliteOwnerRecord => ({
  workspaceId: r.workspace_id,
  id: r.id,
  passwordHash: r.password_hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSession = (r: Selectable<AuthSessionTable>): SqliteSessionRecord => ({
  workspaceId: r.workspace_id,
  idHash: r.id_hash,
  ownerId: r.owner_id,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
});

function parseScopes(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return []; // Fail closed: a corrupted row grants nothing.
  }
}

const toToken = (r: Selectable<ApiTokenTable>): SqliteApiTokenRecord => ({
  workspaceId: r.workspace_id,
  id: r.id,
  name: r.name,
  tokenHash: r.token_hash,
  scopes: parseScopes(r.scopes),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

const toActivity = (r: Selectable<McpActivityTable>): SqliteMcpActivityRecord => ({
  workspaceId: r.workspace_id,
  lastCallAt: r.last_call_at,
  lastTool: r.last_tool,
  clientName: r.client_name,
  tokenId: r.token_id,
});

/** The auth store on an open {@link SqliteStorage} (same connection and database file). */
export function createSqliteAuthStore(storage: SqliteStorage) {
  const db: Kysely<Database> = storage.kysely;
  return {
    async getOwner(ws: string): Promise<SqliteOwnerRecord | null> {
      const row = await db
        .selectFrom("auth_owner")
        .selectAll()
        .where("workspace_id", "=", ws)
        .executeTakeFirst();
      return row === undefined ? null : toOwner(row);
    },

    async completeSetup(
      owner: SqliteOwnerRecord,
      installCodeHash: string,
    ): Promise<"ok" | "already_setup" | "code_mismatch"> {
      return storage.withTransaction(async (tx) => {
        const existing = await tx
          .selectFrom("auth_owner")
          .select("id")
          .where("workspace_id", "=", owner.workspaceId)
          .executeTakeFirst();
        if (existing !== undefined) return "already_setup";
        const deleted = await tx
          .deleteFrom("auth_setting")
          .where("workspace_id", "=", owner.workspaceId)
          .where("key", "=", INSTALL_CODE_KEY)
          .where("value", "=", installCodeHash)
          .executeTakeFirst();
        if (Number(deleted.numDeletedRows) !== 1) return "code_mismatch";
        await tx
          .insertInto("auth_owner")
          .values({
            workspace_id: owner.workspaceId,
            id: owner.id,
            password_hash: owner.passwordHash,
            created_at: owner.createdAt,
            updated_at: owner.updatedAt,
          })
          .execute();
        return "ok";
      });
    },

    async setOwnerPassword(ws: string, id: string, hash: string, at: number): Promise<boolean> {
      const r = await db
        .updateTable("auth_owner")
        .set({ password_hash: hash, updated_at: at })
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .executeTakeFirst();
      return Number(r.numUpdatedRows) === 1;
    },

    async getSetting(ws: string, key: string): Promise<string | null> {
      const row = await db
        .selectFrom("auth_setting")
        .select("value")
        .where("workspace_id", "=", ws)
        .where("key", "=", key)
        .executeTakeFirst();
      return row?.value ?? null;
    },

    async putSetting(ws: string, key: string, value: string, at: number): Promise<void> {
      await db
        .insertInto("auth_setting")
        .values({ workspace_id: ws, key, value, updated_at: at })
        .onConflict((oc) =>
          oc.columns(["workspace_id", "key"]).doUpdateSet({ value, updated_at: at }),
        )
        .execute();
    },

    async deleteSetting(ws: string, key: string): Promise<void> {
      await db
        .deleteFrom("auth_setting")
        .where("workspace_id", "=", ws)
        .where("key", "=", key)
        .execute();
    },

    async insertSession(s: SqliteSessionRecord): Promise<void> {
      await db
        .insertInto("auth_session")
        .values({
          workspace_id: s.workspaceId,
          id_hash: s.idHash,
          owner_id: s.ownerId,
          created_at: s.createdAt,
          last_seen_at: s.lastSeenAt,
          expires_at: s.expiresAt,
        })
        .execute();
    },

    async getSession(ws: string, idHash: string): Promise<SqliteSessionRecord | null> {
      const row = await db
        .selectFrom("auth_session")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("id_hash", "=", idHash)
        .executeTakeFirst();
      return row === undefined ? null : toSession(row);
    },

    async touchSession(ws: string, idHash: string, lastSeenAt: number, expiresAt: number) {
      await db
        .updateTable("auth_session")
        .set({ last_seen_at: lastSeenAt, expires_at: expiresAt })
        .where("workspace_id", "=", ws)
        .where("id_hash", "=", idHash)
        .execute();
    },

    async deleteSession(ws: string, idHash: string): Promise<boolean> {
      const r = await db
        .deleteFrom("auth_session")
        .where("workspace_id", "=", ws)
        .where("id_hash", "=", idHash)
        .executeTakeFirst();
      return Number(r.numDeletedRows) > 0;
    },

    async deleteAllSessions(ws: string): Promise<number> {
      const r = await db
        .deleteFrom("auth_session")
        .where("workspace_id", "=", ws)
        .executeTakeFirst();
      return Number(r.numDeletedRows);
    },

    async deleteExpiredSessions(ws: string, now: number): Promise<number> {
      const r = await db
        .deleteFrom("auth_session")
        .where("workspace_id", "=", ws)
        .where("expires_at", "<=", now)
        .executeTakeFirst();
      return Number(r.numDeletedRows);
    },

    async insertToken(t: SqliteApiTokenRecord): Promise<void> {
      await db
        .insertInto("api_token")
        .values({
          workspace_id: t.workspaceId,
          id: t.id,
          name: t.name,
          token_hash: t.tokenHash,
          scopes: JSON.stringify(t.scopes),
          created_at: t.createdAt,
          expires_at: t.expiresAt,
          last_used_at: t.lastUsedAt,
          revoked_at: t.revokedAt,
        })
        .execute();
    },

    async getTokenByHash(hash: string): Promise<SqliteApiTokenRecord | null> {
      const row = await db
        .selectFrom("api_token")
        .selectAll()
        .where("token_hash", "=", hash)
        .executeTakeFirst();
      return row === undefined ? null : toToken(row);
    },

    async listTokens(ws: string): Promise<SqliteApiTokenRecord[]> {
      const rows = await db
        .selectFrom("api_token")
        .selectAll()
        .where("workspace_id", "=", ws)
        .orderBy("id", "desc")
        .execute();
      return rows.map(toToken);
    },

    async revokeToken(ws: string, id: string, at: number): Promise<boolean> {
      const row = await db
        .selectFrom("api_token")
        .select(["id", "revoked_at"])
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .executeTakeFirst();
      if (row === undefined) return false;
      if (row.revoked_at === null) {
        await db
          .updateTable("api_token")
          .set({ revoked_at: at })
          .where("workspace_id", "=", ws)
          .where("id", "=", id)
          .where("revoked_at", "is", null)
          .execute();
      }
      return true;
    },

    async touchToken(ws: string, id: string, at: number): Promise<void> {
      await db
        .updateTable("api_token")
        .set({ last_used_at: at })
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .execute();
    },

    async recordMcpActivity(a: SqliteMcpActivityRecord): Promise<void> {
      const values = {
        last_call_at: a.lastCallAt,
        last_tool: a.lastTool,
        client_name: a.clientName,
        token_id: a.tokenId,
      };
      await db
        .insertInto("mcp_activity")
        .values({ workspace_id: a.workspaceId, ...values })
        .onConflict((oc) => oc.column("workspace_id").doUpdateSet(values))
        .execute();
    },

    async getMcpActivity(ws: string): Promise<SqliteMcpActivityRecord | null> {
      const row = await db
        .selectFrom("mcp_activity")
        .selectAll()
        .where("workspace_id", "=", ws)
        .executeTakeFirst();
      return row === undefined ? null : toActivity(row);
    },
  };
}

export type SqliteAuthStore = ReturnType<typeof createSqliteAuthStore>;
