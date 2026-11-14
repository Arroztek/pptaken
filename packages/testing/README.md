# @pptaken/testing

Test kit for PPTaken adapters and the core. License: AGPL-3.0-or-later.

- **Contract suites** (call them from a Vitest test file; each test gets a fresh instance from your factory):
  `runStorageContract` (= `runDeckRepositoryContract`, `runRevisionRepositoryContract`,
  `runAssetRepositoryContract`, `runAuditLogContract`, `runIdempotencyRepositoryContract`,
  `runUnitOfWorkContract`), `runBlobStoreContract`, `runIdGeneratorContract`, `runClockContract`.
- **In-memory ports:** `MemoryUnitOfWork` (copy-on-write transactions, one at a time), `MemoryBlobStore`,
  `ManualClock`, `createTestIdGenerator(clock, seed)` (deterministic ULIDs), `seededRandom`.
- **Factories:** `createTestCore({ store?, blobs?, clock?, config?, seed? })` (a core on in-memory ports),
  `agentPrincipal(scopes?)`, `ownerPrincipal()`, `makeDeck`, `makeSlides`, `makeSlideInputs`, `makeDeckRecord`,
  `makeRevisionRecord`, `makeAssetRecord`, `makeAuditEntry`.
- **Image fixtures** built byte by byte: `pngBytes`, `jpegBytes`, `gifBytes`, `webpBytes`, `webpExtendedBytes`,
  `avifBytes`, `svgBytes`, and `hostileImages` (polyglots, truncated files, a 100 000 × 100 000 PNG header).

```ts
import { runStorageContract } from "@pptaken/testing";
import { openSqliteStorage } from "@pptaken/storage-sqlite";

runStorageContract("sqlite", () => {
  const uow = openSqliteStorage({ filename: ":memory:" });
  return { uow, cleanup: () => uow.close() };
});
```

The in-memory implementations pass the same suites (`test/memory.test.ts`); they are the reference behaviour.
`vitest` is a peer dependency.
