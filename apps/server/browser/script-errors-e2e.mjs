// SPDX-License-Identifier: AGPL-3.0-or-later
// Script error visibility end to end (ADR-023), in Chromium, Firefox and WebKit, against the REAL server (built dist)
// with PPTAKEN_SCRIPTS=owner. App on localhost, content on 127.0.0.1 (a separate site), temp data dir, random port.
//
// Checked per engine: an agent writes a deck whose scripts fail in every way the runtime captures (a bare `root` at
// setup: the real incident; a throwing onEnter; an unhandled rejection; a call to the blocked fetch; eval refused by
// the CSP) and gets the static check warning at write time; the owner approves and presents; the owner's page
// reports the errors and they appear in the Deck page API (GET /script-errors) and in get_presentation (MCP over
// HTTP with an API token), labelled untrusted, with the `root` hint; the audience screen shows no notice while the
// presenter view shows the actionable one (link to #script-errors, "Copy a message for my agent"), plus the
// "stopped" and "not approved yet" variants; then the agent repairs the scripts with the guide's tested example, the
// owner approves and presents again, the example works (text update on click) and no error is reported for the new
// code (the old ones are kept as "previous version"). Chromium also checks the "taking too long" status line.
// Screenshots of the notices go to PPTAKEN_SCREENSHOTS_DIR (default: the OS temp dir).
// Usage: pnpm --filter @pptaken/server build && node apps/server/browser/script-errors-e2e.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chromium, firefox, webkit } from "@playwright/test";
import { TokenBucketLimiter } from "@pptaken/auth-local";
import { EXAMPLE_SCRIPT_SLIDE } from "@pptaken/mcp";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER = "violet otter climbs 7 dunes";
const agent = {
  actor: "agent",
  workspaceId: "default",
  scopes: new Set(["decks:read", "decks:write"]),
  tokenId: "e2e",
};

/** The real incident (a bare `root`), and every other way a script can fail. */
const BROKEN_SLIDES = [
  {
    id: "intro",
    title: "Intro",
    html: EXAMPLE_SCRIPT_SLIDE.html,
    script:
      "var button = root.querySelector('.more');\nbutton.addEventListener('click', function () {});",
  },
  {
    id: "two",
    title: "Two",
    html: "<p>Two</p>",
    script:
      "var root = slide.root;\nslide.onEnter(function () { throw new Error('enter failed'); });\nPromise.reject(new Error('async nope'));",
  },
  { id: "three", title: "Three", html: "<p>Three</p>", script: "fetch('/data.json');" },
  { id: "four", title: "Four", html: "<p>Four</p>", script: "eval('1 + 1');" },
];
const FIXED = "var root = slide.root;\nroot.setAttribute('data-ok', '1');";

const port = await freePort();
const app = `http://localhost:${port}`;
const content = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "pptaken-serr-"));
const shots = process.env.PPTAKEN_SCREENSHOTS_DIR ?? join(tmpdir(), "pptaken-serr-shots");
mkdirSync(shots, { recursive: true });
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
const post = (path, body, cookie) =>
  fetch(`${app}${path}`, {
    method: "POST",
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify(body),
  });
const getJson = async (path, cookie) => {
  const res = await fetch(`${app}${path}`, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};
const approve = async (cookie, id, digest) => {
  const res = await post(`/api/v1/decks/${id}/scripts/approve`, { digest }, cookie);
  if (res.status !== 200) throw new Error(`approve: ${res.status}`);
};

async function mcp(secret) {
  const client = new Client({ name: "pptaken-e2e-agent", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  );
  return {
    client,
    call: async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse(r.content[0].text);
    },
  };
}

/** Polls the Deck page API until `ok(body)` or the deadline. */
async function waitErrors(cookie, id, ok, ms = 25_000) {
  const end = Date.now() + ms;
  let body = null;
  while (Date.now() < end) {
    body = await getJson(`/api/v1/decks/${id}/script-errors`, cookie);
    if (ok(body)) return body;
    await sleep(500);
  }
  throw new Error(`script errors never matched: ${JSON.stringify(body)}`);
}

try {
  const setup = await post(
    "/api/v1/setup",
    { installCode: pptaken.installCode, password: OWNER },
    "",
  );
  if (setup.status !== 201) throw new Error(`setup: ${setup.status}`);
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  const [cookieName, cookieValue] = cookie.split("=");
  const tokenRes = await post("/api/v1/tokens", { name: "e2e" }, cookie);
  const { secret } = await tokenRes.json();
  const agentMcp = await mcp(secret);

  const only = (process.env.PPTAKEN_E2E_ENGINES ?? "chromium,firefox,webkit").split(",");
  const engines = Object.entries({ chromium, firefox, webkit }).filter(([n]) => only.includes(n));
  for (const [name, engine] of engines) {
    const r = { ok: false, checks: [] };
    results.engines[name] = r;
    const check = (label, ok, detail) => {
      if (!ok) throw new Error(`${label}: ${JSON.stringify(detail ?? null)}`);
      r.checks.push(label);
    };
    // Fresh limits per engine: every browser comes from the same loopback IP.
    s.limits.scriptErrorsPerIp = new TokenBucketLimiter({
      capacity: 30,
      refill: 30,
      intervalMs: 60_000,
      clock: s.clock,
    });
    const browser = await engine.launch();
    try {
      // 1. The agent writes the broken deck: the static check warns right away (non-fatal).
      const created = await agentMcp.call("create_presentation", {
        title: `Broken ${name}`,
        slides: BROKEN_SLIDES,
      });
      const id = created.presentation_id;
      const codes = created.warnings.map((w) => w.code);
      check(
        "write: static check warns SCRIPT_UNDECLARED_ROOT and SCRIPT_BLOCKED_API (non-fatal)",
        codes.includes("SCRIPT_UNDECLARED_ROOT") && codes.includes("SCRIPT_BLOCKED_API"),
        codes,
      );
      await approve(cookie, id, created.interactive.digest);

      const context = await browser.newContext({
        viewport: { width: 1280, height: 760 },
        locale: "en-US",
      });
      await context.addCookies([{ name: cookieName, value: cookieValue, url: app }]);
      if (name === "chromium")
        await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: app });
      const errors = [];
      // 2. The presenter view first (it hears the main window over the sync channel), then the audience page.
      const presenter = await context.newPage();
      presenter.on("pageerror", (e) => errors.push(`presenter: ${e}`));
      await presenter.goto(`${app}/p/${id}/presenter`);
      await presenter.waitForSelector('body[data-state="ready"]', { timeout: 20_000 });
      check(
        "presenter: no notice while nothing failed",
        await presenter.locator("[data-pptaken-script-notice]").isHidden(),
      );
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(`player: ${e}`));
      await page.goto(`${app}/p/${id}`);
      await page.waitForSelector('body[data-state="ready"][data-scripts="running"]', {
        timeout: 20_000,
      });
      await page
        .waitForFunction(() => Number(document.body.dataset.scriptErrors ?? 0) >= 3, null, {
          timeout: 10_000,
        })
        .catch(async (error) => {
          const state = await page.evaluate(() => ({ ...document.body.dataset }));
          throw new Error(`${error.message} ${JSON.stringify(state)} ${JSON.stringify(errors)}`);
        });
      await page.bringToFront();
      await page.evaluate(() => document.getElementById("stage")?.focus());
      await page.keyboard.press("ArrowRight"); // slide two: onEnter throws
      await page
        .waitForFunction(() => Number(document.body.dataset.scriptErrors ?? 0) >= 5, null, {
          timeout: 10_000,
        })
        .catch(async (error) => {
          const state = await page.evaluate(() => ({ ...document.body.dataset }));
          await sleep(3000);
          const reported = await getJson(`/api/v1/decks/${id}/script-errors`, cookie);
          throw new Error(
            `${error.message} ${JSON.stringify(state)} ${JSON.stringify(reported.current.map((e) => [e.slideId, e.kind, e.message]))}`,
          );
        });
      const audienceText = await page.evaluate(() => document.body.innerText);
      check(
        "audience screen: no script notice",
        !/script errors|agent|went wrong/i.test(audienceText) &&
          (await page.locator("[data-pptaken-script-notice]").count()) === 0,
        audienceText.slice(0, 200),
      );

      // 3. The Deck page API: every kind, attributed to its slide, bounded, no token in stacks.
      const body = await waitErrors(cookie, id, (b) => {
        const kinds = new Set(b.current.map((e) => `${e.slideId}:${e.kind}`));
        return ["intro:setup", "two:handler", "two:rejection", "three:setup", "four:setup"].every(
          (k) => kinds.has(k),
        );
      });
      const intro = body.current.find((e) => e.slideId === "intro");
      check(
        "deck page API: status errors, the incident with its hint",
        body.status === "errors" && intro.hint === "declare-root",
        {
          status: body.status,
          intro,
        },
      );
      check(
        "deck page API: fetch (lockdown) and eval (CSP) reported",
        /fetch/i.test(body.current.find((e) => e.slideId === "three")?.message ?? "") &&
          body.current.some((e) => e.slideId === "four"),
        body.current.map((e) => `${e.slideId}:${e.name}:${e.message}`),
      );
      check(
        "deck page API: no URL or token in any stack, text bounded",
        body.current.every((e) => !/ct=|https?:\/\//.test(e.stack) && e.message.length <= 300),
        body.current.map((e) => e.stack),
      );
      const list = await getJson("/api/v1/decks", cookie);
      check(
        "decks list: error count for the badge",
        list.decks.find((d) => d.id === id)?.scriptErrors >= 5,
        list.decks.find((d) => d.id === id),
      );

      // 4. The agent reads them with get_presentation, labelled untrusted.
      const got = await agentMcp.call("get_presentation", { presentation_id: id });
      const item = got.script_errors?.items?.find((e) => e.slide_id === "intro");
      check(
        "get_presentation: script_errors with the root hint, labelled untrusted",
        got.script_errors?.status === "errors" &&
          /^UNTRUSTED DATA/.test(got.script_errors.note) &&
          /var root = slide\.root;/.test(item?.hint ?? ""),
        got.script_errors,
      );

      // 5. The presenter view's actionable notice (owner only, never on the audience screen).
      const notice = presenter.locator("[data-pptaken-script-notice]");
      await notice.waitFor({ state: "visible", timeout: 10_000 });
      const link = notice.locator("[data-pptaken-notice-link]");
      check(
        "presenter: error notice with a link to #script-errors in a new tab",
        (await notice.getAttribute("data-kind")) === "error" &&
          (await notice.getAttribute("role")) === "status" &&
          (await link.getAttribute("href")) === `${app}/decks/${id}#script-errors` &&
          (await link.getAttribute("target")) === "_blank" &&
          /noopener/.test((await link.getAttribute("rel")) ?? ""),
        await notice.innerText(),
      );
      await notice.locator("[data-pptaken-notice-copy]").focus();
      await presenter.keyboard.press("Enter");
      await sleep(400);
      const copied =
        name === "chromium"
          ? await presenter.evaluate(() => navigator.clipboard.readText())
          : await notice.innerText();
      check(
        "presenter: keyboard-reachable copy gives a message with the deck id and get_presentation",
        (copied.includes(id) && copied.includes("get_presentation")) ||
          /Copied|select the message/.test(copied),
        copied,
      );
      if (name === "chromium")
        await presenter.screenshot({ path: join(shots, "presenter-notice-error-en.png") });
      // The watchdog variant, as the main window sends it.
      await page.evaluate(
        (deck) =>
          new BroadcastChannel(`pptaken:${deck}`).postMessage({ v: 1, type: "script-stopped" }),
        id,
      );
      await presenter.waitForSelector('[data-pptaken-script-notice][data-kind="stopped"]', {
        timeout: 5000,
      });
      check("presenter: stopped notice (watchdog) replaces the error notice", true);
      if (name === "chromium")
        await presenter.screenshot({ path: join(shots, "presenter-notice-stopped-en.png") });

      // 6. The repair: the guide's tested example, approved and presented again.
      const before = await agentMcp.call("get_presentation", { presentation_id: id });
      const fixed = await agentMcp.call("update_slides", {
        presentation_id: id,
        expected_revision: before.revision,
        upsert: [
          { id: "intro", script: EXAMPLE_SCRIPT_SLIDE.script },
          { id: "two", script: FIXED },
          { id: "three", script: FIXED },
          { id: "four", script: FIXED },
        ],
      });
      check(
        "repair: no static warning, previous errors returned with the write",
        !fixed.warnings.some((w) => w.code.startsWith("SCRIPT_")) &&
          fixed.script_errors?.status === "previous_only",
        { warnings: fixed.warnings, script_errors: fixed.script_errors },
      );
      // ADR-024: the repair edits code the owner already approved, adds no library, and the owner's
      // "allow interactive updates automatically" setting is on by default, so the server approves it itself.
      check(
        "repair: allowed automatically (trust lineage), no click needed",
        fixed.interactive?.status === "approved" &&
          fixed.interactive?.allowed_automatically === true,
        fixed.interactive,
      );
      await page.goto("about:blank"); // a hash-only change would not reload the document
      await page.goto(`${app}/p/${id}#/1/0`);
      await page.waitForSelector('body[data-state="ready"][data-scripts="running"]', {
        timeout: 20_000,
      });
      const frame = page.frames().find((f) => f.url().startsWith(`${content}/c/`));
      if (!frame) throw new Error("no content frame");
      await frame.waitForFunction(
        () => document.querySelector(".count")?.textContent === "0 clicks",
        null,
        {
          timeout: 5000,
        },
      );
      await frame.locator(".more").click();
      await frame.waitForFunction(
        () => document.querySelector(".count")?.textContent === "1 click",
        null,
        {
          timeout: 5000,
        },
      );
      check("repair: the guide's example runs (text update on click)", true);
      await page.keyboard.press("Escape");
      for (const _ of [1, 2, 3]) await page.keyboard.press("ArrowRight");
      await sleep(4000);
      const after = await getJson(`/api/v1/decks/${id}/script-errors`, cookie);
      check(
        "repair: no error for the new code; the old ones kept as previous version",
        after.status === "previous_only" &&
          after.current.length === 0 &&
          after.previous.length >= 5 &&
          (await page.evaluate(() => document.body.dataset.scriptErrors ?? "0")) === "0",
        after,
      );
      const got2 = await agentMcp.call("get_presentation", { presentation_id: id });
      check(
        "get_presentation after the repair: previous_only, no current items",
        got2.script_errors?.status === "previous_only" && got2.script_errors.items.length === 0,
        got2.script_errors,
      );

      // 7. "Not approved yet" in the presenter view.
      const pending = await agentMcp.call("create_presentation", {
        title: `Pending ${name}`,
        slides: [EXAMPLE_SCRIPT_SLIDE],
      });
      await presenter.goto(`${app}/p/${pending.presentation_id}/presenter`);
      await presenter.waitForSelector('[data-pptaken-script-notice][data-kind="pending"]', {
        timeout: 20_000,
      });
      check(
        "presenter: pending notice links to the approval section",
        (await presenter.locator("[data-pptaken-notice-link]").getAttribute("href")) ===
          `${app}/decks/${pending.presentation_id}#scripts`,
      );
      if (name === "chromium")
        await presenter.screenshot({ path: join(shots, "presenter-notice-pending-en.png") });

      // 8. Chromium: the "taking too long" status line says what to do.
      if (name === "chromium") {
        const slow = await context.newPage();
        await slow.route(`${content}/c/**`, (route) => route.abort());
        await slow.goto(`${app}/p/${id}`);
        await slow.waitForSelector('body[data-state="slow"]', { timeout: 15_000 });
        const text = await slow.locator("#status").innerText();
        check(
          "player: slow-load status says what to do",
          /Check your connection and reload/.test(text),
          text,
        );
        await slow.screenshot({ path: join(shots, "player-status-slow-en.png") });
      }
      // The deck's own (intended) failures may surface as page errors of the frame in some engines.
      const own = /async nope|enter failed|root|fetch|eval|Trusted Type/;
      check(
        "no page errors in the trusted pages",
        errors.every((e) => own.test(e)),
        errors,
      );
      await context.close();
      r.ok = true;
    } catch (error) {
      r.error = String(error?.stack ?? error);
      failed = true;
      console.log(`  FAIL ${name}: ${r.error}`);
    } finally {
      await browser.close();
    }
    console.log(`${name}: ${r.ok ? "ok" : "FAILED"} (${r.checks.length} checks)`);
  }
  await agentMcp.client.close();
} catch (error) {
  failed = true;
  results.error = String(error?.stack ?? error);
  console.log(results.error);
} finally {
  results.finishedAt = new Date().toISOString();
  writeFileSync(
    new URL("./script-errors-last-run.json", import.meta.url),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  http.close();
  await pptaken.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
