// SPDX-License-Identifier: AGPL-3.0-or-later
// Presenting: the trusted player page (/p/:deckId, owner session) and the isolated content routes (/c/…):
// the deck document built from the stored, already sanitized revision, its assets and the bundled fonts.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signToken, verifyToken } from "@pptaken/auth-local";
import { DEFAULT_WORKSPACE_ID, isDomainError, type Principal } from "@pptaken/core";
import { assetHeaders, buildDeckDocument, contentHeaders } from "@pptaken/player";
import { Hono } from "hono";
import type { AppEnv, Services } from "./context.js";
import { loadFontFaces } from "./fonts.js";
import { appCsp, contentOrigin, ownOrigin, publicOrigin } from "./http.js";
import { ownerSession } from "./session.js";

/** Lifetime of the token embedded in a document's asset URLs (images on later slides load lazily). */
export const ASSET_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Read-only principal the content routes use after the signed token has been verified. */
const contentReader: Principal = {
  actor: "system",
  workspaceId: DEFAULT_WORKSPACE_ID,
  scopes: new Set(["decks:read"]),
};

// The player shell modules of @pptaken/player, served as static ES modules to the trusted page.
const PLAYER_DIST = dirname(fileURLToPath(import.meta.resolve("@pptaken/player/shell")));
const PLAYER_FILES = new Set([
  "shell.js",
  "keys.js",
  "navigation.js",
  "protocol.js",
  "messages.js",
]);

const PAGE_SCRIPT = `// PPTaken player page: asks the API for the signed content URL and mounts the player shell.
import { createPlayer } from "./shell.js";
const body = document.body;
const id = body.dataset.deck;
const status = document.getElementById("status");
async function start() {
  const res = await fetch("/api/v1/decks/" + encodeURIComponent(id) + "/content-url", { credentials: "same-origin" });
  if (res.status === 401) { location.href = "/login"; return; }
  if (!res.ok) throw new Error("content-url " + res.status);
  const { url } = await res.json();
  const player = createPlayer(document.getElementById("stage"), {
    contentUrl: url,
    showHud: true,
    title: document.title,
    onReady: (slides) => { status.hidden = true; body.dataset.slides = String(slides.length); body.dataset.state = "ready"; },
    onLoadTimeout: () => { body.dataset.state = "slow"; status.hidden = false; status.textContent = "This presentation is taking too long to load. If you are in an embedded preview, open this page in your regular browser."; },
    onChange: (s) => { body.dataset.slide = String(s.slide); body.dataset.step = String(s.step); },
    onFault: (f) => { body.dataset.state = "fault"; status.hidden = false; status.textContent = "The presentation stopped: " + f; },
  });
  player.iframe.focus();
}
start().catch(() => { body.dataset.state = "error"; status.textContent = "Could not load the presentation."; });
`;

const PAGE_CSS =
  "html,body{margin:0;height:100%;background:#000;color:#FAF7F2;font:16px system-ui,sans-serif}#stage{position:fixed;inset:0}#status{position:fixed;left:16px;bottom:16px;color:#8B8FA0}";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function playerPage(deckId: string, title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · PPTaken</title>
<link rel="stylesheet" href="/_player/page.css"></head>
<body data-deck="${escapeHtml(deckId)}" data-state="loading"><div id="stage"></div><p id="status" role="status">Loading…</p>
<script type="module" src="/_player/page.js"></script></body></html>`;
}

function notFoundText(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function forbiddenText(): Response {
  return new Response("Forbidden", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Subject of a signed token (unverified; only used to pick what to verify against). */
function subjectOf(token: string): string | null {
  const payload = token.split(".")[0];
  if (payload === undefined || !/^[A-Za-z0-9_-]{1,400}$/.test(payload)) return null;
  const parts = Buffer.from(payload, "base64url").toString("utf8").split("|");
  return parts.length === 4 ? (parts[2] ?? null) : null;
}

/** Routes served on the app origin: the player page and its static modules. */
export function playerRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/_player/:file", (c) => {
    const file = c.req.param("file");
    const headers = { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
    if (file === "page.js") {
      return c.body(PAGE_SCRIPT, 200, {
        ...headers,
        "Content-Type": "text/javascript; charset=utf-8",
      });
    }
    if (file === "page.css") {
      return c.body(PAGE_CSS, 200, { ...headers, "Content-Type": "text/css; charset=utf-8" });
    }
    if (!PLAYER_FILES.has(file)) return notFoundText();
    const path = join(PLAYER_DIST, file);
    if (!existsSync(path)) return notFoundText();
    return c.body(readFileSync(path, "utf8"), 200, {
      ...headers,
      "Content-Type": "text/javascript; charset=utf-8",
    });
  });

  app.get("/p/:deckId", async (c) => {
    const deckId = c.req.param("deckId");
    if (!(await s.auth.isInstalled())) return c.redirect("/welcome", 302);
    if ((await ownerSession(c, s)) === null) return c.redirect("/login", 302);
    const deck = ULID.test(deckId) ? await s.storage.decks.get(DEFAULT_WORKSPACE_ID, deckId) : null;
    if (deck === null || deck.deletedAt !== null) return notFoundText();
    const frame = contentOrigin(c, s.config);
    const own = publicOrigin(c, s.config);
    return c.html(playerPage(deckId, deck.title), 200, {
      "Content-Security-Policy": appCsp(frame === own ? [] : [frame]),
      "Cache-Control": "no-store",
    });
  });

  return app;
}

const fontFaceCache = new WeakMap<Services, ReturnType<typeof loadFontFaces>>();

/** The bundled font faces, read from disk once per server instance. */
function fontFacesOf(s: Services): ReturnType<typeof loadFontFaces> {
  let faces = fontFaceCache.get(s);
  if (!faces) {
    faces = loadFontFaces(s.config.fontsDir);
    fontFaceCache.set(s, faces);
  }
  return faces;
}

/** Routes served on the content origin (or on the app origin when no separate content origin is configured). */
export function contentRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/fonts/:family/:file", (c) => {
    const family = c.req.param("family");
    const file = c.req.param("file");
    if (!/^[a-z0-9-]{1,40}$/.test(family) || !/^[a-z0-9-]{1,80}\.woff2$/.test(file))
      return notFoundText();
    const path = join(s.config.fontsDir, family, file);
    if (!existsSync(path)) return notFoundText();
    return c.body(readFileSync(path), 200, { ...assetHeaders(), "Content-Type": "font/woff2" });
  });

  app.get("/asset/:token/:sha256", async (c) => {
    const token = c.req.param("token");
    const sha = c.req.param("sha256");
    const deckId = subjectOf(token);
    if (deckId === null || !ULID.test(deckId) || !SHA256.test(sha)) return forbiddenText();
    if (
      !verifyToken(s.contentKey, token, { purpose: "asset", subject: deckId, now: s.clock.now() })
    ) {
      return forbiddenText();
    }
    try {
      const { asset, content } = await s.core.getAsset(contentReader, {
        sha256: sha,
        presentationId: deckId,
      });
      return c.body(new Uint8Array(content), 200, {
        ...assetHeaders(),
        "Content-Type": asset.mediaType,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        ETag: `"${sha}"`,
      });
    } catch (error) {
      if (isDomainError(error) && error.code === "NOT_FOUND") return notFoundText();
      throw error;
    }
  });

  app.get("/:deckId/:revision", async (c) => {
    const deckId = c.req.param("deckId");
    const revisionText = c.req.param("revision");
    if (!ULID.test(deckId) || !/^[1-9][0-9]{0,8}$/.test(revisionText)) return notFoundText();
    const now = s.clock.now();
    if (
      !verifyToken(s.contentKey, c.req.query("ct"), {
        purpose: "doc",
        subject: `${deckId}:${revisionText}`,
        now,
      })
    ) {
      return forbiddenText();
    }
    let document: Awaited<ReturnType<typeof s.core.getRevision>>["document"];
    try {
      ({ document } = await s.core.getRevision(contentReader, {
        presentationId: deckId,
        revision: Number(revisionText),
      }));
    } catch (error) {
      if (isDomainError(error) && error.code === "NOT_FOUND") return notFoundText();
      throw error;
    }
    // Speaker notes never reach the content route (T7).
    const deck = {
      ...document,
      slides: document.slides.map(({ notes: _notes, ...slide }) => slide),
    };
    const nonce = randomBytes(18).toString("base64");
    const origin = contentOrigin(c, s.config);
    const assetToken = signToken(s.contentKey, {
      purpose: "asset",
      subject: deckId,
      exp: now + ASSET_TOKEN_TTL_MS,
    });
    const assetBaseUrl = `${origin}/c/asset/${assetToken}/`;
    // The player page that frames this document: the public origin, or this same origin as accessed.
    const frameAncestors = [
      ...new Set([
        publicOrigin(c, s.config),
        ...(s.config.contentUrl === null ? [ownOrigin(c, s.config)] : []),
      ]),
    ];
    const fontBaseUrl = `${origin}/c/fonts/`;
    const fontFaces = fontFacesOf(s);
    const built = buildDeckDocument(deck, { nonce, assetBaseUrl, fontBaseUrl, fontFaces });
    return c.body(
      built.html,
      200,
      contentHeaders({ nonce, assetBaseUrl, fontBaseUrl, frameAncestors }),
    );
  });

  app.all("*", () => notFoundText());
  return app;
}
