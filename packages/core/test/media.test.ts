// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  avifBytes,
  gifBytes,
  hostileImages,
  jpegBytes,
  pngBytes,
  svgBytes,
  webpBytes,
  webpExtendedBytes,
} from "@pptaken/testing";
import { describe, expect, it } from "vitest";
import { normalizeMediaType, sniffImage } from "../src/media.js";

describe("sniffImage", () => {
  it.each([
    ["png", pngBytes(640, 480), "image/png"],
    ["jpeg", jpegBytes(640, 480), "image/jpeg"],
    ["gif", gifBytes(640, 480), "image/gif"],
    ["webp (VP8L)", webpBytes(640, 480), "image/webp"],
    ["webp (VP8X)", webpExtendedBytes(640, 480), "image/webp"],
    ["avif", avifBytes(640, 480), "image/avif"],
  ])("detects %s and reads its size", (_name, bytes, mediaType) => {
    expect(sniffImage(bytes)).toEqual({ ok: true, mediaType, width: 640, height: 480 });
  });

  it("reads JPEG multi-picture files (data after EOI that is another JPEG)", () => {
    const mpo = new Uint8Array([...jpegBytes(10, 20), ...jpegBytes(2, 2), 0, 0]);
    expect(sniffImage(mpo)).toMatchObject({ ok: true, width: 10, height: 20 });
  });

  it("detects SVG, including with a BOM and leading whitespace", () => {
    expect(sniffImage(svgBytes())).toMatchObject({ ok: false, kind: "svg" });
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x20, 0x0a, ...svgBytes()]);
    expect(sniffImage(bom)).toMatchObject({ ok: false, kind: "svg" });
  });

  it.each([
    ["PNG followed by HTML", hostileImages.pngWithTrailingHtml()],
    ["GIF followed by script", hostileImages.gifWithTrailingScript()],
    ["truncated PNG", hostileImages.truncatedPng()],
    ["PNG without IEND", hostileImages.pngWithoutEnd()],
    ["truncated JPEG", hostileImages.truncatedJpeg()],
    ["truncated GIF", hostileImages.truncatedGif()],
    ["truncated WebP", hostileImages.truncatedWebp()],
    ["truncated AVIF", hostileImages.truncatedAvif()],
    ["JPEG followed by text", new Uint8Array([...jpegBytes(), 0x3c, 0x68])],
    ["JPEG without frame header", new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
  ])("rejects a malformed or polyglot file: %s", (_name, bytes) => {
    expect(sniffImage(bytes)).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("never classifies an SVG that embeds a PNG as PNG", () => {
    expect(sniffImage(hostileImages.svgWithPngInside())).toMatchObject({ ok: false, kind: "svg" });
  });

  it("rejects unknown content", () => {
    expect(sniffImage(hostileImages.html())).toMatchObject({ ok: false, kind: "unknown" });
    expect(sniffImage(new Uint8Array(0))).toMatchObject({ ok: false, kind: "unknown" });
    expect(sniffImage(new Uint8Array([0x89, 0x50]))).toMatchObject({ ok: false, kind: "unknown" });
    // ISO BMFF that is not AVIF (an MP4).
    const mp4 = new Uint8Array([
      0,
      0,
      0,
      16,
      ...[..."ftypisom"].map((c) => c.charCodeAt(0)),
      0,
      0,
      0,
      0,
    ]);
    expect(sniffImage(mp4)).toMatchObject({ ok: false, kind: "unknown" });
  });

  it("rejects zero dimensions", () => {
    expect(sniffImage(pngBytes(0, 10))).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("does not hang or throw on random bytes after a valid signature", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed & 255;
    };
    const signatures = [
      pngBytes().slice(0, 8),
      jpegBytes().slice(0, 3),
      [..."GIF89a"].map((c) => c.charCodeAt(0)),
    ];
    for (let i = 0; i < 300; i++) {
      const sig = signatures[i % signatures.length] as ArrayLike<number>;
      const bytes = new Uint8Array([...Array.from(sig), ...Array.from({ length: i * 3 }, rand)]);
      expect(() => sniffImage(bytes)).not.toThrow();
    }
  });
});

describe("normalizeMediaType", () => {
  it("lowercases, strips parameters and maps aliases", () => {
    expect(normalizeMediaType("IMAGE/PNG; charset=binary")).toBe("image/png");
    expect(normalizeMediaType("image/jpg")).toBe("image/jpeg");
    expect(normalizeMediaType(" image/webp ")).toBe("image/webp");
  });
});
