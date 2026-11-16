// SPDX-License-Identifier: AGPL-3.0-or-later
// Public types and default limits of the PowerPoint importer.
import type { DeckInput } from "@pptaken/schema";
import type { PackageLimits } from "./package.js";

export interface PptxLimits extends PackageLimits {
  /** Slides in the presentation (the deck format allows 200). */
  maxSlides: number;
  /** Bytes of one image (the core's per-asset limit). */
  maxAssetBytes: number;
  /** Distinct images in the deck. */
  maxAssetsPerDeck: number;
  /** Total bytes of the images. */
  maxAssetBytesPerDeck: number;
  /** Width × height of one image (read from its header; nothing is decoded). */
  maxImagePixels: number;
  /** Width or height of one image. */
  maxImageDimension: number;
  /** Shapes drawn on one slide after groups are flattened. */
  maxShapesPerSlide: number;
  /** Nesting of groups that is followed; deeper content is dropped. */
  maxGroupDepth: number;
  /** Size budget of one slide's HTML (below the format's 256 KB, leaving room for the sanitizer). */
  maxSlideHtmlChars: number;
}

export const DEFAULT_PPTX_LIMITS: Readonly<PptxLimits> = Object.freeze({
  maxEntries: 5000,
  maxTotalBytes: 400 * 1024 * 1024,
  maxXmlPartBytes: 16 * 1024 * 1024,
  maxRatio: 500,
  maxSlides: 200,
  maxAssetBytes: 10 * 1024 * 1024,
  maxAssetsPerDeck: 200,
  maxAssetBytesPerDeck: 100 * 1024 * 1024,
  maxImagePixels: 64 * 1024 * 1024,
  maxImageDimension: 20_000,
  maxShapesPerSlide: 1000,
  maxGroupDepth: 16,
  maxSlideHtmlChars: 200 * 1024,
});

/**
 * Stable warning codes. `feature` names what was affected (`chart`, `transition`, `font:Calibri`...).
 *
 * - `PPTX_FEATURE_DROPPED`: something was not imported (charts, SmartArt, transitions, video...).
 * - `PPTX_FEATURE_SIMPLIFIED`: imported with lower fidelity (animations as click steps, table styles...).
 * - `PPTX_IMAGE_DROPPED`: an image could not be used (format, size, limits); a placeholder box marks it.
 * - `PPTX_FONT_REPLACED`: a font was replaced by a bundled one; line breaks may change.
 * - `PPTX_CANVAS_ADJUSTED`: the slide size is not 16:9 or 4:3; slides are fitted to the nearest canvas.
 * - `PPTX_CONTENT_TRUNCATED`: a slide or its notes were cut to fit the format's limits.
 */
export type PptxWarningCode =
  | "PPTX_FEATURE_DROPPED"
  | "PPTX_FEATURE_SIMPLIFIED"
  | "PPTX_IMAGE_DROPPED"
  | "PPTX_FONT_REPLACED"
  | "PPTX_CANVAS_ADJUSTED"
  | "PPTX_CONTENT_TRUNCATED";

export interface PptxWarning {
  code: PptxWarningCode;
  /** English, safe to show; names the slide number when it is about one slide. */
  message: string;
  /** 1-based slide number, when the warning is about one slide. */
  slide?: number;
  feature?: string;
}

export interface PptxAsset {
  sha256: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  bytes: Uint8Array;
}

export interface PptxConversion {
  /** A `pptaken.deck` envelope. Still untrusted: validate and sanitize it like any agent output. */
  deck: DeckInput;
  /** Images referenced by the deck as `asset:<sha256>`. */
  assets: PptxAsset[];
  warnings: PptxWarning[];
}

export interface ConvertOptions {
  limits?: Partial<PptxLimits>;
}
