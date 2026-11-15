// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/export: portability of presentations (phase F3).
//
// - `exportHtml`: one self-contained `.html` file that opens from `file://` without a server or a network.
// - `writeArchive` / `readArchive`: the `.pptaken` archive (ZIP with manifest.json, deck.json, assets/<sha256>).
// - `writeZip` / `readZip`: the minimal ZIP writer and the hardened reader they are built on (Node zlib only).
//
// This package does no storage I/O and does not import the core: the server composes it with the core's
// `exportPresentation` and `importPresentation` use cases.

export {
  ARCHIVE_EXTENSION,
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_MEDIA_TYPE,
  type ArchiveAsset,
  ArchiveError,
  type ArchiveErrorCode,
  type ArchiveLimits,
  type ArchiveManifest,
  type ArchiveManifestAsset,
  DEFAULT_ARCHIVE_LIMITS,
  parseManifest,
  type ReadArchive,
  readArchive,
  type WriteArchiveInput,
  type WrittenArchive,
  writeArchive,
} from "./archive.js";
export { exportFilenames, slugify, unicodeStem } from "./filename.js";
export {
  type EmbeddedFont,
  type ExportedHtml,
  type ExportHtmlInput,
  type ExportWarning,
  type ExportWarningCode,
  exportHtml,
  fontsUsedBy,
  HTML_SIZE_WARNING_BYTES,
  type HtmlAsset,
  scriptJson,
} from "./html.js";
export {
  crc32,
  readZip,
  unsafeNameReason,
  writeZip,
  type ZipEntry,
  ZipError,
  type ZipErrorCode,
  type ZipInputEntry,
  type ZipReadLimits,
} from "./zip.js";
