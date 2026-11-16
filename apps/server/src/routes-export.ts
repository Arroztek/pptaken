// SPDX-License-Identifier: AGPL-3.0-or-later
// Export and import (phase F3, docs/spec/http-api.md "Export and import"). Owner-session actions, never agent
// tools: the core refuses any other actor, and these routes only accept the panel session cookie.
//
//   GET  /api/v1/decks/:id/export?format=html|pptaken&notes=0|1&revision=   -> file download
//   POST /api/v1/decks/import   (body: the raw .pkn archive, Content-Type: application/zip) -> 201
//   POST /api/v1/decks/import-pptx   (body: the raw .pptx file) -> 201 (converted in an isolated worker)
//
// This router is registered BEFORE the global /api body limit (64 KB by default) because an archive is larger:
// it applies its own limit (PPTAKEN_MAX_IMPORT_MB), its own CSRF check and rate limits, and its middleware is
// scoped to its own paths so that every other /api request falls through untouched.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCsrf, TokenBucketLimiter } from "@pptaken/auth-local";
import {
  DEFAULT_WORKSPACE_ID,
  type DomainError,
  isDomainError,
  ownerPrincipal,
} from "@pptaken/core";
import {
  ARCHIVE_EXTENSION,
  ArchiveError,
  type EmbeddedFont,
  exportFilenames,
  exportHtml,
  readArchive,
  writeArchive,
} from "@pptaken/export";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv, Services } from "./context.js";
import { loadFontFaces } from "./fonts.js";
import { apiError, ownOrigin, publicOrigin } from "./http.js";
import { ownerSession } from "./session.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded>` (RFC 6266 / RFC 8187). */
export function contentDisposition(ascii: string, unicode: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(ascii)) throw new TypeError("unsafe ASCII file name");
  const encoded = encodeURIComponent(unicode).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const fontCache = new WeakMap<Services, EmbeddedFont[]>();

/** The bundled font faces with their bytes, read once per server instance. */
function bundledFonts(s: Services): EmbeddedFont[] {
  let fonts = fontCache.get(s);
  if (fonts === undefined) {
    fonts = [];
    for (const face of loadFontFaces(s.config.fontsDir)) {
      try {
        fonts.push({
          family: face.family,
          weight: face.weight,
          style: face.style,
          unicodeRange: face.unicodeRange,
          bytes: new Uint8Array(readFileSync(join(s.config.fontsDir, face.file))),
        });
      } catch {
        // A missing font file only means a fallback font in the exported file.
      }
    }
    fontCache.set(s, fonts);
  }
  return fonts;
}

/** Maps a core error to the panel API contract (docs/spec/http-api.md "Conventions"). */
function domainError(c: Context, error: DomainError): Response {
  switch (error.code) {
    case "NOT_FOUND":
      return apiError(
        c,
        "NOT_FOUND",
        error.path === "revision" ? error.message : "Presentation not found",
      );
    case "FORBIDDEN_ACTOR":
    case "FORBIDDEN_SCOPE":
      return apiError(c, "FORBIDDEN", error.message);
    case "VALIDATION_ERROR":
    case "LIMIT_EXCEEDED":
    case "UNSUPPORTED_MEDIA":
      return apiError(c, "VALIDATION_ERROR", error.message, { hint: error.hint });
    default:
      throw error;
  }
}

export function exportRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const owner = ownerPrincipal(DEFAULT_WORKSPACE_ID);
  const generator = `pptaken ${s.config.version}`;
  // Imports are heavy (up to 100 MB parsed in memory): 10 per 10 minutes per IP.
  const importsPerIp = new TokenBucketLimiter({
    capacity: 10,
    refill: 10,
    intervalMs: 10 * 60_000,
    clock: s.clock,
  });
  const call = (c: Context<AppEnv>) => ({ ip: c.get("ip"), requestId: c.get("requestId") });

  /** The common guard of the panel API: DoS limit per IP, CSRF on POST, then the owner session. */
  async function guard(c: Context<AppEnv>): Promise<Response | null> {
    const rl = s.limits.apiPerIp.take(c.get("ip"));
    if (!rl.ok) {
      return apiError(c, "RATE_LIMITED", "Too many requests", {
        retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
      });
    }
    const csrf = checkCsrf({
      method: c.req.method,
      header: (n) => c.req.header(n),
      allowedOrigins: [publicOrigin(c, s.config), ownOrigin(c, s.config)],
    });
    if (!csrf.ok) {
      return apiError(c, "FORBIDDEN", "Cross-site request refused", {
        hint: "Send the X-PPTaken-CSRF: 1 header from the PPTaken web app's own origin.",
      });
    }
    if (await ownerSession(c, s)) return null;
    if (!(await s.auth.isInstalled())) {
      return apiError(c, "SETUP_REQUIRED", "Nobody has set up this instance yet");
    }
    return apiError(c, "UNAUTHENTICATED", "Sign in first");
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Export

  app.get("/decks/:id/export", async (c) => {
    const denied = await guard(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    const format = c.req.query("format");
    if (format !== "html" && format !== "pptaken") {
      return apiError(c, "VALIDATION_ERROR", "format must be html or pptaken");
    }
    const notesParam = c.req.query("notes");
    if (notesParam !== undefined && notesParam !== "0" && notesParam !== "1") {
      return apiError(c, "VALIDATION_ERROR", "notes must be 0 or 1");
    }
    const revisionParam = c.req.query("revision");
    if (
      revisionParam !== undefined &&
      revisionParam !== "" &&
      !/^[1-9][0-9]{0,8}$/.test(revisionParam)
    ) {
      return apiError(c, "VALIDATION_ERROR", "revision must be a positive integer");
    }
    // Notes: off by default in HTML (T7, the file may be shared); on by default in the archive (the owner's backup).
    const includeNotes = notesParam === undefined ? format === "pptaken" : notesParam === "1";

    let exported: Awaited<ReturnType<typeof s.core.exportPresentation>>;
    try {
      exported = await s.core.exportPresentation(
        owner,
        {
          presentationId: id,
          includeNotes,
          ...(revisionParam ? { revision: Number(revisionParam) } : {}),
        },
        call(c),
      );
    } catch (error) {
      if (isDomainError(error)) return domainError(c, error);
      throw error;
    }

    let body: Uint8Array;
    let type: string;
    let names: { ascii: string; unicode: string };
    if (format === "html") {
      const out = exportHtml({
        deck: exported.deck,
        assets: new Map(exported.assets.map((a) => [a.sha256, a])),
        includeNotes,
        fonts: bundledFonts(s),
        generator,
      });
      body = new TextEncoder().encode(out.html);
      type = "text/html; charset=utf-8";
      names = exportFilenames(exported.deck.title, ".html");
      if (out.warnings.length > 0) {
        s.logger.info("html export warnings", {
          requestId: c.get("requestId"),
          codes: out.warnings.map((w) => w.code),
        });
      }
    } else {
      const out = writeArchive({
        deck: exported.deck,
        assets: exported.assets,
        includeNotes,
        generator,
        exportedAt: new Date(s.clock.now()),
      });
      body = out.bytes;
      type = "application/zip";
      names = exportFilenames(exported.deck.title, ARCHIVE_EXTENSION);
    }
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": type,
      "Content-Disposition": contentDisposition(names.ascii, names.unicode),
      "Content-Length": String(body.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // A download, never a document of the app origin: if a browser ever rendered it, it would be sandboxed.
      "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
      "X-PPTaken-Revision": String(exported.revision),
      "X-PPTaken-Notes": exported.includesNotes ? "1" : "0",
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Import

  const tooLarge = (c: Context) =>
    apiError(c, "VALIDATION_ERROR", "The archive is too large", {
      status: 413,
      hint: `The limit is ${Math.floor(s.config.maxImportBytes / 1024 / 1024)} MB (PPTAKEN_MAX_IMPORT_MB).`,
    });

  app.post(
    "/decks/import",
    async (c, next) => {
      const denied = await guard(c);
      if (denied) return denied;
      const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "application/zip") {
        return apiError(c, "VALIDATION_ERROR", "The request body must be a .pkn archive", {
          hint: "Send the file as the raw request body with Content-Type: application/zip.",
        });
      }
      const length = c.req.header("content-length");
      if (
        length !== undefined &&
        (!/^\d+$/.test(length) || Number(length) > s.config.maxImportBytes)
      ) {
        return tooLarge(c);
      }
      const rl = importsPerIp.take(c.get("ip"));
      if (!rl.ok) {
        return apiError(c, "RATE_LIMITED", "Too many imports", {
          retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
        });
      }
      await next();
    },
    bodyLimit({ maxSize: s.config.maxImportBytes, onError: tooLarge }),
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.length === 0) return apiError(c, "VALIDATION_ERROR", "The request body is empty");
      const limits = s.core.config.limits;
      let archive: ReturnType<typeof readArchive>;
      try {
        archive = readArchive(bytes, {
          maxArchiveBytes: s.config.maxImportBytes,
          maxAssets: limits.maxAssetsPerDeck,
          maxAssetBytes: limits.maxAssetBytes,
          maxTotalBytes: Math.max(s.config.maxImportBytes, limits.maxAssetBytesPerDeck),
        });
      } catch (error) {
        if (error instanceof ArchiveError) {
          s.logger.info("import refused", { requestId: c.get("requestId"), code: error.code });
          return apiError(c, "VALIDATION_ERROR", `Not a valid .pkn archive: ${error.message}`, {
            hint: "Export the presentation again from PPTaken and import the unmodified file.",
          });
        }
        throw error;
      }
      try {
        const result = await s.core.importPresentation(
          owner,
          {
            deck: archive.deck,
            assets: archive.assets.map((a) => ({
              sha256: a.sha256,
              mediaType: a.mediaType,
              bytes: a.bytes,
            })),
          },
          call(c),
        );
        const deck = await s.storage.decks.get(DEFAULT_WORKSPACE_ID, result.presentationId);
        return c.json(
          {
            deck: {
              id: result.presentationId,
              title: deck?.title ?? archive.manifest.deck.title,
              lang: deck?.lang ?? null,
              slideCount: result.slideCount,
              revision: result.revision,
              updatedAt: new Date(deck?.updatedAt ?? s.clock.now()).toISOString(),
              createdBy: "owner",
            },
            assetCount: result.assetCount,
            warnings: result.warnings.map((w) => ({
              code: w.code,
              message: w.message,
              ...(w.path === undefined ? {} : { path: w.path }),
              ...(w.slideId === undefined ? {} : { slideId: w.slideId }),
            })),
          },
          201,
        );
      } catch (error) {
        if (isDomainError(error)) return domainError(c, error);
        throw error;
      }
    },
  );

  // ---------------------------------------------------------------------------------------------------------------
  // PowerPoint import (docs/spec/pptx-import.md): the raw .pptx as the body, converted in an isolated worker.

  const PPTX_TYPES = new Set([
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    "application/vnd.openxmlformats-officedocument.presentationml.template",
    "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    "application/octet-stream",
  ]);
  /** Conversions running at once (each one is a worker with its own heap). */
  const MAX_CONVERSIONS = 2;
  let converting = 0;

  const pptxTooLarge = (c: Context) =>
    apiError(c, "VALIDATION_ERROR", "The file is too large", {
      status: 413,
      hint: `The limit is ${Math.floor(s.config.maxImportBytes / 1024 / 1024)} MB (PPTAKEN_MAX_IMPORT_MB).`,
    });

  app.post(
    "/decks/import-pptx",
    async (c, next) => {
      const denied = await guard(c);
      if (denied) return denied;
      const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!PPTX_TYPES.has(type)) {
        return apiError(c, "VALIDATION_ERROR", "The request body must be a .pptx file", {
          hint: "Send the file as the raw request body with Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation.",
        });
      }
      const length = c.req.header("content-length");
      if (
        length !== undefined &&
        (!/^\d+$/.test(length) || Number(length) > s.config.maxImportBytes)
      ) {
        return pptxTooLarge(c);
      }
      const rl = importsPerIp.take(c.get("ip"));
      if (!rl.ok) {
        return apiError(c, "RATE_LIMITED", "Too many imports", {
          retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
        });
      }
      await next();
    },
    bodyLimit({ maxSize: s.config.maxImportBytes, onError: pptxTooLarge }),
    async (c) => {
      if (converting >= MAX_CONVERSIONS) {
        return apiError(c, "RATE_LIMITED", "Another import is being converted", {
          retryAfterSec: 10,
        });
      }
      converting++;
      try {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        if (bytes.length === 0) return apiError(c, "VALIDATION_ERROR", "The request body is empty");
        const result = await s.core.importPptx(owner, { bytes }, call(c));
        const deck = await s.storage.decks.get(DEFAULT_WORKSPACE_ID, result.presentationId);
        s.logger.info("pptx imported", {
          requestId: c.get("requestId"),
          slides: result.slideCount,
          assets: result.assetCount,
          warnings: result.warnings.length,
        });
        return c.json(
          {
            deck: {
              id: result.presentationId,
              title: deck?.title ?? result.title,
              lang: deck?.lang ?? null,
              slideCount: result.slideCount,
              revision: result.revision,
              updatedAt: new Date(deck?.updatedAt ?? s.clock.now()).toISOString(),
              createdBy: "owner",
            },
            assetCount: result.assetCount,
            warnings: result.warnings.map((w) => ({
              code: w.code,
              message: w.message,
              ...(w.path === undefined ? {} : { path: w.path }),
              ...(w.slideId === undefined ? {} : { slideId: w.slideId }),
              ...(w.name === undefined ? {} : { name: w.name }),
            })),
          },
          201,
        );
      } catch (error) {
        if (isDomainError(error)) {
          s.logger.info("pptx import refused", {
            requestId: c.get("requestId"),
            code: error.code,
            reason: error.details?.reason,
          });
          return domainError(c, error);
        }
        throw error;
      } finally {
        converting--;
      }
    },
  );

  return app;
}
