// SPDX-License-Identifier: AGPL-3.0-or-later
// The ZIP layer moved to @pptaken/zip (shared with the PowerPoint importer); re-exported here for compatibility.
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
} from "@pptaken/zip";
