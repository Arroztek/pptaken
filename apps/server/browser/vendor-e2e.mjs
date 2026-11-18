// SPDX-License-Identifier: AGPL-3.0-or-later
// Ingest-time vendoring and the HTML importer end to end (ADR-022) in Chromium, Firefox and WebKit, against the REAL
// server (built dist) with PPTAKEN_SCRIPTS=owner, app on localhost and content on 127.0.0.1 (temp data dir, random
// port). The vendoring fetcher is the real one over a fake third-party network (fake-cdn.mjs): no request leaves
// the machine while importing, and every request the browsers make is intercepted: anything that is not the
// instance itself is recorded and aborted, and the run fails if there is any.
//
// Checked per engine, for an imported artifact with a Google Fonts link, a jsDelivr UMD library (behind a redirect)
// that tries to fetch at load time, an https image and an onclick widget:
//   owner, after approval: scripted document; the vendored font is loaded from the instance's asset URL; the
//   deck script ran; the library's runtime fetch was neutralized by the lockdown; clicking the widget works;
//   guest (no owner session): static document, no script ran, the font and the image still load from the instance;
//   both: zero requests to third-party hosts.
// Usage: pnpm --filter @pptaken/server build && node apps/server/browser/vendor-e2e.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { chromium, firefox, webkit } from "@playwright/test";
import { createServer } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { ARTIFACT, fakeCdn } from "./fake-cdn.mjs";

const freePort = () =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const OWNER = "violet otter climbs 7 dunes";
const agent = {
  actor: "agent",
  workspaceId: "default",
  scopes: new Set(["decks:read", "decks:write"]),
  tokenId: "e2e",
};

const port = await freePort();
const app = `http://localhost:${port}`;
const content = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "pptaken-vendor-"));
const results = { startedAt: new Date().toISOString(), engines: {} };
let failed = false;
const cdn = fakeCdn();

const pptaken = await createServer(
  loadConfig({
    PPTAKEN_DATA_DIR: dataDir,
    PPTAKEN_PUBLIC_URL: app,
    PPTAKEN_CONTENT_URL: content,
    PPTAKEN_WEB_DIR: join(dataDir, "no-web"),
    PPTAKEN_SCRIPTS: "owner",
    PPTAKEN_LOG_LEVEL: "warn",
  }),
  {
    logSink: () => {},
    testRoutes: true,
    vendorNetwork: { resolve: cdn.resolve, transport: cdn.transport },
  },
);
const http = serve({ fetch: pptaken.fetch, port, hostname: "::" });
const s = pptaken.services;
const headers = { Origin: app, "X-PPTaken-CSRF": "1", "Content-Type": "application/json" };
const post = (path, body, cookie) =>
  fetch(`${app}${path}`, {
    method: "POST",
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
const contentFrame = (page) => page.frames().find((f) => f.url().startsWith(`${content}/c/`));
const ownHost = (url) => {
  const u = new URL(url);
  return (
    u.protocol === "data:" ||
    u.protocol === "about:" ||
    u.protocol === "blob:" ||
    (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && u.port === String(port))
  );
};

/** Records and aborts every request to anything but this instance. */
async function guard(context, sink) {
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (ownHost(url)) return route.continue();
    sink.push(url);
    return route.abort();
  });
}

async function frameReady(page, scripts) {
  await page.waitForSelector(`body[data-state="ready"][data-scripts="${scripts}"]`, {
    timeout: 20_000,
  });
  const frame = contentFrame(page);
  if (!frame) throw new Error("no content frame on the content origin");
  return frame;
}

try {
  const setup = await post("/api/v1/setup", { installCode: pptaken.installCode, password: OWNER });
  if (setup.status !== 201) throw new Error(`setup: ${setup.status}`);
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  const [cookieName, cookieValue] = cookie.split("=");

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const r = { ok: false, checks: [], thirdParty: [] };
    results.engines[name] = r;
    const check = (label) => r.checks.push(label);
    const browser = await engine.launch();
    try {
      const before = cdn.requests.length;
      const imported = await s.core.importHtml(agent, {
        html: ARTIFACT,
        title: `Vendored ${name}`,
      });
      const id = imported.presentationId;
      if (imported.heuristic !== "slide-class") throw new Error(`heuristic ${imported.heuristic}`);
      // The first import goes through the fake CDN; later ones hit the fetcher's instance cache (no request).
      if (cdn.requests.length < 5 || (name === "chromium" && cdn.requests.length - before < 5))
        throw new Error("the import did not go through the fake CDN");
      if (imported.vendored.length !== 4 || imported.vendored.some((v) => v.status === "failed"))
        throw new Error(`vendoring report ${JSON.stringify(imported.vendored)}`);
      check(
        `import: ${imported.slideCount} slides by ${imported.heuristic}, ${imported.vendored.length} resources vendored over the fake network`,
      );
      const approve = await post(
        `/api/v1/decks/${id}/scripts/approve`,
        { digest: imported.scripts.digest },
        cookie,
      );
      if (approve.status !== 200) throw new Error(`approve: ${approve.status}`);

      // --- Owner, approved: scripted.
      const owner = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await owner.addCookies([{ name: cookieName, value: cookieValue, url: app }]);
      await guard(owner, r.thirdParty);
      const page = await owner.newPage();
      const assetResponses = [];
      page.on("response", (res) => {
        if (res.url().includes("/c/asset/")) assetResponses.push(res.status());
      });
      await page.goto(`${app}/p/${id}`);
      const frame = await frameReady(page, "running");
      const state = await frame.evaluate(async () => {
        await document.fonts.load('48px "Vendored Mono"');
        return {
          font: document.fonts.check('48px "Vendored Mono"'),
          family: getComputedStyle(document.querySelector("h1")).fontFamily,
          deckScript: document.body.getAttribute("data-deck-script"),
          probe: window.MiniChart?.probe ?? null,
        };
      });
      if (!state.font || !/Vendored Mono/.test(state.family))
        throw new Error(`font not loaded: ${JSON.stringify(state)}`);
      check("owner: the vendored font loads from the instance's asset URL");
      if (state.deckScript !== "ran") throw new Error("deck script did not run");
      check("owner: the deck script ran after the vendored library");
      if (
        state.probe === null ||
        state.probe.fetch !== "undefined" ||
        state.probe.fetched !== false
      )
        throw new Error(`library could reach fetch: ${JSON.stringify(state.probe)}`);
      check(
        "owner: the CDN library's runtime fetch is neutralized by the lockdown (fetch is undefined)",
      );
      await page.keyboard.press("ArrowRight");
      await page.waitForSelector('body[data-slide="1"]', { timeout: 5000 });
      await frame.click("#go");
      await frame.click("#go");
      await frame.waitForSelector('#out[data-rendered="2"]', { timeout: 5000 });
      check("owner: the converted onclick widget calls the vendored library (2 clicks → bars:2)");
      await owner.close();

      // --- Guest (no owner session): static.
      const guest = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await guard(guest, r.thirdParty);
      const gpage = await guest.newPage();
      const guestAssets = [];
      gpage.on("response", (res) => {
        if (res.url().includes("/c/asset/")) guestAssets.push(res.status());
      });
      await gpage.goto(`${app}/__test/guest/${id}`);
      const gframe = await frameReady(gpage, "locked");
      const gstate = await gframe.evaluate(async () => {
        await document.fonts.load('48px "Vendored Mono"');
        const img = document.querySelector("img");
        return {
          font: document.fonts.check('48px "Vendored Mono"'),
          deckScript: document.body.getAttribute("data-deck-script"),
          lib: typeof window.MiniChart,
          scripts: document.scripts.length,
          img: img?.getAttribute("src") ?? "",
          button: document.querySelector("#go") !== null,
        };
      });
      if (!gstate.font) throw new Error("guest: font not loaded");
      if (gstate.deckScript !== null || gstate.lib !== "undefined" || gstate.scripts !== 1)
        throw new Error(`guest: scripts ran ${JSON.stringify(gstate)}`);
      if (!gstate.img.startsWith(`${content}/c/asset/`))
        throw new Error(`guest: image ${gstate.img}`);
      await gpage.waitForTimeout(300);
      if (!guestAssets.some((st) => st === 200)) throw new Error("guest: no asset was served");
      check(
        "guest: static document (runtime only, no library, no deck script), vendored font and image still load from the instance",
      );
      await guest.close();

      if (r.thirdParty.length > 0)
        throw new Error(`requests to third parties: ${r.thirdParty.join(", ")}`);
      if (!assetResponses.every((st) => st === 200))
        throw new Error(`asset errors ${assetResponses}`);
      check("no request to any third-party host from either context (intercepted and counted: 0)");
      r.ok = true;
    } catch (error) {
      failed = true;
      r.error = String(error?.stack ?? error);
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  failed = true;
  results.error = String(error?.stack ?? error);
} finally {
  results.finishedAt = new Date().toISOString();
  writeFileSync(
    new URL("./vendor-last-run.json", import.meta.url),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  for (const [name, r] of Object.entries(results.engines)) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"} ${name}: ${r.checks.length} checks${r.error ? `\n  ${r.error}` : ""}`,
    );
  }
  if (results.error) console.log(results.error);
  http.close();
  await pptaken.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.exit(failed ? 1 : 0);
}
