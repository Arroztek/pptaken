// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/zip: the minimal ZIP writer and the hardened ZIP reader shared by the `.pkn` archive (@pptaken/export)
// and the PowerPoint importer (@pptaken/import-pptx). Node's zlib only, no other dependency.

export { hasUnsafeChar, isUnsafeChar, printable } from "./text.js";
export {
  crc32,
  type OpenedZip,
  openZip,
  readZip,
  unsafeNameReason,
  writeZip,
  type ZipEntry,
  ZipError,
  type ZipErrorCode,
  type ZipInputEntry,
  type ZipReadLimits,
} from "./zip.js";
