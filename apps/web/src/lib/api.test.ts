// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ApiError, createApi, type FetchLike, parseRetryAfter, toApiError } from "./api";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status, headers });
  };
  return { calls, api: createApi(impl) };
}

const SECRET = `ppt_${"a".repeat(43)}`;
const NOW = "2026-11-14T10:00:00.000Z";

describe("request basics", () => {
  it("sends CSRF header and JSON body on mutations, same-origin credentials always", async () => {
    const { calls, api } = fakeFetch(200, null);
    await api.login("correct horse battery");
    const call = calls[0];
    expect(call?.url).toBe("/api/v1/auth/login");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("same-origin");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["X-PPTaken-CSRF"]).toBe("1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({ password: "correct horse battery" });
  });

  it("does not send the CSRF header on GET", async () => {
    const { calls, api } = fakeFetch(200, {
      installed: false,
      publicUrl: "http://x",
      https: false,
      version: "0.1.0",
    });
    await api.setupStatus();
    expect((calls[0]?.init.headers as Record<string, string>)["X-PPTaken-CSRF"]).toBeUndefined();
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });

  it("sends DELETE with CSRF and an encoded id", async () => {
    const { calls, api } = fakeFetch(204, undefined);
    await api.revokeToken("01J/../x");
    expect(calls[0]?.url).toBe("/api/v1/tokens/01J%2F..%2Fx");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect((calls[0]?.init.headers as Record<string, string>)["X-PPTaken-CSRF"]).toBe("1");
  });

  it("builds the decks query string", async () => {
    const { calls, api } = fakeFetch(200, { decks: [], nextCursor: null });
    await api.listDecks({ cursor: "abc", q: "q3 results" });
    expect(calls[0]?.url).toBe("/api/v1/decks?cursor=abc&q=q3+results");
    await api.listDecks();
    expect(calls[1]?.url).toBe("/api/v1/decks");
  });
});

describe("response validation", () => {
  it("accepts a valid token creation and rejects a malformed secret", async () => {
    const token = {
      id: "1",
      name: "Claude Code",
      scopes: ["decks:read"],
      createdAt: NOW,
      expiresAt: null,
    };
    const ok = fakeFetch(201, { token, secret: SECRET });
    await expect(ok.api.createToken("Claude Code")).resolves.toMatchObject({ secret: SECRET });
    const bad = fakeFetch(201, { token, secret: "ppt_short" });
    await expect(bad.api.createToken("x")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("rejects missing fields and wrong types", async () => {
    const { api } = fakeFetch(200, {
      installed: "yes",
      publicUrl: "http://x",
      https: false,
      version: "1",
    });
    await expect(api.setupStatus()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    const decks = fakeFetch(200, {
      decks: [
        {
          id: "d",
          title: "T",
          lang: "en",
          slideCount: -1,
          revision: 1,
          updatedAt: NOW,
          createdBy: "agent",
        },
      ],
      nextCursor: null,
    });
    await expect(decks.api.listDecks()).rejects.toBeInstanceOf(ApiError);
    const creator = fakeFetch(200, {
      decks: [
        {
          id: "d",
          title: "T",
          lang: "en",
          slideCount: 1,
          revision: 1,
          updatedAt: NOW,
          createdBy: "robot",
        },
      ],
      nextCursor: null,
    });
    await expect(creator.api.listDecks()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("allows extra fields and tolerates missing optional token fields", async () => {
    const { api } = fakeFetch(200, {
      tokens: [{ id: "1", name: "n", scopes: [], createdAt: NOW, expiresAt: null, extra: true }],
    });
    const tokens = await api.listTokens();
    expect(tokens[0]).toMatchObject({ lastUsedAt: null, revokedAt: null });
    expect(tokens[0]).not.toHaveProperty("extra");
  });

  it("validates connect status", async () => {
    const good = {
      mcpUrl: "http://x/mcp",
      agentConnected: true,
      lastCallAt: NOW,
      lastTool: "whoami",
      clientName: "Claude Code",
    };
    await expect(fakeFetch(200, good).api.connectStatus()).resolves.toEqual(good);
    await expect(
      fakeFetch(200, { ...good, lastCallAt: "yesterday" }).api.connectStatus(),
    ).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });
});

describe("errors", () => {
  it("maps the error envelope by code, with hint", async () => {
    const { api } = fakeFetch(400, {
      error: { code: "VALIDATION_ERROR", message: "Weak", hint: "Use at least 12 characters." },
    });
    const error = await api.setup("7K2M-9QXD", "short").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
      hint: "Use at least 12 characters.",
    });
  });

  it("reads Retry-After on RATE_LIMITED", async () => {
    const { api } = fakeFetch(
      429,
      { error: { code: "RATE_LIMITED", message: "Slow down" } },
      { "Retry-After": "42" },
    );
    await expect(api.login("x")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfter: 42 });
  });

  it("falls back to the HTTP status for non-envelope bodies", () => {
    expect(toApiError(502, "<html>Bad gateway</html>", null).code).toBe("INTERNAL");
    expect(toApiError(401, null, null).code).toBe("UNAUTHENTICATED");
    expect(toApiError(418, { error: { code: "TEAPOT", message: "x" } }, null).code).toBe("UNKNOWN");
  });

  it("turns fetch failures into NETWORK errors", async () => {
    const api = createApi(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api.setupStatus()).rejects.toMatchObject({ code: "NETWORK", status: 0 });
  });

  it("maps /auth/me to a session state", async () => {
    await expect(fakeFetch(200, { owner: { id: "o" }, csrf: "1" }).api.session()).resolves.toBe(
      "signed-in",
    );
    await expect(
      fakeFetch(401, { error: { code: "UNAUTHENTICATED", message: "" } }).api.session(),
    ).resolves.toBe("signed-out");
    await expect(
      fakeFetch(409, { error: { code: "SETUP_REQUIRED", message: "" } }).api.session(),
    ).resolves.toBe("setup-required");
    await expect(fakeFetch(500, null).api.session()).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("0")).toBe(1);
    const now = Date.parse("2026-11-14T10:00:00Z");
    expect(parseRetryAfter("Sat, 14 Nov 2026 10:00:20 GMT", now)).toBe(20);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("export and import", () => {
  it("builds same-origin export URLs", async () => {
    const { exportUrl } = await import("./api");
    expect(exportUrl("01J/x", "html", false)).toBe(
      "/api/v1/decks/01J%2Fx/export?format=html&notes=0",
    );
    expect(exportUrl("abc", "pptaken", true)).toBe(
      "/api/v1/decks/abc/export?format=pptaken&notes=1",
    );
  });

  it("uploads the archive as a raw application/zip body with the CSRF header", async () => {
    const { calls, api } = fakeFetch(201, {
      deck: { id: "d1", title: "Imported", lang: "en", slideCount: 2, revision: 1 },
      assetCount: 1,
      warnings: [{ code: "UNUSED_ASSET", message: "not used" }],
    });
    const file = new Blob([new Uint8Array([0x50, 0x4b, 3, 4])]);
    const result = await api.importDeck(file);
    expect(result).toEqual({
      deck: { id: "d1", title: "Imported" },
      assetCount: 1,
      warnings: [{ code: "UNUSED_ASSET", message: "not used", path: null, slideId: null }],
    });
    const call = calls[0];
    expect(call?.url).toBe("/api/v1/decks/import");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe(file);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/zip");
    expect(headers["X-PPTaken-CSRF"]).toBe("1");
  });

  it("surfaces the server's validation message for a refused archive", async () => {
    const { api } = fakeFetch(400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Not a valid .pptaken archive: manifest.json is missing",
      },
    });
    await expect(api.importDeck(new Blob(["x"]))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Not a valid .pptaken archive: manifest.json is missing",
    });
  });
});
