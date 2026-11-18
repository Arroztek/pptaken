// SPDX-License-Identifier: AGPL-3.0-or-later
// Ingest-time vendoring (ADR-022): when a deck is written, every external resource it references (stylesheets,
// fonts, images, classic scripts) is fetched ONCE through the `VendorFetcher` port, checked by content, stored as a
// content-addressed asset of the deck, and the deck is rewritten to `asset:<sha256>` references. Viewers never
// contact third parties. Fetched scripts become `libs` entries, so they are part of the scripts digest and need the
// owner's approval before they run (ADR-020). Best effort: a resource that cannot be vendored is dropped with a
// `VENDOR_FAILED` warning; the write still succeeds. With the operator switch off, a write that references external
// resources is refused (`FETCH_BLOCKED`).
import {
  type ExternalResolver,
  type ExtractedFontFace,
  transformCssExternals,
  transformHtmlExternals,
} from "@pptaken/sanitizer";
import {
  type Deck,
  type FontFace,
  googleFontsCssUrl,
  googleFontsSchema,
  LIB_CATALOG,
  LIB_IDS,
  LIMITS,
  type VendoredResource,
  type VendoredScript,
} from "@pptaken/schema";
import { assetRefsOf, type CoreWarning } from "../deck.js";
import { DomainError, limitExceeded, validationError } from "../errors.js";
import type { AssetRecord, Repositories, VendorErrorCode, VendorKind } from "../ports.js";
import type { CallContext, Principal } from "../principal.js";
import { sha256Hex } from "../sha256.js";
import {
  type CheckedResource,
  checkVendored,
  fontSubsetRank,
  isVendorError,
  libLabelOf,
  VENDOR_MAX_BYTES,
  VendorError,
} from "../vendor.js";
import { actorRef, audit, type Ctx } from "./context.js";

/** Warning codes of the vendoring stage (added to the sanitizer's). */
export type VendorWarningCode =
  | "VENDOR_FAILED"
  | "VENDOR_UNSUPPORTED"
  | "VENDOR_ES_MODULE"
  | "VENDOR_FONTS_TRIMMED"
  | "VENDOR_STYLESHEET_SKIPPED"
  | "VENDOR_RELATIVE_URL";

/** One line of the vendoring report returned to the agent. */
export interface VendorReportEntry {
  kind: VendorKind;
  url: string;
  /** `vendored`: fetched now; `reused`: already stored for this deck (no network); `failed`: dropped. */
  status: "vendored" | "reused" | "failed";
  finalUrl?: string;
  bytes?: number;
  sha256?: string;
  error?: VendorErrorCode;
  message?: string;
}

/** An asset produced by vendoring, to insert and link in the write's transaction. */
export interface VendoredAsset {
  sha256: string;
  mediaType: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface VendorOutcome {
  /** The rewritten envelope (the input itself when nothing was vendored). */
  envelope: unknown;
  assets: VendoredAsset[];
  /** SHA-256 of the vendored scripts available to `libs` (new and reused). */
  scripts: string[];
  warnings: CoreWarning[];
  report: VendorReportEntry[];
}

interface Ok {
  ok: true;
  kind: VendorKind;
  url: string;
  finalUrl: string;
  redirects: string[];
  sha256: string;
  bytes: number;
  mediaType: string;
  width: number | null;
  height: number | null;
  text?: string;
  format?: FontFace["format"];
  reused: boolean;
  fetchedAt: number;
  via?: string;
}

interface Failed {
  ok: false;
  kind: VendorKind;
  url: string;
  error: VendorErrorCode;
  message: string;
  via?: string;
}

type Result = Ok | Failed;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Makes a URL safe for the provenance fields (percent-encodes the few characters the schema refuses). */
export function provenanceUrl(url: string): string {
  return url
    .replace(/\s+/g, "")
    .replace(/["'<>\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .slice(0, 2048);
}

/** The URL as written to the audit log: origin and path only (a query may carry keys). */
function auditUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)/i.exec(url);
  return (m === null ? url : `${m[1]}${m[2]}`).slice(0, 300);
}

const STORED_KINDS: ReadonlySet<VendorKind> = new Set(["image", "font", "script", "stylesheet"]);

/** Runs tasks with at most `n` in flight. */
async function pool<T>(tasks: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await (tasks[i] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

/** True when the input references anything external (used to refuse a write when vendoring is off). */
function scriptImportsUrl(code: string): boolean {
  return /\bimport\s*\(\s*["'`]https?:|\bfrom\s*["']https?:\/\//.test(code);
}

/**
 * Vendors the external resources of a raw deck envelope (before schema validation; the shape is checked
 * defensively and anything unexpected is left for `validateDeck` to report). `previous` is the deck being edited:
 * its provenance doubles as a persistent cache (a URL already vendored for this deck is not fetched again).
 */
export async function vendorDeckInput(
  ctx: Ctx,
  principal: Principal,
  call: CallContext | undefined,
  args: { deckId: string; input: unknown; previous: Deck | null },
): Promise<VendorOutcome> {
  const out: VendorOutcome = {
    envelope: args.input,
    assets: [],
    scripts: [],
    warnings: [],
    report: [],
  };
  if (!isObj(args.input)) return out;
  const env: Record<string, unknown> = { ...args.input };
  const theme = isObj(env.theme) ? { ...env.theme } : null;
  if (theme !== null) env.theme = theme;
  const slides: unknown[] | null = Array.isArray(env.slides)
    ? env.slides.map((s) => (isObj(s) ? { ...s } : s))
    : null;
  if (slides !== null) env.slides = slides;
  const ws = principal.workspaceId;
  const warn = (code: CoreWarning["code"], message: string, path?: string, slideId?: string) => {
    const w: CoreWarning = { code, message };
    if (path !== undefined) w.path = path;
    if (slideId !== undefined) w.slideId = slideId;
    out.warnings.push(w);
  };
  const slideIdOf = (i: number): string | undefined => {
    const s = slides?.[i];
    return isObj(s) && typeof s.id === "string" ? s.id : undefined;
  };

  // ---- 1. Scan --------------------------------------------------------------------------------------------
  let googleUrl: string | null = null;
  if (theme !== null && theme.googleFonts !== undefined) {
    const parsed = googleFontsSchema.safeParse(theme.googleFonts);
    if (!parsed.success) {
      throw validationError("theme.googleFonts must be a list of { family, weights?, italic? }", {
        path: "theme.googleFonts",
        hint: `Send at most ${LIMITS.maxGoogleFonts} families, e.g. [{ "family": "Source Serif 4", "weights": [400, 700] }].`,
      });
    }
    delete theme.googleFonts;
    if (parsed.data.length > 0) googleUrl = googleFontsCssUrl(parsed.data);
  }
  type SheetTarget = "theme" | number;
  const sheetRoots: { url: string; target: SheetTarget }[] = [];
  const images = new Set<string>();
  const authoredFaces: ExtractedFontFace[] = [];
  let relative = 0;
  const scanCss = (css: string, target: SheetTarget) => {
    const r = transformCssExternals(css);
    for (const url of r.imports) sheetRoots.push({ url, target });
    for (const ref of r.urls) images.add(ref.url);
    authoredFaces.push(...r.fontFaces);
    relative += r.relative;
  };
  if (theme !== null && typeof theme.css === "string") scanCss(theme.css, "theme");
  if (googleUrl !== null) sheetRoots.push({ url: googleUrl, target: "theme" });
  // `libs`: kept entries and URLs, in order; `<script src>` of slides are appended in slide order.
  const libPlan: ({ keep: unknown } | { url: string })[] = [];
  if (Array.isArray(env.libs)) {
    for (const entry of env.libs) {
      if (typeof entry === "string" && /^(?:https?:)?\/\//i.test(entry.trim())) {
        const url = entry.trim().startsWith("//") ? `https:${entry.trim()}` : entry.trim();
        libPlan.push({ url });
      } else libPlan.push({ keep: entry });
    }
  }
  const htmlScans = new Map<number, ReturnType<typeof transformHtmlExternals>>();
  slides?.forEach((s, i) => {
    if (!isObj(s)) return;
    if (typeof s.html === "string") {
      const h = transformHtmlExternals(s.html);
      htmlScans.set(i, h);
      for (const ref of h.refs) images.add(ref.url);
      for (const url of h.stylesheets) sheetRoots.push({ url, target: i });
      for (const url of h.scripts) libPlan.push({ url });
      for (const u of ctx.vendor === undefined ? [] : h.unsupported) {
        warn("VENDOR_UNSUPPORTED", `<${u.what}>: ${u.message}`, `slides[${i}].html`, slideIdOf(i));
      }
      relative += h.relative;
    }
    if (typeof s.css === "string") scanCss(s.css, i);
    if (typeof s.script === "string" && scriptImportsUrl(s.script)) {
      warn(
        "VENDOR_ES_MODULE",
        "The script imports an ES module from a URL: modules are not vendored and the import fails. Put the library's UMD build in libs and use its global.",
        `slides[${i}].script`,
        slideIdOf(i),
      );
    }
  });
  if (typeof env.script === "string" && scriptImportsUrl(env.script)) {
    warn(
      "VENDOR_ES_MODULE",
      "The deck script imports an ES module from a URL: modules are not vendored and the import fails. Put the library's UMD build in libs and use its global.",
      "script",
    );
  }
  if (relative > 0 && ctx.vendor !== undefined) {
    warn(
      "VENDOR_RELATIVE_URL",
      `${relative} relative URL(s) cannot be resolved (no base URL) and were removed: use absolute https URLs.`,
    );
  }

  const libUrls = libPlan.flatMap((p) => ("url" in p ? [p.url] : []));
  const anything = sheetRoots.length + images.size + libUrls.length + authoredFaces.length > 0;
  if (!anything) {
    normalizeLibProvenance(env, args.previous, []);
    finishProvenance(env, args.previous, [], ctx);
    out.envelope = env;
    return out;
  }
  const vendor = ctx.vendor;
  if (vendor === undefined) {
    // No fetcher wired (library use, tests): the sanitizer removes the external references as before; the
    // input-only conveniences are dropped with a warning so that the deck still validates.
    if (libUrls.length > 0) {
      env.libs = libPlan.flatMap((p) => ("keep" in p ? [p.keep] : []));
      warn(
        "VENDOR_FAILED",
        `${libUrls.length} script URL(s) were dropped: this server does not vendor external resources.`,
        "libs",
      );
    }
    if (googleUrl !== null) {
      warn(
        "VENDOR_FAILED",
        "theme.googleFonts was dropped: this server does not vendor external resources.",
        "theme.googleFonts",
      );
    }
    normalizeLibProvenance(env, args.previous, []);
    out.envelope = env;
    return out;
  }
  if (!vendor.enabled) {
    const sample = [...sheetRoots.map((r) => r.url), ...images, ...libUrls].slice(0, 10);
    throw new DomainError(
      "FETCH_BLOCKED",
      "This instance does not fetch external resources (the operator turned vendoring off)",
      {
        hint: "Remove the external URLs: upload images with add_asset (base64), use the bundled fonts and libraries, or ask the owner to set PPTAKEN_VENDOR_FETCH=on.",
        details: { urls: sample.map(auditUrl) },
      },
    );
  }

  // ---- 2. Fetch -------------------------------------------------------------------------------------------
  const limits = ctx.config.vendor;
  const deadline = ctx.clock.now() + limits.deadlineMs;
  const budget = { urls: 0, bytes: 0 };
  const previousByKey = new Map<string, VendoredResource>();
  for (const p of args.previous?.vendored ?? []) {
    if (p.status === "vendored" && p.sha256 !== undefined)
      previousByKey.set(`${p.kind} ${p.url}`, p);
  }
  const memo = new Map<string, Promise<Result>>();
  const fetchOne = (kind: VendorKind, url: string, via?: string): Promise<Result> => {
    const key = `${kind} ${url}`;
    let p = memo.get(key);
    if (p === undefined) {
      p = fetchResource(kind, url, via);
      memo.set(key, p);
    }
    return p;
  };
  const failed = (
    kind: VendorKind,
    url: string,
    error: VendorErrorCode,
    message: string,
    via?: string,
  ): Failed => ({
    ok: false,
    kind,
    url,
    error,
    message,
    ...(via === undefined ? {} : { via }),
  });
  const fetchResource = async (kind: VendorKind, url: string, via?: string): Promise<Result> => {
    if (!/^https:\/\//i.test(url)) {
      return failed(kind, url, "blocked-address", "Only https URLs are vendored", via);
    }
    const prev = previousByKey.get(`${kind} ${url}`);
    if (prev?.sha256 !== undefined) {
      const reused = await reuse(ctx, ws, args.deckId, kind, prev);
      if (reused !== null) return { ...reused, ...(via === undefined ? {} : { via }) };
    }
    if (++budget.urls > limits.maxUrls) {
      return failed(
        kind,
        url,
        "too-large",
        `More than ${limits.maxUrls} external URLs in one write`,
        via,
      );
    }
    let fetched: Awaited<ReturnType<typeof vendor.fetch>>;
    try {
      fetched = await vendor.fetch({
        url,
        kind,
        deckId: args.deckId,
        actor: actorRef(principal),
        deadline,
      });
    } catch (error) {
      const code: VendorErrorCode = isVendorError(error) ? error.code : "fetch-failed";
      const message = isVendorError(error) ? error.message : "The download failed";
      const denied = ["blocked-address", "not-allowed-host", "rate-limited", "disabled"].includes(
        code,
      );
      await audit(
        ctx,
        ctx.store,
        principal,
        call,
        "vendor.fetch",
        `deck:${args.deckId}`,
        denied ? "denied" : "error",
        {
          kind,
          url: auditUrl(url),
          code,
        },
      );
      return failed(kind, url, code, message, via);
    }
    budget.bytes += fetched.bytes.length;
    let checked: CheckedResource;
    try {
      if (budget.bytes > limits.maxBytes) {
        throw new VendorError(
          "too-large",
          `More than ${limits.maxBytes} bytes fetched in one write`,
        );
      }
      checked = checkVendored(kind, fetched.bytes, ctx.config.limits.maxImagePixels);
      if (checked.kind === "script" && checked.module) {
        throw new VendorError(
          "bad-type",
          "This is an ES module (import/export statements): use the library's UMD/IIFE build instead (often a .umd.js or .min.js file)",
        );
      }
    } catch (error) {
      const code: VendorErrorCode = isVendorError(error) ? error.code : "bad-type";
      const message = error instanceof Error ? error.message : "Invalid content";
      await audit(ctx, ctx.store, principal, call, "vendor.fetch", `deck:${args.deckId}`, "error", {
        kind,
        url: auditUrl(url),
        finalUrl: auditUrl(fetched.finalUrl),
        bytes: fetched.bytes.length,
        code,
      });
      return failed(kind, url, code, message, via);
    }
    const sha256 = sha256Hex(fetched.bytes);
    const stored = await ctx.blobs.put(fetched.bytes, { maxBytes: VENDOR_MAX_BYTES[kind] });
    if (stored.sha256 !== sha256) {
      return failed(kind, url, "fetch-failed", "The file could not be stored", via);
    }
    await audit(ctx, ctx.store, principal, call, "vendor.fetch", `deck:${args.deckId}`, "ok", {
      kind,
      url: auditUrl(url),
      finalUrl: auditUrl(fetched.finalUrl),
      redirects: fetched.redirects.length,
      bytes: fetched.bytes.length,
      sha256,
    });
    return {
      ok: true,
      kind,
      url,
      finalUrl: fetched.finalUrl,
      redirects: fetched.redirects,
      sha256,
      bytes: fetched.bytes.length,
      mediaType: checked.mediaType,
      width: checked.kind === "image" ? checked.width : null,
      height: checked.kind === "image" ? checked.height : null,
      ...(checked.kind === "script" || checked.kind === "stylesheet" ? { text: checked.text } : {}),
      ...(checked.kind === "font" ? { format: checked.format } : {}),
      reused: false,
      fetchedAt: ctx.clock.now(),
      ...(via === undefined ? {} : { via }),
    };
  };

  // 2a. Stylesheets, breadth first, at most `maxImportDepth` levels of @import.
  interface Sheet {
    result: Result;
    imports: string[];
    faces: ExtractedFontFace[];
    images: string[];
  }
  const sheets = new Map<string, Sheet>();
  let level = [...new Set(sheetRoots.map((r) => r.url))];
  let depth = 0;
  const viaOf = new Map<string, string>();
  while (level.length > 0) {
    if (depth > limits.maxImportDepth) {
      for (const url of level) {
        sheets.set(url, {
          result: failed(
            "stylesheet",
            url,
            "too-large",
            `@import nested deeper than ${limits.maxImportDepth} levels`,
            viaOf.get(url),
          ),
          imports: [],
          faces: [],
          images: [],
        });
      }
      break;
    }
    const batch = level;
    await pool(
      batch.map((url) => async () => {
        const result = await fetchOne("stylesheet", url, viaOf.get(url));
        const sheet: Sheet = { result, imports: [], faces: [], images: [] };
        if (result.ok && result.text !== undefined) {
          const scan = transformCssExternals(result.text, { base: result.finalUrl });
          sheet.imports = scan.imports;
          sheet.faces = scan.fontFaces;
          sheet.images = scan.urls.map((u) => u.url);
        }
        sheets.set(url, sheet);
      }),
      limits.concurrency,
    );
    const next: string[] = [];
    for (const url of batch) {
      for (const child of sheets.get(url)?.imports ?? []) {
        if (!sheets.has(child) && !next.includes(child)) {
          next.push(child);
          viaOf.set(child, url);
        }
      }
    }
    level = next;
    depth++;
  }

  // 2b. Font faces (authored and from stylesheets), trimmed by subset priority when over the URL budget.
  interface FacePlan {
    face: ExtractedFontFace;
    via?: string;
  }
  let faces: FacePlan[] = authoredFaces.map((face) => ({ face }));
  for (const [url, sheet] of sheets) for (const face of sheet.faces) faces.push({ face, via: url });
  const seenFace = new Set<string>();
  faces = faces.filter(({ face }) => {
    const key = `${face.family}|${face.weight ?? ""}|${face.style ?? ""}|${face.unicodeRange ?? ""}|${face.sources[0]?.url ?? ""}`;
    if (seenFace.has(key)) return false;
    seenFace.add(key);
    return true;
  });
  const sheetImages = [...sheets.entries()].flatMap(([url, s]) =>
    s.images.map((img) => ({ img, via: url })),
  );
  const existingFaces = Array.isArray(theme?.fontFaces) ? theme.fontFaces.length : 0;
  const room = Math.max(
    0,
    Math.min(
      limits.maxUrls - budget.urls - images.size - sheetImages.length - libUrls.length,
      LIMITS.maxFontFaces - existingFaces,
    ),
  );
  if (faces.length > room) {
    const sorted = faces
      .map((f, i) => ({ f, i, rank: fontSubsetRank(f.face.unicodeRange) }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i);
    const kept = new Set(sorted.slice(0, room).map((x) => x.i));
    warn(
      "VENDOR_FONTS_TRIMMED",
      `${faces.length - room} font file(s) were not vendored (budget of ${limits.maxUrls} URLs per write / ${LIMITS.maxFontFaces} font faces); Latin subsets were kept first. Request fewer weights or families.`,
      "theme.fontFaces",
    );
    faces = faces.filter((_, i) => kept.has(i));
  }

  // 2c. Everything else, in parallel within the write's concurrency.
  const faceResults = new Map<FacePlan, Result>();
  const tasks: (() => Promise<unknown>)[] = [];
  for (const url of images) tasks.push(() => fetchOne("image", url));
  for (const { img, via } of sheetImages) tasks.push(() => fetchOne("image", img, via));
  for (const url of libUrls) tasks.push(() => fetchOne("script", url));
  for (const plan of faces) {
    tasks.push(async () => {
      let last: Result | null = null;
      for (const source of plan.face.sources.slice(0, 2)) {
        last = await fetchOne("font", source.url, plan.via);
        if (last.ok) break;
      }
      if (last !== null) faceResults.set(plan, last);
    });
  }
  await pool(tasks, limits.concurrency);

  // ---- 3. Rewrite -----------------------------------------------------------------------------------------
  const settled = new Map<string, Result>();
  for (const [key, p] of memo) settled.set(key, await p);
  const okOf = (kind: VendorKind, url: string): Ok | null => {
    const r = settled.get(`${kind} ${url}`);
    return r?.ok === true ? r : null;
  };
  const resolve: ExternalResolver = (kind, url) => {
    const r = okOf(kind, url);
    return r === null ? null : `asset:${r.sha256}`;
  };
  const processed = new Map<string, string>();
  const processSheet = (url: string, stack: string[]): string => {
    const cached = processed.get(url);
    if (cached !== undefined) return cached;
    if (stack.includes(url)) return ""; // @import loop
    const sheet = sheets.get(url);
    const result = sheet?.result;
    if (sheet === undefined || result === undefined || !result.ok || result.text === undefined)
      return "";
    const imports = new Map<string, string>();
    for (const child of sheet.imports) imports.set(child, processSheet(child, [...stack, url]));
    const css = transformCssExternals(result.text, {
      base: result.finalUrl,
      resolve,
      extractFontFaces: true,
      imports,
    }).css;
    processed.set(url, css);
    return css;
  };
  const rewriteCss = (css: string, max: number, path: string, slideId?: string): string => {
    const scan = transformCssExternals(css);
    const imports = new Map(scan.imports.map((u) => [u, processSheet(u, [])]));
    let next = transformCssExternals(css, { resolve, extractFontFaces: true, imports }).css;
    if (next.length > max) {
      const empty = new Map(scan.imports.map((u) => [u, ""]));
      next = transformCssExternals(css, { resolve, extractFontFaces: true, imports: empty }).css;
      warn(
        "VENDOR_STYLESHEET_SKIPPED",
        `The imported stylesheet rules would exceed ${Math.round(max / 1024)} KB, so only their fonts and images were kept.`,
        path,
        slideId,
      );
    }
    return next;
  };
  if (theme !== null) {
    let css =
      typeof theme.css === "string" ? rewriteCss(theme.css, LIMITS.maxThemeCss, "theme.css") : "";
    if (googleUrl !== null) {
      const extra = processSheet(googleUrl, []);
      if (extra.trim() !== "" && css.length + extra.length <= LIMITS.maxThemeCss)
        css += `\n${extra}`;
    }
    if (typeof theme.css === "string" || css !== "") theme.css = css;
  }
  slides?.forEach((s, i) => {
    if (!isObj(s)) return;
    const scan = htmlScans.get(i);
    let extraCss = "";
    if (scan !== undefined && typeof s.html === "string") {
      s.html = transformHtmlExternals(s.html, resolve).html;
      for (const url of scan.stylesheets) {
        const css = processSheet(url, []);
        if (css.trim() !== "") extraCss += `\n${css}`;
      }
    }
    if (typeof s.css === "string")
      s.css = rewriteCss(s.css, LIMITS.maxSlideCss, `slides[${i}].css`, slideIdOf(i));
    if (extraCss !== "") {
      const merged = `${typeof s.css === "string" ? s.css : ""}${extraCss}`;
      if (merged.length <= LIMITS.maxSlideCss) s.css = merged;
      else {
        warn(
          "VENDOR_STYLESHEET_SKIPPED",
          `The linked stylesheet rules would exceed ${Math.round(LIMITS.maxSlideCss / 1024)} KB, so only their fonts and images were kept.`,
          `slides[${i}].css`,
          slideIdOf(i),
        );
      }
    }
  });

  // Font faces → theme.fontFaces.
  const newFaces: FontFace[] = [];
  for (const plan of faces) {
    const r = faceResults.get(plan);
    if (r === undefined || !r.ok) continue;
    const face: FontFace = {
      family: plan.face.family,
      src: `asset:${r.sha256}`,
      format: r.format ?? plan.face.sources[0]?.format ?? "woff2",
      source: provenanceUrl(r.url),
    };
    if (plan.face.weight !== undefined) face.weight = plan.face.weight;
    if (plan.face.style !== undefined) face.style = plan.face.style;
    if (plan.face.unicodeRange !== undefined) face.unicodeRange = plan.face.unicodeRange;
    newFaces.push(face);
  }
  if (newFaces.length > 0) {
    const target = theme ?? {};
    const existing = Array.isArray(target.fontFaces) ? target.fontFaces : [];
    const key = (f: unknown) =>
      isObj(f)
        ? `${f.family}|${f.weight ?? ""}|${f.style ?? ""}|${f.unicodeRange ?? ""}|${f.src}`
        : "";
    const keys = new Set(existing.map(key));
    target.fontFaces = [...existing, ...newFaces.filter((f) => !keys.has(key(f)))];
    env.theme = target;
  }

  // libs.
  if (libPlan.length > 0) {
    const libs: unknown[] = [];
    const seenSha = new Set<string>();
    for (const p of libPlan) {
      if ("keep" in p) {
        libs.push(p.keep);
        continue;
      }
      const r = okOf("script", p.url);
      if (r === null || seenSha.has(r.sha256)) continue;
      seenSha.add(r.sha256);
      const label = libLabelOf(r.url, r.finalUrl);
      const lib: VendoredScript = {
        name: label.name,
        sha256: r.sha256,
        source: provenanceUrl(r.url),
        finalUrl: provenanceUrl(r.finalUrl),
        bytes: r.bytes,
      };
      if (label.version !== undefined) lib.version = label.version;
      libs.push(lib);
    }
    env.libs = libs;
  }

  // ---- 4. Results, warnings, provenance ---------------------------------------------------------------------
  const all = [...settled.values()];
  for (const r of all) {
    if (r.ok) {
      out.report.push({
        kind: r.kind,
        url: r.url,
        status: r.reused ? "reused" : "vendored",
        finalUrl: r.finalUrl,
        bytes: r.bytes,
        sha256: r.sha256,
      });
      if (STORED_KINDS.has(r.kind) && !out.assets.some((a) => a.sha256 === r.sha256)) {
        out.assets.push({
          sha256: r.sha256,
          mediaType: r.mediaType,
          bytes: r.bytes,
          width: r.width,
          height: r.height,
        });
      }
      if (r.kind === "script") out.scripts.push(r.sha256);
    } else {
      out.report.push({
        kind: r.kind,
        url: r.url,
        status: "failed",
        error: r.error,
        message: r.message,
      });
      warn(
        "VENDOR_FAILED",
        `${r.kind} ${r.url.slice(0, 200)} was not vendored (${r.error}): ${r.message}`,
      );
    }
  }
  normalizeLibProvenance(env, args.previous, all);
  finishProvenance(env, args.previous, all, ctx);
  out.envelope = env;
  return out;
}

/**
 * Re-reads a resource vendored by an earlier revision of the deck, when it is still linked to THIS deck and its
 * blob is stored, and the stored kind matches (provenance is never trusted on its own: an imported archive could
 * carry any mapping; the content check below runs again for text kinds).
 */
async function reuse(
  ctx: Ctx,
  ws: string,
  deckId: string,
  kind: VendorKind,
  prev: VendoredResource,
): Promise<Ok | null> {
  const sha = prev.sha256 as string;
  const record = await ctx.store.assets.get(ws, sha);
  if (record === null || !(await ctx.store.assets.isLinked(ws, deckId, sha))) return null;
  const expected =
    kind === "image"
      ? record.mediaType.startsWith("image/")
      : kind === "font"
        ? record.mediaType.startsWith("font/")
        : record.mediaType === (kind === "script" ? "text/javascript" : "text/css");
  if (!expected || !(await ctx.blobs.has(sha))) return null;
  let text: string | undefined;
  if (kind === "stylesheet" || kind === "script") {
    const bytes = await ctx.blobs.get(sha);
    if (bytes === null) return null;
    try {
      const checked = checkVendored(kind, bytes, ctx.config.limits.maxImagePixels);
      if (checked.kind === "stylesheet" || checked.kind === "script") text = checked.text;
    } catch {
      return null;
    }
  }
  let format: FontFace["format"] | undefined;
  if (kind === "font") {
    format =
      record.mediaType === "font/woff2"
        ? "woff2"
        : record.mediaType === "font/woff"
          ? "woff"
          : record.mediaType === "font/otf"
            ? "opentype"
            : "truetype";
  }
  return {
    ok: true,
    kind,
    url: prev.url,
    finalUrl: prev.finalUrl ?? prev.url,
    redirects: prev.redirects ?? [],
    sha256: sha,
    bytes: record.bytes,
    mediaType: record.mediaType,
    width: record.width,
    height: record.height,
    ...(text === undefined ? {} : { text }),
    ...(format === undefined ? {} : { format }),
    reused: true,
    fetchedAt: prev.fetchedAt,
  };
}

/** SHA-256 values an envelope references (asset refs, font faces, libs). */
function referencedHashes(env: Record<string, unknown>): Set<string> {
  const refs = new Set<string>();
  const add = (text: unknown) => {
    if (typeof text === "string") for (const r of assetRefsOf(text)) refs.add(r);
  };
  if (isObj(env.theme)) {
    add(env.theme.css);
    if (Array.isArray(env.theme.fontFaces))
      for (const f of env.theme.fontFaces) if (isObj(f)) add(f.src);
  }
  if (Array.isArray(env.slides)) {
    for (const s of env.slides) {
      if (!isObj(s)) continue;
      add(s.html);
      add(s.css);
    }
  }
  if (Array.isArray(env.libs)) {
    for (const l of env.libs) if (isObj(l) && typeof l.sha256 === "string") refs.add(l.sha256);
  }
  return refs;
}

/**
 * Sets `env.vendored`: this write's entries (vendored, reused and failed) plus the earlier entries whose files
 * the deck still references; stylesheets stay while something they brought in stays. Failed entries of earlier
 * writes are dropped. Removed when empty. Any `vendored` sent by the caller is ignored: the server owns it.
 */
function finishProvenance(
  env: Record<string, unknown>,
  previous: Deck | null,
  results: Result[],
  ctx: Ctx,
): void {
  const refs = referencedHashes(env);
  const isReferenced = (sha: string | undefined) =>
    sha !== undefined && [...refs].some((r) => sha.startsWith(r));
  const current: VendoredResource[] = results.map((r) => {
    const entry: VendoredResource = r.ok
      ? {
          kind: r.kind,
          url: provenanceUrl(r.url),
          status: "vendored",
          finalUrl: provenanceUrl(r.finalUrl),
          sha256: r.sha256,
          bytes: r.bytes,
          mediaType: r.mediaType,
          fetchedAt: r.fetchedAt,
        }
      : {
          kind: r.kind,
          url: provenanceUrl(r.url),
          status: "failed",
          error: r.error,
          fetchedAt: ctx.clock.now(),
        };
    if (r.ok && r.redirects.length > 0)
      entry.redirects = r.redirects.slice(0, 3).map(provenanceUrl);
    if (r.via !== undefined) entry.via = provenanceUrl(r.via);
    return entry;
  });
  const fresh = new Set(current.map((e) => `${e.kind} ${e.url}`));
  const kept = (previous?.vendored ?? []).filter(
    (e) =>
      e.status === "vendored" &&
      !fresh.has(`${e.kind} ${e.url}`) &&
      e.kind !== "stylesheet" &&
      isReferenced(e.sha256),
  );
  const keptUrls = new Set(
    [...kept, ...current].filter((e) => e.status === "vendored").map((e) => e.via),
  );
  const keptSheets = (previous?.vendored ?? []).filter(
    (e) =>
      e.status === "vendored" &&
      e.kind === "stylesheet" &&
      !fresh.has(`${e.kind} ${e.url}`) &&
      keptUrls.has(e.url),
  );
  // Fresh entries that are not referenced any more (an image whose <img> the sanitizer later removes) still
  // describe this write; they are kept.
  let list = [...keptSheets, ...kept, ...current].filter(
    (e) => /^https?:\/\//i.test(e.url) || e.status === "failed",
  );
  list = list.filter((e) => /^[a-z][a-z0-9+.-]{0,20}:[^\s"'<>\\]*$/.test(e.url));
  if (list.length > LIMITS.maxVendored) list = list.slice(list.length - LIMITS.maxVendored);
  if (list.length > 0) env.vendored = list;
  else delete env.vendored;
}

/**
 * Inserts and links vendored assets inside a write's transaction, enforcing the deck's asset quotas. Already
 * linked assets are skipped.
 */
export async function linkVendoredAssets(
  ctx: Ctx,
  tx: Repositories,
  ws: string,
  deckId: string,
  assets: readonly VendoredAsset[],
  now: number,
): Promise<void> {
  if (assets.length === 0) return;
  const fresh: VendoredAsset[] = [];
  for (const a of assets) if (!(await tx.assets.isLinked(ws, deckId, a.sha256))) fresh.push(a);
  if (fresh.length === 0) return;
  const stats = await tx.assets.statsForDeck(ws, deckId);
  const { maxAssetsPerDeck, maxAssetBytesPerDeck } = ctx.config.limits;
  const count = stats.count + fresh.length;
  const bytes = stats.bytes + fresh.reduce((n, a) => n + a.bytes, 0);
  if (count > maxAssetsPerDeck) {
    throw limitExceeded("Too many assets in this presentation", maxAssetsPerDeck, count, {
      path: "presentationId",
      hint: "Vendored images, fonts and scripts count as assets. Reference fewer external resources.",
    });
  }
  if (bytes > maxAssetBytesPerDeck) {
    throw limitExceeded("Total asset size of this presentation", maxAssetBytesPerDeck, bytes, {
      unit: "bytes",
      hint: "Vendored images, fonts and scripts count as assets. Use smaller images or fewer font weights.",
    });
  }
  for (const a of fresh) {
    const record: AssetRecord = {
      workspaceId: ws,
      sha256: a.sha256,
      mediaType: a.mediaType,
      bytes: a.bytes,
      width: a.width,
      height: a.height,
      createdAt: now,
    };
    await tx.assets.insertIfAbsent(record);
    await tx.assets.link(ws, deckId, a.sha256, now);
  }
}

/**
 * Replaces input conveniences that only the vendoring stage understands with placeholders, so the deck can be
 * validated BEFORE any network access (fail fast on an invalid deck): URL entries of `libs` become dummy vendored
 * references and `theme.googleFonts` is checked and removed.
 */
export function probeEnvelope(input: unknown): unknown {
  if (!isObj(input)) return input;
  const env: Record<string, unknown> = { ...input };
  if (isObj(env.theme) && env.theme.googleFonts !== undefined) {
    const parsed = googleFontsSchema.safeParse(env.theme.googleFonts);
    if (!parsed.success) {
      throw validationError("theme.googleFonts must be a list of { family, weights?, italic? }", {
        path: "theme.googleFonts",
        hint: `Send at most ${LIMITS.maxGoogleFonts} families, e.g. [{ "family": "Source Serif 4", "weights": [400, 700] }].`,
      });
    }
    const { googleFonts: _g, ...theme } = env.theme;
    env.theme = theme;
  }
  if (Array.isArray(env.libs)) {
    env.libs = env.libs.map((entry, i) =>
      typeof entry === "string" &&
      !(LIB_IDS as readonly string[]).includes(entry) &&
      /^(?:https?:)?\/\//i.test(entry.trim())
        ? { name: "pending", sha256: sha256Hex(new Uint8Array([i & 255, (i >> 8) & 255, 7])) }
        : entry,
    );
  }
  delete env.vendored;
  return env;
}

/**
 * The provenance shown on the approval screen must be the server's, never the caller's: a `libs` object entry
 * (`{ name, sha256, source }` sent back by an agent) gets its `source`, `finalUrl` and `bytes` from the deck's own
 * vendoring records for that hash (this write's or an earlier revision's), and loses them when there is none. A
 * bundled hash gets the bundled reference. Without this, an agent could vendor one script and then label it with a
 * reputable CDN URL.
 */
function normalizeLibProvenance(
  env: Record<string, unknown>,
  previous: Deck | null,
  results: Result[],
): void {
  if (!Array.isArray(env.libs)) return;
  const known = new Map<string, { url: string; finalUrl?: string; bytes?: number }>();
  for (const p of previous?.vendored ?? []) {
    if (p.kind === "script" && p.status === "vendored" && p.sha256 !== undefined) {
      known.set(p.sha256, {
        url: p.url,
        ...(p.finalUrl === undefined ? {} : { finalUrl: p.finalUrl }),
        ...(p.bytes === undefined ? {} : { bytes: p.bytes }),
      });
    }
  }
  for (const r of results) {
    if (r.ok && r.kind === "script") {
      known.set(r.sha256, {
        url: provenanceUrl(r.url),
        finalUrl: provenanceUrl(r.finalUrl),
        bytes: r.bytes,
      });
    }
  }
  const bundled = new Map(Object.values(LIB_CATALOG).map((l) => [l.sha256 as string, l]));
  env.libs = env.libs.map((entry) => {
    if (!isObj(entry) || typeof entry.sha256 !== "string") return entry;
    const lib = bundled.get(entry.sha256);
    if (lib !== undefined) {
      return { name: lib.name, version: lib.version, sha256: lib.sha256, source: lib.source };
    }
    const { source: _s, finalUrl: _f, bytes: _b, ...rest } = entry;
    const record = known.get(entry.sha256);
    if (record === undefined) return rest;
    return {
      ...rest,
      ...(/^https:\/\//.test(record.url) ? { source: record.url } : {}),
      ...(record.finalUrl === undefined ? {} : { finalUrl: record.finalUrl }),
      ...(record.bytes === undefined ? {} : { bytes: record.bytes }),
    };
  });
}
