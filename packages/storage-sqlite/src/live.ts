// SPDX-License-Identifier: AGPL-3.0-or-later
// SQLite adapter of the core's `LiveSessionStore` port, on the tables of migration 0003_live. The two operations
// that must be atomic are single statements: redeeming a pairing (`UPDATE … RETURNING` with the conditions in the
// WHERE clause) and inserting a device under the per-session limit (`INSERT … SELECT … WHERE count < max`).
import type {
  DeviceRecord,
  LiveSessionRecord,
  LiveSessionStore,
  PairingRecord,
} from "@pptaken/core";
import { type Kysely, type Selectable, sql } from "kysely";
import type {
  Database,
  LiveDeviceTable,
  LivePairingTable,
  LiveSessionTable,
} from "./repositories.js";
import type { SqliteStorage } from "./storage.js";

const toSession = (r: Selectable<LiveSessionTable>): LiveSessionRecord => ({
  workspaceId: r.workspace_id,
  id: r.id,
  deckId: r.deck_id,
  revision: r.revision,
  startedAt: r.started_at,
  expiresAt: r.expires_at,
  endedAt: r.ended_at,
});

const toPairing = (r: Selectable<LivePairingTable>): PairingRecord => ({
  workspaceId: r.workspace_id,
  liveId: r.live_id,
  secretHash: r.secret_hash,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  redeemedAt: r.redeemed_at,
});

const toDevice = (r: Selectable<LiveDeviceTable>): DeviceRecord => ({
  workspaceId: r.workspace_id,
  id: r.id,
  liveId: r.live_id,
  credentialHash: r.credential_hash,
  label: r.label,
  code: r.code,
  status: r.status === "approved" ? "approved" : "pending",
  createdAt: r.created_at,
  approvedAt: r.approved_at,
  revokedAt: r.revoked_at,
  expiresAt: r.expires_at,
});

/** The live-session store on an open {@link SqliteStorage} (same connection and database file). */
export function createSqliteLiveStore(storage: SqliteStorage): LiveSessionStore {
  const db: Kysely<Database> = storage.kysely;
  return {
    async insertSession(s) {
      await db
        .insertInto("live_session")
        .values({
          workspace_id: s.workspaceId,
          id: s.id,
          deck_id: s.deckId,
          revision: s.revision,
          started_at: s.startedAt,
          expires_at: s.expiresAt,
          ended_at: s.endedAt,
        })
        .execute();
    },

    async getSession(ws, id) {
      const row = await db
        .selectFrom("live_session")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toSession(row) : null;
    },

    async findActiveSession(ws, deckId, now) {
      const row = await db
        .selectFrom("live_session")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("deck_id", "=", deckId)
        .where("ended_at", "is", null)
        .where("expires_at", ">", now)
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();
      return row ? toSession(row) : null;
    },

    async setSessionRevision(ws, id, revision) {
      await db
        .updateTable("live_session")
        .set({ revision })
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .execute();
    },

    async endSession(ws, id, at) {
      const r = await db
        .updateTable("live_session")
        .set({ ended_at: at })
        .where("workspace_id", "=", ws)
        .where("id", "=", id)
        .where("ended_at", "is", null)
        .executeTakeFirst();
      return Number(r.numUpdatedRows) > 0;
    },

    async replacePairing(p) {
      await storage.withTransaction(async (tx) => {
        await tx
          .deleteFrom("live_pairing")
          .where("workspace_id", "=", p.workspaceId)
          .where("live_id", "=", p.liveId)
          .where("redeemed_at", "is", null)
          .execute();
        await tx
          .insertInto("live_pairing")
          .values({
            workspace_id: p.workspaceId,
            live_id: p.liveId,
            secret_hash: p.secretHash,
            created_at: p.createdAt,
            expires_at: p.expiresAt,
            redeemed_at: p.redeemedAt,
          })
          .execute();
      });
    },

    async redeemPairing(secretHash, now) {
      const row = await db
        .updateTable("live_pairing")
        .set({ redeemed_at: now })
        .where("secret_hash", "=", secretHash)
        .where("redeemed_at", "is", null)
        .where("expires_at", ">", now)
        .returningAll()
        .executeTakeFirst();
      return row ? toPairing(row) : null;
    },

    async insertDeviceIfBelow(d, max) {
      const r = await sql`
        INSERT INTO live_device (workspace_id, id, live_id, credential_hash, label, code, status, created_at,
          approved_at, revoked_at, expires_at)
        SELECT ${d.workspaceId}, ${d.id}, ${d.liveId}, ${d.credentialHash}, ${d.label}, ${d.code}, ${d.status},
          ${d.createdAt}, ${d.approvedAt}, ${d.revokedAt}, ${d.expiresAt}
        WHERE (SELECT COUNT(*) FROM live_device
               WHERE workspace_id = ${d.workspaceId} AND live_id = ${d.liveId} AND revoked_at IS NULL) < ${max}
      `.execute(db);
      return Number(r.numAffectedRows ?? 0) > 0;
    },

    async getDeviceByCredential(hash) {
      const row = await db
        .selectFrom("live_device")
        .selectAll()
        .where("credential_hash", "=", hash)
        .executeTakeFirst();
      return row ? toDevice(row) : null;
    },

    async listDevices(ws, liveId) {
      const rows = await db
        .selectFrom("live_device")
        .selectAll()
        .where("workspace_id", "=", ws)
        .where("live_id", "=", liveId)
        .where("revoked_at", "is", null)
        .orderBy("id", "asc")
        .execute();
      return rows.map(toDevice);
    },

    async approveDevice(ws, liveId, id, at) {
      const r = await db
        .updateTable("live_device")
        .set({ status: "approved", approved_at: at })
        .where("workspace_id", "=", ws)
        .where("live_id", "=", liveId)
        .where("id", "=", id)
        .where("status", "=", "pending")
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(r.numUpdatedRows) > 0;
    },

    async revokeDevices(ws, liveId, ids, at) {
      let q = db
        .updateTable("live_device")
        .set({ revoked_at: at })
        .where("workspace_id", "=", ws)
        .where("live_id", "=", liveId)
        .where("revoked_at", "is", null);
      if (ids !== null) {
        if (ids.length === 0) return [];
        q = q.where("id", "in", [...ids]);
      }
      const rows = await q.returning("id").execute();
      return rows.map((r) => r.id);
    },
  };
}
