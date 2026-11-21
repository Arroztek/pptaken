// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/testing: contract suites for adapters, in-memory implementations of every core port, and data
// factories. Contract suites call Vitest's `describe`/`it`, so import them from a Vitest test file.

export {
  type BlobFactory,
  type BlobHarness,
  runBlobStoreContract,
} from "./contracts/blob.js";
export { runClockContract, runIdGeneratorContract } from "./contracts/ids.js";
export { type LiveStoreHarness, runLiveSessionContract } from "./contracts/live.js";
export {
  runAssetRepositoryContract,
  runAuditLogContract,
  runDeckRepositoryContract,
  runIdempotencyRepositoryContract,
  runRevisionRepositoryContract,
  runScriptApprovalRepositoryContract,
  runScriptErrorRepositoryContract,
  runShareLinkRepositoryContract,
  runStorageContract,
  runUnitOfWorkContract,
  type StorageFactory,
  type StorageHarness,
} from "./contracts/storage.js";
export {
  agentPrincipal,
  createTestCore,
  fakeShareSecrets,
  makeAssetRecord,
  makeAuditEntry,
  makeDeck,
  makeDeckRecord,
  makeRevisionRecord,
  makeSlideInputs,
  makeSlides,
  nextTestUlid,
  ownerPrincipal,
  SCOPES,
  TEST_WORKSPACE,
  type TestCore,
} from "./factories.js";
export {
  avifBytes,
  gifBytes,
  hostileImages,
  jpegBytes,
  pngBytes,
  svgBytes,
  webpBytes,
  webpExtendedBytes,
} from "./images.js";
export {
  createTestIdGenerator,
  ManualClock,
  MemoryBlobStore,
  MemoryUnitOfWork,
  seededRandom,
} from "./memory.js";
export { MemoryLiveSessionStore } from "./memory-live.js";
