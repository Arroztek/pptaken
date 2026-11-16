// SPDX-License-Identifier: AGPL-3.0-or-later
// Portability (phase F3): export a presentation as data (deck + asset bytes) and import one as a NEW presentation.
// Both are human-only (owner session) actions, never agent tools: an export can carry speaker notes out of the
// instance, and an import writes a whole deck at once. The core does no I/O and knows nothing about file formats:
// the server turns the export into an HTML file or a `.pkn` archive (`@pptaken/export`) and reads archives
// back into the plain input of `importPresentation`.
//
// Imported content is untrusted, whatever produced it: the deck is validated with `parseDeck`, sanitized again and
// validated again (exactly like `createPresentation`), and every asset is checked like `addAsset` (type by content
// signature, declared type, SHA-256, size and pixel limits, per-deck quotas).
import { type Deck, LIMITS } from "@pptaken/schema";
import {
  assetRefsOf,
  type CoreWarning,
  type CoreWarningCode,
  sanitizeAndCheck,
  validateDeck,
} from "../deck.js";
import { DomainError, internalError, limitExceeded, notFound, validationError } from "../errors.js";
import { normalizeMediaType, RASTER_MEDIA_TYPES, sniffImage } from "../media.js";
import type { AssetRecord } from "../ports.js";
import { type CallContext, type Principal, requireOwner, requireScope } from "../principal.js";
import { sha256Hex } from "../sha256.js";
import type { RevisionWriteResult } from "./commit.js";
import {
  actorRef,
  audit,
  type Ctx,
  loadLiveDeck,
  requireObject,
  requireRevision,
  requireString,
  runWrite,
} from "./context.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Warnings of export and import: the core's, plus the asset bookkeeping ones. */
export interface PortabilityWarning extends Omit<CoreWarning, "code"> {
  code: CoreWarningCode | "UNUSED_ASSET" | "MISSING_ASSET" | PptxWarningCode;
}

/** Warning codes of the PowerPoint converter (`@pptaken/import-pptx`), passed through by `importPptx`. */
export type PptxWarningCode =
  | "PPTX_FEATURE_DROPPED"
  | "PPTX_FEATURE_SIMPLIFIED"
  | "PPTX_IMAGE_DROPPED"
  | "PPTX_FONT_REPLACED"
  | "PPTX_CANVAS_ADJUSTED"
  | "PPTX_CONTENT_TRUNCATED";

export interface ExportPresentationInput {
  presentationId: string;
  /** Export an older revision instead of the current one. */
  revision?: number;
  /** Keep the speaker notes. Default `false`: callers opt in (the `.pkn` backup does, the HTML export not). */
  includeNotes?: boolean;
}

export interface ExportedAsset {
  sha256: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  bytes: Uint8Array;
}

export interface ExportPresentationResult {
  presentationId: string;
  revision: number;
  /** The stored (sanitized) deck of that revision; without notes unless `includeNotes`. */
  deck: Deck;
  includesNotes: boolean;
  /** The assets the deck references (linked to the presentation), each once. */
  assets: ExportedAsset[];
  warnings: PortabilityWarning[];
}

export interface ImportAssetInput {
  /** If given, must equal the SHA-256 of `bytes` (archives name assets by hash). */
  sha256?: string;
  /** Declared type; it must match the type detected from the content. */
  mediaType: string;
  bytes: Uint8Array;
}

export interface ImportPresentationInput {
  /** A `pptaken.deck` envelope. Untrusted. */
  deck: unknown;
  assets?: ImportAssetInput[];
  /** Replaces the deck's title. */
  title?: string;
}

export interface ImportPresentationResult extends Omit<RevisionWriteResult, "warnings"> {
  /** Assets stored and linked to the new presentation. */
  assetCount: number;
  warnings: PortabilityWarning[];
}

/** Text of a deck where `asset:` references can live. */
function assetTexts(deck: Deck): { text: string; path: string; slideId?: string }[] {
  const out: { text: string; path: string; slideId?: string }[] = [];
  if (deck.theme?.css) out.push({ text: deck.theme.css, path: "theme.css" });
  deck.slides.forEach((s, i) => {
    out.push({ text: s.html, path: `slides[${i}].html`, slideId: s.id });
    if (s.css !== undefined) out.push({ text: s.css, path: `slides[${i}].css`, slideId: s.id });
  });
  return out;
}

/** Resolves an `asset:<hex>` reference (full hash or a unique prefix, as the core accepts) to a hash. */
function resolveRef(ref: string, hashes: readonly string[]): string | null {
  if (ref.length === 64) return hashes.includes(ref) ? ref : null;
  const matches = hashes.filter((h) => h.startsWith(ref));
  return matches.length === 1 ? (matches[0] as string) : null;
}

function withoutNotes(deck: Deck): Deck {
  return { ...deck, slides: deck.slides.map(({ notes: _notes, ...slide }) => slide) };
}

/** Owner only (`decks:read`). Reads a revision and the bytes of the assets it references. Audited. */
export async function exportPresentation(
  ctx: Ctx,
  principal: Principal,
  rawInput: ExportPresentationInput,
  call?: CallContext,
): Promise<ExportPresentationResult> {
  const pid = (rawInput as { presentationId?: unknown } | null)?.presentationId;
  const target = typeof pid === "string" && pid.length <= 64 ? `deck:${pid}` : null;
  return runWrite(ctx, principal, call, "presentation.export", target, async () => {
    requireScope(principal, "decks:read");
    requireOwner(principal, "export a presentation");
    const input = requireObject(rawInput);
    const id = requireString(input.presentationId, "presentationId");
    if (input.includeNotes !== undefined && typeof input.includeNotes !== "boolean") {
      throw validationError("includeNotes must be true or false", { path: "includeNotes" });
    }
    const includeNotes = input.includeNotes === true;
    const ws = principal.workspaceId;
    const head = await loadLiveDeck(ctx.store, principal, id);
    const number =
      input.revision === undefined
        ? head.currentRevision
        : requireRevision(input.revision, "revision");
    const revision = await ctx.store.revisions.get(ws, id, number);
    if (revision === null) {
      throw notFound(`Revision ${number} does not exist`, {
        path: "revision",
        hint: "List the revisions to see the ones that are kept.",
      });
    }
    const deck = includeNotes ? revision.document : withoutNotes(revision.document);

    const linked = await ctx.store.assets.listForDeck(ws, id);
    const byHash = new Map(linked.map((a) => [a.sha256, a]));
    const hashes = [...byHash.keys()];
    const warnings: PortabilityWarning[] = [];
    const used = new Set<string>();
    for (const { text, path, slideId } of assetTexts(deck)) {
      for (const ref of new Set(assetRefsOf(text))) {
        const hash = resolveRef(ref, hashes);
        if (hash !== null) {
          used.add(hash);
          continue;
        }
        const warning: PortabilityWarning = {
          code: "UNKNOWN_ASSET_REF",
          message: `asset:${ref} is not an asset of this presentation; it will not display`,
          path,
        };
        if (slideId !== undefined) warning.slideId = slideId;
        warnings.push(warning);
      }
    }
    const assets: ExportedAsset[] = [];
    for (const hash of [...used].sort()) {
      const record = byHash.get(hash) as AssetRecord;
      const bytes = await ctx.blobs.get(hash);
      if (bytes === null) {
        warnings.push({
          code: "MISSING_ASSET",
          message: `The file of asset:${hash.slice(0, 16)}… is missing from storage; it is left out`,
        });
        continue;
      }
      assets.push({
        sha256: hash,
        mediaType: record.mediaType,
        width: record.width,
        height: record.height,
        bytes,
      });
    }
    await audit(ctx, ctx.store, principal, call, "presentation.export", `deck:${id}`, "ok", {
      revision: number,
      notes: includeNotes,
      assets: assets.length,
    });
    return {
      presentationId: id,
      revision: number,
      deck,
      includesNotes: includeNotes,
      assets,
      warnings,
    };
  });
}

interface VerifiedAsset {
  sha256: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  bytes: Uint8Array;
}

function unsupported(message: string, hint: string, path: string): DomainError {
  return new DomainError("UNSUPPORTED_MEDIA", message, {
    path,
    hint,
    details: { accepted: [...RASTER_MEDIA_TYPES] },
  });
}

/** The checks of `addAsset`, for one asset of an import. */
function verifyAsset(ctx: Ctx, raw: unknown, path: string): VerifiedAsset {
  const input = requireObject(raw);
  const bytes = input.bytes;
  if (!(bytes instanceof Uint8Array)) {
    throw validationError(`${path}.bytes must be binary content`, { path: `${path}.bytes` });
  }
  if (bytes.length === 0) throw validationError(`${path} is empty`, { path: `${path}.bytes` });
  const declared = normalizeMediaType(requireString(input.mediaType, `${path}.mediaType`, 255));
  const { maxAssetBytes, maxImagePixels } = ctx.config.limits;
  if (bytes.length > maxAssetBytes) {
    throw limitExceeded(`${path} is too large`, maxAssetBytes, bytes.length, {
      path: `${path}.bytes`,
      unit: "bytes",
      hint: `Images can be at most ${Math.floor(maxAssetBytes / 1024 / 1024)} MB.`,
    });
  }
  const sha256 = sha256Hex(bytes);
  if (input.sha256 !== undefined) {
    if (
      typeof input.sha256 !== "string" ||
      !SHA256_HEX.test(input.sha256) ||
      input.sha256 !== sha256
    ) {
      throw validationError(`${path}: the content does not match its SHA-256`, {
        path: `${path}.sha256`,
        hint: "The archive was modified or damaged. Export it again from the original instance.",
      });
    }
  }
  const sniff = sniffImage(bytes);
  if (!sniff.ok) {
    throw unsupported(
      sniff.kind === "svg"
        ? `${path} is an SVG file, which cannot be an asset`
        : sniff.kind === "malformed"
          ? `${path} looks like ${sniff.mediaType} but is not a valid file (${sniff.reason})`
          : `${path} is not a supported image`,
      "Assets must be PNG, JPEG, GIF, WebP or AVIF files.",
      `${path}.bytes`,
    );
  }
  if (declared !== sniff.mediaType) {
    throw unsupported(
      `${path}: declared type ${declared.slice(0, 60)} does not match the content (${sniff.mediaType})`,
      "The archive was modified or damaged. Export it again from the original instance.",
      `${path}.mediaType`,
    );
  }
  if (
    sniff.width !== null &&
    sniff.height !== null &&
    sniff.width * sniff.height > maxImagePixels
  ) {
    throw limitExceeded(`${path} has too many pixels`, maxImagePixels, sniff.width * sniff.height, {
      path: `${path}.bytes`,
      unit: "pixels",
    });
  }
  return { sha256, mediaType: sniff.mediaType, width: sniff.width, height: sniff.height, bytes };
}

/**
 * Owner only (`decks:write`). Creates a NEW presentation (revision 1) from an exported deck and its assets; it never
 * overwrites anything. Validates, re-sanitizes and re-validates the deck, verifies every asset, keeps only the
 * assets the deck references (`UNUSED_ASSET` warnings for the others; references without a file keep the core's
 * `UNKNOWN_ASSET_REF`), enforces every limit and audits. All or nothing: rows are written in one transaction.
 */
export async function importPresentation(
  ctx: Ctx,
  principal: Principal,
  rawInput: ImportPresentationInput,
  call?: CallContext,
): Promise<ImportPresentationResult> {
  return runWrite(ctx, principal, call, "presentation.import", null, async () => {
    requireScope(principal, "decks:write");
    requireOwner(principal, "import a presentation");
    const input = requireObject(rawInput);
    return storeImported(ctx, principal, call, input, {
      action: "presentation.import",
      summary: "Imported",
      warnings: [],
      detail: {},
    });
  });
}

/** How {@link storeImported} records an import. */
export interface ImportRecord {
  action: string;
  /** Start of the revision summary ("Imported", "Imported from PowerPoint"). */
  summary: string;
  /** Warnings of an earlier stage (a converter), listed before the core's. */
  warnings: PortabilityWarning[];
  /** Extra audit facts (small, JSON-safe, never content). */
  detail: Record<string, unknown>;
}

/**
 * The shared second half of every import: validates, re-sanitizes and re-validates the deck, verifies the assets,
 * enforces the limits and writes a new presentation in one transaction. The caller has checked the principal.
 */
export async function storeImported(
  ctx: Ctx,
  principal: Principal,
  call: CallContext | undefined,
  input: Record<string, unknown>,
  record: ImportRecord,
): Promise<ImportPresentationResult> {
  const limits = ctx.config.limits;

  let deckInput = input.deck;
  if (input.title !== undefined) {
    const title = requireString(input.title, "title", LIMITS.maxTitleLength);
    if (typeof deckInput === "object" && deckInput !== null && !Array.isArray(deckInput)) {
      deckInput = { ...(deckInput as Record<string, unknown>), title };
    }
  }
  const parsed = validateDeck(deckInput, limits.maxSlides, "deck.");

  const rawAssets = input.assets ?? [];
  if (!Array.isArray(rawAssets))
    throw validationError("assets must be an array", { path: "assets" });
  if (rawAssets.length > limits.maxAssetsPerDeck) {
    throw limitExceeded("Too many assets", limits.maxAssetsPerDeck, rawAssets.length, {
      path: "assets",
      hint: `A presentation can have at most ${limits.maxAssetsPerDeck} assets.`,
    });
  }
  const verified = new Map<string, VerifiedAsset>();
  rawAssets.forEach((raw, i) => {
    const asset = verifyAsset(ctx, raw, `assets[${i}]`);
    verified.set(asset.sha256, asset);
  });
  const hashes = [...verified.keys()];

  // Re-sanitize exactly like a new presentation; UNKNOWN_ASSET_REF flags references without a file.
  const { deck, warnings: coreWarnings } = sanitizeAndCheck(parsed, limits.maxSlides, hashes);
  const warnings: PortabilityWarning[] = [...record.warnings, ...coreWarnings];
  const used = new Set<string>();
  for (const { text } of assetTexts(deck)) {
    for (const ref of assetRefsOf(text)) {
      const hash = resolveRef(ref, hashes);
      if (hash !== null) used.add(hash);
    }
  }
  for (const hash of hashes) {
    if (!used.has(hash)) {
      warnings.push({
        code: "UNUSED_ASSET",
        message: `asset:${hash.slice(0, 16)}… is not used by any slide; it was not imported`,
      });
    }
  }
  const kept = [...used].sort().map((h) => verified.get(h) as VerifiedAsset);
  const total = kept.reduce((n, a) => n + a.bytes.length, 0);
  if (total > limits.maxAssetBytesPerDeck) {
    throw limitExceeded("Total asset size", limits.maxAssetBytesPerDeck, total, {
      path: "assets",
      unit: "bytes",
      hint: "Compress the images (WebP or AVIF are much smaller) before exporting again.",
    });
  }

  // Blobs first (content-addressed, idempotent); the orphan collector removes them if the transaction fails.
  for (const asset of kept) {
    const stored = await ctx.blobs.put(asset.bytes, { maxBytes: limits.maxAssetBytes });
    if (stored.sha256 !== asset.sha256) {
      throw internalError(new Error("BlobStore returned a different hash"), call?.requestId);
    }
  }

  const ws = principal.workspaceId;
  return ctx.store.transaction(async (tx) => {
    const now = ctx.clock.now();
    const id = ctx.ids.ulid();
    await tx.decks.insert({
      workspaceId: ws,
      id,
      title: deck.title,
      lang: deck.lang ?? null,
      currentRevision: 1,
      slideCount: deck.slides.length,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      createdBy: actorRef(principal),
    });
    await tx.revisions.insert({
      workspaceId: ws,
      deckId: id,
      number: 1,
      document: deck,
      title: deck.title,
      slideCount: deck.slides.length,
      summary: `${record.summary} with ${deck.slides.length} slide(s)`,
      createdAt: now,
      createdBy: actorRef(principal),
    });
    for (const asset of kept) {
      await tx.assets.insertIfAbsent({
        workspaceId: ws,
        sha256: asset.sha256,
        mediaType: asset.mediaType,
        bytes: asset.bytes.length,
        width: asset.width,
        height: asset.height,
        createdAt: now,
      });
      await tx.assets.link(ws, id, asset.sha256, now);
    }
    await audit(ctx, tx, principal, call, record.action, `deck:${id}`, "ok", {
      revision: 1,
      slides: deck.slides.length,
      assets: kept.length,
      ...record.detail,
    });
    return {
      presentationId: id,
      revision: 1,
      slideCount: deck.slides.length,
      assetCount: kept.length,
      warnings,
    };
  });
}
