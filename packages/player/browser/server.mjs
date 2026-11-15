// SPDX-License-Identifier: Apache-2.0
// Test server for the player browser test, adapted from the S1 spike and sanitizer harnesses. It reproduces the
// recommended production layout with two origins:
//   - app origin     http://localhost:<A>   the trusted shell page (with a session cookie and a fake API) and
//                                           the built player modules (/dist/*.js)
//   - content origin http://127.0.0.1:<B>   deck documents (/c/deck/<key>) and assets (/c/asset/<hex>), with the
//                                           headers from `contentHeaders`/`assetHeaders`; no cookies
// Every other request on either origin is recorded as a hit: content must never cause one.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { crc32, deflateSync } from "node:zlib";
import {
  assetHeaders,
  buildDeckDocument,
  buildOfflineDocument,
  contentHeaders,
  RUNTIME_SHA256,
  renderNotes,
} from "../dist/index.js";

const DIST = new URL("../dist/", import.meta.url);

/** An asset id the content origin answers with 404 (the "partial" preload scenario). Not recorded as a hit. */
export const MISSING_ASSET = "dead0000dead0000dead0000dead0000";

/** A real, decodable 24×24 PNG (offline documents inline raster images only). */
export function pngBytes(size = 24) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** CSP hash source of an inline script. */
export const scriptHash = (source) =>
  `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;

/** The production player page CSP (apps/server `playerCsp`), plus optional extra script hashes for tests. */
const playerPageCsp = (content, extra = []) =>
  [
    "default-src 'self'",
    `script-src 'self' 'sha256-${RUNTIME_SHA256}'${extra.map((h) => ` ${h}`).join("")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src 'self' ${content}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

const offlinePage = (key) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>offline player browser test</title>
<style>html,body{margin:0;height:100%;background:#000}#host{position:fixed;inset:0}#typing{position:fixed;left:0;top:0;width:8px;height:8px;opacity:0}</style>
</head><body><input id="typing" aria-label="typing test"><div id="host"></div>
<script type="module" src="/offline-page.js?key=${encodeURIComponent(key)}"></script></body></html>`;

const OFFLINE_PAGE_SCRIPT = `import { createPlayer } from "/dist/shell.js";
const key = new URL(import.meta.url).searchParams.get("key");
const t = (window.__test = { changes: [], rendered: null, faults: [], keys: 0, pwned: [], probe: null, slides: null, offline: null, error: null, activation: [] });
addEventListener("message", (e) => {
  const d = e.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "key") { t.keys++; t.activation.push(navigator.userActivation?.isActive ?? "n/a"); }
  if (d.pwned) t.pwned.push(String(d.pwned));
  if (d.probe) t.probe = d.probe;
});
const { html } = await (await fetch("/offline-doc/" + encodeURIComponent(key))).json();
try {
  window.__player = createPlayer(document.getElementById("host"), {
    contentHtml: html,
    showHud: true,
    indicator: true,
    onReady: (slides) => { t.slides = slides; },
    onChange: (s) => t.changes.push(s),
    onRender: (p) => { t.rendered = p; },
    onFault: (f) => t.faults.push(f),
    onOffline: (o) => { t.offline = o; },
  });
} catch (error) {
  t.error = String(error);
}
`;

/** A small SVG asset (served for any valid hex id). */
const ASSET_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">' +
  '<rect width="160" height="160" rx="24" fill="#5746AF"/><circle cx="80" cy="80" r="40" fill="#FFB224"/></svg>';

/** JSON safe to embed in a <script> element. */
const embed = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

/** Presenter data the way the server builds it (notes rendered to safe HTML, no slide HTML). */
export const presenterDataOf = (deck) => ({
  title: deck.title,
  aspectRatio: deck.aspectRatio === "4:3" ? "4:3" : "16:9",
  ...(deck.targetMinutes === undefined ? {} : { targetMinutes: deck.targetMinutes }),
  slides: deck.slides.map((s) => ({
    id: s.id,
    title: s.title ?? "",
    ...(s.section ? { section: s.section } : {}),
    ...(s.durationHintSec ? { durationHintSec: s.durationHintSec } : {}),
    notesHtml: renderNotes(s.notes ?? ""),
  })),
});

const presenterPage = (contentUrl, key, deck) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>presenter browser test</title></head>
<body><div id="root"></div>
<script type="module">
import { createPresenter, parsePresenterData } from "/dist/presenter.js";
const data = parsePresenterData(${embed(presenterDataOf(deck))});
window.__data = data;
window.__presenter = createPresenter(document.getElementById("root"), {
  contentUrl: ${JSON.stringify(contentUrl)},
  data,
  sync: ${JSON.stringify(`pptaken:${key}`)},
  tickMs: 100,
});
window.__presenter.ready.then(() => { window.__presenterReady = true; });
</script></body></html>`;

const shellPage = (contentUrl, key) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>player browser test</title>
<style>html,body{margin:0;height:100%;background:#000}#host{position:fixed;inset:0}#typing{position:fixed;left:0;top:0;width:8px;height:8px;opacity:0}</style>
</head><body><input id="typing" aria-label="typing test"><div id="host"></div>
<script type="module">
import { createPlayer } from "/dist/shell.js";
const t = (window.__test = { changes: [], rendered: null, faults: [], keys: 0, pwned: [], probe: null, slides: null, offline: null });
addEventListener("message", (e) => {
  const d = e.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "key") t.keys++;
  if (d.pwned) t.pwned.push(String(d.pwned));
  if (d.probe) t.probe = d.probe;
});
window.__player = createPlayer(document.getElementById("host"), {
  contentUrl: ${JSON.stringify(contentUrl)},
  showHud: true,
  indicator: true,
  presenterUrl: ${JSON.stringify(`/presenter/${key}`)},
  sync: ${JSON.stringify(`pptaken:${key}`)},
  onReady: (slides) => { t.slides = slides; },
  onChange: (s) => t.changes.push(s),
  onRender: (p) => { t.rendered = p; },
  onFault: (f) => t.faults.push(f),
  onOffline: (o) => { t.offline = o; },
});
</script></body></html>`;

/**
 * `pageHashes` (offline page only): extra script hashes for the page CSP, to model a script that got through.
 * @param {(key: string) => { deck: import("@pptaken/schema").Deck; inject?: (html: string, nonce: string, origins: {shell: string, content: string}) => string; pageHashes?: (origins: {shell: string, content: string}) => string[] } | null} deckFor
 */
export async function startServers(deckFor) {
  const hits = [];
  const origins = { shell: "", content: "" };
  const cookies = (req) =>
    (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.split("=")[0]?.trim())
      .filter(Boolean)
      .join(",") || "none";
  const record = (req, res, where) => {
    hits.push(`${where} ${req.method} ${req.url} cookies=${cookies(req)}`);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  };

  const shell = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const player = /^\/player\/([a-z0-9-]+)$/.exec(u.pathname);
    if (player && deckFor(player[1])) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": ["sid=SECRET123; Path=/; HttpOnly; SameSite=Lax", "legacy=1; Path=/"],
      });
      return res.end(shellPage(`${origins.content}/c/deck/${player[1]}`, player[1]));
    }
    const presenter = /^\/presenter\/([a-z0-9-]+)$/.exec(u.pathname);
    const entry = presenter ? deckFor(presenter[1]) : null;
    if (presenter && entry) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(
        presenterPage(`${origins.content}/c/deck/${presenter[1]}`, presenter[1], entry.deck),
      );
    }
    // Offline delivery path: the same shell mounting an offline document through srcdoc, under the production
    // player page CSP (a srcdoc frame inherits it).
    const offline = /^\/offline-player\/([a-z0-9-]+)$/.exec(u.pathname);
    const offlineEntry = offline ? deckFor(offline[1]) : null;
    if (offline && offlineEntry) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": playerPageCsp(
          origins.content,
          offlineEntry.pageHashes?.(origins) ?? [],
        ),
        "set-cookie": ["sid=SECRET123; Path=/; HttpOnly; SameSite=Lax", "legacy=1; Path=/"],
      });
      return res.end(offlinePage(offline[1]));
    }
    if (u.pathname === "/offline-page.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      return res.end(OFFLINE_PAGE_SCRIPT);
    }
    const offlineDoc = /^\/offline-doc\/([a-z0-9-]+)$/.exec(u.pathname);
    const docEntry = offlineDoc ? deckFor(offlineDoc[1]) : null;
    if (offlineDoc && docEntry) {
      const nonce = randomBytes(18).toString("base64");
      const assets = new Map();
      const refs = JSON.stringify(docEntry.deck).matchAll(/asset:([0-9a-f]{16,64})/g);
      for (const [, hex] of refs) {
        if (hex !== MISSING_ASSET)
          assets.set(hex, { mediaType: "image/png", base64: pngBytes().toString("base64") });
      }
      let { html } = buildOfflineDocument(docEntry.deck, { nonce, assets });
      if (docEntry.inject) html = docEntry.inject(html, nonce, origins);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ html }));
    }
    const file = /^\/dist\/([a-z0-9-]+\.js)$/.exec(u.pathname);
    if (file) {
      try {
        const body = readFileSync(new URL(file[1], DIST));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        return res.end(body);
      } catch {}
    }
    return record(req, res, "app");
  });

  const content = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const doc = /^\/c\/deck\/([a-z0-9-]+)$/.exec(u.pathname);
    const entry = doc ? deckFor(doc[1]) : null;
    if (entry && u.search === "") {
      const nonce = randomBytes(16).toString("base64");
      const options = {
        nonce,
        assetBaseUrl: `${origins.content}/c/asset/`,
        frameAncestors: [origins.shell],
      };
      let { html } = buildDeckDocument(entry.deck, options);
      // Hostile documents: raw content injected after the builder, as if the sanitizer had been bypassed.
      if (entry.inject) html = entry.inject(html, nonce, origins);
      res.writeHead(200, contentHeaders(options));
      return res.end(html);
    }
    if (u.pathname === `/c/asset/${MISSING_ASSET}`) {
      res.writeHead(404, { ...assetHeaders(), "content-type": "text/plain" });
      return res.end("missing");
    }
    if (/^\/c\/asset\/[0-9a-f]{16,64}$/.test(u.pathname) && u.search === "") {
      res.writeHead(200, { ...assetHeaders(), "content-type": "image/svg+xml" });
      return res.end(ASSET_SVG);
    }
    return record(req, res, "content");
  });

  const listen = (server, port, host) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

  // `localhost` may resolve to 127.0.0.1 or ::1: listen on both with the same port.
  const shellPort = await listen(shell, 0, "127.0.0.1");
  const shell6 = http.createServer((req, res) => shell.emit("request", req, res));
  await listen(shell6, shellPort, "::1").catch(() => {});
  const contentPort = await listen(content, 0, "127.0.0.1");
  origins.shell = `http://localhost:${shellPort}`;
  origins.content = `http://127.0.0.1:${contentPort}`;

  const close = (server) => new Promise((r) => server.close(() => r()));
  return {
    origins,
    hits,
    close: async () => {
      shell.closeAllConnections?.();
      shell6.closeAllConnections?.();
      content.closeAllConnections?.();
      await Promise.all([close(shell), close(shell6).catch(() => {}), close(content)]);
    },
  };
}
