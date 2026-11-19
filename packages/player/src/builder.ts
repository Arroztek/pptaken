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
  embeddableScript,
  FONT_CATALOG,
  FONT_FAMILY_PATTERN,
  FONT_WEIGHT_PATTERN,
  type FontName,
  LIB_CATALOG,
  scriptProblem,
  UNICODE_RANGE_PATTERN,
} from "@pptaken/schema";
import { assertAssetBaseUrl, assertNonce, type CspOptions, contentSecurityPolicy } from "./csp.js";
import { LIB_SOURCES } from "./libs-source.js";
import { SLIDE_ID_PATTERN } from "./protocol.js";
import { RUNTIME_SHA256, RUNTIME_SOURCE } from "./runtime-source.js";
import { sha256Base64, sha256Hex } from "./sha256.js";

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
  /**
   * Per-response nonce (at least 128 random bits, base64), also used in the CSP header. Required for a static
   * document; must be absent in script mode (no nonce anywhere in a scripted document, ADR-020).
   */
  nonce?: string | undefined;
  /**
   * Script mode (ADR-020): embed the deck's libraries and author scripts and serve a hash-only CSP. Only for the
   * owner's approved session; the caller (the server) decides. Without it, `script` and `libs` are ignored and
   * the document is the static rendering.
   */
  scripts?: boolean | undefined;
  /**
   * Script mode: vendored scripts stored on the instance, by SHA-256 (hex) of the JavaScript, in addition to the
   * bundled ones (`LIB_SOURCES`). The extension point of ingest-time vendoring (ADR-020 §2).
   */
  vendoredScripts?: ReadonlyMap<string, VendoredScriptSource> | undefined;
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

/** The stored files of a vendored script. */
export interface VendoredScriptSource {
  js: string;
  /** Optional stylesheet that ships with it. */
  css?: string | undefined;
}

/** Bundled vendored scripts by SHA-256 (hex), plus the caller's. */
function vendoredScriptSources(
  extra: ReadonlyMap<string, VendoredScriptSource> | undefined,
): Map<string, VendoredScriptSource> {
  const out = new Map<string, VendoredScriptSource>();
  for (const [id, lib] of Object.entries(LIB_SOURCES)) {
    const pinned = Object.hasOwn(LIB_CATALOG, id)
      ? LIB_CATALOG[id as keyof typeof LIB_CATALOG]
      : null;
    if (pinned) out.set(pinned.sha256, { js: lib.js, css: lib.css });
  }
  for (const [sha, source] of extra ?? []) out.set(sha, source);
  return out;
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

const VENDORED_SRC = /^asset:([0-9a-f]{64})$/;
const FORMATS = new Set(["woff2", "woff", "truetype", "opentype"]);
const STYLES = new Set(["normal", "italic", "oblique"]);

/**
 * `@font-face` rules for the deck's vendored faces (`theme.fontFaces`, ADR-022). Every value is re-validated here
 * (the schema checked them on write); a face that does not pass is skipped, never interpolated.
 */
export function vendoredFontFaceCss(deck: Deck, assetBase: string): string {
  const out: string[] = [];
  for (const face of deck.theme?.fontFaces ?? []) {
    const hex = VENDORED_SRC.exec(face.src)?.[1];
    if (
      hex === undefined ||
      !FONT_FAMILY_PATTERN.test(face.family) ||
      !FORMATS.has(face.format) ||
      (face.weight !== undefined && !FONT_WEIGHT_PATTERN.test(face.weight)) ||
      (face.style !== undefined && !STYLES.has(face.style)) ||
      (face.unicodeRange !== undefined && !UNICODE_RANGE_PATTERN.test(face.unicodeRange))
    ) {
      continue;
    }
    const weight = face.weight === undefined ? "" : `font-weight:${face.weight};`;
    const style = face.style === undefined ? "" : `font-style:${face.style};`;
    const range = face.unicodeRange === undefined ? "" : `unicode-range:${face.unicodeRange};`;
    out.push(
      `@font-face{font-family:"${face.family}";${style}${weight}font-display:swap;src:url(${assetBase}${hex}) format("${face.format}");${range}}`,
    );
  }
  return out.join("\n");
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
  const scripted = options?.scripts === true;
  if (scripted) {
    if (options.nonce !== undefined) throw new TypeError("a scripted document has no nonce");
  } else {
    assertNonce(options?.nonce);
  }
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
  const bundledFontCss =
    fontBase !== undefined && options.fontFaces ? fontFaceCss(fontBase, options.fontFaces) : "";
  // Vendored font faces of the deck (ADR-022): stored as assets, served from the asset path (font-src allows it).
  const vendoredFontCss = base === undefined ? "" : vendoredFontFaceCss(deck, base);
  const fontCss = [bundledFontCss, vendoredFontCss].filter((t) => t !== "").join("\n");
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
    const marked = scripted && slide.script !== undefined ? " data-pptaken-script" : "";
    sections.push(
      `<section data-slide="${escapeHtml(slide.id)}"${group}${marked} role="group" aria-roledescription="slide"${label} hidden>` +
        `${rewriteAssets(slide.html, base, true)}</section>`,
    );
    if (slide.css) {
      slideCss.push(rewriteAssets(checkedCss(slide.css, `slides[${index}].css`), base, false));
    }
  });
  const themeCss = deck.theme?.css
    ? rewriteAssets(checkedCss(deck.theme.css, "theme.css"), base, false)
    : "";

  // Script mode: libraries first, then one wrapped script per slide, as the last elements of <body>.
  const libCss: string[] = [];
  const tail: string[] = [];
  const hashes: string[] = [RUNTIME_SHA256];
  if (scripted) {
    const stored = vendoredScriptSources(options.vendoredScripts);
    (deck.libs ?? []).forEach((ref, index) => {
      const lib = stored.get(ref.sha256);
      if (lib === undefined) throw new TypeError(`libs[${index}]: vendored script not available`);
      // The stored bytes must be exactly the referenced ones (the digest binds that hash). CDN code may contain
      // "</script" or "<script" inside strings: it is escaped without changing what it does (ADR-022), and the
      // CSP hash is computed over the text actually embedded.
      if (sha256Hex(lib.js) !== ref.sha256) throw new TypeError(`libs[${index}]: hash mismatch`);
      const js = embeddableScript(lib.js);
      if (js === null) throw new TypeError(`libs[${index}]: cannot be inlined`);
      if (lib.css) libCss.push(checkedCss(lib.css, `libs[${index}]`));
      tail.push(`<script>${js}</script>`);
      hashes.push(scriptHash(js));
    });
    // The deck-level script (ADR-022): once, in the global scope, after the libraries and before the slides.
    // Author scripts carry `data-pptaken-for` (the slide id, or `deck`) and, filled in below, `data-pptaken-line`
    // (the document line their text starts on): the runtime uses them to attribute load errors and to turn document
    // line numbers into the author's own (ADR-023). Attributes are not part of the CSP hash.
    if (deck.script !== undefined) {
      const problem = scriptProblem(deck.script);
      if (problem !== null) throw new TypeError(`script: ${problem}`);
      const text = deck.script.replace(/\r\n?/g, "\n");
      tail.push(`<script data-pptaken-for="deck" data-pptaken-line="@">${text}</script>`);
      hashes.push(scriptHash(text));
    }
    deck.slides.forEach((slide, index) => {
      if (slide.script === undefined) return;
      const text = wrapAuthorScript(slide.id, slide.script, `slides[${index}].script`);
      tail.push(
        `<script data-pptaken-for="${escapeHtml(slide.id)}" data-pptaken-line="@">${text}</script>`,
      );
      hashes.push(scriptHash(text));
    });
  }

  const head = [
    "<!doctype html>",
    `<html${lang === undefined ? "" : ` lang="${escapeHtml(lang)}"`}${scripted ? " data-pptaken-scripts" : ""}>`,
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(deck.title)}</title>`,
    `<style>${fontCss}</style>`,
    `<style>${themeCss}</style>`,
    `<style>${slideCss.join("\n")}</style>`,
    ...(libCss.length > 0 ? [`<style>${libCss.join("\n")}</style>`] : []),
    `<style>${stageCss(width, height)}</style>`,
    scripted
      ? `<script>${RUNTIME_SOURCE}</script>`
      : `<script nonce="${escapeHtml(options.nonce ?? "")}">${RUNTIME_SOURCE}</script>`,
    "</head>",
    "<body>",
    `<div id="pptaken-stage" data-width="${width}" data-height="${height}">`,
    ...sections,
    "</div>",
  ].join("\n");
  // Line numbers as the HTML parser counts them (CRLF, CR and LF are one break each).
  const breaks = (text: string) => text.match(/\r\n?|\n/g)?.length ?? 0;
  let line = breaks(head) + 2;
  const placed = tail.map((element) => {
    const out = element.replace('data-pptaken-line="@"', `data-pptaken-line="${line}"`);
    line += breaks(element) + 1;
    return out;
  });
  const html = [head, ...placed, "</body>", "</html>", ""].join("\n");

  const csp: CspOptions = scripted
    ? { scriptHashes: hashes, assetBaseUrl: base, fontBaseUrl: fontBase }
    : { nonce: options.nonce, assetBaseUrl: base, fontBaseUrl: fontBase };
  if (options.frameAncestors !== undefined) csp.frameAncestors = options.frameAncestors;
  return { html, csp: contentSecurityPolicy(csp) };
}

/**
 * The text of a slide's author script as embedded in a scripted document: line breaks normalized to LF (as the
 * HTML parser does, so the server's hash matches the browser's) and wrapped as
 * `pptaken.register("<id>", function (slide) { … });`. Throws a `TypeError` when the text could escape its
 * `<script>` element (the schema refuses such scripts on ingest; this is the builder's own check).
 */
export function wrapAuthorScript(slideId: string, script: string, where = "script"): string {
  if (!SLIDE_ID_PATTERN.test(slideId)) throw new TypeError(`${where}: invalid slide id`);
  const problem = scriptProblem(script);
  if (problem !== null) throw new TypeError(`${where}: ${problem}`);
  const body = script.replace(/\r\n?/g, "\n");
  return `pptaken.register(${JSON.stringify(slideId)},function(slide){\n${body}\n});`;
}

/** CSP hash source value (SHA-256, base64) of an inline script's text. */
export function scriptHash(text: string): string {
  return sha256Base64(text);
}
