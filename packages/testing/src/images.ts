// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal, structurally valid image files built byte by byte (no image library), plus hostile variants.

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: number[] | Uint8Array): Uint8Array {
  const body = concat(ascii(type), data);
  return concat(u32be(body.length - 4), body, u32be(crc32(body)));
}

/** A PNG of the given size (the pixel data is a placeholder; only the structure is valid). */
export function pngBytes(width = 4, height = 3, payload = 16): Uint8Array {
  return concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk("IHDR", [...u32be(width), ...u32be(height), 8, 2, 0, 0, 0]),
    pngChunk("IDAT", new Uint8Array(payload).fill(7)),
    pngChunk("IEND", []),
  );
}

export function jpegBytes(width = 4, height = 3): Uint8Array {
  return concat(
    [0xff, 0xd8],
    [0xff, 0xe0, ...u16be(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xc0, ...u16be(11), 8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0],
    [0xff, 0xda, ...u16be(8), 1, 1, 0, 0, 63, 0],
    [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78],
    [0xff, 0xd9],
  );
}

export function gifBytes(width = 4, height = 3): Uint8Array {
  return concat(
    ascii("GIF89a"),
    [...u16le(width), ...u16le(height), 0x80, 0, 0],
    [0, 0, 0, 255, 255, 255],
    [0x21, 0xf9, 4, 0, 0, 0, 0, 0],
    [0x2c, ...u16le(0), ...u16le(0), ...u16le(width), ...u16le(height), 0],
    [2, 2, 0x4c, 0x01, 0],
    [0x3b],
  );
}

/** Lossless WebP (VP8L) header. */
export function webpBytes(width = 4, height = 3): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const data = [0x2f, ...u32le(bits >>> 0), 0, 0, 0, 0, 0, 0, 0];
  const chunk = concat(ascii("VP8L"), u32le(data.length), data, data.length % 2 ? [0] : []);
  return concat(ascii("RIFF"), u32le(4 + chunk.length), ascii("WEBP"), chunk);
}

/** Extended WebP (VP8X) header with a 24-bit canvas size. */
export function webpExtendedBytes(width = 4, height = 3): Uint8Array {
  const data = [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  const chunk = concat(ascii("VP8X"), u32le(data.length), data);
  return concat(ascii("RIFF"), u32le(4 + chunk.length), ascii("WEBP"), chunk);
}

function box(type: string, ...payload: (Uint8Array | number[])[]): Uint8Array {
  const body = concat(...payload);
  return concat(u32be(8 + body.length), ascii(type), body);
}

export function avifBytes(width = 4, height = 3): Uint8Array {
  const ispe = box("ispe", [0, 0, 0, 0], u32be(width), u32be(height));
  const meta = box(
    "meta",
    [0, 0, 0, 0],
    box("hdlr", [0, 0, 0, 0, 0, 0, 0, 0], ascii("pict"), new Uint8Array(13)),
    box("iprp", box("ipco", ispe)),
  );
  return concat(
    box("ftyp", ascii("avif"), [0, 0, 0, 0], ascii("mif1"), ascii("miaf")),
    meta,
    box("mdat", [1, 2, 3, 4]),
  );
}

export function svgBytes(): Uint8Array {
  return Uint8Array.from(
    ascii(
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"></svg>',
    ),
  );
}

/** Hostile and broken files for signature tests. */
export const hostileImages = {
  /** A PNG followed by an HTML payload (a PNG/HTML polyglot). */
  pngWithTrailingHtml: () => concat(pngBytes(), ascii("<html><script>alert(1)</script></html>")),
  /** GIF/JavaScript-style polyglot: valid GIF blocks, then script text after the trailer. */
  gifWithTrailingScript: () => concat(gifBytes(), ascii("*/=1;alert(1)//")),
  /** SVG markup that embeds a PNG signature further in (must be detected as SVG, never as PNG). */
  svgWithPngInside: () =>
    concat(ascii('<svg xmlns="http://www.w3.org/2000/svg"><!-- '), pngBytes(), ascii(" --></svg>")),
  /** HTML declared as an image. */
  html: () => Uint8Array.from(ascii("<!doctype html><script>alert(1)</script>")),
  /** PNG cut in the middle of its IHDR chunk. */
  truncatedPng: () => pngBytes().slice(0, 20),
  /** PNG without its IEND chunk. */
  pngWithoutEnd: () => pngBytes().slice(0, -12),
  truncatedJpeg: () => jpegBytes().slice(0, 12),
  truncatedGif: () => gifBytes().slice(0, -1),
  /** WebP whose RIFF size claims more bytes than the file has. */
  truncatedWebp: () => webpBytes().slice(0, -2),
  truncatedAvif: () => avifBytes().slice(0, -3),
  /** A PNG header announcing a 100000 × 100000 image (decompression bomb shape). */
  hugePng: () => pngBytes(100_000, 100_000),
};
