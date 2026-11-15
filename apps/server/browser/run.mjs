// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser smoke test of the real server: start it (built dist) on a temp data dir with a separate content origin
// (app on localhost, content on 127.0.0.1, same port), complete setup through the API, create the 20-slide deck
// through MCP (plus a real image, shown as <img> and as a CSS background), then open /p/:deckId in Chromium,
// Firefox and WebKit: slide 1 shows and ArrowRight advances; the presenter window; and offline presenting (the F3
// definition of done, see offline.mjs), which stops and restarts the server. The web app is not needed.
// Usage: pnpm --filter @pptaken/server test:browser   (builds first; needs the Playwright browsers)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chromium, firefox, webkit } from "@playwright/test";
import { createServer } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { checkOffline } from "./offline.mjs";
import { checkPresenter } from "./presenter.mjs";

const freePort = () =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** A real, decodable 32×32 PNG. */
function png(size = 32) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0xb2)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PASSWORD = "violet otter climbs 7 dunes";
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
let http = null;
const server = {
  start: () =>
    new Promise((resolve) => {
      if (http) return resolve();
      http = serve({ fetch: pptaken.fetch, port, hostname: "::" }, () => resolve());
    }),
  stop: () =>
    new Promise((resolve) => {
      if (!http) return resolve();
      const h = http;
      http = null;
      h.closeAllConnections?.();
      h.close(() => resolve());
    }),
};
await server.start();

try {
  const headers = { Origin: app, "X-PPTaken-CSRF": "1", "Content-Type": "application/json" };
  const setup = await fetch(`${app}/api/v1/setup`, {
    method: "POST",
    headers,
    body: JSON.stringify({ installCode: pptaken.installCode, password: PASSWORD }),
  });
  if (setup.status !== 201) throw new Error(`setup: ${setup.status}`);
  const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  const [cookieName, cookieValue] = cookie.split("=");
  /** A separate owner session (each engine logs out at the end of its offline checks). */
  const login = async () => {
    const res = await fetch(`${app}/api/v1/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ password: PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`login: ${res.status}`);
    const [name, value] = (res.headers.get("set-cookie") ?? "").split(";")[0].split("=");
    return { name, value };
  };
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
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  };
  const deck = await call("create_presentation", {
    title: talk.title,
    lang: talk.lang,
    theme: talk.theme,
    slides: talk.slides.map(({ durationHintSec, ...s }) => ({
      ...s,
      duration_hint_sec: durationHintSec,
    })),
  });
  // A real image on two later slides: an <img> and a CSS background (preloaded although the slides are hidden).
  const asset = await call("add_asset", {
    presentation_id: deck.presentation_id,
    source: { base64: png().toString("base64"), media_type: "image/png" },
  });
  const withImages = talk.slides.map((s, i) => {
    if (i === talk.slides.length - 3)
      return { ...s, html: `${s.html}<img src="${asset.ref}" width="32" height="32" alt="logo">` };
    if (i === talk.slides.length - 2)
      return {
        ...s,
        html: `${s.html}<div style="width:32px;height:32px;background-image:url(${asset.ref})"></div>`,
      };
    return s;
  });
  await call("update_slides", {
    presentation_id: deck.presentation_id,
    expected_revision: 1,
    upsert: [talk.slides.length - 3, talk.slides.length - 2].map((i) => {
      const { durationHintSec, ...s } = withImages[i];
      return durationHintSec === undefined ? s : { ...s, duration_hint_sec: durationHintSec };
    }),
  });
  const partial = await call("create_presentation", {
    title: "Partial",
    slides: [
      { id: "one", html: "<h1>One</h1>" },
      { id: "two", html: `<h1>Two</h1><img src="asset:${"ab".repeat(32)}" alt="missing">` },
    ],
  });
  await client.close();
  const firstId = talk.slides[0].id;
  const secondId = talk.slides[1].id;
  const deckForChecks = { ...talk, slides: withImages };

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const r = { ok: false, checks: [] };
    results.engines[name] = r;
    if (process.env.PPTAKEN_TRACE) {
      r.checks.push = (...items) => {
        for (const i of items) console.log(`  [${name}] ${i}`);
        return Array.prototype.push.apply(r.checks, items);
      };
    }
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
      // The page's state changes first; the content shows it a moment later.
      await frame
        .waitForFunction(
          (sid) => document.querySelector(`section[data-slide="${sid}"]`)?.hidden === false,
          secondId,
          { timeout: 5_000 },
        )
        .catch(() => {});
      if (!(await visible(secondId)) || (await visible(firstId)))
        throw new Error("ArrowRight did not show slide 2");
      r.checks.push("ArrowRight -> slide 2");
      await checkPresenter({
        page,
        context,
        content,
        checks: r.checks,
        notesOf: (i) =>
          (/[A-Za-z][A-Za-z ,]{8,}/.exec(talk.slides[i]?.notes ?? "")?.[0] ?? "").slice(0, 20),
      });
      if (errors.length > 0) throw new Error(`page errors: ${errors.join("; ")}`);
      await context.close();

      r.offline = await checkOffline({
        engineName: name,
        browser,
        app,
        content,
        session: await login(),
        deck: deckForChecks,
        urls: { present: deck.urls.present, partial: partial.urls.present },
        server,
        checks: r.checks,
      });
      r.ok = true;
    } catch (error) {
      r.error = String(error);
      failed = true;
    } finally {
      await browser.close();
    }
    console.log(`${name}: ${r.ok ? "ok" : `FAILED ${r.error}`}`);
    for (const c of r.checks) console.log(`  - ${c}`);
    if (r.offline) console.log(`  offline: ${JSON.stringify(r.offline)}`);
  }
} catch (error) {
  failed = true;
  results.error = String(error);
  console.error(error);
} finally {
  await server.stop();
  await pptaken.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

results.ok = !failed;
writeFileSync(new URL("./last-run.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
process.exit(failed ? 1 : 0);
