// SPDX-License-Identifier: AGPL-3.0-or-later
// The `.pkn` archive: a ZIP with `manifest.json`, `deck.json` (the stored, sanitized `pptaken.deck`
// envelope) and `assets/<sha256>` (raw asset bytes, named by their SHA-256). Used to back up a presentation or to
// move it between instances. The reader only checks the container (structure, sizes, hashes); the deck and the
// assets are still untrusted and must go through the core's import (validation, sanitizing, type sniffing).

import { createHash } from "node:crypto";
import type { Deck } from "@pptaken/schema";
import { exportFilenames } from "./filename.js";
import { printable } from "./text.js";
import { readZip, writeZip, ZipError, type ZipErrorCode } from "./zip.js";

export const ARCHIVE_FORMAT = "pptaken.archive";
export const ARCHIVE_FORMAT_VERSION = 1;
export const ARCHIVE_EXTENSION = ".pkn";
/** Media type of the archive on the wire (it is a plain ZIP). */
export const ARCHIVE_MEDIA_TYPE = "application/zip";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,80}$/;
const ASSET_ENTRY = /^assets\/([0-9a-f]{64})$/;

export interface ArchiveAsset {
  sha256: string;
  mediaType: string;
  bytes: Uint8Array;
  width?: number | null;
  height?: number | null;
}

export interface ArchiveManifestAsset {
  sha256: string;
  mediaType: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: number;
  /** ISO-8601 UTC timestamp. */
  exportedAt: string;
  /** `pptaken <version>`. */
  generator: string;
  deck: { title: string; lang: string | null };
  /** Whether speaker notes were kept in `deck.json`. */
  notes: boolean;
  assets: ArchiveManifestAsset[];
}

export type ArchiveErrorCode =
  | ZipErrorCode
  | "BAD_MANIFEST"
  | "UNSUPPORTED_VERSION"
  | "MISSING_ENTRY"
  | "HASH_MISMATCH"
  | "BAD_DECK";

/** The archive was refused. `message` is English, safe to show and never echoes raw bytes. */
export class ArchiveError extends Error {
  override readonly name = "ArchiveError";
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ArchiveLimits {
  /** Size of the archive file itself. */
  maxArchiveBytes: number;
  /** Assets in one archive. */
  maxAssets: number;
  /** Bytes of one asset. */
  maxAssetBytes: number;
  /** Sum of every uncompressed entry. */
  maxTotalBytes: number;
  /** Bytes of `deck.json` once uncompressed. */
  maxDeckJsonBytes: number;
  /** Maximum compression ratio of a deflated entry larger than 64 KiB. */
  maxRatio: number;
}

/** 100 MB archives and content, 10 MB and 200 assets (the core's per-deck defaults), ratio 200:1. */
export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxArchiveBytes: 100 * 1024 * 1024,
  maxAssets: 200,
  maxAssetBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxDeckJsonBytes: 80 * 1024 * 1024,
  maxRatio: 200,
});

const MAX_MANIFEST_BYTES = 1024 * 1024;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function withoutNotes(deck: Deck): Deck {
  return { ...deck, slides: deck.slides.map(({ notes: _notes, ...slide }) => slide) };
}

export interface WriteArchiveInput {
  /** The stored (sanitized) deck envelope. */
  deck: Deck;
  /** The assets to ship; their hash is verified. Duplicates are written once. */
  assets: readonly ArchiveAsset[];
  /** Keep the speaker notes in `deck.json`. Default `true` (the archive is the owner's own backup). */
  includeNotes?: boolean;
  /** For example `pptaken 0.2.0`. */
  generator: string;
  exportedAt?: Date;
}

export interface WrittenArchive {
  bytes: Uint8Array;
  /** ASCII file name (`<slug>.pkn`). */
  filename: string;
  manifest: ArchiveManifest;
}

/** Writes a `.pkn` archive. Throws a `TypeError` when an asset's bytes do not match its `sha256`. */
export function writeArchive(input: WriteArchiveInput): WrittenArchive {
  const includeNotes = input.includeNotes !== false;
  const deck = includeNotes ? input.deck : withoutNotes(input.deck);
  const exportedAt = input.exportedAt ?? new Date();
  const unique = new Map<string, ArchiveAsset>();
  for (const asset of input.assets) {
    if (!SHA256_HEX.test(asset.sha256) || sha256Hex(asset.bytes) !== asset.sha256) {
      throw new TypeError(`asset ${printable(asset.sha256, 20)} does not match its SHA-256`);
    }
    if (!MEDIA_TYPE.test(asset.mediaType)) throw new TypeError("invalid asset media type");
    unique.set(asset.sha256, asset);
  }
  const assets = [...unique.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportedAt: exportedAt.toISOString(),
    generator: input.generator,
    deck: { title: deck.title, lang: deck.lang ?? null },
    notes: includeNotes,
    assets: assets.map((a) => {
      const item: ArchiveManifestAsset = {
        sha256: a.sha256,
        mediaType: a.mediaType,
        bytes: a.bytes.length,
      };
      if (typeof a.width === "number") item.width = a.width;
      if (typeof a.height === "number") item.height = a.height;
      return item;
    }),
  };
  const encoder = new TextEncoder();
  const bytes = writeZip(
    [
      {
        name: "manifest.json",
        data: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
        compress: true,
      },
      {
        name: "deck.json",
        data: encoder.encode(`${JSON.stringify(deck, null, 2)}\n`),
        compress: true,
      },
      ...assets.map((a) => ({ name: `assets/${a.sha256}`, data: a.bytes, compress: false })),
    ],
    { date: exportedAt },
  );
  return { bytes, filename: exportFilenames(deck.title, ARCHIVE_EXTENSION).ascii, manifest };
}

// ---------------------------------------------------------------------------------------------------------------
// Reader

export interface ReadArchive {
  manifest: ArchiveManifest;
  /** Parsed `deck.json`. Untrusted: validate and sanitize it (the core's `importPresentation` does). */
  deck: unknown;
  /** Asset bytes, hash-verified. The media type is the declared one: verify it by content. */
  assets: ArchiveAsset[];
}

type Json = Record<string, unknown>;

function bad(message: string): ArchiveError {
  return new ArchiveError("BAD_MANIFEST", `manifest.json: ${message}`);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalDimension(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
    throw bad(`${path} must be a positive integer`);
  }
  return value as number;
}

function parseJson(data: Uint8Array, what: string, code: ArchiveErrorCode): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new ArchiveError(code, `${what} is not valid UTF-8`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    throw new ArchiveError(code, `${what} is not valid JSON`);
  }
}

/**
 * Validates the manifest. Unknown keys are ignored (a later generator of format version 1 may add informational
 * fields); every known key must have the documented type.
 */
export function parseManifest(value: unknown, maxAssets: number): ArchiveManifest {
  if (!isObject(value)) throw bad("must be a JSON object");
  if (value.format !== ARCHIVE_FORMAT) {
    throw bad(`format must be "${ARCHIVE_FORMAT}" (this is not a PPTaken archive)`);
  }
  const version = value.formatVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw bad("formatVersion must be a positive integer");
  }
  if (version !== ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveError(
      "UNSUPPORTED_VERSION",
      `This archive uses format version ${version}; this PPTaken reads version ${ARCHIVE_FORMAT_VERSION}. Update PPTaken to import it.`,
    );
  }
  if (typeof value.exportedAt !== "string" || value.exportedAt.length > 64) {
    throw bad("exportedAt must be a string");
  }
  if (typeof value.generator !== "string" || value.generator.length > 200) {
    throw bad("generator must be a string of at most 200 characters");
  }
  const deck = value.deck;
  if (!isObject(deck) || typeof deck.title !== "string" || deck.title.length > 200) {
    throw bad("deck.title must be a string");
  }
  if (deck.lang !== null && deck.lang !== undefined && typeof deck.lang !== "string") {
    throw bad("deck.lang must be a string or null");
  }
  if (typeof value.notes !== "boolean") throw bad("notes must be true or false");
  if (!Array.isArray(value.assets)) throw bad("assets must be an array");
  if (value.assets.length > maxAssets) {
    throw new ArchiveError(
      "TOO_MANY_ENTRIES",
      `The archive has ${value.assets.length} assets; the limit is ${maxAssets}`,
    );
  }
  const seen = new Set<string>();
  const assets = value.assets.map((raw, i): ArchiveManifestAsset => {
    const path = `assets[${i}]`;
    if (!isObject(raw)) throw bad(`${path} must be an object`);
    if (typeof raw.sha256 !== "string" || !SHA256_HEX.test(raw.sha256)) {
      throw bad(`${path}.sha256 must be 64 lowercase hex characters`);
    }
    if (seen.has(raw.sha256)) throw bad(`${path}.sha256 is listed twice`);
    seen.add(raw.sha256);
    if (typeof raw.mediaType !== "string" || !MEDIA_TYPE.test(raw.mediaType)) {
      throw bad(`${path}.mediaType must be a media type such as image/png`);
    }
    if (!Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0) {
      throw bad(`${path}.bytes must be a non-negative integer`);
    }
    const item: ArchiveManifestAsset = {
      sha256: raw.sha256,
      mediaType: raw.mediaType,
      bytes: raw.bytes as number,
    };
    const width = optionalDimension(raw.width, `${path}.width`);
    const height = optionalDimension(raw.height, `${path}.height`);
    if (width !== undefined) item.width = width;
    if (height !== undefined) item.height = height;
    return item;
  });
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: version,
    exportedAt: value.exportedAt,
    generator: value.generator,
    deck: { title: deck.title, lang: typeof deck.lang === "string" ? deck.lang : null },
    notes: value.notes,
    assets,
  };
}

function acceptName(name: string): boolean {
  return (
    name === "manifest.json" || name === "deck.json" || name === "assets/" || ASSET_ENTRY.test(name)
  );
}

/**
 * Reads and checks a `.pkn` archive: ZIP safety (see `readZip`), the allow-listed layout, the manifest, that
 * every listed asset is present with the declared size and SHA-256 (and nothing else is), and that `deck.json`
 * is JSON. Throws {@link ArchiveError}.
 */
export function readArchive(bytes: Uint8Array, limits: Partial<ArchiveLimits> = {}): ReadArchive {
  const l: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
  if (bytes.length > l.maxArchiveBytes) {
    throw new ArchiveError(
      "TOO_LARGE",
      `The archive is ${bytes.length} bytes; the limit is ${l.maxArchiveBytes}`,
    );
  }
  let entries: ReturnType<typeof readZip>;
  try {
    entries = readZip(bytes, {
      maxEntries: l.maxAssets + 3,
      maxTotalBytes: l.maxTotalBytes,
      maxRatio: l.maxRatio,
      acceptName,
      maxEntryBytes: (name) =>
        name === "manifest.json"
          ? MAX_MANIFEST_BYTES
          : name === "deck.json"
            ? l.maxDeckJsonBytes
            : l.maxAssetBytes,
    });
  } catch (error) {
    if (error instanceof ZipError) throw new ArchiveError(error.code, error.message);
    throw error;
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const manifestBytes = byName.get("manifest.json");
  if (manifestBytes === undefined) {
    throw new ArchiveError(
      "MISSING_ENTRY",
      "manifest.json is missing (this is not a PPTaken archive)",
    );
  }
  const manifest = parseManifest(
    parseJson(manifestBytes, "manifest.json", "BAD_MANIFEST"),
    l.maxAssets,
  );
  const deckBytes = byName.get("deck.json");
  if (deckBytes === undefined) throw new ArchiveError("MISSING_ENTRY", "deck.json is missing");
  const deck = parseJson(deckBytes, "deck.json", "BAD_DECK");
  if (!isObject(deck)) throw new ArchiveError("BAD_DECK", "deck.json must be a JSON object");

  const listed = new Set(manifest.assets.map((a) => a.sha256));
  for (const name of byName.keys()) {
    const m = ASSET_ENTRY.exec(name);
    if (m !== null && !listed.has(m[1] as string)) {
      throw new ArchiveError(
        "UNEXPECTED_ENTRY",
        `${name} is not listed in manifest.json (the archive was modified)`,
      );
    }
  }
  const assets = manifest.assets.map((item): ArchiveAsset => {
    const data = byName.get(`assets/${item.sha256}`);
    if (data === undefined) {
      throw new ArchiveError("MISSING_ENTRY", `assets/${item.sha256} is listed but missing`);
    }
    if (data.length !== item.bytes || sha256Hex(data) !== item.sha256) {
      throw new ArchiveError(
        "HASH_MISMATCH",
        `assets/${item.sha256.slice(0, 16)}... does not match its name (the archive was modified or damaged)`,
      );
    }
    const asset: ArchiveAsset = { sha256: item.sha256, mediaType: item.mediaType, bytes: data };
    if (item.width !== undefined) asset.width = item.width;
    if (item.height !== undefined) asset.height = item.height;
    return asset;
  });
  return { manifest, deck, assets };
}
