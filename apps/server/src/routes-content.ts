// SPDX-License-Identifier: AGPL-3.0-or-later
// Presenting: the trusted player page (/p/:deckId, owner session) and the isolated content routes (/c/…):
// the deck document built from the stored, already sanitized revision, its assets and the bundled fonts.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signToken, verifyToken } from "@pptaken/auth-local";
import {
  DEFAULT_WORKSPACE_ID,
  isDomainError,
  isServableAssetType,
  type Principal,
  scriptsDigest,
} from "@pptaken/core";
import {
  assetHeaders,
  BUILD_PLACEHOLDER,
  buildDeckDocument,
  contentHeaders,
  RUNTIME_SHA256,
  SHELL_FILES,
} from "@pptaken/player";
import { staticDeck } from "@pptaken/sanitizer";
import { canvasSize } from "@pptaken/schema";
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
import { labelsFor, pickLocale } from "./i18n.js";
import { syncChannelName } from "./sync.js";
import { keepOfflineCopy, loadContent, SignedOutError } from "./offline-client.js";
import { createUnlockDialog, forgetUnlockToken, readUnlockToken, requestUnlock, storeUnlockToken } from "./unlock.js";
import { createErrorReporter } from "./error-report.js";
const body = document.body;
const id = body.dataset.deck;
const stage = document.getElementById("stage");
const status = document.getElementById("status");
const locale = pickLocale(navigator.languages);
const t = labelsFor(locale);
// Interactive mode (ADR-020): ?safe=1 forces the static version; otherwise the server decides (owner session,
// instance switch, approved digest) and the shell hardens itself when it runs scripts.
const safe = new URLSearchParams(location.search).get("safe") === "1";
// A page served WITHOUT an owner session (ADR-021: future presenter/public links; today only the test route) has a
// view grant for the static version and offers the presenter-password unlock (U). No presenter window, remote
// control or offline copy there. The unlock token lives in sessionStorage only and goes in a header.
const guest = body.dataset.viewer === "guest";
const view = body.dataset.view || "";
let source = null;
let player = null;
let remote = null;
let unlock = null;
function load(options) {
  if (!guest) return loadContent(id, fetch, options);
  const headers = { "X-PPTaken-View": view };
  const token = options.safe ? null : readUnlockToken(id);
  if (token) headers["X-PPTaken-Unlock"] = token;
  return loadContent(id, fetch, { ...options, headers, offline: false });
}
function mount(src) {
  body.dataset.source = src.fromCopy ? "copy" : "network";
  body.dataset.scripts = src.scripts ?? "none";
  body.dataset.state = "loading";
  const scripted = src.scripts === "running";
  // ADR-023: the owner's page sends author-script failures to the panel (never shown on this audience screen).
  const reporter = scripted && !guest && src.digest ? createErrorReporter({ deckId: id, digest: src.digest }) : null;
  if (reporter) addEventListener("pagehide", () => reporter.flush());
  const seenErrors = new Set();
  let keeping = false;
  const p = createPlayer(stage, {
    ...(src.fromCopy ? { contentHtml: src.contentHtml } : { contentUrl: src.contentUrl }),
    showHud: true,
    indicator: true,
    title: document.title,
    locale,
    remoteKeys: !guest && !src.fromCopy,
    unlockKey: guest,
    onKey: (code, from) => {
      // A guest's static frame: Esc gives the keyboard back to the trusted page (where U works).
      if (guest && from === "frame" && code === "Escape") stage.focus({ preventScroll: true });
      return remote ? remote.onKey(code, from) : false;
    },
    ...(guest ? {} : { presenterUrl: "/p/" + encodeURIComponent(id) + "/presenter", sync: syncChannelName(id) ?? undefined }),
    onReady: (slides) => { status.hidden = true; body.dataset.slides = String(slides.length); body.dataset.state = "ready"; },
    onLoadTimeout: () => { body.dataset.state = "slow"; showStatus(t.loadSlow, false); },
    onChange: (s) => { body.dataset.slide = String(s.slide); body.dataset.step = String(s.step); body.dataset.mode = s.mode; body.dataset.black = String(s.black); remote?.onChange(s); unlock?.setIndicatorVisible(!s.black); },
    ...(scripted ? {
      scripts: true,
      expect: src.expect,
      fallbackUrl: () => load({ safe: true }).then((r) => r.contentUrl ?? null),
      onScriptError: (e) => {
        seenErrors.add(JSON.stringify([e.kind, e.slideId, e.name, e.message]));
        body.dataset.scriptErrors = String(seenErrors.size);
        reporter?.add(e);
      },
    } : {}),
    onFault: (f) => {
      if (f === "unresponsive") { body.dataset.state = "unresponsive"; body.dataset.scripts = "stopped"; unlock?.setIndicator(false); return; }
      body.dataset.state = "fault"; body.dataset.fault = f; showStatus(t.stoppedFault, !guest);
    },
    onOffline: (o) => {
      body.dataset.offline = o.state;
      body.dataset.offlineImages = String(o.images);
      body.dataset.offlineFonts = String(o.fonts);
      if (guest || o.state === "loading" || src.fromCopy || keeping) return;
      keeping = true;
      keepOfflineCopy(id).then((r) => { body.dataset.offlineCopy = String(r.kept); p.setOfflineCopy(r.kept); });
    },
  });
  if (src.fromCopy) p.setOfflineCopy(true);
  // A scripted frame never gets the keyboard by default: the trusted page keeps it until the presenter clicks in.
  // A guest page keeps it too, so U reaches the unlock dialog.
  if (scripted || guest) stage.focus({ preventScroll: true });
  else p.iframe.focus();
  unlock?.setIndicator(scripted);
  return p;
}
// Status line (bottom left): what happened and what to do, with a link to the deck's page for the owner. Text only.
function showStatus(text, withLink) {
  status.hidden = false;
  status.replaceChildren(document.createTextNode(text));
  if (withLink) {
    const a = document.createElement("a");
    a.href = "/decks/" + encodeURIComponent(id) + "#script-errors";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = t.openDeckPage;
    a.style.cssText = "margin-left:8px;color:#C9C3FF";
    status.append(a);
  }
}
// After a successful unlock: ask again with the token; when the server signs the scripted document, replace the
// frame (same position, through the URL hash) and show the indicator.
async function onUnlocked(token) {
  storeUnlockToken(id, token);
  let next;
  try { next = await load({ safe: false }); } catch { return false; }
  if (next.scripts !== "running") {
    if (next.unlockRejected) forgetUnlockToken(id);
    return false;
  }
  player.destroy();
  source = next;
  player = mount(next);
  return true;
}
async function start() {
  try {
    source = await load({ safe });
  } catch (error) {
    if (error instanceof SignedOutError) {
      if (guest) { body.dataset.state = "error"; status.textContent = t.linkInvalid; return; }
      location.href = "/login";
      return;
    }
    throw error;
  }
  if (guest) {
    if (source.unlockRejected) forgetUnlockToken(id);
    stage.tabIndex = -1;
    unlock = createUnlockDialog({
      doc: document,
      mount: body,
      locale,
      frames: () => (player ? [player.iframe] : []),
      available: () => navigator.onLine && source !== null && !source.fromCopy,
      submit: (password) => requestUnlock(id, password),
      onUnlocked,
      returnFocus: () => stage,
    });
    body.dataset.unlock = "ready";
  }
  player = mount(source);
  if (guest && source.unlockRejected) unlock.flash(t.unlockEnded);
  if (!guest && !source.fromCopy) {
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
start().catch(() => { body.dataset.state = "error"; showStatus(t.loadFailed, false); });
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
  // The previews never run author scripts (ADR-020): always the static version.
  const [raw, source] = await Promise.all([get(base + "/presenter"), loadContent(id, fetch, { safe: true })]);
  const data = parsePresenterData(raw);
  if (!data) throw new Error("presenter data");
  document.title = t.presenterTitle + " · " + data.title;
  body.dataset.source = source.fromCopy ? "copy" : "network";
  const interactiveNotice = () => (data.interactive === true && (source.fromCopy || !navigator.onLine) ? t.interactiveOffline : null);
  const presenter = createPresenter(document.getElementById("presenter"), {
    ...(source.fromCopy ? { contentHtml: source.contentHtml } : { contentUrl: source.contentUrl }),
    data,
    locale,
    sync: syncChannelName(id) ?? undefined,
    // The page is owner-only and the deck came from the network with the owner session: link back to the panel.
    // An offline copy proves no session, so no link there.
    panelUrl: source.fromCopy ? undefined : "/decks",
    // ADR-023: the actionable script notices link to the deck's page and copy a message for the owner's agent.
    deckId: source.fromCopy ? undefined : id,
    deckPageUrl: source.fromCopy ? undefined : "/decks/" + encodeURIComponent(id),
    // ADR-021: offline the deck is static and nothing asks for a password; say so here, never on the audience screen.
    interactiveNotice: interactiveNotice() ?? undefined,
    onFinish: () => { body.dataset.finished = "true"; },
    onChange: (s) => { body.dataset.slide = String(s.slide); body.dataset.step = String(s.step); body.dataset.end = String(s.atEnd); body.dataset.running = String(s.running); body.dataset.elapsed = String(Math.floor(s.elapsedMs / 1000)); },
    onOffline: (o) => { body.dataset.offline = o.state; },
  });
  if (source.fromCopy) presenter.setOfflineCopy(true);
  for (const type of ["online", "offline"]) {
    window.addEventListener(type, () => {
      const text = interactiveNotice();
      presenter.setInteractiveNotice(text);
      body.dataset.interactiveNotice = text ? "shown" : "hidden";
    });
  }
  body.dataset.interactiveNotice = interactiveNotice() ? "shown" : "hidden";
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
  return playerCsp(frame === own ? null : frame, RUNTIME_SHA256);
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

/**
 * The vendored scripts of a deck (ADR-022), read from the deck's assets by SHA-256. The builder re-verifies every
 * file's hash against the `libs` reference before inlining it, so a swapped blob cannot run.
 */
async function vendoredScriptsOf(
  s: Services,
  deckId: string,
  deck: { libs?: { sha256: string }[] | undefined },
): Promise<Map<string, { js: string }>> {
  const out = new Map<string, { js: string }>();
  for (const lib of deck.libs ?? []) {
    try {
      const { asset, content } = await s.core.getAsset(contentReader, {
        sha256: lib.sha256,
        presentationId: deckId,
      });
      if (asset.mediaType !== "text/javascript") continue;
      out.set(lib.sha256, {
        js: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content),
      });
    } catch {
      // Not stored for this deck (a bundled library, or missing): the builder uses its own or refuses.
    }
  }
  return out;
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
      // Only images and fonts are served (ADR-022): vendored scripts are inlined in the scripted document and
      // vendored stylesheets are merged into the deck's CSS, never loaded from here.
      if (!isServableAssetType(asset.mediaType)) return notFoundText();
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
    const token = c.req.query("ct") ?? "";
    // Two kinds of token: "doc" (static document, subject `<deck>:<revision>`) and, interactive mode (ADR-020),
    // "sdoc" (minted only for the owner's session, subject `<deck>:<revision>:<scripts digest>`).
    const docOk = verifyToken(s.contentKey, token, {
      purpose: "doc",
      subject: `${deckId}:${revisionText}`,
      now,
    });
    let signedDigest: string | null = null;
    if (!docOk) {
      const subject = subjectOf(token) ?? "";
      const prefix = `${deckId}:${revisionText}:`;
      const candidate = subject.startsWith(prefix) ? subject.slice(prefix.length) : "";
      if (
        !SHA256.test(candidate) ||
        !verifyToken(s.contentKey, token, { purpose: "sdoc", subject, now })
      ) {
        return forbiddenText();
      }
      signedDigest = candidate;
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
    // Interactive mode (ADR-020): the scripted document only for an "sdoc" token minted for this revision's exact
    // digest, with the instance switch on and that digest still approved now (a revocation takes effect at
    // once); everything else gets the static fallback (scripts and libraries removed, HTML re-sanitized with the
    // safe profile).
    let scripted = false;
    if (signedDigest !== null && s.config.scripts === "owner") {
      const digest = scriptsDigest(document);
      const approval = await s.storage.scriptApprovals.get(DEFAULT_WORKSPACE_ID, deckId);
      scripted = digest === signedDigest && approval?.digest === digest;
    }
    const servedDeck = scripted ? deck : staticDeck(deck).deck;
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
    if (scripted) {
      const built = buildDeckDocument(servedDeck, {
        scripts: true,
        vendoredScripts: await vendoredScriptsOf(s, deckId, servedDeck),
        assetBaseUrl,
        fontBaseUrl,
        fontFaces,
        frameAncestors,
      });
      return c.body(built.html, 200, {
        ...contentHeaders({
          scriptHashes: [RUNTIME_SHA256],
          assetBaseUrl,
          fontBaseUrl,
          frameAncestors,
        }),
        "Content-Security-Policy": built.csp,
      });
    }
    const built = buildDeckDocument(servedDeck, { nonce, assetBaseUrl, fontBaseUrl, fontFaces });
    return c.body(
      built.html,
      200,
      contentHeaders({ nonce, assetBaseUrl, fontBaseUrl, frameAncestors }),
    );
  });

  app.all("*", () => notFoundText());
  return app;
}
