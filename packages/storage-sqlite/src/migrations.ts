// SPDX-License-Identifier: AGPL-3.0-or-later
// Numbered SQL migrations: `migrations/NNNN_name.sql`, applied in order at startup inside one transaction, with
// a consistent copy of the database taken first (`VACUUM INTO`) when the database already holds data.
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** The database was written by a newer PPTaken: refusing to start avoids corrupting it. */
export class SchemaTooNewError extends Error {
  override readonly name = "SchemaTooNewError";
  constructor(
    readonly databaseVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `The database schema is version ${databaseVersion}, but this PPTaken only knows up to version ${supportedVersion}. Upgrade PPTaken or restore a backup made by this version.`,
    );
  }
}

export class MigrationError extends Error {
  override readonly name = "MigrationError";
  constructor(
    message: string,
    readonly version: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Directory of the migrations shipped with this package. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Reads `NNNN_name.sql` files; versions must start at 1 and have no gaps. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort()
    .map((file) => {
      const m = FILE.exec(file) as RegExpExecArray;
      return {
        version: Number(m[1]),
        name: m[2] as string,
        sql: readFileSync(join(dir, file), "utf8"),
      };
    });
  checkSequence(migrations);
  return migrations;
}

function checkSequence(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(
        `Migration versions must be 1, 2, 3… without gaps (found ${m.version})`,
        m.version,
      );
    }
  });
}

export interface MigrateOptions {
  /**
   * Where to write the pre-migration copy. Default: next to the database file. Ignored for in-memory databases
   * and for new (empty) databases.
   */
  backupDir?: string;
  /** Clock for the backup file name (default `Date.now`). */
  now?: () => number;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
  /** Path of the copy taken before migrating, if one was taken. */
  backupPath: string | null;
}

/** Highest applied migration version (0 for a new database). */
export function schemaVersion(db: BetterSqlite3.Database): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (exists === undefined) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "");
}

/** Consistent online copy of the database (includes the WAL contents). The target must not exist. */
export function backupTo(db: BetterSqlite3.Database, path: string): void {
  db.prepare("VACUUM INTO ?").run(path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort (not supported on every OS).
  }
}

/**
 * Applies pending migrations. Throws {@link SchemaTooNewError} when the database is newer than `migrations`.
 * All pending migrations run in one `BEGIN IMMEDIATE` transaction: either all of them apply or none does.
 */
export function migrate(
  db: BetterSqlite3.Database,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): MigrateResult {
  checkSequence(migrations);
  const known = migrations.length;
  const from = schemaVersion(db);
  if (from > known) throw new SchemaTooNewError(from, known);
  if (from === known) return { from, to: from, applied: [], backupPath: null };

  let backupPath: string | null = null;
  const file = db.name;
  if (from > 0 && !db.memory && file !== "" && file !== ":memory:") {
    const dir = options.backupDir ?? dirname(file);
    const base = file.replace(/^.*[\\/]/, "");
    backupPath = join(dir, `${base}.pre-v${known}-${stamp((options.now ?? Date.now)())}.bak`);
    backupTo(db, backupPath);
  }

  const applied: number[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    // Re-read under the write lock: another process may have migrated meanwhile.
    const current = schemaVersion(db);
    if (current > known) throw new SchemaTooNewError(current, known);
    const record = db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );
    for (const m of migrations) {
      if (m.version <= current) continue;
      try {
        db.exec(m.sql);
      } catch (cause) {
        throw new MigrationError(
          `Migration ${m.version} (${m.name}) failed: ${String(cause)}`,
          m.version,
          {
            cause,
          },
        );
      }
      record.run(m.version, m.name, Date.now());
      applied.push(m.version);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
  return { from, to: known, applied, backupPath };
}
