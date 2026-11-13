# ADR-005 · Database: SQLite when self-hosted, Postgres in the cloud, behind ports

**Decision.**
- **SQLite in WAL mode** as the only database of the self-hosted edition. One file at `/data/pptaken.db`.
- Access with **Kysely** (a typed query builder, not an ORM) and **numbered SQL migrations** (`0001_init.sql`, …) applied at startup, inside a transaction, with a prior copy of the file.
- Driver: **`better-sqlite3`**, encapsulated in a single module.
- The domain does not know SQL: it talks to **repositories** (interfaces). The cloud will implement the same repositories on **Postgres**.
- Binaries (images) do **not** go in the database: they go to a `BlobStore` (local disk; S3 in the cloud), addressed by SHA-256 hash.

**Why SQLite and not Postgres for self-hosted.**

| Criterion | SQLite | Postgres |
|---|---|---|
| Installation | Nothing: it runs inside the process | Second container, credentials, volume, version |
| Backup | Copy a file (or `VACUUM INTO`) | `pg_dump`, more steps |
| Extra RAM | ~0 | 50–150 MB |
| Expected load | More than enough: thousands of writes/s in WAL; a 300-person quiz is tens/s | More than enough |
| Scaling to several nodes | No | Yes |

Our target user must not administer a database. The case that needs several nodes is the cloud, and the adapter exists for that.

**Why Kysely and not Drizzle/Prisma.** Prisma adds an engine and a heavy generation step. Drizzle is good but defines different schemas per dialect (`sqlite-core` vs `pg-core`), which duplicates work when we want the same code on SQLite and Postgres; it is also still 0.x. Kysely is dialect-agnostic, thin and predictable. Rules to keep the SQL portable: simple types (text, integer, JSON as text), dates as epoch-ms integers, ULID identifiers as text.

**Why `better-sqlite3` and not `node:sqlite`.** The built-in `node:sqlite` module is still at stability 1.2 (*release candidate*) on both Node 24 and 26 (verified). `better-sqlite3` is mature and fast, at the cost of being a native module (it compiles per architecture). **Assumption to verify in the first spike:** that it publishes prebuilt binaries for Node 26 on linux-x64 and linux-arm64 (musl and glibc). When `node:sqlite` reaches stable, migrating will mean changing one file and will remove our only native dependency.

**Consequences.** (+) Zero operation for the user. (−) A single node (accepted). (−) Maintaining portable-SQL discipline; verified by running the same contract test suite against both adapters once the Postgres one exists.
