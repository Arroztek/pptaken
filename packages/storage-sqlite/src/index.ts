// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/storage-sqlite: the core's repository ports on SQLite (better-sqlite3 + Kysely).

export {
  backupTo,
  loadMigrations,
  MIGRATIONS_DIR,
  type MigrateOptions,
  type MigrateResult,
  type Migration,
  MigrationError,
  migrate,
  SchemaTooNewError,
  schemaVersion,
} from "./migrations.js";
export { createRepositories, type Database } from "./repositories.js";
export { openSqliteStorage, SqliteStorage, type SqliteStorageOptions } from "./storage.js";
