// SPDX-License-Identifier: AGPL-3.0-or-later
// Presenter-password unlock end to end (ADR-021), in Chromium, Firefox and WebKit, against the REAL server (built
// dist) with PPTAKEN_SCRIPTS=owner and the test-only guest page (`testRoutes`; phase F5's links do not exist yet).
// App on localhost, content on 127.0.0.1 (a separate site), temp data dir, random port.
//
// Checked per engine: the guest page starts static ("locked"); the content frame cannot open the dialog (keys typed
// in the frame, forwarded fake keys, fake messages, synthetic events); offline the dialog is not offered; U opens
// a focus-trapped dialog over an inert frame; Esc closes it; empty, wrong and locked-out attempts show their
// messages and clear the field; the right password replaces the frame with the scripted document and shows the
// "Interactive mode" indicator; the token lives in sessionStorage only (no cookie, not in the URL); a reload keeps
// it; an agent edit ends it (static again, a notice, token forgotten); the owner's own player never shows the
// dialog; the presenter view shows "Interactive mode needs a connection" when offline, the audience view never.
// Usage: pnpm --filter @pptaken/server build && node apps/server/browser/unlock-e2e.mjs
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
const dataDir = mkdtempSync(join(tmpdir(), "pptaken-unlock-"));
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
  { logSink: () => {}, testRoutes: true },
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

/** A fresh scripted, approved deck (one per engine, so per-deck limits never mix). */
async function approvedDeck(cookie, title) {
  const created = await s.core.createPresentation(agent, {
    title,
    slides: [
      { id: "intro", html: "<h1>Intro</h1>", script: SCRIPT },
      { id: "two", html: "<h1>Two</h1>" },
    ],
  });
  const res = await post(
    `/api/v1/decks/${created.presentationId}/scripts/approve`,
    { digest: created.scripts.digest },
    cookie,
  );
  if (res.status !== 200) throw new Error(`approve: ${res.status}`);
  return created.presentationId;
}

const isOpen = (page) =>
  page.evaluate(
    () => document.querySelector("[data-pptaken-unlock]")?.hasAttribute("data-open") === true,
  );
const errorText = (page) => page.locator("[data-pptaken-unlock-error]").innerText();
const contentFrame = (page) => page.frames().find((f) => f.url().startsWith(`${content}/c/`));

try {
  const setup = await post("/api/v1/setup", { installCode: pptaken.installCode, password: OWNER });
  if (setup.status !== 201) throw new Error(`setup: ${setup.status}`);
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  const [cookieName, cookieValue] = cookie.split("=");
  const pw = await post("/api/v1/presenter/password", { password: PRESENTER }, cookie);
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
      const deckId = await approvedDeck(cookie, `Unlock ${name}`);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));

      // 1. Static and locked at first.
      await page.goto(`${app}/__test/guest/${deckId}`);
      await page.waitForSelector('body[data-state="ready"][data-unlock="ready"]', {
        timeout: 15_000,
      });
      const first = await page.evaluate(() => ({ ...document.body.dataset }));
      if (first.scripts !== "locked") throw new Error(`expected locked, got ${first.scripts}`);
      const frame0 = contentFrame(page);
      if (!frame0) throw new Error("no content frame on the content origin");
      if (await frame0.evaluate(() => document.querySelector("[data-ran]") !== null))
        throw new Error("scripts ran before unlock");
      check("guest page: static version, scripts locked");

      // 2. The content cannot open the dialog.
      await frame0.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
        for (const msg of [
          { v: 1, type: "key", code: "KeyU" },
          { v: 1, type: "key", code: "u" },
          { type: "unlock" },
          { v: 1, type: "unlock", open: true },
        ])
          parent.postMessage(msg, "*");
      });
      await page.locator("iframe").click({ position: { x: 300, y: 300 } }); // focus into the frame
      await page.keyboard.press("u");
      await page.waitForTimeout(300);
      if (await isOpen(page)) throw new Error("content opened the dialog");
      if (
        (await frame0.evaluate(() => document.querySelectorAll("[data-pptaken-unlock]").length)) !==
        0
      )
        throw new Error("dialog markup inside the content frame");
      check("keys typed in the frame, forwarded fake keys and fake messages never open the dialog");
      await page.evaluate(() =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true })),
      );
      if (await isOpen(page)) throw new Error("a synthetic event opened the dialog");
      check("synthetic (untrusted) key events are ignored");

      // Esc in the frame gives the keyboard back to the trusted page.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.id === "stage", null, {
        timeout: 3000,
      });

      // 3. Offline: not offered.
      await context.setOffline(true);
      await page.waitForFunction(() => navigator.onLine === false, null, { timeout: 3000 });
      await page.keyboard.press("u");
      await page.waitForTimeout(200);
      if (await isOpen(page)) throw new Error("dialog offered offline");
      await context.setOffline(false);
      await page.waitForFunction(() => navigator.onLine === true, null, { timeout: 3000 });
      check("offline: the dialog is not offered");

      // 4. U opens it, focus trapped, frame inert, Esc closes.
      await page.keyboard.press("u");
      await page.waitForFunction(
        () => document.querySelector("[data-pptaken-unlock]")?.hasAttribute("data-open"),
        null,
        { timeout: 3000 },
      );
      const opened = await page.evaluate(() => ({
        focus: document.activeElement?.id,
        inert: document.querySelector("#stage iframe")?.inert === true,
        modal: document.querySelector("#pptaken-unlock-dialog")?.getAttribute("aria-modal"),
        type: document.querySelector("#pptaken-unlock-password")?.getAttribute("type"),
      }));
      if (
        opened.focus !== "pptaken-unlock-password" ||
        !opened.inert ||
        opened.modal !== "true" ||
        opened.type !== "password"
      )
        throw new Error(`dialog state ${JSON.stringify(opened)}`);
      check("U opens the dialog: password field focused, content frame inert, aria-modal");
      const inside = () =>
        page.evaluate(
          () =>
            document.querySelector("#pptaken-unlock-dialog")?.contains(document.activeElement) ===
            true,
        );
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Tab");
        if (!(await inside())) throw new Error(`Tab ${i + 1} left the dialog`);
      }
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Shift+Tab");
        if (!(await inside())) throw new Error(`Shift+Tab ${i + 1} left the dialog`);
      }
      const slideBefore = await page.evaluate(() => document.body.dataset.slide);
      await page.focus("#pptaken-unlock-password");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Space");
      if ((await page.evaluate(() => document.body.dataset.slide)) !== slideBefore)
        throw new Error("keys typed in the dialog moved the slides");
      check("focus stays in the dialog (Tab, Shift+Tab); keys in it never reach the player");
      await page.keyboard.press("Escape");
      if (await isOpen(page)) throw new Error("Esc did not close");
      const after = await page.evaluate(() => ({
        focus: document.activeElement?.id,
        inert: document.querySelector("#stage iframe")?.inert,
      }));
      if (after.focus !== "stage" || after.inert)
        throw new Error(`after Esc ${JSON.stringify(after)}`);
      check("Esc closes it, the frame is interactive again, focus returns to the stage");

      // 5. Errors and lockout.
      await page.keyboard.press("u");
      await page.locator("#pptaken-unlock-password").waitFor();
      await page.keyboard.press("Enter");
      if (!/Enter the presenter password/.test(await errorText(page)))
        throw new Error(
          `no empty-field error: ${JSON.stringify(await page.evaluate(() => ({ active: document.activeElement?.id, value: document.querySelector("#pptaken-unlock-password")?.value, error: document.querySelector("[data-pptaken-unlock-error]")?.textContent, open: document.querySelector("[data-pptaken-unlock]")?.hasAttribute("data-open") })))}`,
        );
      for (let i = 0; i < 3; i++) {
        await page.fill("#pptaken-unlock-password", OWNER); // the owner password is not the presenter password
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          () =>
            /did not work/.test(
              document.querySelector("[data-pptaken-unlock-error]")?.textContent ?? "",
            ),
          null,
          { timeout: 5000 },
        );
        if ((await page.inputValue("#pptaken-unlock-password")) !== "")
          throw new Error("password kept after a failure");
        await page.evaluate(() => {
          document.querySelector("[data-pptaken-unlock-error]").textContent = "";
        });
      }
      check(
        "empty and wrong passwords (the owner password included) are refused; the field is cleared",
      );
      await page.fill("#pptaken-unlock-password", PRESENTER);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          /Too many attempts/.test(
            document.querySelector("[data-pptaken-unlock-error]")?.textContent ?? "",
          ),
        null,
        { timeout: 5000 },
      );
      check(`lockout after 3 failures: "${(await errorText(page)).trim()}"`);
      await page.waitForTimeout(1300);

      // 6. Success: the scripted document replaces the frame; indicator; token in sessionStorage only.
      await page.fill("#pptaken-unlock-password", PRESENTER);
      await page.keyboard.press("Enter");
      await page.waitForSelector('body[data-scripts="running"][data-state="ready"]', {
        timeout: 15_000,
      });
      if (await isOpen(page)) throw new Error("dialog still open after unlock");
      const indicator = await page.evaluate(() => {
        const el = document.querySelector("[data-pptaken-interactive]");
        return el
          ? { text: el.textContent, visible: getComputedStyle(el).display !== "none" }
          : null;
      });
      if (!indicator?.visible || indicator.text !== "Interactive mode")
        throw new Error(`indicator ${JSON.stringify(indicator)}`);
      const scripted = contentFrame(page);
      await scripted?.waitForSelector("[data-ran='1']", { timeout: 10_000 });
      check(
        "the right password: scripted document replaces the frame, the code ran, 'Interactive mode' shown",
      );
      const where = await page.evaluate(
        (id) => ({
          stored: sessionStorage.getItem(`pptaken.unlock:${id}`),
          local: Object.keys(localStorage).length,
          url: location.href,
        }),
        deckId,
      );
      const cookies = await context.cookies();
      if (
        !where.stored ||
        where.local !== 0 ||
        where.url.includes(where.stored.slice(0, 20)) ||
        cookies.some((c) => c.value.includes(where.stored.slice(0, 20)))
      )
        throw new Error(`token storage ${JSON.stringify({ ...where, cookies: cookies.length })}`);
      check("the token is in sessionStorage only (no cookie, no localStorage, not in the URL)");

      // 7. The scripted content cannot spoof or open the dialog either.
      await scripted.evaluate(() => {
        for (const msg of [{ v: 1, type: "key", code: "KeyU" }, { type: "unlock" }])
          parent.postMessage(msg, "*");
      });
      await page.waitForTimeout(200);
      if (await isOpen(page)) throw new Error("scripted content opened the dialog");
      check("scripted content cannot open the dialog");

      // 8. Reload keeps it; an agent edit ends it.
      await page.reload();
      await page.waitForSelector('body[data-scripts="running"][data-state="ready"]', {
        timeout: 15_000,
      });
      check("reload: still unlocked (same tab)");
      await s.core.updateSlides(agent, {
        presentationId: deckId,
        expectedRevision: 1,
        upsert: [{ id: "intro", html: "<h1>Intro</h1>", script: `${SCRIPT}\n// edited` }],
      });
      await page.reload();
      await page.waitForSelector('body[data-state="ready"][data-unlock="ready"]', {
        timeout: 15_000,
      });
      const edited = await page.evaluate(
        (id) => ({
          scripts: document.body.dataset.scripts,
          stored: sessionStorage.getItem(`pptaken.unlock:${id}`),
          notice: document.querySelector("[data-pptaken-unlock-notice]")?.textContent ?? "",
          indicator: getComputedStyle(document.querySelector("[data-pptaken-interactive]")).display,
        }),
        deckId,
      );
      if (
        edited.scripts !== "pending" ||
        edited.stored !== null ||
        !/Interactive mode ended/.test(edited.notice) ||
        edited.indicator !== "none"
      )
        throw new Error(`after edit ${JSON.stringify(edited)}`);
      check("an edited deck ends the unlock: static again, notice shown, token forgotten");
      if (errors.length > 0) throw new Error(`page errors: ${errors.join("; ")}`);
      await context.close();

      // 9. The owner's own pages: no dialog; the presenter view (only) explains offline.
      const owned = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await owned.addCookies([
        { name: cookieName, value: cookieValue, url: app, httpOnly: true, sameSite: "Lax" },
      ]);
      const ownerDeck = await approvedDeck(cookie, `Owner ${name}`);
      const audience = await owned.newPage();
      await audience.goto(`${app}/p/${ownerDeck}`);
      await audience.waitForSelector('body[data-state="ready"][data-scripts="running"]', {
        timeout: 15_000,
      });
      await audience.locator("#stage").focus();
      await audience.keyboard.press("u");
      if ((await audience.locator("[data-pptaken-unlock]").count()) !== 0)
        throw new Error("owner page has an unlock dialog");
      check("the owner's player page never shows the unlock dialog");
      const presenter = await owned.newPage();
      await presenter.goto(`${app}/p/${ownerDeck}/presenter`);
      await presenter.waitForSelector('body[data-state="ready"]', { timeout: 15_000 });
      if ((await presenter.evaluate(() => document.body.dataset.interactiveNotice)) !== "hidden")
        throw new Error("notice shown online");
      await owned.setOffline(true);
      await presenter.waitForFunction(
        () => document.body.dataset.interactiveNotice === "shown",
        null,
        { timeout: 5000 },
      );
      const noticeText = await presenter.locator("[data-pptaken-interactive-notice]").innerText();
      if (noticeText !== "Interactive mode needs a connection. Unlock before you go offline.")
        throw new Error(`notice: ${noticeText}`);
      const onAudience = await audience.evaluate(() =>
        document.body.innerText.includes("needs a connection"),
      );
      if (onAudience) throw new Error("offline notice on the audience screen");
      await owned.setOffline(false);
      await presenter.waitForFunction(
        () => document.body.dataset.interactiveNotice === "hidden",
        null,
        { timeout: 5000 },
      );
      check(
        "offline: the presenter view says interactive mode needs a connection; the audience screen does not",
      );
      await owned.close();
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
  new URL("./unlock-last-run.json", import.meta.url),
  `${JSON.stringify(results, null, 2)}\n`,
);
process.exit(failed ? 1 : 0);
