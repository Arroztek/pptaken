// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser smoke test of the real server: start it (built dist) on a temp data dir with a separate content origin
// (app on localhost, content on 127.0.0.1, same port), complete setup through the API, create the 20-slide deck
// through MCP, then open /p/:deckId in Chromium, Firefox and WebKit and check that slide 1 shows and ArrowRight
// advances. The web app is not needed.
// Usage: pnpm --filter @pptaken/server test:browser   (builds first; needs the Playwright browsers)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chromium, firefox, webkit } from "@playwright/test";
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

const port = await freePort();
const app = `http://localhost:${port}`;
const content = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "pptaken-browser-"));
const results = { startedAt: new Date().toISOString(), engines: {} };
let failed = false;

const pptaken = await createServer(
  loadConfig({
    PPTAKEN_DATA_DIR: dataDir,
    PPTAKEN_PUBLIC_URL: app,
    PPTAKEN_CONTENT_URL: content,
    PPTAKEN_WEB_DIR: join(dataDir, "no-web"),
    PPTAKEN_LOG_LEVEL: "warn",
  }),
  { logSink: () => {} },
);
const http = serve({ fetch: pptaken.fetch, port, hostname: "::" });

try {
  const headers = { Origin: app, "X-PPTaken-CSRF": "1", "Content-Type": "application/json" };
  const setup = await fetch(`${app}/api/v1/setup`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      installCode: pptaken.installCode,
      password: "violet otter climbs 7 dunes",
    }),
  });
  if (setup.status !== 201) throw new Error(`setup: ${setup.status}`);
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  const [cookieName, cookieValue] = cookie.split("=");
  const tokenRes = await fetch(`${app}/api/v1/tokens`, {
    method: "POST",
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify({ name: "browser test" }),
  });
  const { secret } = await tokenRes.json();

  const talk = JSON.parse(
    readFileSync(
      new URL("../../../packages/schema/examples/talk-20-slides.json", import.meta.url),
      "utf8",
    ),
  );
  const client = new Client({ name: "browser-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  );
  const created = await client.callTool({
    name: "create_presentation",
    arguments: {
      title: talk.title,
      lang: talk.lang,
      theme: talk.theme,
      slides: talk.slides.map(({ durationHintSec, ...s }) => ({
        ...s,
        duration_hint_sec: durationHintSec,
      })),
    },
  });
  const deck = JSON.parse(created.content[0].text);
  if (created.isError) throw new Error(`create_presentation: ${created.content[0].text}`);
  await client.close();
  const firstId = talk.slides[0].id;
  const secondId = talk.slides[1].id;

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const r = { ok: false, checks: [] };
    results.engines[name] = r;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      await context.addCookies([
        { name: cookieName, value: cookieValue, url: app, httpOnly: true, sameSite: "Lax" },
      ]);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const res = await page.goto(deck.urls.present);
      r.checks.push(`page ${res.status()}`);
      await page.waitForSelector('body[data-state="ready"]', { timeout: 15_000 });
      r.checks.push(`ready with ${await page.getAttribute("body", "data-slides")} slides`);
      const frame = page.frames().find((f) => f.url().startsWith(`${content}/c/`));
      if (!frame) throw new Error("content iframe not found on the content origin");
      const visible = async (id) =>
        frame.evaluate((sid) => {
          const el = document.querySelector(`section[data-slide="${sid}"]`);
          return el !== null && !el.hidden && getComputedStyle(el).display !== "none";
        }, id);
      if (!(await visible(firstId))) throw new Error("slide 1 is not visible");
      r.checks.push("slide 1 visible");
      await page.click("#stage");
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.body.dataset.slide === "1", null, {
        timeout: 5_000,
      });
      if (!(await visible(secondId)) || (await visible(firstId)))
        throw new Error("ArrowRight did not show slide 2");
      r.checks.push("ArrowRight -> slide 2");
      if (errors.length > 0) throw new Error(`page errors: ${errors.join("; ")}`);
      r.ok = true;
    } catch (error) {
      r.error = String(error);
      failed = true;
    } finally {
      await browser.close();
    }
    console.log(`${name}: ${r.ok ? "ok" : `FAILED ${r.error}`} (${r.checks.join(", ")})`);
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
writeFileSync(new URL("./last-run.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
process.exit(failed ? 1 : 0);
