// SPDX-License-Identifier: AGPL-3.0-or-later
// PowerPoint import: an owner-only use case that turns a .pptx file into a NEW presentation. The core knows nothing
// about the file format: the composition root provides a `PptxConverter` (the AGPL `@pptaken/import-pptx` package,
// run in an isolated worker by the server). Its output is treated exactly like an agent's or an archive's: the deck
// is validated, sanitized and validated again, and every image is checked like `addAsset` (see `storeImported`).
import { DomainError, validationError } from "../errors.js";
import type { PptxConversionOutput, PptxConverter } from "../ports.js";
import { type CallContext, type Principal, requireOwner, requireScope } from "../principal.js";
import { type Ctx, requireObject, requireString, runWrite } from "./context.js";
import {
  type ImportPresentationResult,
  type PortabilityWarning,
  type PptxWarningCode,
  storeImported,
} from "./portability.js";

const PPTX_CODES: readonly PptxWarningCode[] = [
  "PPTX_FEATURE_DROPPED",
  "PPTX_FEATURE_SIMPLIFIED",
  "PPTX_IMAGE_DROPPED",
  "PPTX_FONT_REPLACED",
  "PPTX_CANVAS_ADJUSTED",
  "PPTX_CONTENT_TRUNCATED",
];

/** Converter warnings kept per import (the converter already deduplicates; this bounds a hostile converter). */
const MAX_CONVERTER_WARNINGS = 500;

export interface ImportPptxInput {
  /** The uploaded file. Untrusted. */
  bytes: Uint8Array;
  /** Replaces the title found in the file. */
  title?: string;
}

export interface ImportPptxResult extends ImportPresentationResult {
  /** Title of the new presentation. */
  title: string;
}

function converterWarnings(output: PptxConversionOutput): PortabilityWarning[] {
  const list = Array.isArray(output.warnings)
    ? output.warnings.slice(0, MAX_CONVERTER_WARNINGS)
    : [];
  const out: PortabilityWarning[] = [];
  for (const w of list) {
    if (typeof w !== "object" || w === null) continue;
    const code = (PPTX_CODES as readonly string[]).includes(w.code)
      ? (w.code as PptxWarningCode)
      : "PPTX_FEATURE_DROPPED";
    const warning: PortabilityWarning = {
      code,
      message:
        typeof w.message === "string" ? w.message.slice(0, 300) : "Something was not imported",
    };
    if (Number.isSafeInteger(w.slide) && (w.slide as number) >= 1) {
      warning.path = `slides[${(w.slide as number) - 1}]`;
      warning.slideId = `slide-${w.slide}`;
    }
    if (typeof w.feature === "string" && w.feature.length <= 100) warning.name = w.feature;
    out.push(warning);
  }
  return out;
}

/**
 * Owner only (`decks:write`). Converts a PowerPoint file with the configured {@link PptxConverter} and stores the
 * result as a new presentation (revision 1), with the converter's warnings followed by the core's. Audited as
 * `presentation.import_pptx`.
 */
export async function importPptx(
  ctx: Ctx,
  converter: PptxConverter | undefined,
  principal: Principal,
  rawInput: ImportPptxInput,
  call?: CallContext,
): Promise<ImportPptxResult> {
  return runWrite(ctx, principal, call, "presentation.import_pptx", null, async () => {
    requireScope(principal, "decks:write");
    requireOwner(principal, "import a PowerPoint presentation");
    const input = requireObject(rawInput);
    if (converter === undefined) {
      throw new DomainError(
        "UNSUPPORTED_MEDIA",
        "PowerPoint import is not available on this server",
        {
          hint: "Export the presentation as a .pkn archive from another PPTaken, or create it with an agent.",
        },
      );
    }
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw validationError("The file is empty", { path: "bytes" });
    }
    const title = input.title === undefined ? undefined : requireString(input.title, "title", 200);
    const limits = ctx.config.limits;
    const output = await converter(bytes, {
      maxSlides: limits.maxSlides,
      maxAssetBytes: limits.maxAssetBytes,
      maxAssetsPerDeck: limits.maxAssetsPerDeck,
      maxAssetBytesPerDeck: limits.maxAssetBytesPerDeck,
      maxImagePixels: limits.maxImagePixels,
    });
    const warnings = converterWarnings(output);
    const result = await storeImported(
      ctx,
      principal,
      call,
      {
        deck: output.deck,
        assets: Array.isArray(output.assets) ? output.assets : [],
        ...(title === undefined ? {} : { title }),
      },
      {
        action: "presentation.import_pptx",
        summary: "Imported from PowerPoint",
        warnings,
        detail: { source: "pptx", warnings: warnings.length },
        stripScripts: true,
      },
    );
    const head = await ctx.store.decks.get(principal.workspaceId, result.presentationId);
    return { ...result, title: head?.title ?? title ?? "" };
  });
}
