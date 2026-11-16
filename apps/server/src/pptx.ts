// SPDX-License-Identifier: AGPL-3.0-or-later
// The core's PowerPoint converter port, implemented with @pptaken/import-pptx in an isolated worker thread (heap
// limit, hard timeout). Converter refusals become DomainErrors with a hint the panel shows as is.
import { type ConverterLimits, DomainError, type PptxConverter } from "@pptaken/core";
import { isPptxError, type PptxError } from "@pptaken/import-pptx";
import { convertPptxIsolated } from "@pptaken/import-pptx/isolated";

export interface PptxConverterOptions {
  /** Hard wall-clock limit of one conversion (default 60 s). */
  timeoutMs?: number;
  /** Heap of the conversion worker in MB (default 768). */
  maxMemoryMb?: number;
}

function toDomainError(error: PptxError): DomainError {
  const details = { reason: error.code };
  switch (error.code) {
    case "TOO_LARGE":
    case "TIMEOUT":
      return new DomainError("LIMIT_EXCEEDED", error.message, {
        hint:
          error.hint ??
          "Split the presentation into smaller files in PowerPoint and import each one.",
        details,
      });
    case "NOT_PPTX":
    case "LEGACY_PPT":
    case "ENCRYPTED":
      return new DomainError("UNSUPPORTED_MEDIA", error.message, {
        hint:
          error.hint ??
          "Choose a .pptx file saved by PowerPoint, Keynote, Google Slides or LibreOffice.",
        details,
      });
    default:
      return new DomainError("VALIDATION_ERROR", error.message, {
        hint:
          error.hint ??
          "The file may be damaged. Open it in PowerPoint, save it again as .pptx and import the new file.",
        details,
      });
  }
}

export function createPptxConverter(options: PptxConverterOptions = {}): PptxConverter {
  return async (bytes: Uint8Array, limits: ConverterLimits) => {
    try {
      return await convertPptxIsolated(bytes, {
        limits,
        timeoutMs: options.timeoutMs ?? 60_000,
        maxMemoryMb: options.maxMemoryMb ?? 768,
      });
    } catch (error) {
      if (isPptxError(error)) throw toDomainError(error);
      throw error;
    }
  };
}
