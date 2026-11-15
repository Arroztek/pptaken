// SPDX-License-Identifier: Apache-2.0
// Server-side document builder: turns an already sanitized deck into the HTML document served by the content
// route and shown in the sandboxed iframe. Pure function, no DOM.
//
// Trust: slide HTML and CSS must come from `sanitizeDeck` (barrier 1). They are inserted as they are; everything
// the builder adds itself (title, lang, ids, nonce, URLs) is validated and escaped.

import {
  type AspectRatio,
  canvasSize,
  type Deck,
  FONT_CATALOG,
  type FontName,
} from "@pptaken/schema";
import { assertAssetBaseUrl, assertNonce, type CspOptions, contentSecurityPolicy } from "./csp.js";
import { SLIDE_ID_PATTERN } from "./protocol.js";
import { RUNTIME_SOURCE } from "./runtime-source.js";

/** One `@font-face` rule of a bundled font (a variable WOFF2 subset). All fields are validated. */
export interface FontFaceSpec {
  /** A family of the font catalog, used by name in slide CSS. */
  family: FontName;
  /** Path of the WOFF2 file below `fontBaseUrl`, for example `inter/inter-latin-wght.woff2`. */
  file: string;
  /** CSS weight range, for example `100 900` or `400`. */
  weight: string;
  /** Defaults to `normal`. */
  style?: "normal" | "italic" | undefined;
  /** CSS `unicode-range` of the subset, for example `U+0000-00FF, U+0131`. */
  unicodeRange?: string | undefined;
}

export interface BuildOptions {
  /** Per-response nonce (at least 128 random bits, base64), also used in the CSP header. Required. */
  nonce: string;
  /** Absolute URL of the content asset path; `asset:<hex>` references are rewritten to `<assetBaseUrl><hex>`. */
  assetBaseUrl?: string | undefined;
  /** Absolute URL of the bundled-font path (ending in `/`); required to use `fontFaces`. */
  fontBaseUrl?: string | undefined;
  /** `@font-face` rules for the bundled fonts. Declared faces are only downloaded when a slide uses the family. */
  fontFaces?: readonly FontFaceSpec[] | undefined;
  /** Document language; defaults to the deck's `lang`. */
  lang?: string | undefined;
  /** Origins allowed to frame the document (CSP `frame-ancestors`). */
  frameAncestors?: readonly string[] | undefined;
}

export interface DeckDocument {
  /** The complete HTML document. */
  html: string;
  /** Value of the `Content-Security-Policy` header that must be sent with it. */
  csp: string;
}

const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Print rules under a selector prefix that matches `html` (print mode attribute, or `@media print`). */
function printCss(p: string, width: number): string {
  return [
    `${p},${p} body{height:auto!important;overflow:visible!important}`,
    `${p} #pptaken-stage{position:static!important;transform:none!important;width:${width}px!important;height:auto!important;overflow:visible!important}`,
    `${p} #pptaken-stage>section[data-slide]{position:relative!important;display:block!important;transform:none!important;break-after:page!important;break-inside:avoid!important}`,
    `${p} #pptaken-stage [data-step]{visibility:visible!important}`,
    `${p} #pptaken-overlay{display:none!important}`,
    `${p} *{print-color-adjust:exact!important;-webkit-print-color-adjust:exact!important}`,
  ].join("\n");
}

/**
 * Stage rules. Last in the document; `!important` where the theme must not break the player. Overview and print
 * layouts are keyed on `html[data-pptaken-mode]`, which only the runtime sets (content cannot run script, and
 * the sanitizer refuses `data-*` attributes other than `data-step`).
 */
function stageCss(width: number, height: number): string {
  const o = "html[data-pptaken-mode=overview]";
  return [
    "html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;overflow:hidden!important;background:#000!important}",
    `#pptaken-stage{position:absolute!important;left:0!important;top:0!important;width:${width}px!important;height:${height}px!important;margin:0!important;transform-origin:0 0!important;overflow:hidden!important}`,
    `#pptaken-stage>section[data-slide]{position:absolute!important;left:0!important;top:0!important;width:${width}px!important;height:${height}px!important;margin:0!important;overflow:hidden!important;contain:layout paint}`,
    "#pptaken-stage>section[data-slide][hidden]{display:none!important}",
    ":where(#pptaken-stage>section[data-slide]){display:block;box-sizing:border-box;background:#fff;color:#000}",
    "#pptaken-stage [data-step]:not(.pptaken-revealed){visibility:hidden!important}",
    "#pptaken-overlay{display:none!important}",
    // Overview: the stage becomes a scrollable grid; the runtime positions each section with an inline transform.
    `${o} #pptaken-stage{position:fixed!important;inset:0!important;width:auto!important;height:auto!important;transform:none!important;overflow:auto!important}`,
    `${o} #pptaken-stage>section[data-slide]{display:block!important;transform-origin:0 0!important;cursor:pointer;content-visibility:auto}`,
    `${o} #pptaken-stage>section[data-slide] *{pointer-events:none!important}`,
    `${o} #pptaken-stage [data-step]{visibility:visible!important}`,
    `${o} #pptaken-overlay{display:block!important;position:absolute!important;left:0!important;top:0!important;width:1px!important;margin:0!important;font:14px/20px "JetBrains Mono",ui-monospace,monospace!important;color:#8B8FA0!important}`,
    `${o} #pptaken-overlay>div{position:absolute!important;display:block!important;margin:0!important;padding:0!important;overflow:hidden!important;white-space:pre!important;text-overflow:ellipsis!important;cursor:pointer;background:none!important;font:inherit!important;color:inherit!important}`,
    `${o} #pptaken-overlay>.pptaken-sec{color:#F2EFE9!important;font-weight:600!important;letter-spacing:.08em!important;text-transform:uppercase!important}`,
    `${o} #pptaken-overlay>#pptaken-mark{box-sizing:border-box!important;border:3px solid #A99BFF!important;border-radius:6px!important;pointer-events:none!important}`,
    // Print: every slide with every step, one canvas per page, backgrounds kept.
    printCss("html[data-pptaken-mode=print]", width),
    `@media print{${printCss("html", width)}}`,
    `@page{size:${width}px ${height}px;margin:0}`,
  ].join("\n");
}

const FONT_FILE = /^(?:[a-z0-9-]{1,40}\/)?[a-z0-9-]{1,80}\.woff2$/;
const FONT_WEIGHT = /^[1-9][0-9]{2}(?: [1-9][0-9]{2})?$/;
const UNICODE_RANGE =
  /^U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?:, ?U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?)*$/;

/** Builds the `@font-face` rules for the bundled fonts; every interpolated value is validated first. */
function fontFaceCss(base: string, faces: readonly FontFaceSpec[]): string {
  return faces
    .map((face, index) => {
      if (!(FONT_CATALOG as readonly string[]).includes(face.family))
        throw new TypeError(`fontFaces[${index}].family is not in the font catalog`);
      if (typeof face.file !== "string" || !FONT_FILE.test(face.file))
        throw new TypeError(`fontFaces[${index}].file is not a valid WOFF2 path`);
      if (typeof face.weight !== "string" || !FONT_WEIGHT.test(face.weight))
        throw new TypeError(`fontFaces[${index}].weight is not a valid weight or range`);
      const style = face.style ?? "normal";
      if (style !== "normal" && style !== "italic")
        throw new TypeError(`fontFaces[${index}].style must be normal or italic`);
      if (face.unicodeRange !== undefined && !UNICODE_RANGE.test(face.unicodeRange))
        throw new TypeError(`fontFaces[${index}].unicodeRange is not valid`);
      const range = face.unicodeRange === undefined ? "" : `unicode-range:${face.unicodeRange};`;
      return `@font-face{font-family:"${face.family}";font-style:${style};font-weight:${face.weight};font-display:swap;src:url(${base}${face.file}) format("woff2");${range}}`;
    })
    .join(String.fromCharCode(10));
}

/** Escapes text for HTML text content and double-quoted attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Exact asset tokens in the two places sanitized content can hold them: a whole `src`/`href` attribute value
// (parse5 always serializes attributes with double quotes) and a whole `url()` argument, quoted or not.
const ASSET_ATTR = /(\s(?:src|href)=")asset:([0-9a-f]{16,64})(?=")/g;
const ASSET_URL = /url\((["']|&quot;)?asset:([0-9a-f]{16,64})\1\)/g;

function rewriteAssets(text: string, base: string | undefined, html: boolean): string {
  if (base === undefined) return text;
  let out = text.replace(
    ASSET_URL,
    (_match, quote: string | undefined, hex: string) =>
      `url(${quote ?? ""}${base}${hex}${quote ?? ""})`,
  );
  if (html) {
    out = out.replace(
      ASSET_ATTR,
      (_match, prefix: string, hex: string) => `${prefix}${base}${hex}`,
    );
  }
  return out;
}

/** Sanitized CSS never contains `</` or `<!`; refuse anything that could close the `<style>` element. */
function checkedCss(css: string, where: string): string {
  if (/<\/|<!/.test(css))
    throw new TypeError(`${where}: CSS is not sanitized (contains "</" or "<!")`);
  return css;
}

/**
 * Builds the deck document: one `<section data-slide="<id>" hidden>` per slide inside `#pptaken-stage`, the theme
 * CSS, every slide's CSS (scoped by the sanitizer to `[data-slide="<id>"]`), the stage CSS and the runtime as an
 * inline `<script nonce>`. Throws a `TypeError` on invalid options or on input that cannot have been sanitized.
 */
export function buildDeckDocument(deck: Deck, options: BuildOptions): DeckDocument {
  assertNonce(options?.nonce);
  const base = options.assetBaseUrl;
  if (base !== undefined) assertAssetBaseUrl(base);
  const lang = options.lang ?? deck.lang;
  if (lang !== undefined && !LANG.test(lang)) throw new TypeError("lang must be a BCP-47 tag");
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) {
    throw new TypeError("deck must have at least one slide");
  }
  const fontBase = options.fontBaseUrl;
  if (fontBase !== undefined) assertAssetBaseUrl(fontBase);
  if (options.fontFaces !== undefined && options.fontFaces.length > 0 && fontBase === undefined) {
    throw new TypeError("fontFaces requires fontBaseUrl");
  }
  const fontCss =
    fontBase !== undefined && options.fontFaces ? fontFaceCss(fontBase, options.fontFaces) : "";
  const ratio: AspectRatio = deck.aspectRatio === "4:3" ? "4:3" : "16:9";
  const { width, height } = canvasSize(ratio);

  const ids = new Set<string>();
  const sections: string[] = [];
  const slideCss: string[] = [];
  deck.slides.forEach((slide, index) => {
    if (!SLIDE_ID_PATTERN.test(slide.id)) throw new TypeError(`slides[${index}].id is not valid`);
    if (ids.has(slide.id)) throw new TypeError(`slides[${index}].id is duplicated`);
    ids.add(slide.id);
    const label = slide.title ? ` aria-label="${escapeHtml(slide.title)}"` : "";
    const group = slide.section ? ` data-section="${escapeHtml(slide.section)}"` : "";
    sections.push(
      `<section data-slide="${escapeHtml(slide.id)}"${group} role="group" aria-roledescription="slide"${label} hidden>` +
        `${rewriteAssets(slide.html, base, true)}</section>`,
    );
    if (slide.css) {
      slideCss.push(rewriteAssets(checkedCss(slide.css, `slides[${index}].css`), base, false));
    }
  });
  const themeCss = deck.theme?.css
    ? rewriteAssets(checkedCss(deck.theme.css, "theme.css"), base, false)
    : "";

  const html = [
    "<!doctype html>",
    `<html${lang === undefined ? "" : ` lang="${escapeHtml(lang)}"`}>`,
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(deck.title)}</title>`,
    `<style>${fontCss}</style>`,
    `<style>${themeCss}</style>`,
    `<style>${slideCss.join("\n")}</style>`,
    `<style>${stageCss(width, height)}</style>`,
    `<script nonce="${escapeHtml(options.nonce)}">${RUNTIME_SOURCE}</script>`,
    "</head>",
    "<body>",
    `<div id="pptaken-stage" data-width="${width}" data-height="${height}">`,
    ...sections,
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

  const csp: CspOptions = { nonce: options.nonce, assetBaseUrl: base, fontBaseUrl: fontBase };
  if (options.frameAncestors !== undefined) csp.frameAncestors = options.frameAncestors;
  return { html, csp: contentSecurityPolicy(csp) };
}
