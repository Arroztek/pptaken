// SPDX-License-Identifier: AGPL-3.0-or-later
// SQLite adapter of the OAuth storage port of @pptaken/auth-local (`OAuthStore`), on the tables of migration
// 0004_oauth. Like ./auth.ts it mirrors the port's record types instead of importing them (adapters depend on core
// only); apps/server and the contract test check the structural match at compile time. The operations that must
// be atomic (consume a code once, rotate a refresh token once, revoke a grant with its secrets) run in one
// transaction each.
import { type Kysely, type Selectable, sql } from "kysely";
import type {
  Database,
  OAuthClientsTable,
  OAuthCodesTable,
  OAuthGrantsTable,
  OAuthTokensTable,
} from "./repositories.js";
import type { SqliteStorage } from "./storage.js";

export interface SqliteOAuthClientRecord {
  workspaceId: string;
  id: string;
  kind: "cimd" | "dcr";
  name: string | null;
  redirectUris: string[];
  metadata: string;
  createdAt: number;
}

export interface SqliteOAuthGrantRecord {
  workspaceId: string;
  id: string;
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  scopes: string[];
  resource: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  revokedAt: number | null;
}

export interface SqliteOAuthCodeRecord {
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

export interface SqliteOAuthTokenRecord {
  workspaceId: string;
  tokenHash: string;
  grantId: string;
  kind: "access" | "refresh";
  createdAt: number;
  expiresAt: number;
  replacedBy: string | null;
  rotatedAt: number | null;
}

function stringList(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return []; // Fail closed: a corrupted row grants nothing and redirects nowhere.
  }
}

const toClient = (r: Selectable<OAuthClientsTable>): SqliteOAuthClientRecord => ({
  workspaceId: r.workspace_id,
  id: r.id,
  kind: r.kind === "cimd" ? "cimd" : "dcr",
  name: r.name,
  redirectUris: stringList(r.redirect_uris),
  metadata: r.metadata,
  createdAt: r.created_at,
});

const toGrant = (r: Selectable<OAuthGrantsTable>): SqliteOAuthGrantRecord => ({
  workspaceId: r.workspace_id,
  id: r.id,
  clientId: r.client_id,
  clientName: r.client_name,
  redirectUri: r.redirect_uri,
  scopes: stringList(r.scopes),
  resource: r.resource,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

const toCode = (r: Selectable<OAuthCodesTable>): SqliteOAuthCodeRecord => ({
  workspaceId: r.workspace_id,
  codeHash: r.code_hash,
  grantId: r.grant_id,
  clientId: r.client_id,
  redirectUri: r.redirect_uri,
  codeChallenge: r.code_challenge,
  resource: r.resource,
  scopes: stringList(r.scopes),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
});

const toToken = (r: Selectable<OAuthTokensTable>): SqliteOAuthTokenRecord => ({
  workspaceId: r.workspace_id,
  tokenHash: r.token_hash,
  grantId: r.grant_id,
  kind: r.kind === "refresh" ? "refresh" : "access",
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  replacedBy: r.replaced_by,
  rotatedAt: r.rotated_at,
});

const tokenRow = (t: SqliteOAuthTokenRecord) => ({
  token_hash: t.tokenHash,
  workspace_id: t.workspaceId,
  grant_id: t.grantId,
  kind: t.kind,
  created_at: t.createdAt,
  expires_at: t.expiresAt,
  replaced_by: t.replacedBy,
  rotated_at: t.rotatedAt,
});

async function dropSecrets(db: Kysely<Database>, ws: string, grantId: string): Promise<void> {
  await db
    .deleteFrom("oauth_codes")
    .where("workspace_id", "=", ws)
    .where("grant_id", "=", grantId)
    .execute();
  await db
    .deleteFrom("oauth_tokens")
    .where("workspace_id", "=", ws)
    .where("grant_id", "=", grantId)
    .execute();
}

/** The OAuth store on an open {@link SqliteStorage} (same connection and database file). */
export function createSqliteOAuthStore(storage: SqliteStorage) {
  const db: Kysely<Database> = storage.kysely;
  return {
    async upsertClient(c: SqliteOAuthClientRecord): Promise<void> {
      const values = {
        kind: c.kind,
        name: c.name,
        redirect_uris: JSON.stringify(c.redirectUris),
        metadata: c.metadata,
        created_at: c.createdAt,
      };
      await db
        .insertInto("oauth_clients")
        .values({ workspace_id: c.workspaceId, id: c.id, ...values })
        .onConflict((oc) => oc.columns(["workspace_id", "id"]).doUpdateSet(values))
        .execute();
    },

    async getClient(ws: string, id: string): Promise<SqliteOAuthClientRecord | null> {
      const row = await db
        .selectFrom("oauth_clients")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? null : toClient(row);
    },

    async countClientsWithoutGrant(ws: string): Promise<number> {
      const row = await db
        .selectFrom("oauth_clients as c")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("c.workspace_id", "=", ws)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("oauth_grants as g")
                .select("g.id")
                .whereRef("g.workspace_id", "=", "c.workspace_id")
                .whereRef("g.client_id", "=", "c.id"),
            ),
          ),
        )
        .executeTakeFirst();
      return Number(row?.n ?? 0);
    },

    async insertGrant(g: SqliteOAuthGrantRecord): Promise<void> {
      await db
        .insertInto("oauth_grants")
        .values({
          workspace_id: g.workspaceId,
          id: g.id,
          client_id: g.clientId,
          client_name: g.clientName,
          redirect_uri: g.redirectUri,
          scopes: JSON.stringify(g.scopes),
          resource: g.resource,
          created_at: g.createdAt,
          last_used_at: g.lastUsedAt,
          expires_at: g.expiresAt,
          revoked_at: g.revokedAt,
        })
        .execute();
    },

    async getGrant(ws: string, id: string): Promise<SqliteOAuthGrantRecord | null> {
      const row = await db
        .selectFrom("oauth_grants")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? null : toGrant(row);
    },

    async listGrants(ws: string): Promise<SqliteOAuthGrantRecord[]> {
      const rows = await db
        .selectFrom("oauth_grants")
        .selectAll()
        .where("workspace_id", "=", ws)
        .orderBy("id", "desc")
        .execute();
      return rows.map(toGrant);
    },

    async updateGrant(
      ws: string,
      id: string,
      patch: { lastUsedAt?: number; expiresAt?: number },
    ): Promise<void> {
      const set: { last_used_at?: number; expires_at?: number } = {};
      if (patch.lastUsedAt !== undefined) set.last_used_at = patch.lastUsedAt;
      if (patch.expiresAt !== undefined) set.expires_at = patch.expiresAt;
      if (Object.keys(set).length === 0) return;
      await db
        .updateTable("oauth_grants")
        .set(set)
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .execute();
    },

    async revokeGrant(ws: string, id: string, at: number): Promise<boolean> {
      return storage.withTransaction(async (tx) => {
        const row = await tx
          .selectFrom("oauth_grants")
          .select("id")
          .where("workspace_id", "=", ws)
          .where("id", "=", id)
          .executeTakeFirst();
        if (row === undefined) return false;
        await tx
          .updateTable("oauth_grants")
          .set({ revoked_at: at })
          .where("workspace_id", "=", ws)
          .where("id", "=", id)
          .where("revoked_at", "is", null)
          .execute();
        await dropSecrets(tx, ws, id);
        return true;
      });
    },

    async revokeAllGrants(ws: string, at: number): Promise<number> {
      return storage.withTransaction(async (tx) => {
        const r = await tx
          .updateTable("oauth_grants")
          .set({ revoked_at: at })
          .where("workspace_id", "=", ws)
          .where("revoked_at", "is", null)
          .executeTakeFirst();
        await tx.deleteFrom("oauth_codes").where("workspace_id", "=", ws).execute();
        await tx.deleteFrom("oauth_tokens").where("workspace_id", "=", ws).execute();
        return Number(r.numUpdatedRows);
      });
    },

    async insertCode(c: SqliteOAuthCodeRecord): Promise<void> {
      await db
        .insertInto("oauth_codes")
        .values({
          code_hash: c.codeHash,
          workspace_id: c.workspaceId,
          grant_id: c.grantId,
          client_id: c.clientId,
          redirect_uri: c.redirectUri,
          code_challenge: c.codeChallenge,
          resource: c.resource,
          scopes: JSON.stringify(c.scopes),
          created_at: c.createdAt,
          expires_at: c.expiresAt,
          used_at: c.usedAt,
        })
        .execute();
    },

    async consumeCode(
      codeHash: string,
      at: number,
    ): Promise<{ code: SqliteOAuthCodeRecord; firstUse: boolean } | null> {
      return storage.withTransaction(async (tx) => {
        const row = await tx
          .selectFrom("oauth_codes")
          .selectAll()
          .where("code_hash", "=", codeHash)
          .executeTakeFirst();
        if (row === undefined) return null;
        const code = toCode(row);
        if (code.usedAt !== null) return { code, firstUse: false };
        const r = await tx
          .updateTable("oauth_codes")
          .set({ used_at: at })
          .where("code_hash", "=", codeHash)
          .where("used_at", "is", null)
          .executeTakeFirst();
        return { code, firstUse: Number(r.numUpdatedRows) === 1 };
      });
    },

    async insertToken(t: SqliteOAuthTokenRecord): Promise<void> {
      await db.insertInto("oauth_tokens").values(tokenRow(t)).execute();
    },

    async getTokenByHash(tokenHash: string): Promise<SqliteOAuthTokenRecord | null> {
      const row = await db
        .selectFrom("oauth_tokens")
        .selectAll()
        .where("token_hash", "=", tokenHash)
        .executeTakeFirst();
      return row === undefined ? null : toToken(row);
    },

    async rotateRefreshToken(
      oldHash: string,
      next: SqliteOAuthTokenRecord,
      at: number,
    ): Promise<boolean> {
      return storage.withTransaction(async (tx) => {
        const exists = await tx
          .selectFrom("oauth_tokens")
          .select("token_hash")
          .where("token_hash", "=", next.tokenHash)
          .executeTakeFirst();
        if (exists !== undefined) return false;
        const r = await tx
          .updateTable("oauth_tokens")
          .set({ replaced_by: next.tokenHash, rotated_at: at })
          .where("token_hash", "=", oldHash)
          .where("kind", "=", "refresh")
          .where("replaced_by", "is", null)
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) !== 1) return false;
        await tx.insertInto("oauth_tokens").values(tokenRow(next)).execute();
        return true;
      });
    },

    async deleteToken(tokenHash: string): Promise<void> {
      await db.deleteFrom("oauth_tokens").where("token_hash", "=", tokenHash).execute();
    },

    async deleteExpired(ws: string, now: number): Promise<number> {
      return storage.withTransaction(async (tx) => {
        const codes = await tx
          .deleteFrom("oauth_codes")
          .where("workspace_id", "=", ws)
          .where("expires_at", "<=", now)
          .executeTakeFirst();
        const tokens = await tx
          .deleteFrom("oauth_tokens")
          .where("workspace_id", "=", ws)
          .where("expires_at", "<=", now)
          .executeTakeFirst();
        return Number(codes.numDeletedRows) + Number(tokens.numDeletedRows);
      });
    },

    async purge(
      ws: string,
      o: { deadGrantsBefore: number; clientsWithoutGrantBefore: number },
    ): Promise<{ grants: number; clients: number }> {
      return storage.withTransaction(async (tx) => {
        // Codes and tokens go with their grant (ON DELETE CASCADE); deleted explicitly too, in case foreign keys
        // are off on some connection.
        const dead = await tx
          .selectFrom("oauth_grants")
          .select("id")
          .where("workspace_id", "=", ws)
          .where((eb) =>
            eb.or([
              eb.and([eb("revoked_at", "is not", null), eb("revoked_at", "<", o.deadGrantsBefore)]),
              eb("expires_at", "<", o.deadGrantsBefore),
            ]),
          )
          .execute();
        for (const g of dead) {
          await dropSecrets(tx, ws, g.id);
          await tx
            .deleteFrom("oauth_grants")
            .where("workspace_id", "=", ws)
            .where("id", "=", g.id)
            .execute();
        }
        const clients = await tx
          .deleteFrom("oauth_clients")
          .where("workspace_id", "=", ws)
          .where("created_at", "<", o.clientsWithoutGrantBefore)
          .where(
            sql<boolean>`NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.workspace_id = oauth_clients.workspace_id AND g.client_id = oauth_clients.id)`,
          )
          .executeTakeFirst();
        return { grants: dead.length, clients: Number(clients.numDeletedRows) };
      });
    },
  };
}

export type SqliteOAuthStore = ReturnType<typeof createSqliteOAuthStore>;
