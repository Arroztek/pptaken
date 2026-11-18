// SPDX-License-Identifier: AGPL-3.0-or-later
import { LIMITS } from "@pptaken/schema";

/** Configurable limits (`docs/foundation/02-architecture.md` §10). Format limits live in `@pptaken/schema`. */
export interface CoreLimits {
  /** Slides per presentation; cannot exceed the format's hard limit (200). */
  maxSlides: number;
  /** Bytes per asset (default 10 MB). */
  maxAssetBytes: number;
  /** Assets linked to one presentation (default 200). */
  maxAssetsPerDeck: number;
  /** Total bytes of the assets linked to one presentation (default 100 MB). */
  maxAssetBytesPerDeck: number;
  /** Width × height of a raster image (default 64 megapixels), a guard against decompression bombs. */
  maxImagePixels: number;
}

/** Limits of ingest-time vendoring per write (ADR-022). The fetcher adds its own per-request limits. */
export interface VendorLimits {
  /** Distinct external URLs one write may vendor, nested stylesheets and font files included (default 100). */
  maxUrls: number;
  /** Bytes one write may fetch in total (default 40 MB). */
  maxBytes: number;
  /** Deadline for all the fetches of one write (default 60 s). */
  deadlineMs: number;
  /** Fetches in flight at once for one write (default 4). */
  concurrency: number;
  /** Nesting of `@import` followed (default 3). */
  maxImportDepth: number;
}

export interface CoreConfig {
  limits: CoreLimits;
  vendor: VendorLimits;
  /** Revisions kept per presentation by `pruneRevisions` (default 50). */
  revisionsKept: number;
  /** How long a presentation stays restorable in the trash (default 30 days). */
  trashRetentionMs: number;
  /** Language applied when `createPresentation` gets none (default: none). */
  defaultLang?: string;
  /**
   * Interactive mode (ADR-020): the operator enabled author scripts for the instance (`PPTAKEN_SCRIPTS=owner`).
   * Default false: scripts are stored but never approved or run.
   */
  scriptsEnabled: boolean;
}

export const DEFAULT_LIMITS: Readonly<CoreLimits> = Object.freeze({
  maxSlides: LIMITS.maxSlides,
  maxAssetBytes: 10 * 1024 * 1024,
  maxAssetsPerDeck: 200,
  maxAssetBytesPerDeck: 100 * 1024 * 1024,
  maxImagePixels: 64 * 1024 * 1024,
});

export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_VENDOR_LIMITS: Readonly<VendorLimits> = Object.freeze({
  maxUrls: 100,
  maxBytes: 40 * 1024 * 1024,
  deadlineMs: 60_000,
  concurrency: 4,
  maxImportDepth: 3,
});

export const DEFAULT_CONFIG: Readonly<CoreConfig> = Object.freeze({
  limits: DEFAULT_LIMITS,
  vendor: DEFAULT_VENDOR_LIMITS,
  revisionsKept: 50,
  trashRetentionMs: 30 * DAY_MS,
  scriptsEnabled: false,
});

export interface CoreConfigInput {
  limits?: Partial<CoreLimits>;
  vendor?: Partial<VendorLimits>;
  revisionsKept?: number;
  trashRetentionMs?: number;
  defaultLang?: string;
  scriptsEnabled?: boolean;
}

/** Merges overrides with the defaults and checks them. Throws `RangeError` on a nonsensical value. */
export function resolveConfig(input: CoreConfigInput = {}): CoreConfig {
  const limits: CoreLimits = { ...DEFAULT_LIMITS, ...input.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid limit ${name}`);
  }
  if (limits.maxSlides > LIMITS.maxSlides) {
    throw new RangeError(`maxSlides cannot exceed the format limit of ${LIMITS.maxSlides}`);
  }
  const vendor: VendorLimits = { ...DEFAULT_VENDOR_LIMITS, ...input.vendor };
  for (const [name, value] of Object.entries(vendor)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`Invalid vendor limit ${name}`);
  }
  const config: CoreConfig = {
    limits,
    vendor,
    revisionsKept: input.revisionsKept ?? DEFAULT_CONFIG.revisionsKept,
    trashRetentionMs: input.trashRetentionMs ?? DEFAULT_CONFIG.trashRetentionMs,
    scriptsEnabled: input.scriptsEnabled === true,
  };
  if (!Number.isSafeInteger(config.revisionsKept) || config.revisionsKept < 1) {
    throw new RangeError("revisionsKept must be a positive integer");
  }
  if (!Number.isSafeInteger(config.trashRetentionMs) || config.trashRetentionMs < 0) {
    throw new RangeError("trashRetentionMs must be a non-negative integer");
  }
  if (input.defaultLang !== undefined) config.defaultLang = input.defaultLang;
  return config;
}
