# @pptaken/core

The domain and use cases of PPTaken, and the **ports** (interfaces) that adapters implement
([architecture §1, §3, §9](../../docs/foundation/02-architecture.md)). License: AGPL-3.0-or-later.

- **Zero I/O.** The core never touches the network, the file system, a database or a platform API. Time, ids,
  storage and blobs come in through ports. SHA-256 and ULID are implemented here in plain TypeScript.
- **Dependencies:** `@pptaken/schema` (format, `parseDeck`) and `@pptaken/sanitizer` (`sanitizeDeck`) only.
  `test/dependency-rules.test.ts` fails the build if any production source imports anything else (including
  `node:*`, `hono`, `ws`, `better-sqlite3`, `kysely`) or uses I/O globals.
- **Every write** is validated with `parseDeck`, sanitized with `sanitizeDeck`, validated again, stored as a new
  immutable revision with optimistic concurrency, and audited.

## Quick start (composition root)

```ts
import { webcrypto } from "node:crypto";
import { createCore, createUlidGenerator, systemClock, ownerPrincipal } from "@pptaken/core";
import { openSqliteStorage } from "@pptaken/storage-sqlite";
import { openFsBlobStore } from "@pptaken/blob-fs";

const core = createCore({
  store: openSqliteStorage({ filename: "/data/pptaken.db" }),
  blobs: await openFsBlobStore({ root: "/data/blobs" }),
  clock: systemClock,
  ids: createUlidGenerator((n) => webcrypto.getRandomValues(new Uint8Array(n))),
  config: { defaultLang: "en" }, // limits, revisionsKept, trashRetentionMs are optional overrides
});

const result = await core.createPresentation(principal, { title: "Hello", slides: [{ html: "<h1>Hi</h1>" }] }, { ip, requestId });
```

Every use case has the signature `(principal: Principal, input, call?: CallContext) => Promise<Result>`. The auth
layer builds the `Principal` (`{ actor: "owner" | "agent" | "system", workspaceId, scopes, tokenId? }`); the core
never trusts input for identity. Give the owner's session principal every scope (`ownerPrincipal()`); maintenance
jobs use `systemPrincipal()`.

## Ports

| Port | Responsibility | Implementations | Contract suite (`@pptaken/testing`) |
|---|---|---|---|
| `DeckRepository` | Deck head rows: insert, get, compare-and-set of the head (`updateHead`), trash flag, list (cursor, title search), trash sweep | memory, `storage-sqlite` | `runDeckRepositoryContract` |
| `RevisionRepository` | Immutable snapshots: insert, get, list, retention deletes | memory, `storage-sqlite` | `runRevisionRepositoryContract` |
| `AssetRepository` | Asset metadata, deck links, per-deck stats, orphan checks | memory, `storage-sqlite` | `runAssetRepositoryContract` |
| `AuditLog` | Append and list audit entries | memory, `storage-sqlite` | `runAuditLogContract` |
| `IdempotencyRepository` | Stored results of idempotent creates | memory, `storage-sqlite` | `runIdempotencyRepositoryContract` |
| `UnitOfWork` | All repositories + `transaction(work)` (atomic, serializable) | memory (copy-on-write), `storage-sqlite` (`BEGIN IMMEDIATE`) | `runUnitOfWorkContract`, or everything with `runStorageContract` |
| `BlobStore` | Content-addressed bytes by SHA-256 (put/putStream/get/getStream/has/delete/list, `maxBytes`) | memory, `blob-fs` | `runBlobStoreContract` |
| `Clock` | `now()` in epoch ms | `systemClock`, `ManualClock` | `runClockContract` |
| `IdGenerator` | Monotonic ULIDs | `createUlidGenerator(random)`, `createTestIdGenerator` | `runIdGeneratorContract` |

Port conventions: every method is async; every repository call takes `workspaceId` explicitly; timestamps are
epoch milliseconds; records are plain data and implementations return copies. Repositories enforce no business
rules; use cases do. Inside `transaction(work)` use only the `tx` repositories passed to `work`, never start a
nested transaction, and do no slow I/O (blob writes happen before the transaction).

## Use cases

| Method | Scope / actor | MCP tool | Notes |
|---|---|---|---|
| `createPresentation` | `decks:write` | `create_presentation` | Generates missing slide ids (`slide-N`); `idempotencyKey` (scoped to actor + token) replays the stored result with `replayed: true`; same key with a different request is `VALIDATION_ERROR` |
| `getPresentation` | `decks:read` | `get_presentation` | `include`: `outline` (default), `theme`, `slides` (never with notes), `notes` (separate list); `slideIds` filter; optional older `revision` |
| `listPresentations` | `decks:read` (trash: owner) | `list_presentations` | Newest first, opaque `cursor`, `query` (ASCII case-insensitive substring), `limit` ≤ 100 |
| `updatePresentation` | `decks:write` | `update_presentation` | `title`, `lang`, `aspectRatio`, `theme` (replaces; `null` removes), `targetMinutes`, `slideOrder` (exactly the current ids); `expectedRevision` |
| `updateSlides` | `decks:write` | `update_slides` | `upsert` applied in order (existing id: only the fields sent change, `null` clears optional fields, `after` moves; new or missing id: insert at `after` = id, `"start"` or `"end"`, default end; `after` may name a slide inserted earlier in the same call), then `remove`; whole deck re-sanitized and re-validated |
| `trashPresentation` | `decks:write` | `delete_presentation` | Returns `restorableUntil` (epoch ms) |
| `restorePresentation` | `decks:write` + **owner** | panel | |
| `purgePresentation` | `decks:write` + **owner** | panel | Only from the trash. Deletes revisions, links, unused asset rows and their blobs |
| `purgeExpiredTrash` | owner or system | job | Trash older than `trashRetentionMs` (30 days) |
| `listRevisions` / `getRevision` | `decks:read` | panel | `getRevision` returns the full document, notes included |
| `restoreRevision` | `decks:write` + **owner** | panel | New revision copied (and re-sanitized) from an old one |
| `pruneRevisions` | owner or system | job | Keeps the newest `revisionsKept` (50) per deck; the current revision is never deleted |
| `addAsset` | `decks:write` | `add_asset` | Bytes + declared type. Type verified by content (PNG, JPEG, GIF, WebP, AVIF), size read from headers, limits, dedup by SHA-256, returns `ref: "asset:<sha256>"` |
| `getAsset` / `listAssets` | `decks:read` | content route, panel | `getAsset` with `presentationId` only serves that deck's assets |
| `collectOrphanBlobs` | owner or system | job | Instance-wide; deletes blobs no asset row references, older than `graceMs` (1 h); `dryRun` |
| `listAuditLog` | **owner** | panel | Newest first, cursor, `target` filter |
| `exportPresentation` | `decks:read` + **owner** | panel download | The deck of a revision (notes only with `includeNotes: true`) and the bytes of the assets it references; audited. Data only: the server makes the HTML file or the `.pptaken` archive (`@pptaken/export`) |
| `importPresentation` | `decks:write` + **owner** | panel upload | Creates a **new** presentation from `{ deck, assets }`: `parseDeck`, re-sanitize, re-validate; each asset checked like `addAsset` (signature, declared type, SHA-256, limits); only referenced assets are kept (`UNUSED_ASSET` warning for the others, `UNKNOWN_ASSET_REF` for references without a file); one transaction; audited |

All writes (successful or not) are audited: successes inside their transaction (best effort: an audit failure
never fails the write), failures afterwards with `result: "denied"` (scope/actor errors) or `"error"`.

Write results are compact: `{ presentationId, revision, slideCount, warnings }`. Warnings are sanitizer warnings
(`REMOVED_ELEMENT`, `REMOVED_CSS_RULE`…) with `path` (`slides[3].html`) and `slideId`, plus the core's
`UNKNOWN_ASSET_REF` (an `asset:` reference that is not an asset of the presentation).

## Errors

Use cases throw only `DomainError` (`isDomainError(e)` also works across package copies). `error.toJSON()` is the
agent-facing body `{ code, message, path?, hint, retryable, details? }` of the MCP error catalog (§5.4); it never
contains the cause or a stack trace.

| Code | When | `details` |
|---|---|---|
| `VALIDATION_ERROR` | Input does not satisfy the format or the use case (first issue in `path`) | `issues` (up to 20 `{ path, message }`) |
| `NOT_FOUND` | Unknown id, other workspace, or in the trash; unknown slide id or revision | |
| `REVISION_CONFLICT` | `expectedRevision` is not the current revision (`retryable: true`) | `currentRevision`, `expectedRevision` |
| `LIMIT_EXCEEDED` | Slides per deck, asset size, pixels, assets per deck, bytes per deck | `limit`, `received` |
| `UNSUPPORTED_MEDIA` | Content is not an accepted image, is malformed or a polyglot, is SVG, or does not match the declared type | `accepted` |
| `FORBIDDEN_SCOPE` | Missing scope | `requiredScope` |
| `FORBIDDEN_ACTOR` | Human-only action by an agent or job | |
| `INTERNAL` | Anything unexpected (`retryable: true`) | `requestId` (from `CallContext`) |
| `FETCH_FAILED`, `FETCH_BLOCKED`, `RATE_LIMITED` | Reserved for outer layers (URL download, rate limiting); the core never throws them | |

## Implementing a new adapter

1. Implement the port interfaces from `@pptaken/core` (see the conventions above). For storage, implement
   `UnitOfWork`: the repositories plus `transaction(work)`, which must be atomic and serializable with respect to
   other transactions (a compare-and-set in `updateHead` must never lose an update).
2. Add a Vitest file that runs the contract suites against a fresh instance per test:

   ```ts
   import { runStorageContract, runBlobStoreContract } from "@pptaken/testing";
   runStorageContract("postgres", async () => {
     const uow = await openPostgresStorage(freshDatabaseUrl());
     return { uow, cleanup: () => uow.close() };
   });
   runBlobStoreContract("s3", async () => ({ store: await openS3BlobStore(freshBucket()) }));
   ```
3. Also run a few core flows on it with `createTestCore({ store })` (see `packages/storage-sqlite/test`).

`@pptaken/testing` also provides the in-memory ports, `ManualClock`, deterministic ids, data factories and
byte-level image fixtures (including polyglots and truncated files).

## Limits (defaults, configurable through `config.limits`)

200 slides per deck (cannot exceed the format limit), 10 MB per asset, 200 assets and 100 MB per deck,
64 megapixels per image, 50 revisions kept, 30 days in the trash. Format limits (HTML/CSS/notes sizes) come from
`@pptaken/schema` `LIMITS`.

## Decisions and open questions

| Topic | Decision |
|---|---|
| SVG uploads | **Rejected in v1** with `UNSUPPORTED_MEDIA` and a hint to inline the SVG in the slide HTML, where the sanitizer's SVG policy applies. The sanitizer has no standalone-SVG function, and wrapping a file in the HTML sanitizer would mean HTML-parsing an XML document and re-serializing it as HTML (entities such as `&nbsp;` are not valid XML), a parser differential we would rather not ship. Revisit with an XML-aware SVG sanitizer. |
| Declared vs detected type | The declared type must match the detected one (aliases such as `image/jpg` are normalized); a mismatch is `UNSUPPORTED_MEDIA` whose hint names the detected type. The file name is never used. |
| Polyglots | PNG, GIF, WebP and AVIF must be structurally complete with nothing after the last chunk/block/box; JPEG must reach EOI and may only be followed by zero padding or another JPEG (MPO from phones). Assets must still be served with `nosniff` and the sandbox CSP. |
| Decompression bombs | Pixel limit (64 MP) from the headers; nothing is decoded. |
| Asset scope | Asset rows are per workspace and linked to decks; blobs are global (content-addressed). Links are per deck, not per revision: an asset stays until its deck is purged. `collectOrphanBlobs` is instance-wide and has a grace period because blobs are written before the transaction that links them (a re-`put` refreshes the blob's time). |
| Idempotency | Keys are scoped to actor + token, stored with a SHA-256 of the canonical request and the original result; they live until the deck is purged (no expiry yet). |
| Trash | Trashed decks behave as `NOT_FOUND` for every use case except restore, purge and listing the trash (owner). Purge requires the deck to be in the trash first. |
| Retention | `pruneRevisions` is an explicit job (not run on every write) so later phases can exclude revisions pinned by live sessions or share links. |
| Steps in the outline | Counted from the sanitized HTML like the player (distinct numbers + unnumbered), by scanning serialized start tags. Informational only. |
| `aspectRatio` change | Allowed in `updatePresentation`; content is not reflowed. |
| Title search | ASCII case-insensitive substring (the portable guarantee of SQLite `LIKE`; Postgres would use `ILIKE`). |
| Open: cross-slide id/`@keyframes` collisions | Not handled here (sanitizer README open question); the core only calls `sanitizeDeck`. |
| Open: audit retention | The audit log grows without bound; a retention job belongs to a later phase. |
| Export/import actor | Owner only in v1 (human-only action, security §3.3): an export can carry notes out of the instance and an import writes a whole deck; agents get `FORBIDDEN_ACTOR`. `includeNotes` defaults to `false` in the core; the `.pptaken` route opts in. Import re-implements `addAsset`'s checks with the same helpers (`sniffImage`, `normalizeMediaType`) so that all rows go in one transaction instead of N `addAsset` calls. |
| Open: quiz, share links, live sessions | Later phases add their own ports, tables and use cases; `include: ["quiz"]` is not supported yet. |
