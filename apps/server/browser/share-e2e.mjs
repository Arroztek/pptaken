// SPDX-License-Identifier: AGPL-3.0-or-later
// Public links end to end (ADR-026), in Chromium, Firefox and WebKit, against the REAL server (built dist) with
// PPTAKEN_SCRIPTS=owner, the app on localhost and the content on 127.0.0.1 (a separate site), a temp data dir and a
// random port. No test routes: the links are the production /s/<secret> pages.
//
// Per engine, the owner creates a view link and a presenter link through the panel API (session + CSRF) for an
// approved interactive deck with speaker notes; then a FRESH browser context with no cookies:
//   view link: the simple slides show; no notes anywhere (page or frame); the author code never ran; U offers no
//     unlock; S opens no presenter window; the key help lists neither P, S nor U; the panel API and the owner's
//     presenter data answer 401 with the page's grant; the quiet first-load hint appears;
//   presenter link: S opens the presenter window (/s/<secret>/presenter) with the notes; U opens the unlock; the
//     presenter password runs the approved code;
//   turning the links off: a reload shows the generic "not available" page; the open page's grant and its
//     document URL stop working at once;
//   an unknown link shows the same generic page; no request leaves the two origins; no console errors; no CSP
//     violations.
// Usage: pnpm --filter @pptaken/server build && node apps/server/browser/share-e2e.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { chromium, firefox, webkit } from "@playwright/test";
import { SignInThrottle, TokenBucketLimiter } from "@pptaken/auth-local";
import { createServer } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";

const freePort = () =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const OWNER = "violet otter climbs 7 dunes";
const PRESENTER = "lantern quietly folds 9 maps";
const NOTES = "Thank the volunteers before the demo";
const SCRIPT = "slide.root.setAttribute('data-ran', '1'); slide.onEnter(function () {});";
const agent = {
  actor: "agent",
  workspaceId: "default",
  scopes: new Set(["decks:read", "decks:write"]),
  tokenId: "e2e",
};

const port = await freePort();
const app = `http://localhost:${port}`;
const content = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "pptaken-share-"));
const results = { startedAt: new Date().toISOString(), engines: {} };
let failed = false;

const pptaken = await createServer(
  loadConfig({
    PPTAKEN_DATA_DIR: dataDir,
    PPTAKEN_PUBLIC_URL: app,
    PPTAKEN_CONTENT_URL: content,
    PPTAKEN_WEB_DIR: join(dataDir, "no-web"),
    PPTAKEN_SCRIPTS: "owner",
    PPTAKEN_LOG_LEVEL: "warn",
  }),
  { logSink: () => {} },
);
const http = serve({ fetch: pptaken.fetch, port, hostname: "::" });
const s = pptaken.services;

const headers = { Origin: app, "X-PPTaken-CSRF": "1", "Content-Type": "application/json" };
const call = (method, path, body, cookie) =>
  fetch(`${app}${path}`, {
    method,
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A fresh scripted, approved deck with speaker notes. */
async function approvedDeck(cookie, title) {
  const created = await s.core.createPresentation(agent, {
    title,
    slides: [
      { id: "intro", html: "<h1>Intro slide</h1>", notes: NOTES, script: SCRIPT },
      { id: "two", html: "<h1>Second slide</h1>", notes: "Second notes" },
    ],
  });
  const res = await call(
    "POST",
    `/api/v1/decks/${created.presentationId}/scripts/approve`,
    { digest: created.scripts.digest },
    cookie,
  );
  if (res.status !== 200) throw new Error(`approve: ${res.status}`);
  return created.presentationId;
}

async function createLink(cookie, deckId, kind) {
  const res = await call("POST", `/api/v1/decks/${deckId}/links`, { kind, label: kind }, cookie);
  if (res.status !== 201) throw new Error(`create link: ${res.status} ${await res.text()}`);
  return (await res.json()).link;
}

/** Guards of a guest context: requests outside the two origins, console errors, CSP violations. */
function guard(context) {
  const outside = [];
  const errors = [];
  context.on("request", (req) => {
    const u = new URL(req.url());
    if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return;
    if (u.origin !== app && u.origin !== content) outside.push(req.url());
  });
  const watch = (page) => {
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      // Our own expected refusals (401/403/404 after a link is turned off), and Chromium's note when Playwright's
      // init script meets the sandboxed (script-free) content frame.
      if (/Failed to load resource: the server responded with a status of (401|403|404)/.test(text))
        return;
      if (/Blocked script execution in .*because the document's frame is sandboxed/.test(text))
        return;
      // The scripted document's CSP names `webrtc 'block'` (CSP3); engines that do not know it yet say so. It
      // comes from the owner-approved scripted document (ADR-020), the same on the owner's own player.
      if (/Unrecognized Content-Security-Policy directive 'webrtc'/.test(text)) return;
      errors.push(text);
    });
    page.on("pageerror", (e) => errors.push(String(e)));
  };
  context.on("page", watch);
  return { outside, errors, watch };
}

const contentFrame = (page) => page.frames().find((f) => f.url().startsWith(`${content}/c/`));
/** Optional screenshots of the guest pages (PPTAKEN_SHARE_SHOTS=<dir>). */
const SHOTS = process.env.PPTAKEN_SHARE_SHOTS ?? "";
const shot = async (page, engine, name) => {
  if (SHOTS !== "") await page.screenshot({ path: join(SHOTS, `guest-${name}-${engine}.png`) });
};

try {
  const setup = await call("POST", "/api/v1/setup", {
    installCode: pptaken.installCode,
    password: OWNER,
  });
  if (setup.status !== 201) throw new Error(`setup: ${setup.status}`);
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  const pw = await call("POST", "/api/v1/presenter/password", { password: PRESENTER }, cookie);
  if (pw.status !== 200) throw new Error(`presenter password: ${pw.status}`);

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const r = { ok: false, checks: [] };
    results.engines[name] = r;
    const check = (label) => r.checks.push(label);
    // Fresh limits per engine: every browser comes from the same loopback IP.
    s.limits.presenterUnlock = new SignInThrottle({
      clock: s.clock,
      perIpPerMinute: 5,
      globalFailuresPer10Min: 30,
      delayAfterFailures: 3,
    });
    s.limits.presenterUnlockPerDeck = new TokenBucketLimiter({
      capacity: 10,
      refill: 10,
      intervalMs: 600_000,
      clock: s.clock,
    });
    const browser = await engine.launch();
    try {
      const deckId = await approvedDeck(cookie, `Shared ${name}`);
      const view = await createLink(cookie, deckId, "view");
      const presenter = await createLink(cookie, deckId, "presenter");
      if (!/^http:\/\/localhost:\d+\/s\/[A-Za-z0-9_-]{22}$/.test(view.url)) {
        throw new Error(`link url ${view.url}`);
      }

      // A fresh context: no cookies, nothing shared with the owner.
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      const g = guard(context);
      await context.addInitScript(() => {
        if (window !== window.top) return;
        window.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) =>
          window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
        );
      });
      if ((await context.cookies()).length !== 0) throw new Error("cookies in a fresh context");

      // 1. The view link.
      const page = await context.newPage();
      const res = await page.goto(view.url);
      const hdr = res?.headers() ?? {};
      if (
        hdr["cache-control"] !== "private, no-store" ||
        !/noindex/.test(hdr["x-robots-tag"] ?? "") ||
        hdr["referrer-policy"] !== "no-referrer"
      )
        throw new Error(`headers ${JSON.stringify(hdr)}`);
      await page.waitForSelector('body[data-state="ready"]', { timeout: 15_000 });
      const v = await page.evaluate(() => ({ ...document.body.dataset }));
      if (v.kind !== "view" || v.scripts !== "none")
        throw new Error(`view state ${JSON.stringify(v)}`);
      const frame = contentFrame(page);
      if (!frame) throw new Error("no content frame on the content origin");
      const frameText = await frame.evaluate(() => document.body.innerText);
      if (!frameText.includes("Intro slide")) throw new Error("slides not shown");
      if (frameText.includes(NOTES) || (await page.content()).includes(NOTES))
        throw new Error("notes on a view link");
      if (await frame.evaluate(() => document.querySelector("[data-ran]") !== null))
        throw new Error("author code ran on a view link");
      check("view link: simple slides on the content origin, no notes, the author code never ran");
      await page.waitForFunction(
        () => /arrow keys/.test(document.getElementById("status")?.textContent ?? ""),
        null,
        {
          timeout: 5000,
        },
      );
      check("view link: a quiet first-load hint (arrow keys, ? for all keys)");
      await shot(page, name, "view");
      await page.locator("#stage").focus();
      await page.keyboard.press("u");
      await page.waitForTimeout(200);
      if ((await page.locator("[data-pptaken-unlock]").count()) !== 0)
        throw new Error("view link offers the unlock");
      const popups = [];
      context.on("page", (p) => popups.push(p));
      await page.keyboard.press("s");
      await page.waitForTimeout(400);
      if (popups.length !== 0) throw new Error("view link opened a presenter window");
      await page.keyboard.press("?");
      await page.waitForTimeout(300);
      await shot(page, name, "view-help");
      const help = await page.evaluate(() =>
        [...document.querySelectorAll("[role=dialog] td:first-child")].map((td) => td.textContent),
      );
      if (help.length === 0 || help.some((k) => k === "P" || k === "S" || k === "U"))
        throw new Error(`key help ${JSON.stringify(help)}`);
      await page.keyboard.press("Escape");
      check(
        "view link: U offers no unlock, S opens no presenter window, the key help has no P/S/U",
      );
      const probes = await page.evaluate(async (id) => {
        const grant = document.body.dataset.view;
        const get = async (path, h = {}) => (await fetch(path, { headers: h })).status;
        return {
          decks: await get("/api/v1/decks"),
          deck: await get(`/api/v1/decks/${id}`, { "X-PPTaken-View": grant }),
          notes: await get(`/api/v1/decks/${id}/presenter`, { "X-PPTaken-View": grant }),
          guestNotes: await get(`/api/v1/share/${id}/presenter`, { "X-PPTaken-View": grant }),
          exportHtml: await get(`/api/v1/decks/${id}/export?format=html`, {
            "X-PPTaken-View": grant,
          }),
        };
      }, deckId);
      if (
        probes.decks !== 401 ||
        probes.deck !== 401 ||
        probes.notes !== 401 ||
        probes.guestNotes !== 404 ||
        probes.exportHtml !== 401
      )
        throw new Error(`probes ${JSON.stringify(probes)}`);
      check("view link: the panel API, export and the notes refuse the page's grant");

      // 2. The presenter link.
      const pres = await context.newPage();
      await pres.goto(presenter.url);
      await pres.waitForSelector('body[data-state="ready"][data-unlock="ready"]', {
        timeout: 15_000,
      });
      const p = await pres.evaluate(() => ({ ...document.body.dataset }));
      if (p.kind !== "presenter" || p.scripts !== "locked")
        throw new Error(`presenter ${JSON.stringify(p)}`);
      if ((await pres.content()).includes(NOTES)) throw new Error("notes in the audience page");
      check(
        "presenter link: the audience page starts with the simple version (interactive parts locked)",
      );
      await pres.locator("#stage").focus();
      const [win] = await Promise.all([
        context.waitForEvent("page", { timeout: 10_000 }),
        pres.keyboard.press("s"),
      ]);
      g.watch(win);
      await win.waitForSelector('body[data-state="ready"]', { timeout: 15_000 });
      if (!win.url().endsWith("/presenter") || !win.url().startsWith(`${app}/s/`))
        throw new Error(`presenter window at ${win.url()}`);
      const winText = await win.evaluate(() => document.body.innerText);
      if (!winText.includes(NOTES)) throw new Error("no notes in the presenter window");
      if (/Back to panel/.test(winText)) throw new Error("panel link in a guest presenter window");
      await win.setViewportSize({ width: 1280, height: 800 });
      await shot(win, name, "presenter-window");
      check("presenter link: S opens the presenter window with the notes, no panel link");
      await win.close();
      await pres.locator("#stage").focus();
      await pres.keyboard.press("u");
      await pres.locator("#pptaken-unlock-password").waitFor({ timeout: 5000 });
      await pres.fill("#pptaken-unlock-password", PRESENTER);
      await pres.keyboard.press("Enter");
      await pres.waitForSelector('body[data-scripts="running"][data-state="ready"]', {
        timeout: 15_000,
      });
      await contentFrame(pres)?.waitForSelector("[data-ran='1']", { timeout: 10_000 });
      await shot(pres, name, "presenter-unlocked");
      check("presenter link: U and the presenter password run the approved code");

      // 3. Turning the links off.
      const docUrl = await page.evaluate(() => document.querySelector("#stage iframe")?.src ?? "");
      for (const link of [view, presenter]) {
        const del = await call(
          "DELETE",
          `/api/v1/decks/${deckId}/links/${link.id}`,
          undefined,
          cookie,
        );
        if (del.status !== 204) throw new Error(`revoke ${del.status}`);
      }
      const after = await page.evaluate(async (id) => {
        const grant = document.body.dataset.view;
        return {
          grant: (
            await fetch(`/api/v1/decks/${id}/content-url`, { headers: { "X-PPTaken-View": grant } })
          ).status,
        };
      }, deckId);
      if (after.grant !== 401) throw new Error(`grant after revoke ${after.grant}`);
      const direct = await fetch(docUrl);
      if (direct.status !== 403) throw new Error(`document after revoke ${direct.status}`);
      check("turned off: the open page's grant and its document URL stop working at once");
      const gone = await page.goto(view.url);
      const goneText = await page.evaluate(() => document.body.innerText);
      if (gone?.status() !== 404 || !/not available anymore/.test(goneText))
        throw new Error(`dead link page ${gone?.status()} ${goneText}`);
      await shot(page, name, "dead-link");
      const unknown = await context.newPage();
      const u = await unknown.goto(`${app}/s/AAAAAAAAAAAAAAAAAAAAAA`);
      if (u?.status() !== 404 || (await unknown.content()) !== (await page.content()))
        throw new Error("unknown and turned-off links answer differently");
      check("turned off and unknown links show the same calm 'not available' page");

      const csp = [];
      for (const pg of context.pages()) {
        if (!pg.isClosed())
          csp.push(...(await pg.evaluate(() => window.__csp ?? []).catch(() => [])));
      }
      if (g.outside.length > 0) throw new Error(`third-party requests: ${g.outside.join(", ")}`);
      if (g.errors.length > 0) throw new Error(`console errors: ${g.errors.join(" | ")}`);
      if (csp.length > 0) throw new Error(`CSP violations: ${csp.join(" | ")}`);
      check("no request outside the app and content origins; no console errors; no CSP violations");
      await context.close();
      r.ok = true;
    } catch (error) {
      r.error = String(error);
      failed = true;
    } finally {
      await browser.close();
    }
    console.log(`${name}: ${r.ok ? "ok" : `FAILED ${r.error}`} (${r.checks.length} checks)`);
    for (const c of r.checks) console.log(`  - ${c}`);
  }
} catch (error) {
  failed = true;
  results.error = String(error);
  console.error(error);
} finally {
  http.close();
  await pptaken.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

results.ok = !failed;
writeFileSync(
  new URL("./share-last-run.json", import.meta.url),
  `${JSON.stringify(results, null, 2)}\n`,
);
process.exit(failed ? 1 : 0);
