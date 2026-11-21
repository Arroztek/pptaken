// SPDX-License-Identifier: AGPL-3.0-or-later
// End to end on a real SQLite file, real blob-fs and a real listening port: first run → setup → session → token →
// MCP client over Streamable HTTP → panel API → content route.
import { afterEach, describe, expect, it } from "vitest";
import {
  createToken,
  type Harness,
  listen,
  makeHarness,
  mcpClient,
  PASSWORD,
  setupOwner,
  talkArgs,
} from "./helpers.js";

let h: Harness | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  await h?.cleanup();
  h = undefined;
});

describe("first-run flow", () => {
  it("setup, token, MCP tools, panel, content route, trash", async () => {
    h = await makeHarness();
    const { api } = h;

    // Status before setup.
    let res = await api("GET", "/api/v1/setup/status");
    expect(await res.json()).toEqual({
      installed: false,
      publicUrl: "http://localhost:8080",
      https: false,
      version: "0.1.0",
    });
    expect(h.server.installCode).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    expect((await api("GET", "/api/v1/auth/me")).status).toBe(409);
    expect((await api("POST", "/api/v1/auth/login", { body: { password: PASSWORD } })).status).toBe(
      409,
    );

    // Wrong code, weak password, then success.
    res = await api("POST", "/api/v1/setup", {
      body: { installCode: "AAAA-BBBB", password: PASSWORD },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    res = await api("POST", "/api/v1/setup", {
      body: { installCode: h.server.installCode, password: "short" },
    });
    expect(res.status).toBe(400);
    const weak = await res.json();
    expect(weak.error.code).toBe("VALIDATION_ERROR");
    expect(weak.error.hint).toBeTruthy();
    res = await api("POST", "/api/v1/setup", {
      body: { installCode: h.server.installCode, password: PASSWORD },
    });
    expect(res.status).toBe(201);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(
      /^pptaken_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
    );
    const cookie = set.split(";")[0] as string;
    const ownerId = (await res.json()).owner.id;
    expect(
      (await api("POST", "/api/v1/setup", { body: { installCode: "X", password: PASSWORD } }))
        .status,
    ).toBe(409);

    res = await api("GET", "/api/v1/auth/me", { cookie });
    expect(await res.json()).toEqual({ owner: { id: ownerId }, csrf: "1" });
    expect((await (await api("GET", "/api/v1/setup/status")).json()).installed).toBe(true);

    // Connect status before any agent call.
    res = await api("GET", "/api/v1/connect/status", { cookie });
    expect(await res.json()).toEqual({
      mcpUrl: "http://localhost:8080/mcp",
      agentConnected: false,
      lastCallAt: null,
      lastTool: null,
      clientName: null,
    });

    // Token.
    const { token, secret } = await createToken(h, cookie, { name: "Claude Code" });
    expect(secret).toMatch(/^ppt_[A-Za-z0-9_-]{43}$/);
    expect(token.scopes).toEqual(["decks:read", "decks:write", "quiz:draft"]);
    res = await api("GET", "/api/v1/tokens", { cookie });
    const listed = await res.json();
    expect(listed.tokens).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(secret.slice(4));
    expect(Object.keys(listed.tokens[0]).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "lastUsedAt", "name", "revokedAt", "scopes"].sort(),
    );

    // MCP over a real port.
    const live = await listen(h.server);
    stop = live.close;
    const { client, call } = await mcpClient(live.base, secret);
    expect(client.getInstructions()).toContain("get_authoring_guide");

    const who = await call("whoami");
    expect(who.body).toMatchObject({
      actor: "agent",
      scopes: ["decks:read", "decks:write", "quiz:draft"],
    });
    // The MCP base URL follows the request (127.0.0.1:<port>) when PPTAKEN_PUBLIC_URL is not set.
    expect(who.body.base_url).toBe(live.base);

    const guide = await call("get_authoring_guide");
    expect(guide.body.guide).toContain("1920×1080");

    const created = await call("create_presentation", { ...talkArgs(), idempotency_key: "talk-1" });
    expect(created.isError).toBe(false);
    expect(created.body).toMatchObject({ revision: 1, slide_count: 20, warnings: [] });
    const id = created.body.presentation_id as string;
    expect(created.body.urls.present).toBe(`${live.base}/p/${id}`);

    res = await api("GET", "/api/v1/connect/status", { cookie });
    const status = await res.json();
    expect(status.agentConnected).toBe(true);
    expect(status.lastTool).toBe("create_presentation");
    expect(status.clientName).toContain("pptaken-test-agent");
    expect(Date.parse(status.lastCallAt)).toBeGreaterThan(0);

    // Panel sees it.
    res = await api("GET", "/api/v1/decks", { cookie });
    const decks = await res.json();
    expect(decks.nextCursor).toBeNull();
    expect(decks.decks).toEqual([
      {
        id,
        title: "How a talk gets taken care of",
        lang: "en",
        slideCount: 20,
        revision: 1,
        updatedAt: expect.any(String),
        createdBy: "agent",
        scripts: "none",
        scriptErrors: 0,
        sharedLinks: 0,
      },
    ]);
    res = await api("GET", `/api/v1/decks/${id}`, { cookie });
    const urls = (await res.json()).urls;
    expect(urls.present).toBe(`http://localhost:8080/p/${id}`);
    expect(urls.manage).toBe(`http://localhost:8080/decks/${id}`);
    expect(
      (await api("GET", "/api/v1/decks?q=nothing-like-this", { cookie }).then((r) => r.json()))
        .decks,
    ).toEqual([]);

    const got = await call("get_presentation", { presentation_id: id });
    expect(got.body.outline).toHaveLength(20);
    const edited = await call("update_slides", {
      presentation_id: id,
      expected_revision: 1,
      upsert: [{ id: "agenda", title: "Agenda (edited)" }],
    });
    expect(edited.body).toMatchObject({ revision: 2, slide_count: 20 });
    const list = await call("list_presentations");
    expect(list.body.presentations[0]).toMatchObject({ presentation_id: id, revision: 2 });

    // Content URL → isolated document with the CSP from @pptaken/player, without speaker notes.
    res = await api("GET", `/api/v1/decks/${id}/content-url`, { cookie });
    const { url } = await res.json();
    expect(url).toMatch(
      new RegExp(`^http://localhost:8080/c/${id}/2\\?ct=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$`),
    );
    const doc = await h.server.app.request(url);
    expect(doc.status).toBe(200);
    const csp = doc.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("img-src http://localhost:8080/c/asset/");
    expect(csp).toContain("frame-ancestors http://localhost:8080");
    expect(doc.headers.get("cache-control")).toBe("no-store");
    expect(doc.headers.get("access-control-allow-origin")).toBeNull();
    const html = await doc.text();
    expect(html).toContain('data-slide="agenda"');
    expect(html).not.toContain("Welcome the room"); // a speaker note of the cover slide

    // Panel token cannot be used on the content route for another revision.
    const other = url.replace(`/c/${id}/2?`, `/c/${id}/1?`);
    expect((await h.server.app.request(other)).status).toBe(403);

    // Trash: gone from the panel and the content route; MCP sees NOT_FOUND.
    const del = await call("delete_presentation", { presentation_id: id });
    expect(del.body.trashed).toBe(true);
    expect((await api("GET", "/api/v1/decks", { cookie }).then((r) => r.json())).decks).toEqual([]);
    expect((await api("GET", `/api/v1/decks/${id}`, { cookie })).status).toBe(404);
    expect((await h.server.app.request(url)).status).toBe(404);
    expect((await call("get_presentation", { presentation_id: id })).body.code).toBe("NOT_FOUND");
    await client.close();

    // Logout invalidates the session.
    expect((await api("POST", "/api/v1/auth/logout", { cookie })).status).toBe(204);
    expect((await api("GET", "/api/v1/auth/me", { cookie })).status).toBe(401);

    // Login again works; the logs never contain a secret.
    res = await api("POST", "/api/v1/auth/login", { body: { password: PASSWORD } });
    expect(res.status).toBe(200);
    const newCookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const logs = h.logs.join("\n");
    for (const value of [
      secret,
      secret.slice(4),
      PASSWORD,
      cookie.split("=")[1] as string,
      newCookie.split("=")[1] as string,
      h.server.installCode as string,
      (h.server.installCode as string).replace("-", ""),
      url.split("ct=")[1] as string,
    ]) {
      expect(logs).not.toContain(value);
    }
    expect(logs).toContain('"msg":"request"');
  });
});
