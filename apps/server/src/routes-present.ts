// SPDX-License-Identifier: AGPL-3.0-or-later
// Presenter view (phase F3): the presenter data API (`GET /api/v1/decks/:id/presenter`) and the presenter page
// (`GET /p/:deckId/presenter`), both on the app origin and only for the owner session. This is the only place
// speaker notes leave the server, rendered to safe HTML by `renderNotes` (T7: never on `/c/*`, never on public
// links, never in the content iframe). Also the offline document API (`GET /api/v1/decks/:id/offline`, offline
// layer 2): the deck document with its images and fonts inlined, which the service worker stores.
//
// Mounted at `/` before the panel API router, whose catch-all would otherwise answer the API path.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assetRefsOf,
  DEFAULT_WORKSPACE_ID,
  isDomainError,
  ownerPrincipal,
  type Principal,
} from "@pptaken/core";
import {
  buildOfflineDocument,
  type OfflineAsset,
  type OfflineFont,
  type PresenterData,
  type PresenterSlide,
  renderNotes,
} from "@pptaken/player";
import { staticDeck } from "@pptaken/sanitizer";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv, Services } from "./context.js";
import { loadFontFaces } from "./fonts.js";
import { apiError } from "./http.js";
import { escapeHtml, playerPagePolicy } from "./routes-content.js";
import { ownerSession } from "./session.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Read-only principal used to read the deck's assets once the owner session has been checked. */
const deckReader: Principal = {
  actor: "system",
  workspaceId: DEFAULT_WORKSPACE_ID,
  scopes: new Set(["decks:read"]),
};

const fontCache = new WeakMap<Services, OfflineFont[]>();

/** Every bundled font face with its file, base64 (the runtime preloads all declared faces). Read once. */
function offlineFonts(s: Services): OfflineFont[] {
  let fonts = fontCache.get(s);
  if (fonts === undefined) {
    fonts = [];
    for (const face of loadFontFaces(s.config.fontsDir)) {
      try {
        const { file: _file, ...rest } = face;
        fonts.push({
          ...rest,
          base64: readFileSync(join(s.config.fontsDir, face.file)).toString("base64"),
        });
      } catch {
        // A missing file only means a fallback font offline.
      }
    }
    fontCache.set(s, fonts);
  }
  return fonts;
}

/** The offline document of the deck's current revision, or `null` when there is no such deck. */
export async function offlineBundle(
  s: Services,
  deckId: string,
): Promise<{ id: string; revision: number; html: string } | null> {
  const deck = await s.storage.decks.get(DEFAULT_WORKSPACE_ID, deckId);
  if (deck === null || deck.deletedAt !== null) return null;
  let document: Awaited<ReturnType<typeof s.core.getRevision>>["document"];
  try {
    ({ document } = await s.core.getRevision(deckReader, {
      presentationId: deckId,
      revision: deck.currentRevision,
    }));
  } catch (error) {
    if (isDomainError(error) && error.code === "NOT_FOUND") return null;
    throw error;
  }
  const refs = new Set<string>();
  for (const text of [
    document.theme?.css ?? "",
    ...document.slides.flatMap((x) => [x.html, x.css ?? ""]),
  ]) {
    for (const ref of assetRefsOf(text)) if (SHA256.test(ref)) refs.add(ref);
  }
  const assets = new Map<string, OfflineAsset>();
  for (const sha256 of refs) {
    try {
      const { asset, content } = await s.core.getAsset(deckReader, {
        sha256,
        presentationId: deckId,
      });
      assets.set(sha256, {
        mediaType: asset.mediaType,
        base64: Buffer.from(content).toString("base64"),
      });
    } catch (error) {
      if (!(isDomainError(error) && error.code === "NOT_FOUND")) throw error;
    }
  }
  // Offline copies are always the static version (ADR-020: scripted decks are online only in this phase).
  const { html } = buildOfflineDocument(staticDeck(document).deck, {
    nonce: randomBytes(18).toString("base64"),
    assets,
    fonts: offlineFonts(s),
  });
  return { id: deckId, revision: deck.currentRevision, html };
}

function presenterPage(deckId: string, title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Presenter · ${escapeHtml(title)} · PPTaken</title>
<link rel="stylesheet" href="/_player/presenter.css"></head>
<body data-deck="${escapeHtml(deckId)}" data-state="loading"><div id="presenter"></div><p id="status" role="status">Loading…</p>
<script type="module" src="/_player/presenter-page.js"></script></body></html>`;
}

/**
 * The presenter data of a revision of the deck (default: the current one). Steps are left to the client (it reads
 * the player). Also served to an APPROVED remote device for its live session's revision (F4).
 */
export async function presenterData(
  s: Services,
  deckId: string,
  revision?: number,
): Promise<PresenterData | null> {
  const deck = await s.storage.decks.get(DEFAULT_WORKSPACE_ID, deckId);
  if (deck === null || deck.deletedAt !== null) return null;
  const number = revision ?? deck.currentRevision;
  let document: Awaited<ReturnType<typeof s.core.getRevision>>["document"];
  try {
    ({ document } = await s.core.getRevision(ownerPrincipal(DEFAULT_WORKSPACE_ID), {
      presentationId: deckId,
      revision: number,
    }));
  } catch (error) {
    if (isDomainError(error) && error.code === "NOT_FOUND") return null;
    throw error;
  }
  const data: PresenterData = {
    title: document.title,
    revision: number,
    aspectRatio: document.aspectRatio === "4:3" ? "4:3" : "16:9",
    slides: document.slides.map((slide) => {
      const out: PresenterSlide = {
        id: slide.id,
        title: slide.title ?? "",
        notesHtml: renderNotes(slide.notes ?? ""),
      };
      if (slide.section !== undefined && slide.section !== "") out.section = slide.section;
      if (slide.durationHintSec !== undefined) out.durationHintSec = slide.durationHintSec;
      return out;
    }),
  };
  if (document.targetMinutes !== undefined) data.targetMinutes = document.targetMinutes;
  return data;
}

export function presenterRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /** Rate limit and owner session of the presenter and offline APIs; a response when refused. */
  const requireOwnerApi = async (c: Context<AppEnv>): Promise<Response | null> => {
    const rl = s.limits.apiPerIp.take(c.get("ip"));
    if (!rl.ok) {
      return apiError(c, "RATE_LIMITED", "Too many requests", {
        retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
      });
    }
    if ((await ownerSession(c, s)) === null) {
      if (!(await s.auth.isInstalled())) {
        return apiError(c, "SETUP_REQUIRED", "Nobody has set up this instance yet", {
          hint: "Open /welcome to set it up.",
        });
      }
      return apiError(c, "UNAUTHENTICATED", "Sign in first");
    }
    return null;
  };

  app.get("/api/v1/decks/:id/presenter", async (c) => {
    const denied = await requireOwnerApi(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const data = ULID.test(id) ? await presenterData(s, id) : null;
    if (data === null) return apiError(c, "NOT_FOUND", "Presentation not found");
    return c.json(data, 200, { "Cache-Control": "no-store" });
  });

  app.get("/p/:deckId/presenter", async (c) => {
    const deckId = c.req.param("deckId");
    if (!(await s.auth.isInstalled())) return c.redirect("/welcome", 302);
    if ((await ownerSession(c, s)) === null) return c.redirect("/login", 302);
    const deck = ULID.test(deckId) ? await s.storage.decks.get(DEFAULT_WORKSPACE_ID, deckId) : null;
    if (deck === null || deck.deletedAt !== null) {
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return c.html(presenterPage(deckId, deck.title), 200, {
      "Content-Security-Policy": playerPagePolicy(c, s),
      "Cache-Control": "no-store",
    });
  });

  // Offline layer 2: the deck's offline document (images and fonts inlined as data: URIs, notes removed, the
  // no-network CSP as its first <meta>). The service worker stores it; the player mounts it through srcdoc when
  // the content route cannot be reached. Owner session only, app origin, JSON (never rendered as a page here).
  app.get("/api/v1/decks/:id/offline", async (c) => {
    const denied = await requireOwnerApi(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const bundle = ULID.test(id) ? await offlineBundle(s, id) : null;
    if (bundle === null) return apiError(c, "NOT_FOUND", "Presentation not found");
    return c.json(bundle, 200, { "Cache-Control": "no-store" });
  });

  return app;
}
