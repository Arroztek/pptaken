// SPDX-License-Identifier: AGPL-3.0-or-later
// Assets: images uploaded for a presentation, verified by content signature and stored by SHA-256.
import { DomainError, internalError, limitExceeded, notFound, validationError } from "../errors.js";
import { normalizeMediaType, RASTER_MEDIA_TYPES, sniffImage } from "../media.js";
import type { AssetRecord, Repositories } from "../ports.js";
import {
  type CallContext,
  type Principal,
  requireOwnerOrSystem,
  requireScope,
} from "../principal.js";
import { sha256Hex } from "../sha256.js";
import { checkVendored, isVendorError } from "../vendor.js";
import {
  audit,
  type Ctx,
  loadLiveDeck,
  requireObject,
  requireString,
  runRead,
  runWrite,
} from "./context.js";

export interface AddAssetInput {
  presentationId: string;
  /** Raw file content (already base64-decoded or downloaded by the caller). */
  bytes: Uint8Array;
  /** Declared media type. Never trusted: it must match the type detected from the content. */
  mediaType: string;
  /** Informational only (never used to decide the type). */
  filename?: string;
}

export interface AssetInfo {
  /** Reference to use in slide HTML/CSS: `asset:<sha256>`. */
  ref: string;
  sha256: string;
  mediaType: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface AddAssetResult extends AssetInfo {
  /** True when identical content was already stored (nothing new was written). */
  deduplicated: boolean;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ACCEPTED = RASTER_MEDIA_TYPES.join(", ");

function infoOf(a: AssetRecord): AssetInfo {
  return {
    ref: `asset:${a.sha256}`,
    sha256: a.sha256,
    mediaType: a.mediaType,
    bytes: a.bytes,
    width: a.width,
    height: a.height,
  };
}

function unsupported(message: string, hint: string, path = "bytes"): DomainError {
  return new DomainError("UNSUPPORTED_MEDIA", message, {
    path,
    hint,
    details: { accepted: [...RASTER_MEDIA_TYPES] },
  });
}

async function checkDeckQuota(
  ctx: Ctx,
  repos: Repositories,
  ws: string,
  deckId: string,
  size: number,
): Promise<void> {
  const stats = await repos.assets.statsForDeck(ws, deckId);
  const { maxAssetsPerDeck, maxAssetBytesPerDeck } = ctx.config.limits;
  if (stats.count + 1 > maxAssetsPerDeck) {
    throw limitExceeded("Too many assets in this presentation", maxAssetsPerDeck, stats.count + 1, {
      path: "presentationId",
      hint: `A presentation can have at most ${maxAssetsPerDeck} assets. Reuse existing images (call \`get_presentation\`) instead of uploading new ones.`,
    });
  }
  if (stats.bytes + size > maxAssetBytesPerDeck) {
    throw limitExceeded(
      "Total asset size of this presentation",
      maxAssetBytesPerDeck,
      stats.bytes + size,
      {
        path: "bytes",
        unit: "bytes",
        hint: "Compress the images (WebP or AVIF are much smaller) or reuse existing ones.",
      },
    );
  }
}

export async function addAsset(
  ctx: Ctx,
  principal: Principal,
  rawInput: AddAssetInput,
  call?: CallContext,
): Promise<AddAssetResult> {
  const pid = (rawInput as { presentationId?: unknown } | null)?.presentationId;
  const target = typeof pid === "string" && pid.length <= 64 ? `deck:${pid}` : null;
  return runWrite(ctx, principal, call, "asset.add", target, async () => {
    requireScope(principal, "decks:write");
    const input = requireObject(rawInput) as unknown as AddAssetInput;
    const id = requireString(input.presentationId, "presentationId");
    const declared = normalizeMediaType(requireString(input.mediaType, "mediaType", 255));
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array)) {
      throw validationError("bytes must be binary content", { path: "bytes" });
    }
    if (bytes.length === 0) throw validationError("The file is empty", { path: "bytes" });
    const { maxAssetBytes, maxImagePixels } = ctx.config.limits;
    if (bytes.length > maxAssetBytes) {
      throw limitExceeded("Asset too large", maxAssetBytes, bytes.length, {
        path: "bytes",
        unit: "bytes",
        hint: `Images can be at most ${Math.floor(maxAssetBytes / 1024 / 1024)} MB. Resize or compress it (WebP or AVIF).`,
      });
    }

    const sniff = sniffImage(bytes);
    if (!sniff.ok) {
      if (sniff.kind === "svg") {
        throw unsupported(
          "SVG files cannot be uploaded as assets in this version",
          "Put the SVG markup inline in the slide `html` (it is sanitized there), or upload a PNG or WebP.",
        );
      }
      if (sniff.kind === "malformed") {
        throw unsupported(
          `The content looks like ${sniff.mediaType} but is not a valid file (${sniff.reason})`,
          "Upload the complete, unmodified image file.",
        );
      }
      throw unsupported(
        "The content is not a supported image",
        `Accepted types: ${ACCEPTED}. The type is detected from the content, not from the name or media_type.`,
      );
    }
    if (declared !== sniff.mediaType) {
      throw unsupported(
        `Declared media type ${declared.slice(0, 60)} does not match the content (${sniff.mediaType})`,
        `Send media_type "${sniff.mediaType}" for this file.`,
        "mediaType",
      );
    }
    if (
      sniff.width !== null &&
      sniff.height !== null &&
      sniff.width * sniff.height > maxImagePixels
    ) {
      throw limitExceeded("Image has too many pixels", maxImagePixels, sniff.width * sniff.height, {
        path: "bytes",
        unit: "pixels",
        hint: "Resize the image; slides are 1920×1080, so larger images bring no benefit.",
      });
    }

    const ws = principal.workspaceId;
    const sha256 = sha256Hex(bytes);
    await loadLiveDeck(ctx.store, principal, id);
    const existing = await ctx.store.assets.get(ws, sha256);
    if (existing !== null && (await ctx.store.assets.isLinked(ws, id, sha256))) {
      return { ...infoOf(existing), deduplicated: true };
    }
    await checkDeckQuota(ctx, ctx.store, ws, id, bytes.length);

    const stored = await ctx.blobs.put(bytes, { maxBytes: maxAssetBytes });
    if (stored.sha256 !== sha256) {
      throw internalError(new Error("BlobStore returned a different hash"), call?.requestId);
    }

    return ctx.store.transaction(async (tx) => {
      await loadLiveDeck(tx, principal, id);
      const now = ctx.clock.now();
      const record: AssetRecord = {
        workspaceId: ws,
        sha256,
        mediaType: sniff.mediaType,
        bytes: bytes.length,
        width: sniff.width,
        height: sniff.height,
        createdAt: now,
      };
      const inserted = await tx.assets.insertIfAbsent(record);
      const asset = inserted ? record : ((await tx.assets.get(ws, sha256)) ?? record);
      if (!(await tx.assets.isLinked(ws, id, sha256))) {
        await checkDeckQuota(ctx, tx, ws, id, bytes.length);
        await tx.assets.link(ws, id, sha256, now);
      }
      await audit(ctx, tx, principal, call, "asset.add", `deck:${id}`, "ok", {
        sha256,
        bytes: bytes.length,
      });
      return { ...infoOf(asset), deduplicated: !inserted };
    });
  });
}

/**
 * `decks:write`. Downloads an image once through the vendoring fetcher (ADR-022: SSRF-safe, size and type
 * checked by content) and stores it like {@link addAsset}. Viewers only ever load the stored copy.
 */
export async function addAssetFromUrl(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string; url: string; filename?: string },
  call?: CallContext,
): Promise<AddAssetResult> {
  requireScope(principal, "decks:write");
  const input = requireObject(rawInput);
  const id = requireString(input.presentationId, "presentationId");
  const url = requireString(input.url, "url", 2048);
  const vendor = ctx.vendor;
  if (vendor === undefined || !vendor.enabled) {
    throw new DomainError("FETCH_BLOCKED", "This instance does not download external resources", {
      path: "url",
      hint: "Upload the image as base64 instead: source { base64, media_type }.",
    });
  }
  if (!/^https:\/\//i.test(url)) {
    throw new DomainError("FETCH_BLOCKED", "Only https URLs are downloaded", {
      path: "url",
      hint: "Use an https URL, or upload the image as base64.",
    });
  }
  await loadLiveDeck(ctx.store, principal, id);
  let fetched: Awaited<ReturnType<typeof vendor.fetch>>;
  try {
    fetched = await vendor.fetch({
      url,
      kind: "image",
      deckId: id,
      actor: { actor: principal.actor, tokenId: principal.tokenId ?? null },
      deadline: ctx.clock.now() + ctx.config.vendor.deadlineMs,
    });
  } catch (error) {
    const code = isVendorError(error) ? error.code : "fetch-failed";
    await audit(ctx, ctx.store, principal, call, "vendor.fetch", `deck:${id}`, "error", {
      kind: "image",
      code,
    });
    const blocked = ["blocked-address", "not-allowed-host", "disabled", "rate-limited"].includes(
      code,
    );
    throw new DomainError(
      code === "rate-limited" ? "RATE_LIMITED" : blocked ? "FETCH_BLOCKED" : "FETCH_FAILED",
      `The image could not be downloaded (${code})${isVendorError(error) ? `: ${error.message}` : ""}`,
      {
        path: "url",
        hint: "Use a public https URL of a PNG, JPEG, GIF, WebP or AVIF image, or upload it as base64.",
        retryable: code === "timeout" || code === "rate-limited" || code === "fetch-failed",
      },
    );
  }
  let mediaType: string;
  try {
    mediaType = checkVendored("image", fetched.bytes, ctx.config.limits.maxImagePixels).mediaType;
  } catch (error) {
    throw unsupported(
      isVendorError(error) ? error.message : "The content is not a supported image",
      `Accepted types: ${ACCEPTED}. The type is detected from the content.`,
      "url",
    );
  }
  await audit(ctx, ctx.store, principal, call, "vendor.fetch", `deck:${id}`, "ok", {
    kind: "image",
    bytes: fetched.bytes.length,
    sha256: sha256Hex(fetched.bytes),
  });
  return addAsset(
    ctx,
    principal,
    {
      presentationId: id,
      bytes: fetched.bytes,
      mediaType,
      ...(typeof input.filename === "string" ? { filename: input.filename } : {}),
    },
    call,
  );
}

function parseAssetKey(input: Record<string, unknown>): string {
  const raw =
    input.sha256 ?? (typeof input.ref === "string" ? input.ref.replace(/^asset:/, "") : undefined);
  if (typeof raw !== "string" || !SHA256_HEX.test(raw)) {
    throw validationError("Expected `sha256` (64 lowercase hex) or `ref` (`asset:<sha256>`)", {
      path: input.sha256 === undefined ? "ref" : "sha256",
    });
  }
  return raw;
}

/** Reads an asset's metadata and bytes. With `presentationId`, the asset must belong to that presentation. */
export async function getAsset(
  ctx: Ctx,
  principal: Principal,
  rawInput: { sha256?: string; ref?: string; presentationId?: string },
  call?: CallContext,
): Promise<{ asset: AssetInfo; content: Uint8Array }> {
  return runRead(call, async () => {
    requireScope(principal, "decks:read");
    const input = requireObject(rawInput);
    const sha256 = parseAssetKey(input);
    const ws = principal.workspaceId;
    const missing = () =>
      notFound(`Asset ${sha256.slice(0, 16)}… does not exist`, {
        path: input.sha256 === undefined ? "ref" : "sha256",
        hint: "Upload the image with `add_asset` and use the `ref` it returns.",
      });
    if (input.presentationId !== undefined) {
      const id = requireString(input.presentationId, "presentationId");
      await loadLiveDeck(ctx.store, principal, id);
      if (!(await ctx.store.assets.isLinked(ws, id, sha256))) throw missing();
    }
    const asset = await ctx.store.assets.get(ws, sha256);
    if (asset === null) throw missing();
    const content = await ctx.blobs.get(sha256);
    if (content === null) throw missing();
    return { asset: infoOf(asset), content };
  });
}

export async function listAssets(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string },
  call?: CallContext,
): Promise<AssetInfo[]> {
  return runRead(call, async () => {
    requireScope(principal, "decks:read");
    const id = requireString(requireObject(rawInput).presentationId, "presentationId");
    await loadLiveDeck(ctx.store, principal, id);
    return (await ctx.store.assets.listForDeck(principal.workspaceId, id)).map(infoOf);
  });
}

/**
 * Owner or system job (instance-wide: blobs are shared by every workspace). Deletes blobs that no asset row
 * references and that are older than `graceMs` (default 1 hour, so uploads in flight are never collected).
 */
export async function collectOrphanBlobs(
  ctx: Ctx,
  principal: Principal,
  rawInput: { graceMs?: number; dryRun?: boolean } = {},
  call?: CallContext,
): Promise<{ scanned: number; deleted: string[] }> {
  return runWrite(ctx, principal, call, "maintenance.collect_orphan_blobs", null, async () => {
    requireOwnerOrSystem(principal, "collect orphan blobs");
    const input = requireObject(rawInput);
    const grace = input.graceMs ?? 60 * 60 * 1000;
    if (!Number.isSafeInteger(grace) || (grace as number) < 0) {
      throw validationError("graceMs must be a non-negative integer", { path: "graceMs" });
    }
    const cutoff = ctx.clock.now() - (grace as number);
    const candidates: string[] = [];
    let scanned = 0;
    for await (const blob of ctx.blobs.list()) {
      scanned++;
      if (blob.createdAt > cutoff) continue;
      if (!(await ctx.store.assets.isReferencedAnywhere(blob.sha256))) candidates.push(blob.sha256);
    }
    const deleted: string[] = [];
    if (input.dryRun !== true) {
      for (const sha of candidates) {
        // Re-check right before deleting: an upload may have linked it meanwhile.
        if (await ctx.store.assets.isReferencedAnywhere(sha)) continue;
        if (await ctx.blobs.delete(sha)) deleted.push(sha);
      }
      if (deleted.length > 0) {
        await audit(ctx, ctx.store, principal, call, "blob.collect", null, "ok", {
          deleted: deleted.length,
        });
      }
    } else {
      deleted.push(...candidates);
    }
    return { scanned, deleted };
  });
}
