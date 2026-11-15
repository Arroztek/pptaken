# @pptaken/storage-sqlite

The core's storage ports (`UnitOfWork` and every repository) on SQLite, with
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) 13.1.1 and [Kysely](https://kysely.dev) 0.29.8
([ADR-005](../../docs/adr/0005-database-sqlite-postgres.md)). License: AGPL-3.0-or-later.

```ts
import { openSqliteStorage } from "@pptaken/storage-sqlite";
const store = openSqliteStorage({ filename: "/data/pptaken.db" }); // migrates at open
// … createCore({ store, … }); on shutdown: await store.close();
```

## Connection

- One connection per `SqliteStorage`; share one instance per process. Pragmas: `journal_mode=WAL`,
  `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout` (default **50 ms**).
- `transaction(work)` runs `BEGIN IMMEDIATE … COMMIT` on the connection (Kysely's connection mutex keeps other
  in-process queries out meanwhile). If another connection (another process, or the backup CLI) holds the write
  lock, `BEGIN IMMEDIATE` is retried **asynchronously** with backoff for up to `lockTimeoutMs` (default 10 s);
  `busy_timeout` stays short because SQLite waits synchronously and would block the event loop. A lock timeout
  surfaces as the driver's `SQLITE_BUSY` error (the core reports it as a retryable `INTERNAL`).
- "Check revision + insert revision + move head" is atomic: the core runs it in one transaction and
  `updateHead` is a compare-and-set (`UPDATE … WHERE current_revision = ? AND deleted_at IS NULL`); the revision
  primary key `(workspace_id, deck_id, number)` is a second guard.
- New database files are created with mode `0600` where the OS supports it. The data directory itself (and the
  `-wal`/`-shm` files) should live in a `0700` directory created by the server.
- `store.backup(path)` writes a consistent online copy (`VACUUM INTO`), for `pptaken backup`.
- `store.kysely` is exposed for later adapters (auth, share links) that add their own tables through new
  migrations in this package.

## Migrations

- Files `migrations/NNNN_name.sql` (four digits, contiguous from `0001`), shipped with the package. Applied at
  open, all pending ones inside **one** `BEGIN IMMEDIATE` transaction (SQLite DDL is transactional): either all
  apply or none. Applied versions are recorded in `schema_migrations (version, name, applied_at)`.
- **Backup:** when the database already has a schema and migrations are pending, a copy is written first with
  `VACUUM INTO` to `<db>.pre-v<target>-<UTC timestamp>.bak` (next to the database, or in `backupDir`), mode
  `0600`. `VACUUM INTO` was chosen over copying the file because it is consistent while the database is open and
  includes the WAL contents. Backups are not deleted automatically.
- **Newer schema:** if the database has a version higher than the code knows, opening fails with
  `SchemaTooNewError` and nothing is written.
- Writing a migration: plain portable SQL (`TEXT`, `INTEGER`; JSON as `TEXT`; epoch-ms timestamps; ULIDs as
  `TEXT`; `workspace_id TEXT NOT NULL DEFAULT 'default'` first in every primary key). No `BEGIN`/`COMMIT` inside
  the file. `PRAGMA foreign_keys` cannot change inside the transaction: for SQLite's table-rebuild procedure use
  `PRAGMA defer_foreign_keys = ON`. Add a test like `test/migrations.test.ts` "upgrades a database created by
  0001 that holds data" for every new migration.

## Auth tables

Migration `0002_auth.sql` adds `auth_owner` (one per workspace, enforced by a unique index), `auth_session`,
`api_token` (unique `token_hash`), `auth_setting` (the install code's HMAC) and `mcp_activity`.
`createSqliteAuthStore(storage)` (`src/auth.ts`) implements the `AuthStore` port of `@pptaken/auth-local` on the
same connection; this package does not import auth-local (the records mirror its types and the server checks the
match at compile time). `completeSetup` runs in `storage.withTransaction(work)`, a new `BEGIN IMMEDIATE` helper that
`transaction` now also uses. The adapter passes `runAuthStoreContract` (`test/auth.test.ts`).

## Tests

`pnpm --filter @pptaken/storage-sqlite test`: the full storage contract (on `:memory:` and on a WAL file), core
flows end to end, migrations (from scratch, from 0001 with data plus a hypothetical 0002, newer-schema refusal,
atomic failure), two connections on one file (lock waiting without blocking, lock timeout, exactly one stale
writer wins), and a performance check.
