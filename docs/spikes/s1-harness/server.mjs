import fs from "node:fs";
import http from "node:http";

const NONCE = "n0nc3abc";
const font = fs.readFileSync(
  new URL("../../../packages/ui/fonts/inter/inter-latin-wght.woff2", import.meta.url),
);
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#FFB224"/></svg>';
const CSP = `sandbox allow-scripts; default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${NONCE}'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'`;

const parent = `<!doctype html><meta charset=utf-8><title>S1 parent</title>
<body style="margin:0;background:#111;color:#eee;font:14px monospace">
<div id=bar style="padding:8px">parent focus target <button id=pbtn>parent button</button></div>
<iframe id=deck src="/c/deck" sandbox="allow-scripts" style="width:960px;height:540px;border:0;background:#fff"></iframe>
<pre id=out></pre>
<script>
const R = { parent: {}, iframe: {}, keys: [] };
window.__R = R;
const f = document.getElementById("deck");
try { R.parent.readIframeDom = String(f.contentDocument && f.contentDocument.title || "null/blocked"); } catch (e) { R.parent.readIframeDom = "blocked: " + e.name; }
document.cookie = "sid=SECRET123; path=/";
addEventListener("message", (e) => { R.parent.count = (R.parent.count || 0) + 1; R.parent.lastType = e.data && e.data.type;
  R.parent.lastOrigin = e.origin; document.getElementById("out").textContent = JSON.stringify(R, null, 1);
  R.parent.sourceIsIframe = e.source === f.contentWindow;
  if (!R.parent.sourceIsIframe) return;
  const d = e.data;
  if (d && d.type === "tests") R.iframe = d.results;
  if (d && d.type === "key") R.keys.push(d.code);
  if (d && d.type === "ready") R.ready = d;
  
});
R.parent.iframeLoadEvent = false; f.addEventListener("load", () => { R.parent.iframeLoadEvent = true; }); f.addEventListener("load", () => setTimeout(() => f.contentWindow.postMessage({ type: "goto", slide: 1, step: 0 }, "*"), 300));
</script>`;

const deck = `<!doctype html><meta charset=utf-8>
<style>
@font-face{font-family:NoCors;src:url(/c/asset/font-nocors.woff2) format("woff2")}
@font-face{font-family:WithCors;src:url(/c/asset/font-cors.woff2) format("woff2")}
body{margin:0;font-family:sans-serif}
section{width:960px;height:540px;padding:20px;box-sizing:border-box}
.s{display:none}.s.on{display:block}
</style>
<body>
<section class="s on" id=s0><h1 style="font-family:NoCors,serif">Slide 0 NoCors</h1><img id=img src="/c/asset/img.svg"><img id=ext src="http://example.com/x.png"></section>
<section class="s" id=s1><h1 style="font-family:WithCors,serif">Slide 1 WithCors</h1></section>
<script nonce="${NONCE}">
const T = {};
const post = (m) => parent.postMessage(m, "*");
const t = async (name, fn) => { try { T[name] = await Promise.race([fn(), new Promise((_, rj) => setTimeout(() => rj({ name: "TIMEOUT" }), 3000))]); } catch (e) { T[name] = "threw: " + e.name; } post({ type: "tests", results: T }); };
(async () => {
  await t("origin", () => location.origin);
  await t("document.cookie", () => document.cookie === undefined ? "undefined" : "readable:" + document.cookie);
  await t("localStorage", () => String(localStorage.length));
  await t("parent.document", () => String(parent.document.title));
  await t("fetch same-origin api", async () => { const r = await fetch("/api/secret"); return "status " + r.status; });
  await t("eval", () => String(eval("1+1")));
  await t("top.location", () => { top.location = "http://example.com"; return "no throw"; });
  await t("window.open", () => String(window.open("/c/deck")));
  await t("img svg loaded", () => new Promise((res) => { const i = document.getElementById("img"); if (i.complete) return res(i.naturalWidth > 0 ? "yes " + i.naturalWidth : "no"); i.onload = () => res("yes " + i.naturalWidth); i.onerror = () => res("no"); }));
  await t("external img loaded", () => new Promise((res) => { const i = document.getElementById("ext"); if (i.complete) return res(i.naturalWidth > 0 ? "yes" : "no (blocked)"); i.onload = () => res("yes"); i.onerror = () => res("no (blocked)"); }));
  await t("font WITHOUT cors header", async () => { await document.fonts.load("20px NoCors"); return document.fonts.check("20px NoCors") ? "loaded" : "not loaded"; });
  await t("font WITH cors header", async () => { await document.fonts.load("20px WithCors"); return document.fonts.check("20px WithCors") ? "loaded" : "not loaded"; });
  post({ type: "tests", results: T });
  post({ type: "ready", slides: 2 });
})();
addEventListener("message", (e) => { 
  if (e.source !== parent) return;
  if (e.data && e.data.type === "goto") { document.querySelectorAll(".s").forEach((s, i) => s.classList.toggle("on", i === e.data.slide)); }
});
addEventListener("keydown", (e) => post({ type: "key", code: e.code }));
</script>`;

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/parent") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(parent);
    }
    if (u.pathname === "/c/deck") {
      const v = u.searchParams.get("csp");
      const csp =
        v === "explicit"
          ? CSP.replaceAll("'self'", "http://localhost:5391")
          : v === "nosandbox"
            ? CSP.replace("sandbox allow-scripts; ", "")
            : v === "none"
              ? null
              : CSP;
      const h = { "content-type": "text/html", "x-content-type-options": "nosniff" };
      if (csp) h["content-security-policy"] = csp;
      res.writeHead(200, h);
      return res.end(
        deck.replace(
          "R.parent.count = (R.parent.count || 0) + 1; R.parent.lastType = e.data && e.data.type;",
          "",
        ),
      );
    }
    if (u.pathname === "/c/asset/img.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      return res.end(svg);
    }
    if (u.pathname === "/c/asset/font-nocors.woff2") {
      res.writeHead(200, { "content-type": "font/woff2" });
      return res.end(font);
    }
    if (u.pathname === "/c/asset/font-cors.woff2") {
      res.writeHead(200, { "content-type": "font/woff2", "access-control-allow-origin": "*" });
      return res.end(font);
    }
    if (u.pathname === "/api/secret") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ secret: req.headers.cookie || "" }));
    }
    res.writeHead(404);
    res.end("nf");
  })
  .listen(5391, () => console.log("s1 up"));
