// SPDX-License-Identifier: Apache-2.0
// Test server for the player browser test, adapted from the S1 spike and sanitizer harnesses. It reproduces the
// recommended production layout with two origins:
//   - app origin     http://localhost:<A>   the trusted shell page (with a session cookie and a fake API) and
//                                           the built player modules (/dist/*.js)
//   - content origin http://127.0.0.1:<B>   deck documents (/c/deck/<key>) and assets (/c/asset/<hex>), with the
//                                           headers from `contentHeaders`/`assetHeaders`; no cookies
// Every other request on either origin is recorded as a hit: content must never cause one.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { assetHeaders, buildDeckDocument, contentHeaders } from "../dist/index.js";

const DIST = new URL("../dist/", import.meta.url);

/** A small SVG asset (served for any valid hex id). */
const ASSET_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">' +
  '<rect width="160" height="160" rx="24" fill="#5746AF"/><circle cx="80" cy="80" r="40" fill="#FFB224"/></svg>';

const shellPage = (contentUrl) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>player browser test</title>
<style>html,body{margin:0;height:100%;background:#000}#host{position:fixed;inset:0}#typing{position:fixed;left:0;top:0;width:8px;height:8px;opacity:0}</style>
</head><body><input id="typing" aria-label="typing test"><div id="host"></div>
<script type="module">
import { createPlayer } from "/dist/shell.js";
const t = (window.__test = { changes: [], rendered: null, faults: [], keys: 0, pwned: [], probe: null, slides: null });
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
  onReady: (slides) => { t.slides = slides; },
  onChange: (s) => t.changes.push(s),
  onRender: (p) => { t.rendered = p; },
  onFault: (f) => t.faults.push(f),
});
</script></body></html>`;

/**
 * @param {(key: string) => { deck: import("@pptaken/schema").Deck; inject?: (html: string, nonce: string, origins: {shell: string, content: string}) => string } | null} deckFor
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
      return res.end(shellPage(`${origins.content}/c/deck/${player[1]}`));
    }
    const file = /^\/dist\/([a-z-]+\.js)$/.exec(u.pathname);
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
