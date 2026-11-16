// SPDX-License-Identifier: AGPL-3.0-or-later
// Presenting: the trusted player page (/p/:deckId, owner session) and the isolated content routes (/c/…):
// the deck document built from the stored, already sanitized revision, its assets and the bundled fonts.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signToken, verifyToken } from "@pptaken/auth-local";
import { DEFAULT_WORKSPACE_ID, isDomainError, type Principal } from "@pptaken/core";
import {
  assetHeaders,
  BUILD_PLACEHOLDER,
  buildDeckDocument,
  contentHeaders,
  RUNTIME_SHA256,
  SHELL_FILES,
} from "@pptaken/player";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv, Services } from "./context.js";
import { loadFontFaces } from "./fonts.js";
import { contentOrigin, ownOrigin, playerCsp, publicOrigin, SERVICE_WORKER_CSP } from "./http.js";
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

// The player shell and presenter modules of @pptaken/player, served as static ES modules to the trusted pages.
// The same list (plus the generated page files) is what the service worker stores for offline use.
const PLAYER_DIST = dirname(fileURLToPath(import.meta.resolve("@pptaken/player/shell")));
const GENERATED_FILES = new Set(["page.js", "page.css", "presenter-page.js", "presenter.css"]);
const PLAYER_FILES = new Set<string>(SHELL_FILES.filter((f) => !GENERATED_FILES.has(f)));

/** UI fonts of the presenter view, served on the app origin (the page's CSP allows `font-src 'self'` only). */
const UI_FONT_FAMILIES = new Map([
  ["Inter", "inter"],
  ["JetBrains Mono", "jetbrains-mono"],
]);

const PAGE_SCRIPT = `// PPTaken player page: loads the deck (the signed content URL online, the stored offline copy without a
// network), mounts the player shell and, in secure contexts, asks the service worker to keep an offline copy once
// the deck is in memory. Online, it also loads the remote control (/_rt/screen.js) on demand: remote commands are
// applied as local input, and any failure there never reaches the player.
import { createPlayer } from "./shell.js";
import { pickLocale } from "./i18n.js";
import { syncChannelName } from "./sync.js";
import { keepOfflineCopy, loadContent, SignedOutError } from "./offline-client.js";
const body = document.body;
const id = body.dataset.deck;
const status = document.getElementById("status");
async function start() {
  let source;
  try {
    source = await loadContent(id);
  } catch (error) {
    if (error instanceof SignedOutError) { location.href = "/login"; return; }
    throw error;
  }
  body.dataset.source = source.fromCopy ? "copy" : "network";
  let keeping = false;
  let remote = null;
  const locale = pickLocale(navigator.languages);
  const player = createPlayer(document.getElementById("stage"), {
    ...(source.fromCopy ? { contentHtml: source.contentHtml } : { contentUrl: source.contentUrl }),
    showHud: true,
    indicator: true,
    title: document.title,
    locale,
    remoteKeys: !source.fromCopy,
    onKey: (code, from) => (remote ? remote.onKey(code, from) : false),
    presenterUrl: "/p/" + encodeURIComponent(id) + "/presenter",
    sync: syncChannelName(id) ?? undefined,
    onReady: (slides) => { status.hidden = true; body.dataset.slides = String(slides.length); body.dataset.state = "ready"; },
    onLoadTimeout: () => { body.dataset.state = "slow"; status.hidden = false; status.textContent = "This presentation is taking too long to load. If you are in an embedded preview, open this page in your regular browser."; },
    onChange: (s) => { body.dataset.slide = String(s.slide); body.dataset.step = String(s.step); body.dataset.mode = s.mode; body.dataset.black = String(s.black); remote?.onChange(s); },
    onFault: (f) => { body.dataset.state = "fault"; status.hidden = false; status.textContent = "The presentation stopped: " + f; },
    onOffline: (o) => {
      body.dataset.offline = o.state;
      body.dataset.offlineImages = String(o.images);
      body.dataset.offlineFonts = String(o.fonts);
      if (o.state === "loading" || source.fromCopy || keeping) return;
      keeping = true;
      keepOfflineCopy(id).then((r) => { body.dataset.offlineCopy = String(r.kept); player.setOfflineCopy(r.kept); });
    },
  });
  if (source.fromCopy) player.setOfflineCopy(true);
  player.iframe.focus();
  if (!source.fromCopy) {
    Promise.all([import("/_rt/screen.js"), import("/_rt/qr.js")]).then(([m, q]) => {
      remote = m.startRemoteScreen({
        deckId: id,
        player,
        mount: document.getElementById("stage"),
        locale,
        qr: (text) => q.encodeQR(text, "raw", { ecc: "medium", border: 4 }),
        onStatus: (st, devices) => {
          body.dataset.remote = st;
          body.dataset.remotes = String(devices.filter((d) => d.status === "approved" && d.online).length);
          body.dataset.pending = String(devices.filter((d) => d.status === "pending").length);
        },
      });
    }).catch(() => { body.dataset.remote = "unavailable"; });
  }
}
start().catch(() => { body.dataset.state = "error"; status.textContent = "Could not load the presentation."; });
`;

const PAGE_CSS =
  "html,body{margin:0;height:100%;background:#000;color:#FAF7F2;font:16px system-ui,sans-serif}#stage{position:fixed;inset:0}#status{position:fixed;left:16px;bottom:16px;color:#8B8FA0}";

const PRESENTER_SCRIPT = `// PPTaken presenter page: loads the presenter data (notes, once, kept in memory) and the deck (signed content
// URL, or the stored offline copy without a network), then mounts the view.
import { createPresenter, parsePresenterData } from "./presenter.js";
import { labelsFor, pickLocale } from "./i18n.js";
import { syncChannelName } from "./sync.js";
import { loadContent, offlineCopyStatus, SignedOutError } from "./offline-client.js";
const body = document.body;
const id = body.dataset.deck;
const status = document.getElementById("status");
const locale = pickLocale(navigator.languages);
const t = labelsFor(locale);
status.textContent = t.loading;
async function get(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  if (res.status === 401) throw new SignedOutError();
  if (!res.ok) throw new Error(path + " " + res.status);
  return res.json();
}
async function start() {
  const base = "/api/v1/decks/" + encodeURIComponent(id);
  const [raw, source] = await Promise.all([get(base + "/presenter"), loadContent(id)]);
  const data = parsePresenterData(raw);
  if (!data) throw new Error("presenter data");
  document.title = t.presenterTitle + " · " + data.title;
  body.dataset.source = source.fromCopy ? "copy" : "network";
  const presenter = createPresenter(document.getElementById("presenter"), {
    ...(source.fromCopy ? { contentHtml: source.contentHtml } : { contentUrl: source.contentUrl }),
    data,
    locale,
    sync: syncChannelName(id) ?? undefined,
    // The page is owner-only and the deck came from the network with the owner session: link back to the panel.
    // An offline copy proves no session, so no link there.
    panelUrl: source.fromCopy ? undefined : "/decks",
    onFinish: () => { body.dataset.finished = "true"; },
    onChange: (s) => { body.dataset.slide = String(s.slide); body.dataset.step = String(s.step); body.dataset.end = String(s.atEnd); body.dataset.running = String(s.running); body.dataset.elapsed = String(Math.floor(s.elapsedMs / 1000)); },
    onOffline: (o) => { body.dataset.offline = o.state; },
  });
  if (source.fromCopy) presenter.setOfflineCopy(true);
  await presenter.ready;
  status.hidden = true;
  body.dataset.state = "ready";
  if (!source.fromCopy) mountRemote(locale).catch(() => {});
  if (!source.fromCopy) offlineCopyStatus(id).then((r) => presenter.setOfflineCopy(r.kept));
}
// Remote control panel (pairing QR, approvals, kick): a button here, over HTTP only (no socket in this window).
async function mountRemote(locale) {
  const [m, q, l] = await Promise.all([import("/_rt/panel.js"), import("/_rt/qr.js"), import("/_rt/i18n.js")]);
  const rt = l.remoteLabels(locale);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = rt.panelTitle;
  button.dataset.pptakenRemoteButton = "";
  button.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:5;font:14px Inter,system-ui,sans-serif;padding:8px 14px;border-radius:6px;border:1px solid #3A3F4B;background:#22252D;color:#F2EFE9;cursor:pointer";
  document.body.append(button);
  const panel = m.createPanel({
    doc: document,
    mount: document.body,
    locale,
    poll: true,
    qr: (text) => q.encodeQR(text, "raw", { ecc: "medium", border: 4 }),
    live: async () => {
      const res = await fetch("/api/v1/live", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-PPTaken-CSRF": "1" }, body: JSON.stringify({ deckId: id }) });
      if (!res.ok) throw new Error("live " + res.status);
      const r = await res.json();
      return { liveId: r.live.id, publicUrl: r.publicUrl };
    },
  });
  button.addEventListener("click", () => panel.toggle());
}
start().catch((error) => {
  if (error instanceof SignedOutError) { location.href = "/login"; return; }
  body.dataset.state = "error";
  status.textContent = t.loadError;
});
`;

const UNICODE_RANGE =
  /^U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?:, ?U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?)*$/;

/** Presenter page CSS: the UI fonts from the app origin (validated values from our own fonts.css). */
function presenterCss(s: Services): string {
  const faces = fontFacesOf(s)
    .filter((f) => UI_FONT_FAMILIES.has(f.family))
    .filter((f) => /^[1-9][0-9]{2}(?: [1-9][0-9]{2})?$/.test(f.weight))
    .filter((f) => f.unicodeRange === undefined || UNICODE_RANGE.test(f.unicodeRange))
    .map(
      (f) =>
        `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};font-display:swap;src:url(/_player/fonts/${f.file}) format("woff2");${f.unicodeRange ? `unicode-range:${f.unicodeRange};` : ""}}`,
    );
  return `${faces.join("\n")}\nhtml,body{margin:0;height:100%;background:#0F1115;color:#F2EFE9;font:16px Inter,system-ui,sans-serif}#status{position:fixed;left:16px;bottom:16px;margin:0;color:#8B8FA0}\n`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function playerPage(deckId: string, title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · PPTaken</title>
<link rel="stylesheet" href="/_player/page.css"></head>
<body data-deck="${escapeHtml(deckId)}" data-state="loading" data-offline="loading"><div id="stage"></div><p id="status" role="status">Loading…</p>
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

  app.get("/_player/fonts/:family/:file", (c) => {
    const family = c.req.param("family");
    const file = c.req.param("file");
    if (![...UI_FONT_FAMILIES.values()].includes(family) || !/^[a-z0-9-]{1,80}\.woff2$/.test(file))
      return notFoundText();
    const path = join(s.config.fontsDir, family, file);
    if (!existsSync(path)) return notFoundText();
    return c.body(readFileSync(path), 200, {
      "Content-Type": "font/woff2",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    });
  });

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
    if (file === "presenter-page.js") {
      return c.body(PRESENTER_SCRIPT, 200, {
        ...headers,
        "Content-Type": "text/javascript; charset=utf-8",
      });
    }
    if (file === "presenter.css") {
      return c.body(presenterCss(s), 200, {
        ...headers,
        "Content-Type": "text/css; charset=utf-8",
      });
    }
    if (!PLAYER_FILES.has(file)) return notFoundText();
    const path = join(PLAYER_DIST, file);
    if (!existsSync(path)) return notFoundText();
    return c.body(readFileSync(path, "utf8"), 200, {
      ...headers,
      "Content-Type": "text/javascript; charset=utf-8",
    });
  });

  // The offline service worker (layer 2). Its scope is `/p/`, the directory it is served from: the narrowest
  // scope that controls the player and presenter pages. Not private (no deck data in it).
  app.get("/p/sw.js", (c) =>
    c.body(serviceWorkerSource(s), 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": SERVICE_WORKER_CSP,
    }),
  );

  app.get("/p/:deckId", async (c) => {
    const deckId = c.req.param("deckId");
    if (!(await s.auth.isInstalled())) return c.redirect("/welcome", 302);
    if ((await ownerSession(c, s)) === null) return c.redirect("/login", 302);
    const deck = ULID.test(deckId) ? await s.storage.decks.get(DEFAULT_WORKSPACE_ID, deckId) : null;
    if (deck === null || deck.deletedAt !== null) return notFoundText();
    return c.html(playerPage(deckId, deck.title), 200, {
      "Content-Security-Policy": playerPagePolicy(c, s),
      "Cache-Control": "no-store",
    });
  });

  return app;
}

/** CSP of the player and presenter pages: the app CSP plus the runtime hash and data: fonts (offline srcdoc). */
export function playerPagePolicy(c: Context, s: Services): string {
  const frame = contentOrigin(c, s.config);
  const own = publicOrigin(c, s.config);
  return playerCsp(frame === own ? [] : [frame], RUNTIME_SHA256);
}

const swCache = new WeakMap<Services, string>();

/**
 * The service worker script with its build id: a hash of everything the worker stores for the shell (the worker
 * itself, the player modules, the page scripts and styles, the runtime). Any change installs a new worker.
 */
function serviceWorkerSource(s: Services): string {
  let source = swCache.get(s);
  if (source === undefined) {
    const sw = readFileSync(join(PLAYER_DIST, "sw.js"), "utf8");
    const hash = createHash("sha256").update(sw).update(RUNTIME_SHA256);
    for (const file of [...PLAYER_FILES].sort()) {
      const path = join(PLAYER_DIST, file);
      if (existsSync(path)) hash.update(readFileSync(path));
    }
    hash.update(PAGE_SCRIPT).update(PRESENTER_SCRIPT).update(PAGE_CSS).update(presenterCss(s));
    source = sw.replace(
      JSON.stringify(BUILD_PLACEHOLDER),
      JSON.stringify(hash.digest("hex").slice(0, 16)),
    );
    swCache.set(s, source);
  }
  return source;
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
