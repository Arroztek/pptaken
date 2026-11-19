// SPDX-License-Identifier: AGPL-3.0-or-later
// Full-stack OAuth consent test (ADR-0018): the REAL server serving the REAL built web app, driven by Chromium.
// An MCP client (the official SDK's auth() with an in-memory provider, DCR, loopback redirect like Claude Code)
// starts the flow; the signed-out owner is sent to sign in, returns to the consent page, checks what it shows,
// unticks a permission and allows; the code comes back to a loopback callback; the client gets tokens with the
// reduced scope and calls a tool; the owner then disconnects the app from "Connected applications"; a second
// request is denied. Runs on temporary data and random ports only.
// Usage: pnpm --filter @pptaken/server build && node apps/server/browser/oauth-e2e.mjs (needs apps/web built)

import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { auth, Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
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

const PASSWORD = "violet otter climbs 7 dunes";
const port = await freePort();
const cbPort = await freePort();
const app = `http://localhost:${port}`;
const callbackUrl = `http://127.0.0.1:${cbPort}/callback`;
const dataDir = mkdtempSync(join(tmpdir(), "pptaken-oauth-e2e-"));
const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) process.exitCode = 1;
};

// The loopback "client": records what the authorization server sends back.
const callbacks = [];
const callbackServer = createHttpServer((req, res) => {
  callbacks.push(new URL(req.url, callbackUrl));
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("You can close this window.");
});
await new Promise((r) => callbackServer.listen(cbPort, "127.0.0.1", r));
const nextCallback = async (count) => {
  for (let i = 0; i < 100 && callbacks.length < count; i++)
    await new Promise((r) => setTimeout(r, 100));
  return callbacks[count - 1];
};

class Provider {
  info;
  saved;
  verifier = "";
  authUrl;
  get redirectUrl() {
    return callbackUrl;
  }
  state() {
    return `e2e-${Math.random().toString(36).slice(2)}`;
  }
  // Remembered across the redirect, as a real client must (SEP-2352 authorization-server binding).
  saveDiscoveryState(d) {
    this.discovery = d;
  }
  discoveryState() {
    return this.discovery;
  }
  get clientMetadata() {
    return {
      client_name: "OAuth e2e client",
      redirect_uris: [callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t) {
    this.saved = t;
  }
  redirectToAuthorization(url) {
    this.authUrl = url;
  }
  saveCodeVerifier(v) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

const pptaken = await createServer(
  loadConfig({ PPTAKEN_DATA_DIR: dataDir, PPTAKEN_PUBLIC_URL: app, PPTAKEN_LOG_LEVEL: "warn" }),
  { logSink: () => {} },
);
const http = serve({ fetch: pptaken.fetch, port, hostname: "::" });
const browser = await chromium.launch();
const serverUrl = `${app}/mcp`;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e}`));
  page.on("console", (m) => {
    // The signed-out session probe (GET /api/v1/auth/me) answers 401 by design; Chromium logs it.
    if (m.type() === "error" && !/status of 401/.test(m.text()))
      problems.push(`console: ${m.text()}`);
  });
  const unexpected401 = [];
  page.on("response", (r) => {
    if (r.status() === 401 && !r.url().endsWith("/api/v1/auth/me")) unexpected401.push(r.url());
  });
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(app) && !u.startsWith(`http://127.0.0.1:${cbPort}/`))
      problems.push(`external request: ${u}`);
  });

  // Owner exists; the browser is signed out.
  const setup = await fetch(`${app}/api/v1/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app, "X-PPTaken-CSRF": "1" },
    body: JSON.stringify({ installCode: pptaken.installCode, password: PASSWORD }),
  });
  check("owner created", setup.status === 201);

  const provider = new Provider();
  const started = await auth(provider, { serverUrl });
  check(
    "the SDK discovers the server, registers (DCR) and asks to redirect",
    started === "REDIRECT",
  );

  await page.goto(provider.authUrl.toString());
  await page.waitForURL(/\/login\?next=%2Fconnect%2F/, { timeout: 10_000 });
  check("a signed-out owner is sent to sign in first, with an internal return path", true);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/connect\/[A-Za-z0-9_-]{32}$/, { timeout: 10_000 });
  await page.getByRole("button", { name: "Allow", exact: true }).waitFor({ timeout: 10_000 });
  check("after sign-in the owner lands on the consent page", true);

  const heading = await page.getByRole("heading", { level: 1 }).innerText();
  check("the headline names the redirect host", heading.includes(`127.0.0.1:${cbPort}`));
  check(
    "the loopback warning is shown",
    await page.getByText("This app runs on a computer, not on a website.").isVisible(),
  );
  check(
    "no Claude badge for a non-claude.ai redirect",
    (await page.getByTestId("consent-claude").count()) === 0,
  );
  check(
    "the client name is only what it calls itself",
    (await page.getByTestId("consent-name").innerText()).includes(
      "calls itself “OAuth e2e client”",
    ),
  );
  const boxes = page.locator('input[type="checkbox"][name="scope"]');
  check("three permissions, all ticked", (await boxes.count()) === 3);
  check(
    "share:write is never offered",
    (await page.locator('input[value="share:write"]').count()) === 0,
  );
  await page.locator('input[value="quiz:draft"]').uncheck();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  const approved = await nextCallback(1);
  check(
    "approving sends the browser to the registered loopback callback",
    approved?.pathname === "/callback",
  );
  check(
    "the callback carries code and iss",
    approved?.searchParams.get("code") && approved.searchParams.get("iss") === app,
  );

  const done = await auth(provider, {
    serverUrl,
    authorizationCode: approved.searchParams.get("code"),
    iss: approved.searchParams.get("iss"),
  });
  check("the code is exchanged for tokens", done === "AUTHORIZED");
  check(
    "the granted scope reflects the unticked permission",
    provider.saved?.scope === "decks:read decks:write",
  );
  const client = new Client({ name: "oauth-e2e-agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider }),
  );
  const who = await client.callTool({ name: "whoami", arguments: {} });
  const whoBody = JSON.parse(who.content[0].text);
  check(
    "a tool call works with the OAuth access token",
    !who.isError && whoBody.scopes.join(" ") === "decks:read decks:write",
  );
  await client.close();

  await page.goto(`${app}/apps`);
  await page.getByText("OAuth e2e client").waitFor({ timeout: 10_000 });
  check("the app is listed under Connected apps", true);
  await page.getByRole("button", { name: "Disconnect OAuth e2e client" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await page.getByText("App disconnected.").waitFor({ timeout: 10_000 });
  const after = await fetch(serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${provider.saved.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  check("disconnecting revokes the access token at once", after.status === 401);

  // Deny path (the browser is signed in now).
  const second = new Provider();
  second.info = provider.info;
  await auth(second, { serverUrl });
  await page.goto(second.authUrl.toString());
  await page.getByRole("button", { name: "Deny" }).click();
  const denied = await nextCallback(2);
  check(
    "denying returns access_denied with state",
    denied?.searchParams.get("error") === "access_denied" &&
      denied.searchParams.get("state") !== null,
  );

  problems.push(...unexpected401.map((u) => `401 from ${u}`));
  check("no console errors, page errors or external requests", problems.length === 0);
  if (problems.length) console.log(problems.join("\n"));
} catch (e) {
  console.log(`FAIL  unexpected error: ${e.stack ?? e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  http.close();
  callbackServer.close();
  await pptaken.close?.();
  rmSync(dataDir, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(process.exitCode ?? 0);
