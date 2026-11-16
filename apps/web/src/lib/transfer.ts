// SPDX-License-Identifier: AGPL-3.0-or-later
// Client-side checks before uploading an import, and the grouping of import warnings for the results summary.
// The server checks everything again; the checks only save a pointless upload and give a clearer message.
import { type ImportKind, type ImportWarning, MAX_IMPORT_MB } from "./api";

export type ImportFileProblem = "wrongType" | "legacyPpt" | "tooLarge" | null;

/** `.pkn` (or a renamed `.zip`) is a PPTaken archive; `.pptx` and its siblings are PowerPoint files. */
export function importKindOf(name: string): ImportKind | null {
  if (/\.(pkn|zip)$/i.test(name)) return "archive";
  if (/\.(pptx|pptm|ppsx|potx)$/i.test(name)) return "pptx";
  return null;
}

/** A supported type, not empty, and at most {@link MAX_IMPORT_MB} MB. Old `.ppt` files get their own reason. */
export function checkImportFile(file: { name: string; size: number }): ImportFileProblem {
  if (/\.(ppt|pps|pot)$/i.test(file.name)) return "legacyPpt";
  if (importKindOf(file.name) === null) return "wrongType";
  if (file.size === 0) return "wrongType";
  if (file.size > MAX_IMPORT_MB * 1024 * 1024) return "tooLarge";
  return null;
}

/** The `accept` list of the import file picker. */
export const IMPORT_ACCEPT =
  ".pkn,.pptx,.pptm,.ppsx,.potx,application/zip,application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type WarningGroup =
  | "dropped"
  | "simplified"
  | "images"
  | "fonts"
  | "canvas"
  | "truncated"
  | "safety"
  | "other";

const GROUP_OF: Record<string, WarningGroup> = {
  PPTX_FEATURE_DROPPED: "dropped",
  PPTX_FEATURE_SIMPLIFIED: "simplified",
  PPTX_IMAGE_DROPPED: "images",
  PPTX_FONT_REPLACED: "fonts",
  PPTX_CANVAS_ADJUSTED: "canvas",
  PPTX_CONTENT_TRUNCATED: "truncated",
  REMOVED_ELEMENT: "safety",
  REMOVED_ATTRIBUTE: "safety",
  REMOVED_CSS_RULE: "safety",
  REMOVED_CSS_PROPERTY: "safety",
  REMOVED_URL: "safety",
  INVALID_ASSET_REF: "safety",
};

const ORDER: WarningGroup[] = [
  "dropped",
  "images",
  "simplified",
  "fonts",
  "canvas",
  "truncated",
  "safety",
  "other",
];

/** Warnings grouped for the results summary, in a fixed order, each group in server order. */
export function groupWarnings(
  warnings: readonly ImportWarning[],
): { group: WarningGroup; items: ImportWarning[] }[] {
  const groups = new Map<WarningGroup, ImportWarning[]>();
  for (const w of warnings) {
    const group = GROUP_OF[w.code] ?? "other";
    const list = groups.get(group) ?? [];
    list.push(w);
    groups.set(group, list);
  }
  return ORDER.filter((g) => groups.has(g)).map((group) => ({
    group,
    items: groups.get(group) as ImportWarning[],
  }));
}
