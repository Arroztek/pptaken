// SPDX-License-Identifier: AGPL-3.0-or-later
// Export to a single self-contained HTML file that works from `file://` (double click) without a server or a
// network: an outer trusted page with an inline shell, and the deck document built by `@pptaken/player` inside a
// sandboxed `<iframe srcdoc>`, with images and fonts inlined as `data:` URIs.
//
// Security parity with the server's content route (ADR-001):
// - barrier 1: the deck must already be sanitized (the core stores only sanitized decks); nothing is re-parsed;
// - barrier 2: `<iframe sandbox="allow-scripts">` gives the deck an opaque origin (no access to the parent);
// - barrier 3: a CSP `<meta>` in the deck document (no network at all: `img-src data:`, `font-src data:`,
//   `connect-src 'none'`, a nonce for the runtime). The outer page carries the same policy, and a srcdoc frame
//   inherits it, so both apply. `sandbox` and `frame-ancestors` cannot be set by `<meta>`; the iframe attribute
//   provides the sandbox.
// - T7: speaker notes are removed unless `includeNotes` is set; they are then shown only by the outer page.

import { randomBytes } from "node:crypto";
import { buildDeckDocument, escapeHtml, vendoredFontFaceCss } from "@pptaken/player";
import { type Deck, FONT_CATALOG, type FontName } from "@pptaken/schema";
import { exportFilenames } from "./filename.js";
import { pptakenShell, type ShellConfig } from "./shell.js";

/** Above this size the result carries a `LARGE_FILE` warning (browsers get slow to open such files). */
export const HTML_SIZE_WARNING_BYTES = 25 * 1024 * 1024;

/** Raster types the core accepts as assets; anything else is not inlined. */
const INLINE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export interface HtmlAsset {
  mediaType: string;
  bytes: Uint8Array;
}

/** A bundled font face to embed. Validated like the player's `FontFaceSpec`. */
export interface EmbeddedFont {
  family: FontName;
  /** CSS weight or range, for example `400` or `100 900`. */
  weight: string;
  style?: "normal" | "italic" | undefined;
  unicodeRange?: string | undefined;
  /** The WOFF2 file. */
  bytes: Uint8Array;
}

export interface ExportHtmlInput {
  /** The stored, sanitized deck. */
  deck: Deck;
  /** Assets by SHA-256 (64 lowercase hex). `asset:` references may use a unique prefix, as in the core. */
  assets?: ReadonlyMap<string, HtmlAsset>;
  /** Keep the speaker notes (shown with the `n` key, outside the deck frame). Default `false` (T7). */
  includeNotes?: boolean;
  /**
   * Bundled font faces available for embedding. Only the faces of families the deck uses (theme fonts, or named in
   * its CSS or HTML) are embedded.
   */
  fonts?: readonly EmbeddedFont[];
  /** Show the `n / N` counter for 2 s after each move. Default `true`. */
  counter?: boolean;
  /** For the generator `<meta>`, for example `pptaken 0.2.0`. */
  generator?: string;
}

export type ExportWarningCode =
  | "MISSING_ASSET"
  | "UNSUPPORTED_ASSET"
  | "FONT_SKIPPED"
  | "LARGE_FILE";

export interface ExportWarning {
  code: ExportWarningCode;
  message: string;
}

export interface ExportedHtml {
  html: string;
  /** ASCII file name: the slugified title plus `.html`. */
  filename: string;
  /** UTF-8 size of `html`. */
  bytes: number;
  includesNotes: boolean;
  /** Families whose font files were embedded. */
  embeddedFonts: FontName[];
  warnings: ExportWarning[];
}

// The exact asset tokens the player rewrites (see @pptaken/player builder.ts): a whole `src`/`href` attribute
// value (parse5 serializes attributes with double quotes) and a whole `url()` argument, quoted or not.
const ASSET_ATTR = /(\s(?:src|href)=")asset:([0-9a-f]{16,64})(?=")/g;
const ASSET_URL = /url\((["']|&quot;)?asset:([0-9a-f]{16,64})\1\)/g;

const FONT_WEIGHT = /^[1-9][0-9]{2}(?: [1-9][0-9]{2})?$/;
const UNICODE_RANGE =
  /^U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?:, ?U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?)*$/;

const TEXTS: Record<"en" | "es", { slow: string; notes: string; noscript: string; frame: string }> =
  {
    en: {
      slow: "This presentation is taking too long to start. Open the file in an up-to-date browser.",
      notes: "Notes",
      noscript: "This presentation needs JavaScript.",
      frame: "Presentation",
    },
    es: {
      slow: "La presentación tarda demasiado en empezar. Abre el archivo en un navegador actualizado.",
      notes: "Notas",
      noscript: "Esta presentación necesita JavaScript.",
      frame: "Presentación",
    },
  };

/** Escapes a value for a double-quoted attribute: only `&` and `"` can end or alter it. */
function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// `<`, `>`, `&` and the two JavaScript line separators U+2028 and U+2029 (built from code points so that the
// source file itself never contains them).
const SCRIPT_UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/** JSON for an inline `<script>`: no `<`, `>`, `&` (so no `</script>` or `<!--`) and no line separators. */
export function scriptJson(value: unknown): string {
  const backslash = String.fromCharCode(92);
  return JSON.stringify(value).replace(
    SCRIPT_UNSAFE,
    (ch) => `${backslash}u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function isWoff2(bytes: Uint8Array): boolean {
  return (
    bytes.length > 48 &&
    bytes[0] === 0x77 &&
    bytes[1] === 0x4f &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x32
  );
}

/** Families of the font catalog the deck uses: theme fonts, plus any family named in its CSS or HTML. */
export function fontsUsedBy(deck: Deck): FontName[] {
  const text = [deck.theme?.css ?? "", ...deck.slides.flatMap((s) => [s.css ?? "", s.html])]
    .join("\n")
    .toLowerCase();
  const declared = new Set<string>(deck.theme?.fonts ?? []);
  return FONT_CATALOG.filter(
    (family) => declared.has(family) || text.includes(family.toLowerCase()),
  );
}

/**
 * Builds the single-file HTML export. Throws a `TypeError` when the deck cannot have been sanitized (the player's
 * builder checks) or when the built document does not have the expected shape.
 */
export function exportHtml(input: ExportHtmlInput): ExportedHtml {
  const { deck } = input;
  const warnings: ExportWarning[] = [];
  const includeNotes = input.includeNotes === true;
  const lang = deck.lang ?? "en";
  const texts = TEXTS[lang.toLowerCase().startsWith("es") ? "es" : "en"];

  // 1. Assets: exact-token rewriting of `asset:<hex>` to data: URIs.
  const assets = input.assets ?? new Map<string, HtmlAsset>();
  const dataUris = new Map<string, string | null>();
  const reported = new Set<string>();
  const resolve = (hex: string): string | null => {
    const cached = dataUris.get(hex);
    if (cached !== undefined) return cached;
    let asset = assets.get(hex);
    if (asset === undefined && hex.length < 64) {
      const matches = [...assets.keys()].filter((sha) => sha.startsWith(hex));
      if (matches.length === 1) asset = assets.get(matches[0] as string);
    }
    let uri: string | null = null;
    if (asset === undefined) {
      if (!reported.has(hex)) {
        warnings.push({
          code: "MISSING_ASSET",
          message: `asset:${hex} is not available; it will not display`,
        });
      }
    } else if (!INLINE_MEDIA_TYPES.has(asset.mediaType)) {
      if (!reported.has(hex)) {
        warnings.push({
          code: "UNSUPPORTED_ASSET",
          message: `asset:${hex} has type ${asset.mediaType.slice(0, 60)}, which is not inlined`,
        });
      }
    } else {
      uri = `data:${asset.mediaType};base64,${base64(asset.bytes)}`;
    }
    reported.add(hex);
    dataUris.set(hex, uri);
    return uri;
  };
  const rewrite = (text: string, html: boolean): string => {
    let out = text.replace(ASSET_URL, (match, quote: string | undefined, hex: string) => {
      const uri = resolve(hex);
      return uri === null ? match : `url(${quote ?? ""}${uri}${quote ?? ""})`;
    });
    if (html) {
      out = out.replace(ASSET_ATTR, (match, prefix: string, hex: string) => {
        const uri = resolve(hex);
        return uri === null ? match : `${prefix}${uri}`;
      });
    }
    return out;
  };

  const notes = deck.slides.map((s) => s.notes ?? "");
  const inner: Deck = {
    ...deck,
    // Notes never enter the deck document, even when they are exported (T7).
    slides: deck.slides.map(({ notes: _notes, ...slide }) => {
      const out = { ...slide, html: rewrite(slide.html, true) };
      if (slide.css !== undefined) out.css = rewrite(slide.css, false);
      return out;
    }),
  };
  if (deck.theme?.css !== undefined)
    inner.theme = { ...deck.theme, css: rewrite(deck.theme.css, false) };

  // 2. Fonts used by the deck, as data: URIs.
  const used = new Set<string>(fontsUsedBy(deck));
  const embedded = new Set<FontName>();
  const faceRules: string[] = [];
  for (const [index, face] of (input.fonts ?? []).entries()) {
    if (!used.has(face.family)) continue;
    const style = face.style ?? "normal";
    const valid =
      (FONT_CATALOG as readonly string[]).includes(face.family) &&
      FONT_WEIGHT.test(face.weight) &&
      (style === "normal" || style === "italic") &&
      (face.unicodeRange === undefined || UNICODE_RANGE.test(face.unicodeRange)) &&
      isWoff2(face.bytes);
    if (!valid) {
      warnings.push({ code: "FONT_SKIPPED", message: `fonts[${index}] is not a valid WOFF2 face` });
      continue;
    }
    const range = face.unicodeRange === undefined ? "" : `unicode-range:${face.unicodeRange};`;
    faceRules.push(
      `@font-face{font-family:"${face.family}";font-style:${style};font-weight:${face.weight};font-display:block;src:url(data:font/woff2;base64,${base64(face.bytes)}) format("woff2");${range}}`,
    );
    embedded.add(face.family);
  }

  // 2b. Vendored font faces of the deck (ADR-022), from the exported assets.
  for (const face of deck.theme?.fontFaces ?? []) {
    const hex = /^asset:([0-9a-f]{64})$/.exec(face.src)?.[1];
    const asset = hex === undefined ? undefined : input.assets?.get(hex);
    if (asset === undefined || !/^font\/(?:woff2|woff|ttf|otf)$/.test(asset.mediaType)) continue;
    const rule = vendoredFontFaceCss(
      { ...deck, theme: { fontFaces: [face] } },
      "https://export.invalid/",
    );
    if (rule === "") continue;
    faceRules.push(
      rule.replace(
        `url(https://export.invalid/${hex})`,
        `url(data:${asset.mediaType};base64,${base64(asset.bytes)})`,
      ),
    );
  }
  if (inner.theme?.fontFaces !== undefined) {
    const { fontFaces: _f, ...theme } = inner.theme;
    inner.theme = theme;
  }

  // 3. The deck document (fresh nonce), with the CSP meta and the font faces first in <head>.
  const nonce = randomBytes(18).toString("base64");
  const built = buildDeckDocument(inner, { nonce });
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join("; ");
  const headAt = built.html.indexOf("<head>");
  const bodyAt = built.html.indexOf("<body>");
  if (headAt < 0 || bodyAt < headAt) throw new TypeError("unexpected deck document shape");
  const headEnd = headAt + "<head>".length;
  const innerHtml =
    built.html.slice(0, headEnd) +
    `\n<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    (faceRules.length > 0 ? `\n<style>${faceRules.join("\n")}</style>` : "") +
    built.html.slice(headEnd);

  // 4. The outer page.
  const shellSource = pptakenShell.toString();
  const config: ShellConfig = {
    notes: includeNotes ? notes : null,
    counter: input.counter !== false,
    slowText: texts.slow,
    notesLabel: texts.notes,
  };
  const script = `(${shellSource})(${scriptJson(config)});`;
  if (/<\/script|<!--/i.test(script)) throw new TypeError("shell script cannot be inlined");
  const title = escapeHtml(deck.title);
  const html = [
    "<!doctype html>",
    `<html lang="${escapeHtml(lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp.replace("frame-src 'none'", "frame-src 'self'")}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    input.generator === undefined
      ? ""
      : `<meta name="generator" content="${escapeHtml(input.generator)}">`,
    `<title>${title}</title>`,
    `<style>${OUTER_CSS}</style>`,
    `<script nonce="${nonce}">${script}</script>`,
    "</head>",
    '<body data-state="loading">',
    '<div id="pptaken-host">',
    `<iframe id="pptaken-frame" sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" title="${escapeHtml(texts.frame)}: ${title}" srcdoc="${escapeAttribute(innerHtml)}"></iframe>`,
    '<div id="pptaken-guard"></div>',
    '<div id="pptaken-curtain" hidden></div>',
    '<div id="pptaken-hud" aria-hidden="true"></div>',
    includeNotes
      ? `<aside id="pptaken-notes" aria-label="${escapeHtml(texts.notes)}" hidden><div class="head"></div><div class="body"></div></aside>`
      : "",
    '<p id="pptaken-status" role="status" hidden></p>',
    `<noscript><p class="noscript">${escapeHtml(texts.noscript)}</p></noscript>`,
    "</div>",
    "</body>",
    "</html>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > HTML_SIZE_WARNING_BYTES) {
    warnings.push({
      code: "LARGE_FILE",
      message: `The file is ${(bytes / 1024 / 1024).toFixed(1)} MB; browsers may be slow to open it. Compress the images to make it smaller.`,
    });
  }
  return {
    html,
    filename: exportFilenames(deck.title, ".html").ascii,
    bytes,
    includesNotes: includeNotes,
    embeddedFonts: [...embedded],
    warnings,
  };
}

const OUTER_CSS = [
  "html,body{margin:0;height:100%;background:#000;overflow:hidden}",
  "#pptaken-host{position:fixed;inset:0;background:#000}",
  "#pptaken-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#000}",
  "#pptaken-guard,#pptaken-curtain{position:absolute;inset:0}",
  "#pptaken-curtain{background:#000}",
  "#pptaken-hud{position:absolute;right:16px;bottom:16px;padding:6px 10px;border-radius:4px;background:rgba(0,0,0,.6);color:#8B8FA0;font:14px/1 ui-monospace,Menlo,Consolas,monospace;pointer-events:none;opacity:0;transition:opacity 200ms cubic-bezier(.2,0,0,1)}",
  "#pptaken-hud.on{opacity:1}",
  "@media (prefers-reduced-motion:reduce){#pptaken-hud{transition:none}}",
  "#pptaken-notes{position:absolute;left:0;right:0;bottom:0;max-height:40%;overflow:auto;box-sizing:border-box;padding:16px 24px;background:rgba(16,17,20,.95);color:#FAF7F2;font:20px/1.5 system-ui,sans-serif;white-space:pre-wrap}",
  "#pptaken-notes .head{font-size:14px;color:#8B8FA0;margin-bottom:8px}",
  "#pptaken-status,.noscript{position:absolute;left:16px;bottom:16px;margin:0;color:#8B8FA0;font:16px system-ui,sans-serif}",
  "[hidden]{display:none!important}",
].join("\n");
