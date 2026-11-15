// SPDX-License-Identifier: AGPL-3.0-or-later
// The in-memory implementations must pass the same contract suites as the real adapters.
import { webcrypto } from "node:crypto";
import { createUlidGenerator, systemClock } from "@pptaken/core";
import {
  createTestIdGenerator,
  MemoryBlobStore,
  MemoryLiveSessionStore,
  MemoryUnitOfWork,
  runBlobStoreContract,
  runClockContract,
  runIdGeneratorContract,
  runLiveSessionContract,
  runStorageContract,
} from "../src/index.js";

runStorageContract("memory", () => ({ uow: new MemoryUnitOfWork() }));
runLiveSessionContract("memory", () => ({ store: new MemoryLiveSessionStore() }));
runBlobStoreContract("memory", () => ({ store: new MemoryBlobStore() }));
runIdGeneratorContract("test ids", (clock) => createTestIdGenerator(clock));
runIdGeneratorContract("ulid generator", (clock) =>
  createUlidGenerator((n) => webcrypto.getRandomValues(new Uint8Array(n)), clock),
);
runClockContract("system clock", () => systemClock);
