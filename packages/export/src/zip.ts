// SPDX-License-Identifier: AGPL-3.0-or-later
// A minimal ZIP writer and a hardened ZIP reader (PKWARE APPNOTE 6.3, no ZIP64, no encryption), built on Node's
// zlib only. The reader treats every archive as hostile: it trusts the central directory only after checking it
// against the local headers, refuses unsafe names, symlinks, duplicates, overlapping entries and anything it does
// not understand, enforces size and ratio limits before inflating, and verifies every CRC-32.

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { hasUnsafeChar, printable } from "./text.js";

/** Why a ZIP archive was refused. Stable codes; messages are English and safe to show. */
export type ZipErrorCode =
  | "NOT_A_ZIP"
  | "UNSUPPORTED"
  | "TOO_MANY_ENTRIES"
  | "TOO_LARGE"
  | "COMPRESSION_RATIO"
  | "UNSAFE_NAME"
  | "UNEXPECTED_ENTRY"
  | "DUPLICATE_ENTRY"
  | "SYMLINK"
  | "ENCRYPTED"
  | "CORRUPT"
  | "CRC_MISMATCH";

export class ZipError extends Error {
  override readonly name = "ZipError";
  constructor(
    readonly code: ZipErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, the ZIP polynomial)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Names

const MAX_NAME_LENGTH = 255;

/**
 * A safe relative entry name: `/`-separated, no empty, `.` or `..` segment, no backslash, no drive letter, no
 * control, zero-width or bidi characters. Directory entries end with `/`. Returns why a name is not safe, or null.
 */
export function unsafeNameReason(name: string): string | null {
  if (name.length === 0) return "empty name";
  if (name.length > MAX_NAME_LENGTH) return "name too long";
  if (name.startsWith("/")) return "absolute path";
  if (/^[A-Za-z]:/.test(name)) return "drive letter";
  if (name.includes("\\")) return "backslash in name";
  if (hasUnsafeChar(name)) return "control character in name";
  const body = name.endsWith("/") ? name.slice(0, -1) : name;
  for (const segment of body.split("/")) {
    if (segment === "") return "empty path segment";
    if (segment === "." || segment === "..") return "path traversal";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Writer

export interface ZipInputEntry {
  name: string;
  data: Uint8Array;
  /** Deflate this entry (kept stored when deflating does not make it smaller). Default false. */
  compress?: boolean;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

const UTF8_FLAG = 0x0800;
const MADE_BY_UNIX = 0x0314; // UNIX, spec 2.0
const REGULAR_FILE_MODE = 0o100644;

/** Writes a ZIP archive (stored or deflated entries, UTF-8 names, regular-file permissions). */
export function writeZip(
  entries: readonly ZipInputEntry[],
  options: { date?: Date } = {},
): Uint8Array {
  if (entries.length > 0xfffe) throw new RangeError("too many entries for a ZIP archive");
  const stamp = dosDateTime(options.date ?? new Date());
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const reason = unsafeNameReason(entry.name);
    if (reason !== null) {
      throw new TypeError(`unsafe entry name "${printable(entry.name)}": ${reason}`);
    }
    if (seen.has(entry.name)) throw new TypeError(`duplicate entry name "${entry.name}"`);
    seen.add(entry.name);
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    let method = 0;
    let body = entry.data;
    if (entry.compress === true && entry.data.length > 0) {
      const deflated = new Uint8Array(deflateRawSync(entry.data, { level: 9 }));
      if (deflated.length < entry.data.length) {
        method = 8;
        body = deflated;
      }
    }
    if (offset + 30 + name.length + body.length > 0xfffffffe) {
      throw new RangeError("archive too large for a ZIP without ZIP64");
    }

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, MADE_BY_UNIX, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    // 30 extra length, 32 comment length, 34 disk, 36 internal attributes: all zero.
    cv.setUint32(38, (REGULAR_FILE_MODE << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reader

export interface ZipReadLimits {
  /** Maximum number of entries (directory entries included). */
  maxEntries: number;
  /** Maximum sum of the declared uncompressed sizes. */
  maxTotalBytes: number;
  /** Maximum uncompressed size of one entry, by name. */
  maxEntryBytes: (name: string) => number;
  /**
   * Maximum ratio uncompressed / compressed of a deflated entry, checked on the declared sizes before inflating,
   * for entries larger than {@link ZipReadLimits.ratioThresholdBytes}.
   */
  maxRatio: number;
  /** Entries up to this uncompressed size are exempt from the ratio check. Default 64 KiB. */
  ratioThresholdBytes?: number;
  /** Allow-list of entry names, checked before anything is inflated. Default: every safe name. */
  acceptName?: (name: string) => boolean;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

interface CentralEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeName(raw: Uint8Array, utf8: boolean): string {
  if (!utf8) {
    for (const byte of raw) {
      if (byte > 0x7e) {
        throw new ZipError("UNSAFE_NAME", "An entry name is not ASCII and not marked as UTF-8");
      }
    }
  }
  try {
    return decoder.decode(raw);
  } catch {
    throw new ZipError("UNSAFE_NAME", "An entry name is not valid UTF-8");
  }
}

/** Locates the end-of-central-directory record; the comment (if any) must run exactly to the end. */
function findEnd(bytes: Uint8Array, dv: DataView): number {
  if (bytes.length < 22)
    throw new ZipError("NOT_A_ZIP", "The file is not a ZIP archive (too short)");
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (
      dv.getUint32(i, true) === 0x06054b50 &&
      i + 22 + dv.getUint16(i + 20, true) === bytes.length
    ) {
      return i;
    }
  }
  throw new ZipError("NOT_A_ZIP", "The file is not a ZIP archive (no end of central directory)");
}

function isEncrypted(flags: number): boolean {
  return (flags & 0x0001) !== 0 || (flags & 0x0040) !== 0;
}

/**
 * Reads every entry of a ZIP archive into memory, refusing anything unsafe (see the module comment). Directory
 * entries (names ending in `/`) are validated and returned with empty data. Entries come back in the order of the
 * central directory.
 */
export function readZip(bytes: Uint8Array, limits: ZipReadLimits): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = findEnd(bytes, dv);
  const disk = dv.getUint16(endAt + 4, true);
  const cdDisk = dv.getUint16(endAt + 6, true);
  const countDisk = dv.getUint16(endAt + 8, true);
  const count = dv.getUint16(endAt + 10, true);
  const cdSize = dv.getUint32(endAt + 12, true);
  const cdOffset = dv.getUint32(endAt + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError("UNSUPPORTED", "ZIP64 archives are not supported");
  }
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) {
    throw new ZipError("UNSUPPORTED", "Multi-part (spanned) ZIP archives are not supported");
  }
  if (count > limits.maxEntries) {
    throw new ZipError(
      "TOO_MANY_ENTRIES",
      `The archive has ${count} entries; the limit is ${limits.maxEntries}`,
    );
  }
  // The central directory must end exactly where the end record starts: no hidden data in between.
  if (cdOffset + cdSize !== endAt) {
    throw new ZipError("CORRUPT", "The central directory does not match the end record");
  }

  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  const folded = new Set<string>();
  let at = cdOffset;
  let declaredTotal = 0;
  const threshold = limits.ratioThresholdBytes ?? 64 * 1024;
  for (let i = 0; i < count; i++) {
    if (at + 46 > endAt || dv.getUint32(at, true) !== 0x02014b50) {
      throw new ZipError("CORRUPT", "Bad central directory entry");
    }
    const madeBy = dv.getUint16(at + 4, true);
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const crc = dv.getUint32(at + 16, true);
    const compressedSize = dv.getUint32(at + 20, true);
    const size = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    const startDisk = dv.getUint16(at + 34, true);
    const external = dv.getUint32(at + 38, true);
    const localOffset = dv.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > endAt) throw new ZipError("CORRUPT", "Bad central directory entry");
    const name = decodeName(
      bytes.subarray(at + 46, at + 46 + nameLength),
      (flags & UTF8_FLAG) !== 0,
    );
    at = next;

    const reason = unsafeNameReason(name);
    if (reason !== null) {
      throw new ZipError("UNSAFE_NAME", `Unsafe entry name "${printable(name)}": ${reason}`);
    }
    if (limits.acceptName !== undefined && !limits.acceptName(name)) {
      throw new ZipError("UNEXPECTED_ENTRY", `Unexpected entry "${printable(name)}"`);
    }
    const key = name.normalize("NFC").toLowerCase();
    if (names.has(name) || folded.has(key)) {
      throw new ZipError("DUPLICATE_ENTRY", `Duplicate entry "${printable(name)}"`);
    }
    names.add(name);
    folded.add(key);
    if (isEncrypted(flags))
      throw new ZipError("ENCRYPTED", "Encrypted ZIP entries are not supported");
    if (method !== 0 && method !== 8) {
      throw new ZipError("UNSUPPORTED", `Compression method ${method} is not supported`);
    }
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("UNSUPPORTED", "ZIP64 archives are not supported");
    }
    if (startDisk !== 0)
      throw new ZipError("UNSUPPORTED", "Spanned ZIP archives are not supported");
    const host = madeBy >>> 8;
    const mode = (external >>> 16) & 0o170000;
    if (host === 3 && mode === 0o120000) {
      throw new ZipError("SYMLINK", `Entry "${printable(name)}" is a symbolic link`);
    }
    const isDir = name.endsWith("/");
    if (isDir && size !== 0) throw new ZipError("CORRUPT", "A directory entry has content");
    if (!isDir && host === 3 && mode !== 0 && mode !== 0o100000) {
      throw new ZipError("UNSUPPORTED", `Entry "${printable(name)}" is not a regular file`);
    }
    if (method === 0 && compressedSize !== size) {
      throw new ZipError("CORRUPT", `Stored entry "${printable(name)}" has inconsistent sizes`);
    }
    const max = limits.maxEntryBytes(name);
    if (size > max) {
      throw new ZipError(
        "TOO_LARGE",
        `Entry "${printable(name)}" is ${size} bytes uncompressed; the limit is ${max}`,
      );
    }
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) {
      throw new ZipError(
        "TOO_LARGE",
        `The archive expands to more than ${limits.maxTotalBytes} bytes, which is the limit`,
      );
    }
    if (method === 8 && size > threshold && size > compressedSize * limits.maxRatio) {
      throw new ZipError(
        "COMPRESSION_RATIO",
        `Entry "${printable(name)}" is compressed more than ${limits.maxRatio}:1 (a ZIP bomb?)`,
      );
    }
    entries.push({ name, method, crc, compressedSize, size, localOffset });
  }
  if (at !== endAt) throw new ZipError("CORRUPT", "Unexpected data in the central directory");

  // Local headers: present, consistent with the central directory, inside the data area, not overlapping.
  const ranges: { start: number; end: number; entry: CentralEntry; dataStart: number }[] = [];
  for (const entry of entries) {
    const lo = entry.localOffset;
    if (lo + 30 > cdOffset || dv.getUint32(lo, true) !== 0x04034b50) {
      throw new ZipError("CORRUPT", `Missing local header for "${printable(entry.name)}"`);
    }
    const localFlags = dv.getUint16(lo + 6, true);
    const localMethod = dv.getUint16(lo + 8, true);
    const nameLength = dv.getUint16(lo + 26, true);
    const extraLength = dv.getUint16(lo + 28, true);
    const dataStart = lo + 30 + nameLength + extraLength;
    if (dataStart > cdOffset) throw new ZipError("CORRUPT", "A local header is out of bounds");
    const localName = decodeName(
      bytes.subarray(lo + 30, lo + 30 + nameLength),
      (localFlags & UTF8_FLAG) !== 0,
    );
    if (localName !== entry.name || localMethod !== entry.method) {
      throw new ZipError(
        "CORRUPT",
        `The local header of "${printable(entry.name)}" does not match the central directory`,
      );
    }
    if (isEncrypted(localFlags)) {
      throw new ZipError("ENCRYPTED", "Encrypted ZIP entries are not supported");
    }
    const end = dataStart + entry.compressedSize;
    if (end > cdOffset) {
      throw new ZipError("CORRUPT", `Entry "${printable(entry.name)}" is truncated`);
    }
    ranges.push({ start: lo, end, entry, dataStart });
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as { end: number };
    const cur = sorted[i] as { start: number };
    if (cur.start < prev.end) throw new ZipError("CORRUPT", "Overlapping entries (a ZIP bomb?)");
  }

  return ranges.map(({ entry, dataStart }) => {
    const raw = bytes.subarray(dataStart, dataStart + entry.compressedSize);
    let data: Uint8Array;
    if (entry.method === 0) {
      data = raw.slice();
    } else {
      try {
        data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }));
      } catch {
        throw new ZipError(
          "CORRUPT",
          `Entry "${printable(entry.name)}" cannot be decompressed or is larger than declared`,
        );
      }
    }
    if (data.length !== entry.size) {
      throw new ZipError("CORRUPT", `Entry "${printable(entry.name)}" has the wrong size`);
    }
    if (crc32(data) !== entry.crc) {
      throw new ZipError(
        "CRC_MISMATCH",
        `Entry "${printable(entry.name)}" is damaged (CRC mismatch)`,
      );
    }
    return { name: entry.name, data };
  });
}
