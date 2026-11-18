// SPDX-License-Identifier: AGPL-3.0-or-later
// Image type detection by content signature plus a structural walk of the container, and width/height read from
// the headers. Nothing is decoded: no image library, no native dependency. The declared media type and the file
// name are never trusted (architecture §10).
//
// Polyglot defense: PNG, GIF, WebP and AVIF must be structurally complete with no trailing bytes after the last
// chunk/block/box; JPEG must reach its EOI marker and may only be followed by zero padding or another JPEG (the
// MPO multi-picture layout phones produce).

export const RASTER_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;

export type RasterMediaType = (typeof RASTER_MEDIA_TYPES)[number];

export type SniffResult =
  | { ok: true; mediaType: RasterMediaType; width: number | null; height: number | null }
  | {
      ok: false;
      /** `svg`: an SVG document; `malformed`: a known signature with a broken structure; `unknown`: no match. */
      kind: "svg" | "malformed" | "unknown";
      /** Detected type for `malformed` files. */
      mediaType?: RasterMediaType;
      reason: string;
    };

const MAX_DIMENSION = 2 ** 31 - 1;

/** Lowercases a declared media type, drops parameters and maps common aliases (`image/jpg`). */
export function normalizeMediaType(declared: string): string {
  const base = (declared.split(";")[0] ?? "").trim().toLowerCase();
  if (base === "image/jpg" || base === "image/pjpeg") return "image/jpeg";
  if (base === "image/x-png") return "image/png";
  return base;
}

/** Detects the image type of `bytes` from its content alone. */
export function sniffImage(bytes: Uint8Array): SniffResult {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return png(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return jpeg(bytes);
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return gif(bytes);
  if (startsWith(bytes, ascii("RIFF")) && matchAt(bytes, 8, ascii("WEBP"))) return webp(bytes);
  if (matchAt(bytes, 4, ascii("ftyp"))) return avif(bytes);
  if (looksLikeSvg(bytes)) return { ok: false, kind: "svg", reason: "SVG document" };
  return { ok: false, kind: "unknown", reason: "No supported image signature" };
}

// ---------------------------------------------------------------------------------------------------------------

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function matchAt(bytes: Uint8Array, offset: number, sig: readonly number[]): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  return matchAt(bytes, 0, sig);
}

function u16be(b: Uint8Array, o: number): number {
  return ((b[o] as number) << 8) | (b[o + 1] as number);
}

function u16le(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8);
}

function u24le(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16);
}

function u32be(b: Uint8Array, o: number): number {
  return (
    (b[o] as number) * 0x1000000 +
    (((b[o + 1] as number) << 16) | ((b[o + 2] as number) << 8) | (b[o + 3] as number))
  );
}

function u32le(b: Uint8Array, o: number): number {
  return u24le(b, o) + (b[o + 3] as number) * 0x1000000;
}

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
}

function bad(mediaType: RasterMediaType, reason: string): SniffResult {
  return { ok: false, kind: "malformed", mediaType, reason };
}

function good(
  mediaType: RasterMediaType,
  width: number | null,
  height: number | null,
): SniffResult {
  if (width !== null && height !== null) {
    if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
      return bad(mediaType, "Invalid image dimensions");
    }
  }
  return { ok: true, mediaType, width, height };
}

// PNG: signature, IHDR first, chunks until IEND, nothing after IEND.
function png(b: Uint8Array): SniffResult {
  const T = "image/png";
  if (b.length < 8 + 25 + 12) return bad(T, "Truncated PNG header");
  if (u32be(b, 8) !== 13 || fourcc(b, 12) !== "IHDR") return bad(T, "PNG without IHDR chunk");
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  let off = 8;
  while (off + 12 <= b.length) {
    const len = u32be(b, off);
    const type = fourcc(b, off + 4);
    const end = off + 12 + len;
    if (len > 0x7fffffff || end > b.length) return bad(T, "Truncated PNG chunk");
    if (type === "IEND") {
      if (end !== b.length) return bad(T, "Data after the PNG IEND chunk");
      return good(T, width, height);
    }
    off = end;
  }
  return bad(T, "PNG without IEND chunk");
}

// JPEG: walk the marker segments to EOI, reading the first SOFn for the size.
function jpeg(b: Uint8Array): SniffResult {
  const T = "image/jpeg";
  const end = jpegEnd(b, 0);
  if (typeof end === "string") return bad(T, end);
  // After EOI: zero padding, or further JPEG images (MPO).
  let off = end.end;
  while (off < b.length) {
    if (b[off] === 0) {
      off++;
      continue;
    }
    if (b[off] === 0xff && b[off + 1] === 0xd8) {
      const next = jpegEnd(b, off);
      if (typeof next === "string") return bad(T, `Trailing image: ${next}`);
      off = next.end;
      continue;
    }
    return bad(T, "Data after the JPEG EOI marker");
  }
  if (end.width === null || end.height === null) return bad(T, "JPEG without a frame header");
  return good(T, end.width, end.height);
}

function jpegEnd(
  b: Uint8Array,
  start: number,
): { end: number; width: number | null; height: number | null } | string {
  let off = start + 2;
  let width: number | null = null;
  let height: number | null = null;
  while (off < b.length) {
    if (b[off] !== 0xff) return "Invalid JPEG marker";
    while (b[off] === 0xff) off++;
    if (off >= b.length) break;
    const marker = b[off] as number;
    off++;
    if (marker === 0xd9) return { end: off, width, height };
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd8) return "Unexpected JPEG start marker";
    if (off + 2 > b.length) break;
    const len = u16be(b, off);
    if (len < 2 || off + len > b.length) return "Truncated JPEG segment";
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && width === null) {
      if (len < 7) return "Truncated JPEG frame header";
      height = u16be(b, off + 3);
      width = u16be(b, off + 5);
    }
    off += len;
    if (marker === 0xda) {
      // Entropy-coded data: skip to the next marker that is not a stuffed byte or a restart marker.
      while (off < b.length) {
        if (b[off] === 0xff) {
          const next = b[off + 1];
          if (next === undefined) return "Truncated JPEG scan";
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            off += next === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        off++;
      }
    }
  }
  return "JPEG without EOI marker";
}

// GIF: header, logical screen, optional global color table, blocks until the trailer, nothing after it.
function gif(b: Uint8Array): SniffResult {
  const T = "image/gif";
  if (b.length < 14) return bad(T, "Truncated GIF header");
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  const flags = b[10] as number;
  let off = 13;
  if (flags & 0x80) off += 3 * 2 ** ((flags & 7) + 1);
  const skipSubBlocks = (): boolean => {
    while (off < b.length) {
      const size = b[off] as number;
      off += 1 + size;
      if (size === 0) return off <= b.length;
    }
    return false;
  };
  while (off < b.length) {
    const block = b[off] as number;
    if (block === 0x3b) {
      if (off + 1 !== b.length) return bad(T, "Data after the GIF trailer");
      return good(T, width, height);
    }
    if (block === 0x21) {
      off += 2; // introducer + label
      if (!skipSubBlocks()) return bad(T, "Truncated GIF extension");
    } else if (block === 0x2c) {
      if (off + 10 > b.length) return bad(T, "Truncated GIF image descriptor");
      const local = b[off + 9] as number;
      off += 10;
      if (local & 0x80) off += 3 * 2 ** ((local & 7) + 1);
      off += 1; // LZW minimum code size
      if (!skipSubBlocks()) return bad(T, "Truncated GIF image data");
    } else {
      return bad(T, "Invalid GIF block");
    }
  }
  return bad(T, "GIF without trailer");
}

// WebP: RIFF size must match the file; chunks must tile the RIFF payload; size from VP8/VP8L/VP8X.
function webp(b: Uint8Array): SniffResult {
  const T = "image/webp";
  if (b.length < 30) return bad(T, "Truncated WebP header");
  if (u32le(b, 4) + 8 !== b.length) return bad(T, "WebP RIFF size does not match the file size");
  let width: number | null = null;
  let height: number | null = null;
  let off = 12;
  let first = true;
  while (off < b.length) {
    if (off + 8 > b.length) return bad(T, "Truncated WebP chunk");
    const type = fourcc(b, off);
    const size = u32le(b, off + 4);
    const data = off + 8;
    const end = data + size + (size & 1);
    if (end > b.length) return bad(T, "Truncated WebP chunk");
    if (first) {
      if (type === "VP8 ") {
        if (size < 10 || !matchAt(b, data + 3, [0x9d, 0x01, 0x2a]))
          return bad(T, "Invalid VP8 frame");
        width = u16le(b, data + 6) & 0x3fff;
        height = u16le(b, data + 8) & 0x3fff;
      } else if (type === "VP8L") {
        if (size < 5 || b[data] !== 0x2f) return bad(T, "Invalid VP8L header");
        const bits = u32le(b, data + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      } else if (type === "VP8X") {
        if (size < 10) return bad(T, "Invalid VP8X header");
        width = u24le(b, data + 4) + 1;
        height = u24le(b, data + 7) + 1;
      } else {
        return bad(T, "WebP without an image chunk");
      }
      first = false;
    }
    off = end;
  }
  if (first) return bad(T, "WebP without an image chunk");
  return good(T, width, height);
}

// AVIF (ISO BMFF): `ftyp` first with an AVIF brand, top-level boxes tile the file, size from `meta/iprp/ipco/ispe`.
function avif(b: Uint8Array): SniffResult {
  const boxes = readBoxes(b, 0, b.length);
  if (boxes === null) {
    return isAvifBrand(b) ? bad("image/avif", "Truncated or invalid AVIF box") : unknown();
  }
  const ftyp = boxes[0];
  if (ftyp === undefined || ftyp.type !== "ftyp" || !isAvifBrand(b)) return unknown();
  const meta = boxes.find((box) => box.type === "meta");
  let width: number | null = null;
  let height: number | null = null;
  if (meta !== undefined) {
    const ispe = findPath(b, meta.start + 4, meta.end, ["iprp", "ipco", "ispe"]);
    if (ispe !== null && ispe.end - ispe.start >= 12) {
      width = u32be(b, ispe.start + 4);
      height = u32be(b, ispe.start + 8);
    }
  }
  return good("image/avif", width, height);
}

function unknown(): SniffResult {
  return { ok: false, kind: "unknown", reason: "No supported image signature" };
}

function isAvifBrand(b: Uint8Array): boolean {
  if (b.length < 16) return false;
  const size = u32be(b, 0);
  const limit = Math.min(size, b.length, 4096);
  if (fourcc(b, 8) === "avif" || fourcc(b, 8) === "avis") return true;
  for (let o = 16; o + 4 <= limit; o += 4) {
    const brand = fourcc(b, o);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

interface Box {
  type: string;
  /** Start of the payload (after the header). */
  start: number;
  end: number;
}

function readBoxes(b: Uint8Array, from: number, to: number): Box[] | null {
  const out: Box[] = [];
  let off = from;
  while (off < to) {
    if (off + 8 > to) return null;
    let size = u32be(b, off);
    const type = fourcc(b, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > to) return null;
      const high = u32be(b, off + 8);
      if (high > 0x1fffff) return null;
      size = high * 2 ** 32 + u32be(b, off + 12);
      header = 16;
    } else if (size === 0) {
      size = to - off;
    }
    if (size < header || off + size > to) return null;
    out.push({ type, start: off + header, end: off + size });
    off += size;
    if (out.length > 10_000) return null;
  }
  return out;
}

function findPath(b: Uint8Array, from: number, to: number, path: readonly string[]): Box | null {
  const [head, ...rest] = path;
  if (head === undefined) return null;
  const children = readBoxes(b, from, to);
  if (children === null) return null;
  const box = children.find((c) => c.type === head);
  if (box === undefined) return null;
  if (rest.length === 0) return box;
  return findPath(b, box.start, box.end, rest);
}

// ---------------------------------------------------------------------------------------------------------------
// Fonts and text (ingest-time vendoring, ADR-022)

export const FONT_MEDIA_TYPES = ["font/woff2", "font/woff", "font/ttf", "font/otf"] as const;
export type FontMediaType = (typeof FONT_MEDIA_TYPES)[number];

export type FontSniff =
  | { ok: true; mediaType: FontMediaType; format: "woff2" | "woff" | "truetype" | "opentype" }
  | { ok: false; reason: string };

/**
 * Detects a font file by its signature and checks its container: WOFF/WOFF2 must declare exactly the file's
 * length (no appended data); TrueType/OpenType table records must lie inside the file and the file may not extend
 * past the last table (plus 3 padding bytes). Collections (`ttcf`) and anything else are refused.
 */
export function sniffFont(b: Uint8Array): FontSniff {
  if (b.length < 12) return { ok: false, reason: "Truncated font header" };
  const tag = fourcc(b, 0);
  if (tag === "wOF2" || tag === "wOFF") {
    const woff2 = tag === "wOF2";
    const headerSize = woff2 ? 48 : 44;
    if (b.length < headerSize) return { ok: false, reason: "Truncated WOFF header" };
    const flavor = fourcc(b, 4);
    if (flavor !== "\u0000\u0001\u0000\u0000" && flavor !== "OTTO" && flavor !== "true") {
      return { ok: false, reason: "Unknown WOFF flavor" };
    }
    if (u32be(b, 8) !== b.length) {
      return { ok: false, reason: "The WOFF length field does not match the file size" };
    }
    const tables = u16be(b, 12);
    if (tables === 0 || tables > 512) return { ok: false, reason: "Invalid WOFF table count" };
    return woff2
      ? { ok: true, mediaType: "font/woff2", format: "woff2" }
      : { ok: true, mediaType: "font/woff", format: "woff" };
  }
  if (tag === "\u0000\u0001\u0000\u0000" || tag === "true" || tag === "OTTO") {
    const tables = u16be(b, 4);
    if (tables === 0 || tables > 512) return { ok: false, reason: "Invalid font table count" };
    const dirEnd = 12 + tables * 16;
    if (dirEnd > b.length) return { ok: false, reason: "Truncated font table directory" };
    let end = dirEnd;
    for (let i = 0; i < tables; i++) {
      const rec = 12 + i * 16;
      const offset = u32be(b, rec + 8);
      const length = u32be(b, rec + 12);
      if (offset + length > b.length)
        return { ok: false, reason: "A font table lies outside the file" };
      end = Math.max(end, offset + length);
    }
    if (b.length > end + 3) return { ok: false, reason: "Data after the last font table" };
    return tag === "OTTO"
      ? { ok: true, mediaType: "font/otf", format: "opentype" }
      : { ok: true, mediaType: "font/ttf", format: "truetype" };
  }
  if (tag === "ttcf") return { ok: false, reason: "Font collections are not supported" };
  return { ok: false, reason: "No font signature (WOFF2, WOFF, TrueType or OpenType)" };
}

/**
 * Strict UTF-8 decoding (no replacement characters): `null` for invalid sequences, overlong forms, surrogates or
 * NUL. A leading BOM is removed. Used for vendored scripts and stylesheets, whose bytes must be exactly the text.
 */
export function decodeUtf8Strict(b: Uint8Array): string | null {
  let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  const parts: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length > 0) parts.push(String.fromCodePoint(...chunk));
    chunk = [];
  };
  while (i < b.length) {
    const c = b[i] as number;
    let cp: number;
    let need: number;
    if (c < 0x80) {
      if (c === 0) return null;
      cp = c;
      need = 0;
    } else if (c >= 0xc2 && c <= 0xdf) {
      cp = c & 0x1f;
      need = 1;
    } else if (c >= 0xe0 && c <= 0xef) {
      cp = c & 0x0f;
      need = 2;
    } else if (c >= 0xf0 && c <= 0xf4) {
      cp = c & 0x07;
      need = 3;
    } else return null;
    for (let k = 1; k <= need; k++) {
      const n = b[i + k];
      if (n === undefined || (n & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (n & 0x3f);
    }
    if (
      (need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) ||
      (need === 3 && (cp < 0x10000 || cp > 0x10ffff))
    ) {
      return null;
    }
    chunk.push(cp);
    if (chunk.length >= 4096) flush();
    i += need + 1;
  }
  flush();
  return parts.join("");
}

/** True when text looks like an HTML page (an error or login page served with 200), not a script or stylesheet. */
export function looksLikeHtml(text: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<!--)/i.test(text.slice(0, 512));
}

function looksLikeSvg(b: Uint8Array): boolean {
  const n = Math.min(b.length, 4096);
  let text = "";
  for (let i = 0; i < n; i++) text += String.fromCharCode(b[i] as number);
  const trimmed = text.replace(/^﻿|^ï»¿/, "").trimStart();
  return trimmed.startsWith("<") && /<svg[\s>/]/i.test(text);
}
