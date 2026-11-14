// SPDX-License-Identifier: AGPL-3.0-or-later
// Test server for the browser test, adapted from the S1 isolation spike harness (docs/spikes/s1-harness).
// It serves a parent page (the trusted shell, holding a "session" cookie and a fake API) and one content
// document per vector, with the production isolation: `Content-Security-Policy: sandbox allow-scripts` plus the
// no-network CSP, loaded by the parent in `<iframe sandbox="allow-scripts">`.

import { randomBytes } from "node:crypto";
import http from "node:http";

/**
 * The CSP of `/c/...` content documents. `planned` is the policy of ADR-001 / security §4 as verified by the S1
 * spike (`img-src 'self'`). `hardened` restricts images and fonts to the asset path of the content route, which
 * this test shows is needed to stop raw content from sending cookie-bearing GETs to other same-origin paths.
 */
export const contentCsp = (nonce, variant = "planned", origin = "") =>
  [
    "sandbox allow-scripts",
    "default-src 'none'",
    variant === "hardened" ? `img-src ${origin}/c/asset/` : "img-src 'self'",
    variant === "hardened" ? `font-src ${origin}/c/asset/` : "font-src 'self'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join("; ");

const PARENT = `<!doctype html><meta charset=utf-8><title>sanitizer browser test</title>
<body style="margin:0">
<script>
window.__canaries = [];
window.__done = new Map();
addEventListener("message", (e) => {
  const frame = [...document.querySelectorAll("iframe")].find((f) => f.contentWindow === e.source);
  const key = frame ? frame.dataset.key : "unknown";
  const d = e.data;
  if (d && d.__done) { window.__done.set(key, d); return; }
  // Anything else that reaches the parent from content is a canary: PWNED strings, alert() overrides...
  window.__canaries.push({ key, origin: e.origin, data: JSON.stringify(d).slice(0, 200) });
});
window.runBatch = (items, timeoutMs) => new Promise((resolve) => {
  document.querySelectorAll("iframe").forEach((f) => f.remove());
  for (const item of items) {
    const f = document.createElement("iframe");
    f.dataset.key = item.key;
    f.setAttribute("sandbox", "allow-scripts");
    f.style.cssText = "width:480px;height:270px;border:0";
    f.src = item.url;
    document.body.appendChild(f);
  }
  const started = Date.now();
  const tick = () => {
    const finished = items.every((i) => window.__done.has(i.key));
    if (finished || Date.now() - started > timeoutMs) {
      resolve(items.map((i) => ({ key: i.key, done: window.__done.get(i.key) || null })));
    } else setTimeout(tick, 50);
  };
  tick();
});
</script>`;

/** Instrumentation that runs first in every content document (nonce-authorized, like the PPTaken runtime). */
const instrumentation = (nonce) => `<script nonce="${nonce}">
(() => {
  const report = (what) => { try { parent.postMessage({ canary: what }, "*"); } catch (e) {} };
  for (const n of ["alert", "confirm", "prompt", "print"]) { try { window[n] = () => report(n); } catch (e) {} }
  let violations = 0;
  addEventListener("securitypolicyviolation", () => { violations++; });
  addEventListener("load", () => setTimeout(() => {
    parent.postMessage({ __done: true, pwned: window.__pwned === 1, violations }, "*");
  }, 700));
})();
</script>`;

/**
 * @param {(id: string) => { html: string; css: string } | null} contentFor resolves `/c/<mode>/<id>` documents.
 * @returns {Promise<{ url: string; apiHits: string[]; close: () => Promise<void> }>}
 */
export function startServer(contentFor) {
  const apiHits = [];
  const cookieNames = (req) =>
    (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.split("=")[0]?.trim())
      .filter(Boolean)
      .join(",") || "none";
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/parent") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        // `sid` is configured like the planned production session cookie; `legacy` has no SameSite attribute
        // and only measures what browsers do with such a cookie (informational).
        "set-cookie": ["sid=SECRET123; Path=/; HttpOnly; SameSite=Lax", "legacy=1; Path=/"],
      });
      return res.end(PARENT);
    }
    if (u.pathname.startsWith("/c/")) {
      // Documents live at /c/<id>/ so that relative URLs in raw content resolve to /c/<id>/... (attribution).
      const [rawId = "", ...rest] = u.pathname.slice(3).split("/");
      const id = decodeURIComponent(rawId);
      const content = rest.join("") === "" ? contentFor(id) : null;
      if (!content) {
        apiHits.push(`${req.method} ${req.url} cookies=${cookieNames(req)}`);
        res.writeHead(404);
        return res.end("not found");
      }
      const nonce = randomBytes(16).toString("base64");
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      };
      // The "control-nocsp" document proves that the network instrumentation detects leaks.
      if (!id.startsWith("control-nocsp")) {
        const variant = u.searchParams.get("csp") === "hardened" ? "hardened" : "planned";
        headers["content-security-policy"] = contentCsp(
          nonce,
          variant,
          `http://${req.headers.host}`,
        );
      }
      res.writeHead(200, headers);
      // The slide HTML goes inside <section data-slide="v">, as the player does; CSS in a <style> element.
      return res.end(
        `<!doctype html><html><head><meta charset="utf-8">${instrumentation(nonce)}` +
          `${content.script ? `<script nonce="${nonce}">${content.script}</script>` : ""}` +
          `<style>${content.css}</style></head><body><section data-slide="v">${content.html}</section></body></html>`,
      );
    }
    // Anything else (the fake API included) is recorded: content must never reach it.
    apiHits.push(`${req.method} ${req.url} cookies=${cookieNames(req)}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ secret: req.headers.cookie ?? "" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        apiHits,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
