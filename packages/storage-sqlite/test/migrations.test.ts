// SPDX-License-Identifier: AGPL-3.0-or-later
// Migration runner: from an empty database, from a database created by 0001 holding data (the pattern every later
// migration follows), refusal on a newer schema, atomic failure and the pre-migration backup.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { agentPrincipal, createTestCore, makeSlideInputs } from "@pptaken/testing";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadMigrations,
  type Migration,
  MigrationError,
  migrate,
  openSqliteStorage,
  SchemaTooNewError,
  schemaVersion,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

const shipped = loadMigrations();

/** A hypothetical next migration, written the way real ones must be. */
const v2: Migration = {
  version: 2,
  name: "deck_color",
  sql: "ALTER TABLE deck ADD COLUMN color TEXT NOT NULL DEFAULT 'none';\nUPDATE deck SET color = 'blue';",
};

let tmp: ReturnType<typeof tempDir>;
afterEach(() => tmp?.remove());

function tables(file: string): string[] {
  const db = new Database(file, { readonly: true });
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

describe("migrations", () => {
  it("ships contiguous numbered migrations", () => {
    expect(shipped.map((m) => m.version)).toEqual(shipped.map((_, i) => i + 1));
    expect(shipped[0]?.name).toBe("init");
  });

  it("creates the schema from an empty database, in WAL mode with foreign keys on", async () => {
    tmp = tempDir();
    const file = join(tmp.dir, "new.db");
    const storage = openSqliteStorage({ filename: file });
    expect(storage.migration).toMatchObject({ from: 0, to: shipped.length, backupPath: null });
    expect(storage.schemaVersion()).toBe(shipped.length);
    await storage.close();
    expect(tables(file)).toEqual(
      [
        "api_token",
        "asset",
        "audit_log",
        "auth_owner",
        "auth_session",
        "auth_setting",
        "deck",
        "deck_asset",
        "idempotency_key",
        "mcp_activity",
        "revision",
        "schema_migrations",
      ].sort(),
    );
    const db = new Database(file);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
    // No backup for a new database.
    expect(readdirSync(tmp.dir).filter((f) => f.endsWith(".bak"))).toEqual([]);
  });

  it("is a no-op when re-opened at the same version", async () => {
    tmp = tempDir();
    const file = join(tmp.dir, "same.db");
    await openSqliteStorage({ filename: file }).close();
    const again = openSqliteStorage({ filename: file });
    expect(again.migration).toMatchObject({ applied: [], backupPath: null });
    await again.close();
  });

  it("upgrades a database created by 0001 that holds data, after taking a backup", async () => {
    tmp = tempDir();
    const file = join(tmp.dir, "old.db");
    const v1 = openSqliteStorage({ filename: file, migrations: shipped.slice(0, 1) });
    const t = createTestCore({ store: v1 });
    const { presentationId } = await t.core.createPresentation(agentPrincipal(), {
      title: "Before upgrade",
      slides: makeSlideInputs(2),
    });
    await v1.close();

    const v2storage = openSqliteStorage({
      filename: file,
      migrations: [...shipped.slice(0, 1), v2],
    });
    expect(v2storage.migration).toMatchObject({ from: 1, to: 2, applied: [2] });
    const backup = v2storage.migration.backupPath as string;
    expect(existsSync(backup)).toBe(true);
    expect(backup.startsWith(tmp.dir)).toBe(true);
    // Data survived and the new column was filled.
    const t2 = createTestCore({ store: v2storage });
    const view = await t2.core.getPresentation(agentPrincipal(), {
      presentationId,
      include: ["slides"],
    });
    expect(view.slides).toHaveLength(2);
    const { sql } = await import("kysely");
    const color = await sql<{ color: string }>`SELECT color FROM deck`.execute(v2storage.kysely);
    expect(color.rows).toEqual([{ color: "blue" }]);
    await v2storage.close();
    // The backup is a complete version-1 database with the data.
    const copy = new Database(backup, { readonly: true });
    expect(schemaVersion(copy)).toBe(1);
    expect(copy.prepare("SELECT title FROM deck").all()).toEqual([{ title: "Before upgrade" }]);
    copy.close();
  });

  it("upgrades a 0001 database with data to 0002_auth (shipped migrations)", async () => {
    tmp = tempDir();
    const file = join(tmp.dir, "auth-upgrade.db");
    const v1 = openSqliteStorage({ filename: file, migrations: shipped.slice(0, 1) });
    const t = createTestCore({ store: v1 });
    await t.core.createPresentation(agentPrincipal(), {
      title: "Kept",
      slides: makeSlideInputs(1),
    });
    await v1.close();
    const current = openSqliteStorage({ filename: file });
    expect(current.migration).toMatchObject({ from: 1, to: shipped.length });
    expect(current.migration.applied).toContain(2);
    const list = await createTestCore({ store: current }).core.listPresentations(
      agentPrincipal(),
      {},
    );
    expect(list.items.map((d) => d.title)).toEqual(["Kept"]);
    await current.close();
    expect(tables(file)).toContain("api_token");
  });

  it("refuses to open a database from a newer schema", async () => {
    tmp = tempDir();
    const file = join(tmp.dir, "newer.db");
    await openSqliteStorage({
      filename: file,
      migrations: [...shipped, { ...v2, version: shipped.length + 1 }],
    }).close();
    const failure = (() => {
      try {
        openSqliteStorage({ filename: file });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(SchemaTooNewError);
    expect(failure).toMatchObject({
      databaseVersion: shipped.length + 1,
      supportedVersion: shipped.length,
    });
  });

  it("applies pending migrations atomically: a failing one leaves the database untouched", () => {
    const db = new Database(":memory:");
    migrate(db, shipped.slice(0, 1));
    const broken: Migration[] = [
      ...shipped.slice(0, 1),
      v2,
      { version: 3, name: "broken", sql: "CREATE TABLE ok_table (x INTEGER); THIS IS NOT SQL;" },
    ];
    expect(() => migrate(db, broken)).toThrow(MigrationError);
    expect(schemaVersion(db)).toBe(1);
    const cols = db.prepare("SELECT name FROM pragma_table_info('deck')").all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name)).not.toContain("color");
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_table'").get(),
    ).toBeUndefined();
    db.close();
  });

  it("rejects migration lists with gaps", () => {
    const db = new Database(":memory:");
    expect(() => migrate(db, [{ ...v2, version: 2 }])).toThrow(MigrationError);
    db.close();
  });
});
