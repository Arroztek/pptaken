// SPDX-License-Identifier: AGPL-3.0-or-later
// Ingest-time vendoring (ADR-022), pure helpers: the error type of the fetcher port, the content checks by kind
// (magic bytes and structure, never the declared type) and library labels derived from CDN URLs.
import {
  decodeUtf8Strict,
  FONT_MEDIA_TYPES,
  looksLikeHtml,
  sniffFont,
  sniffImage,
} from "./media.js";
import type { VendorErrorCode, VendorKind } from "./ports.js";

/** The only error a {@link VendorFetcher} throws. `message` is safe to show to an agent (no secrets). */
export class VendorError extends Error {
  override readonly name = "VendorError";
  constructor(
    readonly code: VendorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isVendorError(value: unknown): value is VendorError {
  if (value instanceof VendorError) return true;
  const v = value as { name?: unknown; code?: unknown } | null;
  return (
    typeof v === "object" && v !== null && v.name === "VendorError" && typeof v.code === "string"
  );
}

/** Per-kind size caps (bytes): the fetcher enforces them while streaming, the core checks them again. */
export const VENDOR_MAX_BYTES: Readonly<Record<VendorKind, number>> = Object.freeze({
  script: 2 * 1024 * 1024,
  stylesheet: 512 * 1024,
  font: 2 * 1024 * 1024,
  image: 8 * 1024 * 1024,
});

/** A fetched resource after its content check. */
export type CheckedResource =
  | { kind: "image"; mediaType: string; width: number | null; height: number | null }
  | { kind: "font"; mediaType: string; format: "woff2" | "woff" | "truetype" | "opentype" }
  | { kind: "script"; mediaType: "text/javascript"; text: string; module: boolean }
  | { kind: "stylesheet"; mediaType: "text/css"; text: string };

/**
 * Checks fetched bytes against what `kind` requires. Images: PNG, JPEG, GIF, WebP or AVIF by signature and
 * container structure (SVG is refused: it can carry markup); fonts: WOFF2, WOFF, TrueType, OpenType with a
 * consistent container; scripts and stylesheets: strict UTF-8 without NUL that is not an HTML page. Throws
 * {@link VendorError} `bad-type` or `too-large`.
 */
export function checkVendored(
  kind: VendorKind,
  bytes: Uint8Array,
  maxImagePixels: number,
): CheckedResource {
  if (bytes.length > VENDOR_MAX_BYTES[kind]) {
    throw new VendorError(
      "too-large",
      `The ${kind} is larger than ${VENDOR_MAX_BYTES[kind]} bytes`,
    );
  }
  if (bytes.length === 0) throw new VendorError("bad-type", `The ${kind} is empty`);
  if (kind === "image") {
    const sniff = sniffImage(bytes);
    if (!sniff.ok) {
      if (sniff.kind === "svg") {
        throw new VendorError(
          "bad-type",
          "SVG images are not vendored (they can carry markup): put the SVG inline in the slide HTML, or use a PNG/WebP URL",
        );
      }
      throw new VendorError(
        "bad-type",
        sniff.kind === "malformed"
          ? `The image looks like ${sniff.mediaType} but is not a valid file (${sniff.reason})`
          : "The content is not a PNG, JPEG, GIF, WebP or AVIF image",
      );
    }
    if (
      sniff.width !== null &&
      sniff.height !== null &&
      sniff.width * sniff.height > maxImagePixels
    ) {
      throw new VendorError("too-large", "The image has too many pixels");
    }
    return { kind, mediaType: sniff.mediaType, width: sniff.width, height: sniff.height };
  }
  if (kind === "font") {
    const sniff = sniffFont(bytes);
    if (!sniff.ok) throw new VendorError("bad-type", `Not a usable font file: ${sniff.reason}`);
    return { kind, mediaType: sniff.mediaType, format: sniff.format };
  }
  const text = decodeUtf8Strict(bytes);
  if (text === null) {
    throw new VendorError(
      "bad-type",
      `The ${kind} is not valid UTF-8 text (or contains NUL characters)`,
    );
  }
  if (looksLikeHtml(text)) {
    throw new VendorError("bad-type", `The URL answered with an HTML page, not a ${kind}`);
  }
  if (kind === "stylesheet") return { kind, mediaType: "text/css", text };
  return { kind, mediaType: "text/javascript", text, module: looksLikeModule(text) };
}

/**
 * True when a script uses ES module syntax at the top level (import/export statements). Such a file cannot run as
 * a classic script, so it is not vendored. A heuristic over statement starts; strings that merely contain the word
 * are not matched.
 */
export function looksLikeModule(text: string): boolean {
  return /(?:^|[\n;}])\s*(?:import\s*(?:[\w$]+\s*(?:,|from\b)|\{|\*|["'])|export\s*(?:\{|\*|default\b|(?:const|let|var|function|class|async)\b))/.test(
    text,
  );
}

/** True for media types the content route may serve as assets (images and fonts; never scripts or CSS). */
export function isServableAssetType(mediaType: string): boolean {
  return (
    mediaType.startsWith("image/") || (FONT_MEDIA_TYPES as readonly string[]).includes(mediaType)
  );
}

const NAME = /[^A-Za-z0-9@/._+-]+/g;
const VERSION = /^[A-Za-z0-9._+-]{1,40}$/;

function pathOf(url: string): string[] {
  const m = /^https?:\/\/[^/?#]+(\/[^?#]*)?/i.exec(url);
  return (m?.[1] ?? "/").split("/").filter((p) => p !== "");
}

/**
 * A human label for a script vendored from a CDN URL: the package name and version for jsDelivr (`/npm/`, `/gh/`),
 * unpkg, esm.sh and cdnjs (`/ajax/libs/<name>/<version>/`); otherwise the file name. The final URL after
 * redirects is preferred (jsDelivr and unpkg resolve version ranges by redirecting).
 */
export function libLabelOf(url: string, finalUrl?: string): { name: string; version?: string } {
  for (const candidate of [finalUrl, url]) {
    if (candidate === undefined) continue;
    const parts = pathOf(candidate);
    const host = (/^https?:\/\/([^/?#]+)/i.exec(candidate)?.[1] ?? "").toLowerCase();
    let pkg: string | undefined;
    if (host === "cdnjs.cloudflare.com" && parts[0] === "ajax" && parts[1] === "libs") {
      const name = parts[2];
      const version = parts[3];
      if (name !== undefined) return label(name, version);
    }
    if (host === "cdn.jsdelivr.net" && (parts[0] === "npm" || parts[0] === "gh")) {
      pkg = parts[1]?.startsWith("@") ? `${parts[1]}/${parts[2] ?? ""}` : parts[1];
    } else if (host === "unpkg.com" || host === "esm.sh" || host === "cdn.skypack.dev") {
      pkg = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0];
    }
    if (pkg !== undefined) {
      const at = pkg.lastIndexOf("@");
      if (at > 0) return label(pkg.slice(0, at), pkg.slice(at + 1));
      return label(pkg, undefined);
    }
  }
  const file = pathOf(finalUrl ?? url).pop() ?? "script";
  return label(file.replace(/(?:\.min)?\.m?js$/i, "") || "script", undefined);
}

function label(name: string, version: string | undefined): { name: string; version?: string } {
  const clean = decodeSafe(name).replace(NAME, "-").slice(0, 80) || "script";
  const v = version === undefined ? undefined : decodeSafe(version).slice(0, 40);
  return v !== undefined && VERSION.test(v) ? { name: clean, version: v } : { name: clean };
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Ranks a font face's unicode-range for trimming: basic Latin first, then Latin extended, then the rest. */
export function fontSubsetRank(unicodeRange: string | undefined): number {
  if (unicodeRange === undefined) return 0;
  const r = unicodeRange.toUpperCase();
  if (/U\+0000-00FF/.test(r)) return 0;
  if (/U\+0100-02(?:AF|BA)/.test(r) || /U\+0100-024F/.test(r)) return 1;
  return 2;
}
