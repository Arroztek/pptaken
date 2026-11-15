// SPDX-License-Identifier: Apache-2.0
// Server side: the offline deck document, the copy the service worker stores and the shell mounts with `srcdoc`
// when the content route cannot be reached (offline layer 2). Pure function, no DOM.
//
// Same approach and security parity as the single-file HTML export (`@pptaken/export`), see ADR-001:
// - barrier 1: the deck must come from `sanitizeDeck`; the builder inserts slide HTML/CSS as they are;
// - barrier 2: the shell mounts it in the same `<iframe sandbox="allow-scripts">` (opaque origin);
// - barrier 3: the CSP travels as the first `<meta>` of `<head>`, before anything the content controls: no network
//   at all (`connect-src 'none'`, images and fonts only as `data:` URIs inlined here, a nonce for the runtime).
//   A srcdoc frame also inherits the page's CSP, so both policies apply. `sandbox` and `frame-ancestors` cannot be
//   set by `<meta>`; the iframe attribute provides the sandbox, and a srcdoc document cannot be framed elsewhere.
// - T7: speaker notes are removed before building (they are never in a content document).

import { type Deck, FONT_CATALOG, type FontName } from "@pptaken/schema";
import { buildDeckDocument, type FontFaceSpec } from "./builder.js";
import { OFFLINE_DOCUMENT_CSP } from "./offline.js";

/** Raster types the core accepts as assets (the same set the HTML export inlines). */
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface OfflineAsset {
  mediaType: string;
  /** The file, base64 encoded. */
  base64: string;
}

/** A bundled font face with its WOFF2 file, base64 encoded (validated like `FontFaceSpec`). */
export interface OfflineFont extends Omit<FontFaceSpec, "file"> {
  family: FontName;
  base64: string;
}

export interface OfflineDocumentOptions {
  /** Fresh nonce (at least 128 random bits, base64). Kept in the stored copy, like in an exported file. */
  nonce: string;
  /** Assets by full SHA-256 (64 lowercase hex). References to anything else are left as they are (they fail). */
  assets?: ReadonlyMap<string, OfflineAsset>;
  /** Every bundled face (the runtime preloads all declared faces). */
  fonts?: readonly OfflineFont[];
}

export interface OfflineDocument {
  html: string;
  /** `asset:` references that could not be inlined (missing or not an image): they will not display. */
  missing: string[];
}

const ASSET_ATTR = /(\s(?:src|href)=")asset:([0-9a-f]{16,64})(?=")/g;
const ASSET_URL = /url\((["']|&quot;)?asset:([0-9a-f]{16,64})\1\)/g;
const FONT_WEIGHT = /^[1-9][0-9]{2}(?: [1-9][0-9]{2})?$/;
const UNICODE_RANGE =
  /^U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?:, ?U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?)*$/;

/** Builds the offline deck document. Throws a `TypeError` on invalid options or unsanitized input. */
export function buildOfflineDocument(deck: Deck, options: OfflineDocumentOptions): OfflineDocument {
  const assets = options.assets ?? new Map<string, OfflineAsset>();
  const missing = new Set<string>();
  const uriOf = (hex: string): string | null => {
    const asset = assets.get(hex);
    if (!asset || !MEDIA_TYPES.has(asset.mediaType) || !BASE64.test(asset.base64)) {
      missing.add(hex);
      return null;
    }
    return `data:${asset.mediaType};base64,${asset.base64}`;
  };
  const rewrite = (text: string, html: boolean): string => {
    let out = text.replace(ASSET_URL, (match, quote: string | undefined, hex: string) => {
      const uri = uriOf(hex);
      return uri === null ? match : `url(${quote ?? ""}${uri}${quote ?? ""})`;
    });
    if (html) {
      out = out.replace(ASSET_ATTR, (match, prefix: string, hex: string) => {
        const uri = uriOf(hex);
        return uri === null ? match : `${prefix}${uri}`;
      });
    }
    return out;
  };
  const inner: Deck = {
    ...deck,
    slides: deck.slides.map(({ notes: _notes, ...slide }) => {
      const out = { ...slide, html: rewrite(slide.html, true) };
      if (slide.css !== undefined) out.css = rewrite(slide.css, false);
      return out;
    }),
  };
  if (deck.theme?.css !== undefined)
    inner.theme = { ...deck.theme, css: rewrite(deck.theme.css, false) };

  const faces = (options.fonts ?? []).map((face, index) => {
    const style = face.style ?? "normal";
    if (
      !FONT_WEIGHT.test(face.weight) ||
      (style !== "normal" && style !== "italic") ||
      (face.unicodeRange !== undefined && !UNICODE_RANGE.test(face.unicodeRange)) ||
      !BASE64.test(face.base64) ||
      !(FONT_CATALOG as readonly string[]).includes(face.family)
    ) {
      throw new TypeError(`fonts[${index}] is not a valid font face`);
    }
    const range = face.unicodeRange === undefined ? "" : `unicode-range:${face.unicodeRange};`;
    return `@font-face{font-family:"${face.family}";font-style:${style};font-weight:${face.weight};font-display:swap;src:url(data:font/woff2;base64,${face.base64}) format("woff2");${range}}`;
  });

  // The builder checks the nonce and refuses unsanitized CSS; no asset or font base URL: nothing is fetched.
  const built = buildDeckDocument(inner, { nonce: options.nonce });
  const head = "<head>\n";
  const at = built.html.indexOf(head);
  if (at < 0 || at > 200) throw new TypeError("unexpected deck document shape");
  const csp = OFFLINE_DOCUMENT_CSP.replace("{nonce}", options.nonce);
  const html =
    built.html.slice(0, at + head.length) +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
    (faces.length > 0 ? `<style>${faces.join("\n")}</style>\n` : "") +
    built.html.slice(at + head.length);
  return { html, missing: [...missing] };
}
