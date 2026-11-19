// SPDX-License-Identifier: AGPL-3.0-or-later
// Full-stack first-run test: the REAL server serving the REAL built web app, driven by Chromium like a person.
// Setup wizard -> "Copy setup prompt" -> extract the token from the copied prompt -> an MCP client uses it
// -> the page flips to "connected" -> the deck created through MCP shows up in the list -> Present opens the player.
// Usage: pnpm --filter @pptaken/server build && node apps/server/browser/ui-e2e.mjs (needs apps/web built)

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chromium } from "@playwright/test";
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
const dataDir = mkdtempSync(join(tmpdir(), "pptaken-ui-e2e-"));
const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) process.exitCode = 1;
};

const pptaken = await createServer(
  loadConfig({ PPTAKEN_DATA_DIR: dataDir, PPTAKEN_PUBLIC_URL: app, PPTAKEN_LOG_LEVEL: "warn" }),
  { logSink: () => {} },
);
const http = serve({ fetch: pptaken.fetch, port, hostname: "::" });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: app });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("request", (r) => {
    if (!r.url().startsWith(app)) problems.push(`external request: ${r.url()}`);
  });

  await page.goto(app);
  await page.waitForURL("**/welcome");
  check("fresh instance redirects to /welcome", true);

  await page.getByLabel("Install code").fill(pptaken.installCode);
  await page.getByLabel("Your password", { exact: true }).fill("violet otter climbs 7 dunes");
  await page.getByLabel("Confirm password").fill("violet otter climbs 7 dunes");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Connect Claude." }).waitFor({ timeout: 10_000 });
  // Claude Code lives under the Developer fold of Connect Claude (UX pass 2026-11).
  await page.locator("[data-testid=developer-fold] summary").click();
  await page.getByRole("button", { name: "Copy setup prompt" }).waitFor({ timeout: 10_000 });
  check("setup with the install code works and the connect screen opens", true);

  await page.getByRole("button", { name: "Copy setup prompt" }).click();
  await page.getByText(/Waiting for Claude/i).waitFor({ timeout: 10_000 });
  // The page confirms once the clipboard write has finished; reading earlier races with it.
  await page.getByText("Copied to clipboard.").waitFor({ timeout: 10_000 });
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  const token = /ppt_[A-Za-z0-9_-]{43}/.exec(prompt)?.[0];
  check("copied prompt contains a ppt_ token", token);
  check("copied prompt contains the MCP URL", prompt.includes(`${app}/mcp`));
  check(
    "copied prompt runs claude mcp add at user scope",
    /claude mcp add --transport http pptaken/.test(prompt) && prompt.includes("--scope user"),
  );

  // The agent side: connect with the token from the prompt, as Claude Code would.
  const client = new Client({ name: "ui-e2e-agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const who = await client.callTool({ name: "whoami", arguments: {} });
  check("whoami works with the token from the prompt", !who.isError);
  await page.getByText("Claude is connected.").waitFor({ timeout: 15_000 });
  check("the page flips to connected after the first MCP call", true);

  const talk = JSON.parse(
    readFileSync(
      new URL("../../../packages/schema/examples/talk-20-slides.json", import.meta.url),
      "utf8",
    ),
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
  check("agent creates the 20-slide deck", !created.isError);
  await client.close();

  await page.goto(`${app}/decks`);
  await page.getByText(talk.title).first().waitFor({ timeout: 10_000 });
  check("the deck appears in the panel list", true);

  const present = page.locator(".deck-row a[href^='/p/']").first();
  const popupPromise = context.waitForEvent("page", { timeout: 3000 }).catch(() => null);
  await present.click();
  const popup = await popupPromise;
  const player = popup ?? page;
  await player.waitForSelector('body[data-state="ready"]', { timeout: 15_000 }).catch(async (e) => {
    const info = await player.evaluate(
      () =>
        `${document.body.getAttribute("data-state")} | ${document.body.innerText.slice(0, 200)}`,
    );
    console.log("PLAYER", player.url(), info);
    console.log(problems.join(String.fromCharCode(10)));
    throw e;
  });
  check("Present opens the player and it reaches the ready state", true);
  const url = new URL(player.url());
  check("player URL is the /p/ page", url.pathname.startsWith("/p/"));

  // Fonts: the bundled fonts must really load inside the sandboxed content frame (CSP font-src + CORS).
  const content = player.frames().find((f) => f.url().includes("/c/"));
  const loaded = content
    ? await content.evaluate(async () => {
        await Promise.all(
          ["Inter", "Bricolage Grotesque", "JetBrains Mono"].map((f) =>
            document.fonts.load(`16px "${f}"`),
          ),
        );
        return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family);
      })
    : [];
  check(
    "bundled fonts load inside the content frame",
    ["Inter", "Bricolage Grotesque"].every((f) => loaded.includes(f)),
  );

  // Slow or impossible content load: the page must say so instead of staying black forever.
  const slow = await context.newPage();
  await slow.route("**/c/**", (route) =>
    route.request().url().includes("/c/fonts/") ? route.continue() : route.abort(),
  );
  await slow.goto(player.url());
  await slow.waitForSelector('body[data-state="slow"]', { timeout: 20_000 });
  check(
    "a content frame that never loads shows a message",
    /taking too long/i.test(await slow.locator("#status").innerText()),
  );
  await slow.close();

  check("no console errors, page errors or external requests", problems.length === 0);
  if (problems.length) console.log(problems.join("\n"));
} catch (e) {
  console.log(`FAIL  unexpected error: ${e.message}`);
  console.log(
    (await browser
      .contexts()[0]
      ?.pages()[0]
      ?.locator("body")
      .innerText()
      .catch(() => "")) ?? "",
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  http.close();
  await pptaken.close?.();
  rmSync(dataDir, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(process.exitCode ?? 0);
