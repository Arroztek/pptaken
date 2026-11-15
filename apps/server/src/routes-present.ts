// SPDX-License-Identifier: AGPL-3.0-or-later
// Presenter view (phase F3): the presenter data API (`GET /api/v1/decks/:id/presenter`) and the presenter page
// (`GET /p/:deckId/presenter`), both on the app origin and only for the owner session. This is the only place
// speaker notes leave the server, rendered to safe HTML by `renderNotes` (T7: never on `/c/*`, never on public
// links, never in the content iframe).
//
// Mounted at `/` before the panel API router, whose catch-all would otherwise answer the API path.
import { DEFAULT_WORKSPACE_ID, isDomainError, ownerPrincipal } from "@pptaken/core";
import { type PresenterData, type PresenterSlide, renderNotes } from "@pptaken/player";
import { Hono } from "hono";
import type { AppEnv, Services } from "./context.js";
import { apiError, appCsp, contentOrigin, publicOrigin } from "./http.js";
import { escapeHtml } from "./routes-content.js";
import { ownerSession } from "./session.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function presenterPage(deckId: string, title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Presenter · ${escapeHtml(title)} · PPTaken</title>
<link rel="stylesheet" href="/_player/presenter.css"></head>
<body data-deck="${escapeHtml(deckId)}" data-state="loading"><div id="presenter"></div><p id="status" role="status">Loading…</p>
<script type="module" src="/_player/presenter-page.js"></script></body></html>`;
}

/** The presenter data of the deck's current revision. Steps are left to the client (it reads the player). */
export async function presenterData(s: Services, deckId: string): Promise<PresenterData | null> {
  const deck = await s.storage.decks.get(DEFAULT_WORKSPACE_ID, deckId);
  if (deck === null || deck.deletedAt !== null) return null;
  let document: Awaited<ReturnType<typeof s.core.getRevision>>["document"];
  try {
    ({ document } = await s.core.getRevision(ownerPrincipal(DEFAULT_WORKSPACE_ID), {
      presentationId: deckId,
      revision: deck.currentRevision,
    }));
  } catch (error) {
    if (isDomainError(error) && error.code === "NOT_FOUND") return null;
    throw error;
  }
  const data: PresenterData = {
    title: document.title,
    revision: deck.currentRevision,
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

  app.get("/api/v1/decks/:id/presenter", async (c) => {
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
    const frame = contentOrigin(c, s.config);
    const own = publicOrigin(c, s.config);
    return c.html(presenterPage(deckId, deck.title), 200, {
      "Content-Security-Policy": appCsp(frame === own ? [] : [frame]),
      "Cache-Control": "no-store",
    });
  });

  return app;
}
