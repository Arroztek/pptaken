// SPDX-License-Identifier: AGPL-3.0-or-later
// Kysely implementations of the core's repository ports. Each function receives a Kysely instance bound either
// to the shared connection (autocommit) or to the connection that holds an open transaction.
import type {
  Actor,
  AssetRecord,
  AssetRepository,
  AuditEntry,
  AuditLog,
  AuditResult,
  DeckRecord,
  DeckRepository,
  IdempotencyRecord,
  IdempotencyRepository,
  Repositories,
  RevisionRecord,
  RevisionRepository,
  RevisionSummary,
  ScriptApprovalRepository,
  ScriptErrorKind,
  ScriptErrorRecord,
  ScriptErrorRepository,
} from "@pptaken/core";
import { type Kysely, type Selectable, sql } from "kysely";

export interface DeckTable {
  workspace_id: string;
  id: string;
  title: string;
  lang: string | null;
  current_revision: number;
  slide_count: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  created_by_actor: string;
  created_by_token: string | null;
}

export interface RevisionTable {
  workspace_id: string;
  deck_id: string;
  number: number;
  document: string;
  title: string;
  slide_count: number;
  summary: string;
  created_at: number;
  created_by_actor: string;
  created_by_token: string | null;
}

export interface AssetTable {
  workspace_id: string;
  sha256: string;
  media_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

export interface DeckAssetTable {
  workspace_id: string;
  deck_id: string;
  sha256: string;
  created_at: number;
}

export interface AuditLogTable {
  workspace_id: string;
  id: string;
  at: number;
  actor: string;
  token_id: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  result: string;
  detail: string | null;
}

export interface IdempotencyKeyTable {
  workspace_id: string;
  key: string;
  request_hash: string;
  deck_id: string;
  result: string;
  created_at: number;
}

export interface SchemaMigrationsTable {
  version: number;
  name: string;
  applied_at: number;
}

// Tables of migration 0002_auth, used by the auth store adapter (src/auth.ts).
export interface AuthOwnerTable {
  workspace_id: string;
  id: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
}

export interface AuthSessionTable {
  workspace_id: string;
  id_hash: string;
  owner_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export interface ApiTokenTable {
  workspace_id: string;
  id: string;
  name: string;
  token_hash: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface AuthSettingTable {
  workspace_id: string;
  key: string;
  value: string;
  updated_at: number;
}

export interface McpActivityTable {
  workspace_id: string;
  last_call_at: number;
  last_tool: string | null;
  client_name: string | null;
  token_id: string | null;
}

// Tables of migration 0003_live, used by the live-session store adapter (src/live.ts).
export interface LiveSessionTable {
  workspace_id: string;
  id: string;
  deck_id: string;
  revision: number;
  started_at: number;
  expires_at: number;
  ended_at: number | null;
}

export interface LivePairingTable {
  workspace_id: string;
  live_id: string;
  secret_hash: string;
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
}

export interface LiveDeviceTable {
  workspace_id: string;
  id: string;
  live_id: string;
  credential_hash: string;
  label: string;
  code: string;
  status: string;
  created_at: number;
  approved_at: number | null;
  revoked_at: number | null;
  expires_at: number;
}

// Tables of migration 0004_oauth, used by the OAuth store adapter (src/oauth.ts).
export interface OAuthClientsTable {
  workspace_id: string;
  id: string;
  kind: string;
  name: string | null;
  redirect_uris: string;
  metadata: string;
  created_at: number;
}

export interface OAuthGrantsTable {
  workspace_id: string;
  id: string;
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  scopes: string;
  resource: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
  revoked_at: number | null;
}

export interface OAuthCodesTable {
  code_hash: string;
  workspace_id: string;
  grant_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scopes: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export interface OAuthTokensTable {
  token_hash: string;
  workspace_id: string;
  grant_id: string;
  kind: string;
  created_at: number;
  expires_at: number;
  replaced_by: string | null;
  rotated_at: number | null;
}

export interface DeckScriptsApprovalTable {
  workspace_id: string;
  deck_id: string;
  approved_digest: string;
  approved_at: number;
  approved_by_actor: string;
  approved_by_token: string | null;
  /** Migration 0007 (ADR-024). */
  mode: string;
  owner_digest: string | null;
  trusted_libs: string;
  previous_revision: number | null;
}

export interface DeckScriptErrorTable {
  workspace_id: string;
  deck_id: string;
  digest: string;
  fingerprint: string;
  kind: string;
  slide_id: string;
  name: string;
  message: string;
  stack: string;
  count: number;
  first_seen: number;
  last_seen: number;
}

/** Typed view of the database for Kysely. */
export interface Database {
  deck_scripts_approval: DeckScriptsApprovalTable;
  deck_script_error: DeckScriptErrorTable;
  deck: DeckTable;
  revision: RevisionTable;
  asset: AssetTable;
  deck_asset: DeckAssetTable;
  audit_log: AuditLogTable;
  idempotency_key: IdempotencyKeyTable;
  schema_migrations: SchemaMigrationsTable;
  auth_owner: AuthOwnerTable;
  auth_session: AuthSessionTable;
  api_token: ApiTokenTable;
  auth_setting: AuthSettingTable;
  mcp_activity: McpActivityTable;
  live_session: LiveSessionTable;
  live_pairing: LivePairingTable;
  live_device: LiveDeviceTable;
  oauth_clients: OAuthClientsTable;
  oauth_grants: OAuthGrantsTable;
  oauth_codes: OAuthCodesTable;
  oauth_tokens: OAuthTokensTable;
}

type Db = Kysely<Database>;

const toDeck = (r: Selectable<DeckTable>): DeckRecord => ({
  workspaceId: r.workspace_id,
  id: r.id,
  title: r.title,
  lang: r.lang,
  currentRevision: r.current_revision,
  slideCount: r.slide_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  createdBy: { actor: r.created_by_actor as Actor, tokenId: r.created_by_token },
});

const toAsset = (r: Selectable<AssetTable>): AssetRecord => ({
  workspaceId: r.workspace_id,
  sha256: r.sha256,
  mediaType: r.media_type,
  bytes: r.bytes,
  width: r.width,
  height: r.height,
  createdAt: r.created_at,
});

/** Escapes `\`, `%` and `_` for `LIKE … ESCAPE '\'`. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const count = (n: bigint | undefined) => Number(n ?? 0n);

function decks(db: Db): DeckRepository {
  return {
    async insert(d) {
      await db
        .insertInto("deck")
        .values({
          workspace_id: d.workspaceId,
          id: d.id,
          title: d.title,
          lang: d.lang,
          current_revision: d.currentRevision,
          slide_count: d.slideCount,
          created_at: d.createdAt,
          updated_at: d.updatedAt,
          deleted_at: d.deletedAt,
          created_by_actor: d.createdBy.actor,
          created_by_token: d.createdBy.tokenId,
        })
        .execute();
    },
    async get(ws, id) {
      const row = await db
        .selectFrom("deck")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? null : toDeck(row);
    },
    async updateHead(ws, id, expected, head) {
      const res = await db
        .updateTable("deck")
        .set({
          current_revision: head.currentRevision,
          title: head.title,
          lang: head.lang,
          slide_count: head.slideCount,
          updated_at: head.updatedAt,
        })
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .where("current_revision", "=", expected)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return count(res.numUpdatedRows) === 1;
    },
    async setDeletedAt(ws, id, deletedAt) {
      const res = await db
        .updateTable("deck")
        .set({ deleted_at: deletedAt })
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .executeTakeFirst();
      return count(res.numUpdatedRows) === 1;
    },
    async delete(ws, id) {
      const res = await db
        .deleteFrom("deck")
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .executeTakeFirst();
      return count(res.numDeletedRows) === 1;
    },
    async list(q) {
      let query = db.selectFrom("deck").selectAll().where("workspace_id", "=", q.workspaceId);
      query =
        (q.trash ?? "exclude") === "only"
          ? query.where("deleted_at", "is not", null)
          : query.where("deleted_at", "is", null);
      if (q.beforeId !== undefined) query = query.where("id", "<", q.beforeId);
      if (q.titleContains !== undefined) {
        // LIKE folds ASCII case in SQLite (a Postgres adapter uses ILIKE); wildcards in the input are literal.
        const pattern = `%${likeLiteral(q.titleContains)}%`;
        query = query.where(sql<boolean>`title LIKE ${pattern} ESCAPE '\\'`);
      }
      const rows = await query.orderBy("id", "desc").limit(q.limit).execute();
      return rows.map(toDeck);
    },
    async listTrashedBefore(ws, before, limit) {
      const rows = await db
        .selectFrom("deck")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("deleted_at", "is not", null)
        .where("deleted_at", "<", before)
        .orderBy("deleted_at", "asc")
        .orderBy("id", "asc")
        .limit(limit)
        .execute();
      return rows.map(toDeck);
    },
  };
}

const SUMMARY_COLUMNS = [
  "workspace_id",
  "deck_id",
  "number",
  "title",
  "slide_count",
  "summary",
  "created_at",
  "created_by_actor",
  "created_by_token",
] as const;

function revisions(db: Db): RevisionRepository {
  const toSummary = (r: Omit<Selectable<RevisionTable>, "document">): RevisionSummary => ({
    workspaceId: r.workspace_id,
    deckId: r.deck_id,
    number: r.number,
    title: r.title,
    slideCount: r.slide_count,
    summary: r.summary,
    createdAt: r.created_at,
    createdBy: { actor: r.created_by_actor as Actor, tokenId: r.created_by_token },
  });
  return {
    async insert(r) {
      await db
        .insertInto("revision")
        .values({
          workspace_id: r.workspaceId,
          deck_id: r.deckId,
          number: r.number,
          document: JSON.stringify(r.document),
          title: r.title,
          slide_count: r.slideCount,
          summary: r.summary,
          created_at: r.createdAt,
          created_by_actor: r.createdBy.actor,
          created_by_token: r.createdBy.tokenId,
        })
        .execute();
    },
    async get(ws, deckId, number) {
      const row = await db
        .selectFrom("revision")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .where("number", "=", number)
        .executeTakeFirst();
      if (row === undefined) return null;
      const out: RevisionRecord = {
        ...toSummary(row),
        document: JSON.parse(row.document) as RevisionRecord["document"],
      };
      return out;
    },
    async list(ws, deckId, { limit, beforeNumber }) {
      let query = db
        .selectFrom("revision")
        .select(SUMMARY_COLUMNS)
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId);
      if (beforeNumber !== undefined) query = query.where("number", "<", beforeNumber);
      const rows = await query.orderBy("number", "desc").limit(limit).execute();
      return rows.map(toSummary);
    },
    async listNumbers(ws, deckId) {
      const rows = await db
        .selectFrom("revision")
        .select("number")
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .orderBy("number", "asc")
        .execute();
      return rows.map((r) => r.number);
    },
    async deleteMany(ws, deckId, numbers) {
      if (numbers.length === 0) return 0;
      let deleted = 0;
      // Chunked to stay far below SQLite's bound-parameter limit.
      for (let i = 0; i < numbers.length; i += 500) {
        const res = await db
          .deleteFrom("revision")
          .where("workspace_id", "=", ws)
          .where("deck_id", "=", deckId)
          .where("number", "in", numbers.slice(i, i + 500))
          .executeTakeFirst();
        deleted += count(res.numDeletedRows);
      }
      return deleted;
    },
    async deleteAllForDeck(ws, deckId) {
      const res = await db
        .deleteFrom("revision")
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .executeTakeFirst();
      return count(res.numDeletedRows);
    },
  };
}

function assets(db: Db): AssetRepository {
  return {
    async insertIfAbsent(a) {
      const res = await db
        .insertInto("asset")
        .values({
          workspace_id: a.workspaceId,
          sha256: a.sha256,
          media_type: a.mediaType,
          bytes: a.bytes,
          width: a.width,
          height: a.height,
          created_at: a.createdAt,
        })
        .onConflict((oc) => oc.columns(["workspace_id", "sha256"]).doNothing())
        .executeTakeFirst();
      return count(res.numInsertedOrUpdatedRows) === 1;
    },
    async get(ws, sha) {
      const row = await db
        .selectFrom("asset")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("sha256", "=", sha)
        .executeTakeFirst();
      return row === undefined ? null : toAsset(row);
    },
    async link(ws, deckId, sha, at) {
      const res = await db
        .insertInto("deck_asset")
        .values({ workspace_id: ws, deck_id: deckId, sha256: sha, created_at: at })
        .onConflict((oc) => oc.columns(["workspace_id", "deck_id", "sha256"]).doNothing())
        .executeTakeFirst();
      return count(res.numInsertedOrUpdatedRows) === 1;
    },
    async isLinked(ws, deckId, sha) {
      const row = await db
        .selectFrom("deck_asset")
        .select("sha256")
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .where("sha256", "=", sha)
        .executeTakeFirst();
      return row !== undefined;
    },
    async listForDeck(ws, deckId) {
      const rows = await db
        .selectFrom("deck_asset as l")
        .innerJoin("asset as a", (j) =>
          j.onRef("a.workspace_id", "=", "l.workspace_id").onRef("a.sha256", "=", "l.sha256"),
        )
        .selectAll("a")
        .where("l.workspace_id", "=", ws)
        .where("l.deck_id", "=", deckId)
        .orderBy("a.sha256", "asc")
        .execute();
      return rows.map(toAsset);
    },
    async statsForDeck(ws, deckId) {
      const row = await db
        .selectFrom("deck_asset as l")
        .innerJoin("asset as a", (j) =>
          j.onRef("a.workspace_id", "=", "l.workspace_id").onRef("a.sha256", "=", "l.sha256"),
        )
        .select((eb) => [
          eb.fn.countAll<number>().as("count"),
          eb.fn.sum<number>("a.bytes").as("bytes"),
        ])
        .where("l.workspace_id", "=", ws)
        .where("l.deck_id", "=", deckId)
        .executeTakeFirstOrThrow();
      return { count: Number(row.count), bytes: Number(row.bytes ?? 0) };
    },
    async unlinkAllForDeck(ws, deckId) {
      const rows = await db
        .selectFrom("deck_asset")
        .select("sha256")
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .orderBy("sha256", "asc")
        .execute();
      await db
        .deleteFrom("deck_asset")
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .execute();
      return rows.map((r) => r.sha256);
    },
    async deleteIfUnlinked(ws, sha) {
      const res = await db
        .deleteFrom("asset")
        .where("workspace_id", "=", ws)
        .where("sha256", "=", sha)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("deck_asset")
                .select("deck_asset.sha256")
                .where("deck_asset.workspace_id", "=", ws)
                .where("deck_asset.sha256", "=", sha),
            ),
          ),
        )
        .executeTakeFirst();
      return count(res.numDeletedRows) === 1;
    },
    async isReferencedAnywhere(sha) {
      const row = await db
        .selectFrom("asset")
        .select("sha256")
        .where("sha256", "=", sha)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}

function audit(db: Db): AuditLog {
  return {
    async append(e) {
      await db
        .insertInto("audit_log")
        .values({
          workspace_id: e.workspaceId,
          id: e.id,
          at: e.at,
          actor: e.actor,
          token_id: e.tokenId,
          action: e.action,
          target: e.target,
          ip: e.ip,
          result: e.result,
          detail: e.detail === null ? null : JSON.stringify(e.detail),
        })
        .execute();
    },
    async list(ws, { limit, beforeId, target }) {
      let query = db.selectFrom("audit_log").selectAll().where("workspace_id", "=", ws);
      if (beforeId !== undefined) query = query.where("id", "<", beforeId);
      if (target !== undefined) query = query.where("target", "=", target);
      const rows = await query.orderBy("id", "desc").limit(limit).execute();
      return rows.map(
        (r): AuditEntry => ({
          workspaceId: r.workspace_id,
          id: r.id,
          at: r.at,
          actor: r.actor as Actor,
          tokenId: r.token_id,
          action: r.action,
          target: r.target,
          ip: r.ip,
          result: r.result as AuditResult,
          detail: r.detail === null ? null : (JSON.parse(r.detail) as Record<string, unknown>),
        }),
      );
    },
  };
}

function idempotency(db: Db): IdempotencyRepository {
  return {
    async get(ws, key) {
      const r = await db
        .selectFrom("idempotency_key")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("key", "=", key)
        .executeTakeFirst();
      if (r === undefined) return null;
      const out: IdempotencyRecord = {
        workspaceId: r.workspace_id,
        key: r.key,
        requestHash: r.request_hash,
        deckId: r.deck_id,
        result: JSON.parse(r.result) as Record<string, unknown>,
        createdAt: r.created_at,
      };
      return out;
    },
    async insert(r) {
      await db
        .insertInto("idempotency_key")
        .values({
          workspace_id: r.workspaceId,
          key: r.key,
          request_hash: r.requestHash,
          deck_id: r.deckId,
          result: JSON.stringify(r.result),
          created_at: r.createdAt,
        })
        .execute();
    },
    async deleteForDeck(ws, deckId) {
      const res = await db
        .deleteFrom("idempotency_key")
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .executeTakeFirst();
      return count(res.numDeletedRows);
    },
  };
}

/** The trusted library keys of a lineage (ADR-024); anything malformed reads as "nothing trusted" (fail closed). */
function parseTrustedLibs(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function scriptApprovals(db: Db): ScriptApprovalRepository {
  return {
    async get(ws, deckId) {
      const r = await db
        .selectFrom("deck_scripts_approval")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .executeTakeFirst();
      if (r === undefined) return null;
      return {
        workspaceId: r.workspace_id,
        deckId: r.deck_id,
        digest: r.approved_digest,
        approvedAt: r.approved_at,
        approvedBy: { actor: r.approved_by_actor as Actor, tokenId: r.approved_by_token },
        mode: r.mode === "auto" ? "auto" : "owner",
        ownerDigest: r.owner_digest ?? r.approved_digest,
        trustedLibs: parseTrustedLibs(r.trusted_libs),
        previousRevision: r.previous_revision,
      };
    },
    async set(r) {
      const lineage = {
        mode: r.mode,
        owner_digest: r.ownerDigest,
        trusted_libs: JSON.stringify(r.trustedLibs),
        previous_revision: r.previousRevision,
      };
      await db
        .insertInto("deck_scripts_approval")
        .values({
          workspace_id: r.workspaceId,
          deck_id: r.deckId,
          approved_digest: r.digest,
          approved_at: r.approvedAt,
          approved_by_actor: r.approvedBy.actor,
          approved_by_token: r.approvedBy.tokenId,
          ...lineage,
        })
        .onConflict((oc) =>
          oc.columns(["workspace_id", "deck_id"]).doUpdateSet({
            approved_digest: r.digest,
            approved_at: r.approvedAt,
            approved_by_actor: r.approvedBy.actor,
            approved_by_token: r.approvedBy.tokenId,
            ...lineage,
          }),
        )
        .execute();
    },
    async delete(ws, deckId) {
      const res = await db
        .deleteFrom("deck_scripts_approval")
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .executeTakeFirst();
      return count(res.numDeletedRows) > 0;
    },
  };
}

function scriptErrors(db: Db): ScriptErrorRepository {
  const toRecord = (r: Selectable<DeckScriptErrorTable>): ScriptErrorRecord => ({
    workspaceId: r.workspace_id,
    deckId: r.deck_id,
    digest: r.digest,
    fingerprint: r.fingerprint,
    kind: r.kind as ScriptErrorKind,
    slideId: r.slide_id,
    name: r.name,
    message: r.message,
    stack: r.stack,
    count: r.count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  });
  return {
    async list(ws, deckId) {
      const rows = await db
        .selectFrom("deck_script_error")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .orderBy("last_seen", "desc")
        .orderBy("fingerprint", "asc")
        .execute();
      return rows.map(toRecord);
    },
    async get(ws, deckId, digest, fingerprint) {
      const r = await db
        .selectFrom("deck_script_error")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .where("digest", "=", digest)
        .where("fingerprint", "=", fingerprint)
        .executeTakeFirst();
      return r === undefined ? null : toRecord(r);
    },
    async put(r) {
      const values = {
        kind: r.kind,
        slide_id: r.slideId,
        name: r.name,
        message: r.message,
        stack: r.stack,
        count: r.count,
        first_seen: r.firstSeen,
        last_seen: r.lastSeen,
      };
      await db
        .insertInto("deck_script_error")
        .values({
          workspace_id: r.workspaceId,
          deck_id: r.deckId,
          digest: r.digest,
          fingerprint: r.fingerprint,
          ...values,
        })
        .onConflict((oc) =>
          oc.columns(["workspace_id", "deck_id", "digest", "fingerprint"]).doUpdateSet(values),
        )
        .execute();
    },
    async deleteOne(ws, deckId, digest, fingerprint) {
      const res = await db
        .deleteFrom("deck_script_error")
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .where("digest", "=", digest)
        .where("fingerprint", "=", fingerprint)
        .executeTakeFirst();
      return count(res.numDeletedRows) > 0;
    },
    async deleteForDeck(ws, deckId) {
      const res = await db
        .deleteFrom("deck_script_error")
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .executeTakeFirst();
      return count(res.numDeletedRows);
    },
    async deleteDigestsExcept(ws, deckId, keep) {
      let q = db
        .deleteFrom("deck_script_error")
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId);
      if (keep.length > 0) q = q.where("digest", "not in", [...keep]);
      const res = await q.executeTakeFirst();
      return count(res.numDeletedRows);
    },
  };
}

export function createRepositories(db: Db): Repositories {
  return {
    scriptErrors: scriptErrors(db),
    scriptApprovals: scriptApprovals(db),
    decks: decks(db),
    revisions: revisions(db),
    assets: assets(db),
    audit: audit(db),
    idempotency: idempotency(db),
  };
}
