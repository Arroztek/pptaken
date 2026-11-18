// SPDX-License-Identifier: AGPL-3.0-or-later
// The SQLite UnitOfWork: one better-sqlite3 connection per storage, wrapped by Kysely, migrated at open.
import { chmodSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AssetRepository,
  AuditLog,
  DeckRepository,
  IdempotencyRepository,
  Repositories,
  RevisionRepository,
  ScriptApprovalRepository,
  UnitOfWork,
} from "@pptaken/core";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import {
  backupTo,
  loadMigrations,
  type MigrateResult,
  type Migration,
  migrate,
  schemaVersion,
} from "./migrations.js";
import { createRepositories, type Database as Schema } from "./repositories.js";

export interface SqliteStorageOptions {
  /** Database file path, or `:memory:` (tests). */
  filename: string;
  /**
   * SQLite `busy_timeout` in ms: how long a statement blocks the thread waiting for a lock held by another
   * connection. Kept short (default 50) because waiting blocks the event loop; acquiring the write lock for a
   * transaction is retried asynchronously instead (see `lockTimeoutMs`).
   */
  busyTimeoutMs?: number;
  /** Total time to keep retrying `BEGIN IMMEDIATE` while another connection writes (default 10 000 ms). */
  lockTimeoutMs?: number;
  /** Migrations to apply (default: the ones shipped in `migrations/`). */
  migrations?: readonly Migration[];
  /** Directory for the pre-migration copy (default: next to the database file). */
  backupDir?: string;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_"));
}

/**
 * The SQLite adapter of the core's {@link UnitOfWork}. Open it with {@link openSqliteStorage}; close it on
 * shutdown. One instance owns one connection: in a single process, share one instance.
 */
export class SqliteStorage implements UnitOfWork {
  readonly decks: DeckRepository;
  readonly revisions: RevisionRepository;
  readonly assets: AssetRepository;
  readonly audit: AuditLog;
  readonly idempotency: IdempotencyRepository;
  readonly scriptApprovals: ScriptApprovalRepository;
  /** Result of the migration run done at open. */
  readonly migration: MigrateResult;

  private constructor(
    private readonly raw: Database.Database,
    /** The Kysely instance, for adapters that add their own tables in later migrations. */
    readonly kysely: Kysely<Schema>,
    migration: MigrateResult,
    private readonly lockTimeoutMs: number,
  ) {
    const repos = createRepositories(kysely);
    this.decks = repos.decks;
    this.revisions = repos.revisions;
    this.assets = repos.assets;
    this.audit = repos.audit;
    this.idempotency = repos.idempotency;
    this.scriptApprovals = repos.scriptApprovals;
    this.migration = migration;
  }

  /** Opens (creating if needed) and migrates a database. Throws `SchemaTooNewError` for a newer schema. */
  static open(options: SqliteStorageOptions): SqliteStorage {
    const memory = options.filename === ":memory:" || options.filename === "";
    const isNew = memory || !existsSync(options.filename);
    const raw = new Database(options.filename);
    try {
      if (isNew && !memory) {
        try {
          chmodSync(options.filename, 0o600);
        } catch {
          // Best effort (not supported on every OS).
        }
      }
      raw.pragma(`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 50))}`);
      raw.pragma("journal_mode = WAL");
      raw.pragma("synchronous = NORMAL");
      raw.pragma("foreign_keys = ON");
      const migration = migrate(raw, options.migrations ?? loadMigrations(), {
        ...(options.backupDir === undefined ? {} : { backupDir: options.backupDir }),
      });
      const kysely = new Kysely<Schema>({ dialect: new SqliteDialect({ database: raw }) });
      return new SqliteStorage(raw, kysely, migration, options.lockTimeoutMs ?? 10_000);
    } catch (error) {
      raw.close();
      throw error;
    }
  }

  async transaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T> {
    return this.withTransaction((conn) => work(createRepositories(conn)));
  }

  /**
   * Runs `work` inside `BEGIN IMMEDIATE … COMMIT` with a Kysely instance bound to the transaction, for adapters
   * that own their tables (for example the auth store). Same rules as {@link transaction}.
   */
  async withTransaction<T>(work: (db: Kysely<Schema>) => Promise<T>): Promise<T> {
    return this.kysely.connection().execute(async (conn) => {
      await this.beginImmediate(conn);
      let result: T;
      try {
        result = await work(conn);
      } catch (error) {
        try {
          await sql`ROLLBACK`.execute(conn);
        } catch {
          // The transaction may already be rolled back by SQLite; the original error matters.
        }
        throw error;
      }
      await sql`COMMIT`.execute(conn);
      return result;
    });
  }

  /** Takes the write lock up front; while another connection holds it, retries without blocking the loop. */
  private async beginImmediate(conn: Kysely<Schema>): Promise<void> {
    const deadline = Date.now() + this.lockTimeoutMs;
    let delay = 2;
    for (;;) {
      try {
        await sql`BEGIN IMMEDIATE`.execute(conn);
        return;
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) throw error;
        await sleep(delay);
        delay = Math.min(delay * 2, 50);
      }
    }
  }

  /** Current schema version (highest applied migration). */
  schemaVersion(): number {
    return schemaVersion(this.raw);
  }

  /** Consistent online copy of the database to `path` (which must not exist), e.g. for `pptaken backup`. */
  async backup(path: string): Promise<void> {
    await this.kysely.connection().execute(async () => {
      backupTo(this.raw, path);
    });
  }

  /** Closes the connection. The instance cannot be used afterwards. */
  async close(): Promise<void> {
    await this.kysely.destroy();
    // Kysely only closes the database if its driver was initialized (lazily, on the first query).
    if (this.raw.open) this.raw.close();
  }
}

/** Opens and migrates a SQLite storage. See {@link SqliteStorage.open}. */
export function openSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  return SqliteStorage.open(options);
}
