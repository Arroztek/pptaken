// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Why a file cannot be imported at all. Stable codes; messages are English, short and safe to show (hostile names
 * are made printable before they are echoed).
 *
 * - `NOT_PPTX`: not a PowerPoint file (or another Office document).
 * - `LEGACY_PPT`: a PowerPoint 97-2003 `.ppt` file (binary format, out of scope).
 * - `ENCRYPTED`: a password-protected presentation.
 * - `INVALID_FILE`: a damaged or malformed package, or a part that breaks the safety rules (DTD, bad UTF-8...).
 * - `TOO_LARGE`: over a size, entry or slide limit.
 * - `TIMEOUT`: the isolated conversion took too long or ran out of memory.
 */
export type PptxErrorCode =
  | "NOT_PPTX"
  | "LEGACY_PPT"
  | "ENCRYPTED"
  | "INVALID_FILE"
  | "TOO_LARGE"
  | "TIMEOUT";

export class PptxError extends Error {
  override readonly name = "PptxError";
  constructor(
    readonly code: PptxErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export function isPptxError(value: unknown): value is PptxError {
  return (
    value instanceof PptxError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { name?: unknown }).name === "PptxError" &&
      typeof (value as { code?: unknown }).code === "string")
  );
}
