// SPDX-License-Identifier: Apache-2.0
// Spike S4 harness: does a service worker of the app origin see the requests of an opaque-origin sandboxed
// content iframe, and does a `srcdoc` delivery keep working under the app page's CSP?
//
//   app origin      http://localhost:<A>    page, page script, service worker (scope "/"), same-origin content
//   content origin  http://127.0.0.1:<B>    the same content documents, cross-origin
//
// Every content document has the production-like CSP header (`sandbox allow-scripts`, a nonce, img/font limited
// to the `/c/` path, `connect-src 'none'`) and reports to the parent whether its image and font loaded.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

/** A real bundled WOFF2 (JetBrains Mono, latin subset). */
const FONT = readFileSync(
  new URL(
    "../../../packages/ui/fonts/jetbrains-mono/jetbrains-mono-latin-wght.woff2",
    import.meta.url,
  ),
);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#5746AF"/></svg>';
const NONCE = "c3Bpa2UtczQtbm9uY2UtMTIzNDU2";

/** The script inside every content document: checks its image and font and reports to the parent. */
const probe = (which) => `
addEventListener("DOMContentLoaded", async () => {
  const img = document.getElementById("img");
  const imgOk = await new Promise((r) => { if (img.complete) r(img.naturalWidth > 0); img.onload = () => r(true); img.onerror = () => r(false); });
  let fontFetched = "unknown";
  try { await document.fonts.load("16px Probe"); fontFetched = [...document.fonts].map((f) => f.status).join(","); } catch (e) { fontFetched = "error " + e.name; }
  let api = "blocked";
  try { await fetch("/api/x"); api = "reached"; } catch { api = "blocked"; }
  parent.postMessage({ which: ${JSON.stringify(which)}, img: imgOk, font: fontFetched, api, origin: String(self.origin) }, "*");
});`;

const docHtml = (which, base) => `<!doctype html><html><head><meta charset="utf-8">
<style>@font-face{font-family:Probe;src:url(${base}/c/font.woff2) format("woff2")}body{font-family:Probe}</style>
<script nonce="${NONCE}">${probe(which)}</script></head>
<body><img id="img" src="${base}/c/img.svg" alt=""><p>probe</p></body></html>`;

/** The srcdoc document: data: image and font, the CSP as a <meta>, and an inline script. */
const SRCDOC_SCRIPT = probe("srcdoc");
const srcdocHtml = (script) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'">
<style>@font-face{font-family:Probe;src:url(data:font/woff2;base64,${FONT.toString("base64")}) format("woff2")}body{font-family:Probe}</style>
<script nonce="${NONCE}">${script}</script></head>
<body><img id="img" src="data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}" alt=""><p>probe</p></body></html>`;

const sha256 = (text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

const SW = `
const log = [];
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname === "/sw-log") return;
  log.push((u.origin === self.location.origin ? "same " : "cross ") + e.request.mode + " " + e.request.destination + " " + u.pathname);
  if (u.pathname === "/c/sw-only") {
    e.respondWith(new Response("<!doctype html><p id=sw>served by the service worker</p><script nonce='${NONCE}'>parent.postMessage({which:'sw-only',served:true},'*')</script>", { headers: { "Content-Type": "text/html", "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'nonce-${NONCE}'" } }));
  }
});
self.addEventListener("message", (e) => {
  if (e.data === "log") e.source.postMessage({ log: log.slice() });
  if (e.data === "clear") log.length = 0;
});`;

const PAGE_SCRIPT = `
const results = (window.__s4 = { messages: [], sw: null });
addEventListener("message", (e) => {
  if (e.data && e.data.log) results.sw = e.data.log;
  else results.messages.push({ origin: e.origin, ...e.data });
});
navigator.serviceWorker?.addEventListener("message", (e) => { results.sw = e.data.log; });
window.__frame = (src, kind) => {
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-scripts");
  if (kind === "srcdoc") f.srcdoc = src; else f.src = src;
  document.body.append(f);
};
window.__swLog = () => navigator.serviceWorker.controller?.postMessage("log");
window.__register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready).then(() => true);
window.__srcdoc = ${JSON.stringify({ ok: srcdocHtml(SRCDOC_SCRIPT), unhashed: srcdocHtml(probe("srcdoc-unhashed")) })};
`;

export async function startServers() {
  const origins = { app: "", content: "" };
  const handler = (where) => (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const base = where === "app" ? origins.app : origins.content;
    if (u.pathname === "/c/doc") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'unsafe-inline'; img-src ${base}/c/; font-src ${base}/c/; connect-src 'none'`,
        "Cache-Control": "no-store",
      });
      return res.end(docHtml(`${where}-doc`, base));
    }
    if (u.pathname === "/c/img.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Access-Control-Allow-Origin": "*" });
      return res.end(SVG);
    }
    if (u.pathname === "/c/font.woff2") {
      res.writeHead(200, { "Content-Type": "font/woff2", "Access-Control-Allow-Origin": "*" });
      return res.end(FONT);
    }
    // `/` allows data: fonts; `/strict` does not (to see whether the srcdoc frame inherits the page's CSP).
    if (where === "app" && (u.pathname === "/" || u.pathname === "/strict")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": [
          "default-src 'self'",
          `script-src 'self' ${sha256(SRCDOC_SCRIPT)}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          u.pathname === "/" ? "font-src 'self' data:" : "font-src 'self'",
          "connect-src 'self'",
          `frame-src 'self' ${origins.content}`,
          "object-src 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      });
      return res.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>S4</title><script src="/page.js"></script></head><body></body></html>',
      );
    }
    if (where === "app" && u.pathname === "/page.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(PAGE_SCRIPT);
    }
    if (where === "app" && u.pathname === "/sw.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
      return res.end(SW);
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  };
  const app = http.createServer(handler("app"));
  const app6 = http.createServer((req, res) => app.emit("request", req, res));
  const content = http.createServer(handler("content"));
  const listen = (server, port, host) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(server.address().port));
    });
  const appPort = await listen(app, 0, "127.0.0.1");
  await listen(app6, appPort, "::1").catch(() => {});
  const contentPort = await listen(content, 0, "127.0.0.1");
  origins.app = `http://localhost:${appPort}`;
  origins.content = `http://127.0.0.1:${contentPort}`;
  return {
    origins,
    close: async () => {
      for (const s of [app, app6, content]) s.closeAllConnections?.();
      await Promise.all([app, app6, content].map((s) => new Promise((r) => s.close(() => r()))));
    },
  };
}
