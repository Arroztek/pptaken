// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/core: the domain and use cases of PPTaken, and the ports (interfaces) adapters implement.
// Zero I/O: this package never touches the network, the file system or a database (see README "Dependency rules").

import type { Clock, IdGenerator } from "./ports.js";
import { createUlidFactory, type RandomSource } from "./ulid.js";

export {
  type CoreConfig,
  type CoreConfigInput,
  type CoreLimits,
  DAY_MS,
  DEFAULT_CONFIG,
  DEFAULT_LIMITS,
  resolveConfig,
} from "./config.js";
export { type Core, type CoreDeps, createCore } from "./core.js";
export {
  applySlideEdits,
  assetRefsOf,
  type CoreWarning,
  type CoreWarningCode,
  countSteps,
  type OutlineItem,
  outlineOf,
  type SlideUpsert,
  sanitizeAndCheck,
  validateDeck,
} from "./deck.js";
export {
  DomainError,
  type DomainErrorBody,
  type DomainErrorInit,
  ERROR_CODES,
  type ErrorCode,
  isDomainError,
  limitExceeded,
  validationError,
} from "./errors.js";
export {
  normalizeMediaType,
  RASTER_MEDIA_TYPES,
  type RasterMediaType,
  type SniffResult,
  sniffImage,
} from "./media.js";
export type {
  ActorRef,
  AssetRecord,
  AssetRepository,
  AuditEntry,
  AuditLog,
  AuditResult,
  BlobInfo,
  BlobPutOptions,
  BlobPutResult,
  BlobStore,
  Clock,
  DeckHeadUpdate,
  DeckListQuery,
  DeckRecord,
  DeckRepository,
  IdempotencyRecord,
  IdempotencyRepository,
  IdGenerator,
  Repositories,
  RevisionRecord,
  RevisionRepository,
  RevisionSummary,
  UnitOfWork,
} from "./ports.js";
export {
  type Actor,
  type CallContext,
  DEFAULT_WORKSPACE_ID,
  ownerPrincipal,
  type Principal,
  requireOwner,
  requireOwnerOrSystem,
  requireScope,
  SCOPES,
  type Scope,
  systemPrincipal,
} from "./principal.js";
export { sha256Hex, utf8Encode } from "./sha256.js";
export { createUlidFactory, isUlid, type RandomSource, ULID_PATTERN, ulidTime } from "./ulid.js";
export type {
  AddAssetInput,
  AddAssetResult,
  AssetInfo,
} from "./usecases/assets.js";
export type { RevisionWriteResult } from "./usecases/commit.js";
export {
  type CreatePresentationInput,
  type CreatePresentationResult,
  type GetPresentationInput,
  INCLUDE_PARTS,
  type IncludePart,
  type ListPresentationsInput,
  type Page,
  type PresentationSummary,
  type PresentationView,
  type PurgeResult,
  type SlideInput,
  type SlideView,
  type TrashResult,
  type UpdatePresentationInput,
  type UpdateSlidesInput,
} from "./usecases/presentations.js";
export type { RevisionDetail, RevisionInfo } from "./usecases/revisions.js";

/** The system clock (`Date.now()`). */
export const systemClock: Clock = { now: () => Date.now() };

/**
 * The production {@link IdGenerator}: monotonic ULIDs over the given clock and random source. The random source
 * is injected to keep the core free of platform APIs; in Node pass
 * `(n) => crypto.getRandomValues(new Uint8Array(n))`.
 */
export function createUlidGenerator(random: RandomSource, clock: Clock = systemClock): IdGenerator {
  const next = createUlidFactory(() => clock.now(), random);
  return { ulid: next };
}
