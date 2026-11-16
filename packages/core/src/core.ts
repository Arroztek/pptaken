// SPDX-License-Identifier: AGPL-3.0-or-later
// The composition-friendly facade: `createCore(deps)` binds every use case to its ports.
import { type CoreConfig, type CoreConfigInput, resolveConfig } from "./config.js";
import { validationError } from "./errors.js";
import type {
  AuditEntry,
  BlobStore,
  Clock,
  IdGenerator,
  PptxConverter,
  UnitOfWork,
} from "./ports.js";
import { type CallContext, type Principal, requireOwner } from "./principal.js";
import { isUlid } from "./ulid.js";
import {
  type AddAssetInput,
  type AddAssetResult,
  type AssetInfo,
  addAsset,
  collectOrphanBlobs,
  getAsset,
  listAssets,
} from "./usecases/assets.js";
import type { RevisionWriteResult } from "./usecases/commit.js";
import {
  type Ctx,
  decodeCursor,
  encodeCursor,
  optionalLimit,
  requireObject,
  runRead,
} from "./usecases/context.js";
import {
  type ExportPresentationInput,
  type ExportPresentationResult,
  exportPresentation,
  type ImportPresentationInput,
  type ImportPresentationResult,
  importPresentation,
} from "./usecases/portability.js";
import { type ImportPptxInput, type ImportPptxResult, importPptx } from "./usecases/pptx.js";
import {
  type CreatePresentationInput,
  type CreatePresentationResult,
  createPresentation,
  type GetPresentationInput,
  getPresentation,
  type ListPresentationsInput,
  listPresentations,
  type Page,
  type PresentationSummary,
  type PresentationView,
  type PurgeResult,
  purgeExpiredTrash,
  purgePresentation,
  restorePresentation,
  type TrashResult,
  trashPresentation,
  type UpdatePresentationInput,
  type UpdateSlidesInput,
  updatePresentation,
  updateSlides,
} from "./usecases/presentations.js";
import {
  getRevision,
  listRevisions,
  pruneRevisions,
  type RevisionDetail,
  type RevisionInfo,
  restoreRevision,
} from "./usecases/revisions.js";

/** Everything the core needs, provided by the composition root (`apps/server`). */
export interface CoreDeps {
  store: UnitOfWork;
  blobs: BlobStore;
  clock: Clock;
  ids: IdGenerator;
  config?: CoreConfigInput;
  /** PowerPoint converter for `importPptx` (optional: without it, PowerPoint import is reported as unavailable). */
  convertPptx?: PptxConverter;
}

/**
 * The use cases. Every method takes the caller's {@link Principal} first, checks scopes and human-only rules,
 * and throws only `DomainError` (anything unexpected is wrapped as `INTERNAL`). `call` carries the IP and the
 * request id for the audit log and for `INTERNAL` errors.
 */
export interface Core {
  readonly config: Readonly<CoreConfig>;

  /** `decks:write`. Validates, sanitizes and stores revision 1. Idempotent with `idempotencyKey`. */
  createPresentation(
    p: Principal,
    input: CreatePresentationInput,
    call?: CallContext,
  ): Promise<CreatePresentationResult>;
  /** `decks:read`. Outline by default; `include` adds theme, slides (without notes) and notes. */
  getPresentation(
    p: Principal,
    input: GetPresentationInput,
    call?: CallContext,
  ): Promise<PresentationView>;
  /** `decks:read`. Newest first, cursor-paginated, title search. The trash (`trashed: true`) is owner only. */
  listPresentations(
    p: Principal,
    input?: ListPresentationsInput,
    call?: CallContext,
  ): Promise<Page<PresentationSummary>>;
  /** `decks:write`. Metadata, theme and slide order; needs `expectedRevision`. */
  updatePresentation(
    p: Principal,
    input: UpdatePresentationInput,
    call?: CallContext,
  ): Promise<RevisionWriteResult>;
  /** `decks:write`. Upserts (in order) then removals; needs `expectedRevision`. */
  updateSlides(
    p: Principal,
    input: UpdateSlidesInput,
    call?: CallContext,
  ): Promise<RevisionWriteResult>;
  /** `decks:write`. Moves to the trash (restorable by the owner for `trashRetentionMs`). */
  trashPresentation(
    p: Principal,
    input: { presentationId: string },
    call?: CallContext,
  ): Promise<TrashResult>;
  /** `decks:write` + owner. Restores from the trash. */
  restorePresentation(
    p: Principal,
    input: { presentationId: string },
    call?: CallContext,
  ): Promise<PresentationSummary>;
  /** `decks:write` + owner. Permanent deletion of a presentation in the trash. */
  purgePresentation(
    p: Principal,
    input: { presentationId: string },
    call?: CallContext,
  ): Promise<PurgeResult>;
  /** Owner or system. Purges presentations whose trash retention expired. */
  purgeExpiredTrash(
    p: Principal,
    input?: { limit?: number },
    call?: CallContext,
  ): Promise<{ purged: string[] }>;

  /** `decks:read`. Newest first. */
  listRevisions(
    p: Principal,
    input: { presentationId: string; limit?: number; cursor?: string },
    call?: CallContext,
  ): Promise<Page<RevisionInfo>>;
  /** `decks:read`. Full document of one revision (including notes). */
  getRevision(
    p: Principal,
    input: { presentationId: string; revision: number },
    call?: CallContext,
  ): Promise<RevisionDetail>;
  /** `decks:write` + owner. New revision copied from an old one. */
  restoreRevision(
    p: Principal,
    input: { presentationId: string; revision: number; expectedRevision: number },
    call?: CallContext,
  ): Promise<RevisionWriteResult>;
  /** Owner or system. Retention: keeps the newest N revisions (never the current one is deleted). */
  pruneRevisions(
    p: Principal,
    input?: { presentationId?: string; keep?: number },
    call?: CallContext,
  ): Promise<{ decks: number; revisionsDeleted: number }>;

  /** `decks:write`. Verifies the type by content, enforces limits, deduplicates by SHA-256. */
  addAsset(p: Principal, input: AddAssetInput, call?: CallContext): Promise<AddAssetResult>;
  /** `decks:read`. Metadata and bytes. */
  getAsset(
    p: Principal,
    input: { sha256?: string; ref?: string; presentationId?: string },
    call?: CallContext,
  ): Promise<{ asset: AssetInfo; content: Uint8Array }>;
  /** `decks:read`. Assets of a presentation. */
  listAssets(
    p: Principal,
    input: { presentationId: string },
    call?: CallContext,
  ): Promise<AssetInfo[]>;
  /** Owner or system. Deletes unreferenced blobs older than the grace period. */
  collectOrphanBlobs(
    p: Principal,
    input?: { graceMs?: number; dryRun?: boolean },
    call?: CallContext,
  ): Promise<{ scanned: number; deleted: string[] }>;

  /** Owner only (`decks:read`). The deck of a revision and its referenced assets' bytes. Audited. */
  exportPresentation(
    p: Principal,
    input: ExportPresentationInput,
    call?: CallContext,
  ): Promise<ExportPresentationResult>;
  /** Owner only (`decks:write`). Creates a new presentation from an exported deck and assets. */
  importPresentation(
    p: Principal,
    input: ImportPresentationInput,
    call?: CallContext,
  ): Promise<ImportPresentationResult>;
  /** Owner only (`decks:write`). Creates a new presentation from a PowerPoint file (needs `convertPptx`). */
  importPptx(p: Principal, input: ImportPptxInput, call?: CallContext): Promise<ImportPptxResult>;

  /** Owner only. Newest first. */
  listAuditLog(
    p: Principal,
    input?: { limit?: number; cursor?: string; target?: string },
    call?: CallContext,
  ): Promise<Page<AuditEntry>>;
}

export function createCore(deps: CoreDeps): Core {
  const ctx: Ctx = {
    store: deps.store,
    blobs: deps.blobs,
    clock: deps.clock,
    ids: deps.ids,
    config: resolveConfig(deps.config),
  };
  return {
    config: ctx.config,
    createPresentation: (p, i, c) => createPresentation(ctx, p, i, c),
    getPresentation: (p, i, c) => getPresentation(ctx, p, i, c),
    listPresentations: (p, i, c) => listPresentations(ctx, p, i, c),
    updatePresentation: (p, i, c) => updatePresentation(ctx, p, i, c),
    updateSlides: (p, i, c) => updateSlides(ctx, p, i, c),
    trashPresentation: (p, i, c) => trashPresentation(ctx, p, i, c),
    restorePresentation: (p, i, c) => restorePresentation(ctx, p, i, c),
    purgePresentation: (p, i, c) => purgePresentation(ctx, p, i, c),
    purgeExpiredTrash: (p, i, c) => purgeExpiredTrash(ctx, p, i, c),
    listRevisions: (p, i, c) => listRevisions(ctx, p, i, c),
    getRevision: (p, i, c) => getRevision(ctx, p, i, c),
    restoreRevision: (p, i, c) => restoreRevision(ctx, p, i, c),
    pruneRevisions: (p, i, c) => pruneRevisions(ctx, p, i, c),
    addAsset: (p, i, c) => addAsset(ctx, p, i, c),
    getAsset: (p, i, c) => getAsset(ctx, p, i, c),
    listAssets: (p, i, c) => listAssets(ctx, p, i, c),
    collectOrphanBlobs: (p, i, c) => collectOrphanBlobs(ctx, p, i, c),
    exportPresentation: (p, i, c) => exportPresentation(ctx, p, i, c),
    importPresentation: (p, i, c) => importPresentation(ctx, p, i, c),
    importPptx: (p, i, c) => importPptx(ctx, deps.convertPptx, p, i, c),
    listAuditLog: (p, i, c) =>
      runRead(c, async () => {
        requireOwner(p, "read the audit log");
        const input = requireObject(i ?? {});
        const limit = optionalLimit(input.limit, 50, 500);
        const before = decodeCursor(input.cursor, "a");
        if (before !== undefined && !isUlid(before)) {
          throw validationError("Invalid cursor", { path: "cursor" });
        }
        const rows = await ctx.store.audit.list(p.workspaceId, {
          limit: limit + 1,
          ...(before === undefined ? {} : { beforeId: before }),
          ...(typeof input.target === "string" ? { target: input.target } : {}),
        });
        const items = rows.slice(0, limit);
        const last = items[items.length - 1];
        return {
          items,
          nextCursor: rows.length > limit && last !== undefined ? encodeCursor("a", last.id) : null,
        };
      }),
  };
}
