// SPDX-License-Identifier: AGPL-3.0-or-later
// Attacks from security §6 that apply in F2: T3 (stolen/revoked token, never in a URL), T4 (takeover of a fresh
// instance), T12 (body size, rate limits), T13 (CSRF), T14 (DNS rebinding), plus headers, CORS and scopes.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pngBytes } from "@pptaken/testing";
import { afterEach, describe, expect, it } from "vitest";
import { backup } from "../src/cli.js";
import { ConfigError, loadConfig } from "../src/config.js";
import {
  createToken,
  type Harness,
  listen,
  makeHarness,
  mcpClient,
  ORIGIN,
  PASSWORD,
  setupOwner,
} from "./helpers.js";

let h: Harness | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  await h?.cleanup();
  h = undefined;
});

async function mcpPost(base: string, headers: Record<string, string>) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("operations", () => {
  it("healthz and readyz", async () => {
    h = await makeHarness();
    const health = await h.server.app.request("http://localhost:8080/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(await (await h.server.app.request("http://localhost:8080/readyz")).json()).toEqual({
      status: "ready",
    });
  });

  it("creates secret.key and the database in the data dir", async () => {
    h = await makeHarness();
    expect(readdirSync(h.dataDir)).toEqual(
      expect.arrayContaining(["secret.key", "pptaken.db", "blobs"]),
    );
  });

  it("validates configuration with clear errors", () => {
    expect(() => loadConfig({ PPTAKEN_PUBLIC_URL: "slides.example.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ PPTAKEN_PUBLIC_URL: "https://x.example/sub" })).toThrow(/path/);
    expect(() => loadConfig({ PPTAKEN_PORT: "eighty" })).toThrow(/PPTAKEN_PORT/);
    expect(() => loadConfig({ PPTAKEN_TRUST_PROXY: "maybe" })).toThrow(/PPTAKEN_TRUST_PROXY/);
    expect(() => loadConfig({ PPTAKEN_CONTENT_URL: "https://c.example" })).toThrow(/PUBLIC_URL/);
    const ok = loadConfig({ PPTAKEN_PUBLIC_URL: "https://slides.example.com/" });
    expect(ok).toMatchObject({ publicUrl: "https://slides.example.com", port: 8080 });
  });
});

describe("T4 takeover of a fresh instance", () => {
  it("needs the install code; wrong codes are rate limited", async () => {
    h = await makeHarness({ PPTAKEN_TRUST_PROXY: "true" });
    for (let i = 0; i < 5; i++) {
      h.clock.t += 70_000; // past the per-IP bucket and the growing delay
      const r = await h.api("POST", "/api/v1/setup", {
        body: { installCode: `AAAA-AAA${i + 2}`, password: PASSWORD },
        headers: { "X-Forwarded-For": "203.0.113.9" },
      });
      expect(r.status).toBe(403);
    }
    const blocked = await h.api("POST", "/api/v1/setup", {
      body: { installCode: h.server.installCode, password: PASSWORD },
      headers: { "X-Forwarded-For": "203.0.113.9" },
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await blocked.json()).error.code).toBe("RATE_LIMITED");
    // The owner, from another address, still gets in.
    const ok = await h.api("POST", "/api/v1/setup", {
      body: { installCode: h.server.installCode, password: PASSWORD },
      headers: { "X-Forwarded-For": "198.51.100.7" },
    });
    expect(ok.status).toBe(201);
  });
});

describe("sign-in brute force", () => {
  it("5 attempts per minute per IP, then 429 with Retry-After", async () => {
    h = await makeHarness();
    await setupOwner(h);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await h.api("POST", "/api/v1/auth/login", { body: { password: `wrong ${i} password` } }))
          .status,
      );
    }
    // The 4th attempt hits the increasing delay that starts after 3 failures.
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
    h.clock.t += 60 * 60_000;
    expect(
      (await h.api("POST", "/api/v1/auth/login", { body: { password: PASSWORD } })).status,
    ).toBe(200);
  });
});

describe("T13 CSRF", () => {
  it("refuses state changes without the header or from another origin", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const body = { name: "x" };
    const cases: Record<string, string>[] = [
      { "X-PPTaken-CSRF": "" },
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { Origin: "", Referer: "https://evil.example/page" },
      { Origin: "", Referer: "" },
    ];
    for (const headers of cases) {
      const r = await h.api("POST", "/api/v1/tokens", { body, cookie, headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect((await r.json()).error.code).toBe("FORBIDDEN");
    }
    // Referer from the same origin is accepted when Origin is absent.
    const viaReferer = await h.api("POST", "/api/v1/tokens", {
      body,
      cookie,
      headers: { Origin: "", Referer: `${ORIGIN}/welcome` },
    });
    expect(viaReferer.status).toBe(201);
    // Logout is a state change too.
    expect(
      (await h.api("POST", "/api/v1/auth/logout", { cookie, headers: { "X-PPTaken-CSRF": "" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await h.api("DELETE", "/api/v1/tokens/x", {
          cookie,
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  });

  it("never grants CORS on /api or /mcp", async () => {
    h = await makeHarness();
    for (const path of ["/api/v1/setup/status", "/mcp"]) {
      const r = await h.server.app.request(`${ORIGIN}${path}`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
      });
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });
});

describe("T14 DNS rebinding", () => {
  it("rejects foreign Host headers, accepts localhost, IP literals and the public host", async () => {
    h = await makeHarness({ PPTAKEN_PUBLIC_URL: "https://slides.example.com" });
    const status = (host: string) =>
      Promise.resolve(h?.server.app.request(`http://${host}/api/v1/setup/status`)).then(
        (r) => r?.status,
      );
    expect(await status("evil.example")).toBe(403);
    expect(await status("rebind.attacker.test:8080")).toBe(403);
    expect(await status("slides.example.com")).toBe(200);
    expect(await status("localhost:8080")).toBe(200);
    expect(await status("127.0.0.1:8080")).toBe(200);
    expect(await status("192.168.1.20:8080")).toBe(200);
    expect(await status("[::1]:8080")).toBe(200);
    // With an HTTPS public URL the session cookie gets the __Host- prefix and Secure, and HSTS is sent.
    const r = await h.server.app.request("http://slides.example.com/api/v1/setup", {
      method: "POST",
      headers: {
        Origin: "https://slides.example.com",
        "X-PPTaken-CSRF": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ installCode: h.server.installCode, password: PASSWORD }),
    });
    expect(r.status).toBe(201);
    expect(r.headers.get("set-cookie")).toMatch(
      /^__Host-pptaken_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/,
    );
    expect(r.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });
});

describe("T12 limits", () => {
  it("refuses oversized and non-JSON bodies", async () => {
    h = await makeHarness();
    const big = await h.api("POST", "/api/v1/auth/login", {
      raw: JSON.stringify({ password: "x".repeat(70_000) }),
    });
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe("VALIDATION_ERROR");
    await setupOwner(h);
    const form = await h.api("POST", "/api/v1/auth/login", {
      raw: "password=x",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(400);
    const broken = await h.api("POST", "/api/v1/auth/login", { raw: "{not json" });
    expect(broken.status).toBe(400);
  });
});

describe("T3 tokens on /mcp", () => {
  it("401 with WWW-Authenticate for missing, malformed, revoked and expired tokens; never in the URL", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const live = await listen(h.server);
    stop = live.close;
    const { token, secret } = await createToken(h, cookie);

    const none = await mcpPost(live.base, {});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(
      `Bearer realm="pptaken", error="invalid_request", resource_metadata="${live.base}/.well-known/oauth-protected-resource/mcp"`,
    );
    const meta = await (
      await fetch(`${live.base}/.well-known/oauth-protected-resource/mcp`)
    ).json();
    expect(meta.resource).toBe(`${live.base}/mcp`);

    expect((await mcpPost(live.base, { Authorization: "Bearer ppt_nope" })).status).toBe(401);
    expect((await mcpPost(live.base, { Authorization: secret })).status).toBe(401);
    const inUrl = await fetch(`${live.base}/mcp?access_token=${secret}`, {
      method: "POST",
      body: "{}",
    });
    expect(inUrl.status).toBe(401);
    // A session cookie is not an MCP credential.
    expect((await mcpPost(live.base, { Cookie: cookie })).status).toBe(401);

    expect((await mcpPost(live.base, { Authorization: `Bearer ${secret}` })).status).toBe(200);
    expect((await h.api("DELETE", `/api/v1/tokens/${token.id}`, { cookie })).status).toBe(204);
    expect(
      (await h.api("DELETE", "/api/v1/tokens/01UNKNOWNUNKNOWNUNKNOWN000", { cookie })).status,
    ).toBe(404);
    const revoked = await mcpPost(live.base, { Authorization: `Bearer ${secret}` });
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const tokens = await (await h.api("GET", "/api/v1/tokens", { cookie })).json();
    expect(tokens.tokens[0].revokedAt).not.toBeNull();

    const short = await createToken(h, cookie, { name: "short", expiresInDays: 1 });
    expect((await mcpPost(live.base, { Authorization: `Bearer ${short.secret}` })).status).toBe(
      200,
    );
    h.clock.t += 24 * 60 * 60_000;
    expect((await mcpPost(live.base, { Authorization: `Bearer ${short.secret}` })).status).toBe(
      401,
    );

    // Unassignable scopes are refused by the panel.
    const admin = await h.api("POST", "/api/v1/tokens", {
      body: { name: "a", scopes: ["admin"] },
      cookie,
    });
    expect(admin.status).toBe(400);
    const share = await h.api("POST", "/api/v1/tokens", {
      body: { name: "a", scopes: ["share:write"] },
      cookie,
    });
    expect(share.status).toBe(400);
  });

  it("rejects browser requests from other origins and rate limits failed authentication", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const live = await listen(h.server);
    stop = live.close;
    const { secret } = await createToken(h, cookie);
    const cross = await mcpPost(live.base, {
      Authorization: `Bearer ${secret}`,
      Origin: "https://evil.example",
    });
    expect(cross.status).toBe(403);
    let last = 0;
    for (let i = 0; i < 21; i++)
      last = (await mcpPost(live.base, { Authorization: "Bearer ppt_bad" })).status;
    expect(last).toBe(429);
  });

  it("a read-only token cannot write (FORBIDDEN_SCOPE) and writes are rate limited", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const live = await listen(h.server);
    stop = live.close;
    const reader = await createToken(h, cookie, { name: "reader", scopes: ["decks:read"] });
    const r = await mcpClient(live.base, reader.secret);
    const denied = await r.call("create_presentation", {
      title: "t",
      slides: [{ html: "<p>x</p>" }],
    });
    expect(denied.isError).toBe(true);
    expect(denied.body).toMatchObject({ code: "FORBIDDEN_SCOPE", retryable: false });
    expect((await r.call("list_presentations")).isError).toBe(false);
    await r.client.close();

    const writer = await createToken(h, cookie, { name: "writer" });
    const w = await mcpClient(live.base, writer.secret);
    const codes: string[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await w.call("create_presentation", {
        title: `t${i}`,
        slides: [{ html: "<p>x</p>" }],
      });
      codes.push(res.isError ? res.body.code : "ok");
    }
    expect(codes.filter((c) => c === "ok")).toHaveLength(20);
    expect(codes[20]).toBe("RATE_LIMITED");
    await w.client.close();
  });
});

describe("content route", () => {
  it("rejects forged, expired and foreign tokens; serves assets only with a valid asset token", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const live = await listen(h.server);
    stop = live.close;
    const { secret } = await createToken(h, cookie);
    const { call, client } = await mcpClient(live.base, secret);
    const created = await call("create_presentation", {
      title: "Img",
      slides: [{ id: "a", html: "<p>x</p>", notes: "SECRET NOTE" }],
    });
    const id = created.body.presentation_id;
    const asset = await call("add_asset", {
      presentation_id: id,
      source: { base64: Buffer.from(pngBytes(10, 10)).toString("base64"), media_type: "image/png" },
    });
    const sha = (asset.body.ref as string).slice("asset:".length);
    await call("update_slides", {
      presentation_id: id,
      expected_revision: 1,
      upsert: [{ id: "a", html: `<img src="asset:${sha}" alt="x" width="10" height="10">` }],
    });
    await client.close();

    const { url } = await (
      await h.api("GET", `/api/v1/decks/${id}/content-url`, { cookie })
    ).json();
    const docRes = await h.server.app.request(url);
    expect(docRes.status).toBe(200);
    const html = await docRes.text();
    expect(html).not.toContain("SECRET NOTE");
    const assetUrl = /src="(http:\/\/localhost:8080\/c\/asset\/[^"]+)"/.exec(html)?.[1] as string;
    expect(assetUrl).toContain(sha);
    const img = await h.server.app.request(assetUrl);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.headers.get("access-control-allow-origin")).toBe("*");
    expect(img.headers.get("cache-control")).toContain("immutable");

    const [path, token] = url.split("?ct=") as [string, string];
    expect((await h.server.app.request(path)).status).toBe(403);
    expect((await h.server.app.request(`${path}?ct=${token.slice(0, -2)}xx`)).status).toBe(403);
    const assetToken = assetUrl.split("/c/asset/")[1]?.split("/")[0] as string;
    expect((await h.server.app.request(`${path}?ct=${assetToken}`)).status).toBe(403); // wrong purpose
    expect(
      (await h.server.app.request(`http://localhost:8080/c/asset/${token}/${sha}`)).status,
    ).toBe(403);
    expect(
      (await h.server.app.request(`http://localhost:8080/c/asset/${assetToken}/${"0".repeat(64)}`))
        .status,
    ).toBe(404);

    h.clock.t += 5 * 60_000 + 1;
    expect((await h.server.app.request(url)).status).toBe(403); // expired
    // Without a session there is no content URL.
    expect((await h.api("GET", `/api/v1/decks/${id}/content-url`)).status).toBe(401);
  });

  it("player page requires the owner session and carries a strict CSP", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const r0 = await h.server.app.request(`${ORIGIN}/p/01HZZZZZZZZZZZZZZZZZZZZZZZ`);
    expect(r0.status).toBe(302);
    expect(r0.headers.get("location")).toBe("/login");
    const missing = await h.server.app.request(`${ORIGIN}/p/01HZZZZZZZZZZZZZZZZZZZZZZZ`, {
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);
    const { secret } = await createToken(h, cookie);
    const live = await listen(h.server);
    stop = live.close;
    const { call, client } = await mcpClient(live.base, secret);
    const id = (await call("create_presentation", { title: "P", slides: [{ html: "<p>x</p>" }] }))
      .body.presentation_id;
    await client.close();
    const page = await h.server.app.request(`${ORIGIN}/p/${id}`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(await page.text()).toContain('src="/_player/page.js"');
    expect((await h.server.app.request(`${ORIGIN}/_player/shell.js`)).status).toBe(200);
    expect((await h.server.app.request(`${ORIGIN}/_player/builder.js`)).status).toBe(404);
  });
});

describe("headers", () => {
  it("security headers on JSON responses and errors", async () => {
    h = await makeHarness();
    for (const path of ["/api/v1/setup/status", "/api/v1/nope", "/healthz", "/mcp"]) {
      const r = await h.server.app.request(`${ORIGIN}${path}`);
      expect(r.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(r.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(r.headers.get("permissions-policy"), path).toContain("camera=()");
      expect(r.headers.get("cross-origin-opener-policy"), path).toBe("same-origin");
      expect(r.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
      expect(r.headers.get("strict-transport-security"), path).toBeNull(); // plain HTTP
    }
    const notFound = await h.server.app.request(`${ORIGIN}/api/v1/nope`);
    expect(notFound.status).toBe(404);
    expect((await notFound.json()).error.code).toBe("NOT_FOUND");
  });
});

describe("panel API without a session", () => {
  it("401 on owner routes, never leaks data", async () => {
    h = await makeHarness();
    await setupOwner(h);
    for (const path of [
      "/api/v1/tokens",
      "/api/v1/connect/status",
      "/api/v1/decks",
      "/api/v1/auth/me",
    ]) {
      const r = await h.api("GET", path);
      expect(r.status, path).toBe(401);
      expect((await r.json()).error.code).toBe("UNAUTHENTICATED");
    }
    const forged = await h.api("GET", "/api/v1/tokens", {
      cookie: `pptaken_session=${"A".repeat(43)}`,
    });
    expect(forged.status).toBe(401);
  });
});

describe("backup", () => {
  it("writes a consistent database copy and the blobs to a new directory", async () => {
    h = await makeHarness();
    await setupOwner(h);
    const out = join(mkdtempSync(join(tmpdir(), "pptaken-backup-")), "copy");
    try {
      const config = loadConfig({ PPTAKEN_DATA_DIR: h.dataDir });
      expect(await backup(config, out)).toBe(0);
      expect(readdirSync(out)).toContain("pptaken.db");
      expect(await backup(config, out)).toBe(1); // refuses to overwrite
    } finally {
      rmSync(join(out, ".."), { recursive: true, force: true });
    }
  });
});
