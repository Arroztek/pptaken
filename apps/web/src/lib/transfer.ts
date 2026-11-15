// SPDX-License-Identifier: AGPL-3.0-or-later
// Client-side checks before uploading an archive. The server checks everything again; these only save a
// pointless upload and give a clearer message.
import { MAX_IMPORT_MB } from "./api";

export type ImportFileProblem = "wrongType" | "tooLarge" | null;

/** `.pptaken` (or a renamed `.zip`) and at most {@link MAX_IMPORT_MB} MB. */
export function checkImportFile(file: { name: string; size: number }): ImportFileProblem {
  if (!/\.(pptaken|zip)$/i.test(file.name)) return "wrongType";
  if (file.size === 0) return "wrongType";
  if (file.size > MAX_IMPORT_MB * 1024 * 1024) return "tooLarge";
  return null;
}
