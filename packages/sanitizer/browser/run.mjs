// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser test: renders every corpus vector, raw and sanitized, inside the production isolation (sandboxed
// iframe + CSP sandbox + no-network CSP) in Chromium, Firefox and WebKit, and checks that no canary fires and
// that nothing leaves the content over the network.
// Usage: pnpm --filter @pptaken/sanitizer test:browser   (builds first; needs the Playwright browsers)
//
// Phases per engine (each with its own request log, so a request is always attributed to the right phase):
//   1. controls  - a nonce-authorized alert() and a CSP-less external image MUST be detected (harness self-test)
//   2. sanitized - sanitized vectors and the legitimate slides: no canary, no request of any kind
//   3. raw       - raw vectors: no canary, no session cookie on any request, no request outside the content
//                  route except the documented gaps (vectors with `rawNetworkLeak`)

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, firefox, webkit } from "@playwright/test";
import { sanitizeCss, sanitizeSlideHtml } from "../dist/index.js";
import { startServer } from "./server.mjs";

const CORPUS = new URL("../corpus/", import.meta.url);
const SCOPE = '[data-slide="v"]';
const BATCH = 25;
const BATCH_TIMEOUT_MS = 8000;

const expand = (g) => g.prefix + g.unit.repeat(g.times) + g.suffix;
const vectors = [];
for (const file of readdirSync(CORPUS).sort()) {
  if (!file.endsWith(".json") || file === "legit.json") continue;
  for (const v of JSON.parse(readFileSync(new URL(file, CORPUS), "utf8"))) {
    vectors.push({
      ...v,
      html: v.htmlGenerator ? expand(v.htmlGenerator) : (v.html ?? ""),
      css: v.cssGenerator ? expand(v.cssGenerator) : (v.css ?? ""),
    });
  }
}
const legit = JSON.parse(readFileSync(new URL("legit.json", CORPUS), "utf8"));
const byId = new Map(vectors.map((v) => [v.id, v]));

// Content documents, keyed by `<mode>-<id>`.
const docs = new Map();
for (const v of vectors) {
  docs.set(`raw-${v.id}`, { html: v.html, css: v.css });
  docs.set(`clean-${v.id}`, {
    html: sanitizeSlideHtml(v.html).html,
    css: sanitizeCss(v.css, { scope: SCOPE }).css,
  });
}
for (const l of legit) {
  docs.set(`legit-${l.id}`, {
    html: sanitizeSlideHtml(l.html).html,
    css: sanitizeCss(l.css ?? "", { scope: SCOPE }).css,
  });
}
docs.set("control-script", { html: "<p>control</p>", css: "", script: "alert('control')" });
docs.set("control-nocsp", { html: '<img src="http://evil.test/control.png">', css: "" });

const server = await startServer((id) => docs.get(id) ?? null);
const base = server.url;
const report = {
  date: new Date().toISOString(),
  vectors: vectors.length,
  legit: legit.length,
  engines: {},
};
let failed = false;

// Attribution of a request to a document: documents live at /c/<key>/ (relative URLs carry the key); raw vectors
// that use absolute paths carry `?v=<id>`; otherwise the frame URL is used.
const keyIn = (url) => {
  const m = /\/c\/([^/?#]+)/.exec(url);
  return m && docs.has(decodeURIComponent(m[1])) ? decodeURIComponent(m[1]) : null;
};
const keyOf = (request) => {
  const own = keyIn(request.url());
  if (own) return own;
  const v = /[?&]v=([a-z0-9-]+)/.exec(request.url());
  if (v) return `raw-${v[1]}`;
  try {
    return keyIn(request.frame().url()) ?? "unknown";
  } catch {
    return "unknown";
  }
};

for (const [name, type] of [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
]) {
  const engine = { failures: [], sanitizedCspViolations: 0 };
  report.engines[name] = engine;
  const fail = (message) => {
    failed = true;
    engine.failures.push(message);
  };

  const browser = await type.launch();
  const context = await browser.newContext();
  let requests = [];
  let page;
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = request.url();
    if (url === `${base}/parent`) return route.continue();
    const key = keyIn(url);
    const docUrl = `${base}/c/${encodeURIComponent(key ?? "")}/?csp=`;
    if (
      key &&
      url.startsWith(docUrl) &&
      /^(planned|hardened)$/.test(url.slice(docUrl.length)) &&
      request.resourceType() === "document"
    ) {
      let parentIsMain = false;
      try {
        parentIsMain = request.frame().parentFrame() === page.mainFrame();
      } catch {}
      // Content documents may only be loaded by the harness, as direct children of the parent page.
      if (parentIsMain) return route.continue();
    }
    const contentRoute = url.startsWith(`${base}/c/`) && request.resourceType() !== "document";
    requests.push({ key: keyOf(request), url: url.slice(0, 120), contentRoute });
    // Same-origin requests go through so the server can record which cookies were sent; others are aborted.
    return url.startsWith(base) ? route.continue() : route.abort();
  });

  const canaries = [];
  const newPage = async () => {
    if (page) {
      try {
        canaries.push(...(await page.evaluate(() => window.__canaries.splice(0))));
      } catch {}
      await page.close().catch(() => {});
    }
    page = await context.newPage();
    await page.goto(`${base}/parent`);
  };
  const batch = (items) =>
    page.evaluate(([its, t]) => window.runBatch(its, t), [items, BATCH_TIMEOUT_MS]);

  // Runs documents in batches. A renderer crash takes the parent page down with it (the sandboxed frame shares
  // the renderer process): the batch is then re-run one document at a time, each in a fresh page.
  const runAll = async (keys, csp = "planned") => {
    const results = [];
    for (let i = 0; i < keys.length; i += BATCH) {
      const items = keys
        .slice(i, i + BATCH)
        .map((key) => ({ key, url: `${base}/c/${encodeURIComponent(key)}/?csp=${csp}` }));
      try {
        results.push(...(await batch(items)));
      } catch {
        await newPage();
        for (const item of items) {
          try {
            results.push(...(await batch([item])));
          } catch {
            results.push({ key: item.key, done: null, crashed: true });
            await newPage();
          }
        }
      }
    }
    canaries.push(...(await page.evaluate(() => window.__canaries.splice(0))));
    return results;
  };
  const takeCanaries = () => canaries.splice(0);
  const takeRequests = () => {
    const out = requests;
    requests = [];
    return out;
  };
  const takeHits = () => server.apiHits.splice(0);

  await newPage();

  // 1. Controls.
  await runAll(["control-script", "control-nocsp"]);
  if (!takeCanaries().some((c) => c.key === "control-script"))
    fail("control: canary detection does not work");
  if (!takeRequests().some((r) => r.key === "control-nocsp" && r.url.includes("evil.test"))) {
    fail("control: network detection does not work");
  }
  takeHits();

  // 2. Sanitized documents: nothing may happen.
  const cleanKeys = [...vectors.map((v) => `clean-${v.id}`), ...legit.map((l) => `legit-${l.id}`)];
  for (const r of await runAll(cleanKeys)) {
    if (r.crashed) fail(`renderer crashed on sanitized document ${r.key}`);
    else if (!r.done) fail(`no completion message from ${r.key}`);
    else {
      if (r.done.pwned) fail(`window.__pwned set in ${r.key}`);
      engine.sanitizedCspViolations += r.done.violations;
    }
  }
  for (const c of takeCanaries()) fail(`canary fired in sanitized ${c.key}: ${c.data}`);
  for (const r of takeRequests()) fail(`request from sanitized ${r.key}: ${r.url}`);
  for (const h of takeHits()) fail(`server hit during sanitized phase: ${h}`);

  // 3 and 4. Raw documents: the sandbox and the CSP must contain them. Run once with the planned CSP
  // (img-src 'self') and once with the hardened CSP (img-src limited to /c/asset/).
  const rawKeys = vectors.map((v) => `raw-${v.id}`);
  for (const variant of ["planned", "hardened"]) {
    const phase = {
      documentedLeaks: [],
      contentRouteRequests: 0,
      rendererCrashes: [],
      cspViolations: 0,
    };
    engine[`raw_${variant}`] = phase;
    for (const r of await runAll(rawKeys, variant)) {
      const vector = byId.get(r.key.slice(4));
      if (r.crashed) {
        // Resource-exhaustion input can crash the renderer: a denial of service, not an escape. Recorded.
        phase.rendererCrashes.push(r.key);
      } else if (!r.done) {
        if (!vector?.rawNetworkLeak) fail(`[raw ${variant}] no completion message from ${r.key}`);
      } else {
        if (r.done.pwned) fail(`[raw ${variant}] window.__pwned set in ${r.key}`);
        phase.cspViolations += r.done.violations;
      }
    }
    for (const c of takeCanaries()) fail(`[raw ${variant}] canary fired in ${c.key}: ${c.data}`);
    for (const r of takeRequests()) {
      const documented = byId.get(r.key.slice(4))?.rawNetworkLeak;
      if (r.contentRoute && variant === "planned") phase.contentRouteRequests++;
      else if (documented) phase.documentedLeaks.push(`${r.key} -> ${r.url}`);
      else fail(`[raw ${variant}] request from ${r.key}: ${r.url}`);
    }
    const hits = takeHits();
    phase.serverHits = hits;
    phase.sessionCookieSent = hits.filter((h) => /cookies=.*\bsid\b/.test(h));
    phase.legacyCookieSent = hits.filter((h) => /cookies=.*\blegacy\b/.test(h)).length;
    if (variant === "hardened") {
      // With the hardened CSP the session cookie must never leave with a request triggered by content, except
      // through the documented navigation gap (meta refresh), which no CSP directive covers.
      phase.knownGaps = [];
      for (const hit of phase.sessionCookieSent) {
        const v = /[?&]v=([a-z0-9-]+)/.exec(hit);
        if (v && byId.get(v[1])?.rawNetworkLeak) phase.knownGaps.push(hit);
        else fail(`[raw hardened] SameSite=Lax session cookie sent with ${hit}`);
      }
    }
  }

  engine.ok = engine.failures.length === 0;
  const p = engine.raw_planned;
  const h = engine.raw_hardened;
  console.log(
    `${name}: ${engine.ok ? "PASS" : "FAIL"} - ${cleanKeys.length} sanitized documents clean`,
  );
  console.log(
    `  raw, planned CSP:  ${rawKeys.length} documents; no canary; same-origin content-route requests ${p.contentRouteRequests}; ` +
      `SameSite=Lax session cookie sent on ${p.sessionCookieSent.length}; documented leaks ${p.documentedLeaks.length}; ` +
      `renderer crashes ${p.rendererCrashes.length}`,
  );
  console.log(
    `  raw, hardened CSP: ${rawKeys.length} documents; no canary; session cookie sent on ${h.sessionCookieSent.length} ` +
      `(documented navigation gap: ${h.knownGaps.length}); ` +
      `documented leaks ${h.documentedLeaks.length}; renderer crashes ${h.rendererCrashes.length}`,
  );
  for (const f of engine.failures.slice(0, 30)) console.log(`  - ${f}`);
  await browser.close();
}

await server.close();
writeFileSync(new URL("./last-run.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
process.exit(failed ? 1 : 0);
