// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  ApiError,
  createApi,
  type FetchLike,
  type ImportProgress,
  PPTX_MEDIA_TYPE,
  parseRetryAfter,
  toApiError,
  type UploadRequest,
  uploadImport,
} from "./api";

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
    // A deck written without a language comes back with lang null: the list must still load.
    const noLang = fakeFetch(200, {
      decks: [
        {
          id: "d",
          title: "T",
          lang: null,
          slideCount: 1,
          revision: 1,
          updatedAt: NOW,
          createdBy: "agent",
          scripts: "none",
        },
      ],
      nextCursor: null,
    });
    await expect(noLang.api.listDecks()).resolves.toMatchObject({ decks: [{ lang: null }] });
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
      warnings: [
        { code: "UNUSED_ASSET", message: "not used", path: null, slideId: null, name: null },
      ],
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
        message: "Not a valid .pkn archive: manifest.json is missing",
      },
    });
    await expect(api.importDeck(new Blob(["x"]))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Not a valid .pkn archive: manifest.json is missing",
    });
  });
});

describe("PowerPoint import", () => {
  const result = {
    deck: { id: "d2", title: "Slides", lang: "en", slideCount: 3, revision: 1 },
    assetCount: 2,
    warnings: [
      {
        code: "PPTX_FEATURE_DROPPED",
        message: "Slide 2: charts are not imported",
        path: "slides[1]",
        slideId: "slide-2",
        name: "chart",
      },
    ],
  };

  it("posts the .pptx with its media type to the PowerPoint route", async () => {
    const { calls, api } = fakeFetch(201, result);
    const out = await api.importPptx(new Blob(["PK"]));
    expect(out.warnings[0]).toMatchObject({ slideId: "slide-2", name: "chart" });
    expect(calls[0]?.url).toBe("/api/v1/decks/import-pptx");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe(PPTX_MEDIA_TYPE);
    expect(headers["X-PPTaken-CSRF"]).toBe("1");
  });

  /** A scripted XMLHttpRequest: reports upload progress, then answers. */
  function fakeXhr(status: number, body: unknown, headers: Record<string, string> = {}) {
    const sent: { method?: string; url?: string; headers: Record<string, string>; body?: Blob } = {
      headers: {},
    };
    const xhr: UploadRequest = {
      status: 0,
      responseText: "",
      onload: null,
      onerror: null,
      upload: { onprogress: null, onload: null },
      open(method, url) {
        sent.method = method;
        sent.url = url;
      },
      setRequestHeader(name, value) {
        sent.headers[name] = value;
      },
      getResponseHeader: (name) => headers[name] ?? null,
      send(file) {
        sent.body = file;
        queueMicrotask(() => {
          xhr.upload.onprogress?.({ loaded: 50, total: 100, lengthComputable: true });
          xhr.upload.onprogress?.({ loaded: 100, total: 100, lengthComputable: true });
          xhr.upload.onload?.();
          Object.assign(xhr, { status, responseText: JSON.stringify(body) });
          xhr.onload?.();
        });
      },
    };
    return { xhr, sent };
  }

  it("uploads with progress, then reports the server phase", async () => {
    const { xhr, sent } = fakeXhr(201, result);
    const seen: ImportProgress[] = [];
    const file = new Blob(["PK"]);
    const out = await uploadImport(
      file,
      "pptx",
      (p) => seen.push(p),
      () => xhr,
    );
    expect(out.deck.id).toBe("d2");
    expect(sent).toMatchObject({ method: "POST", url: "/api/v1/decks/import-pptx", body: file });
    expect(sent.headers["Content-Type"]).toBe(PPTX_MEDIA_TYPE);
    expect(sent.headers["X-PPTaken-CSRF"]).toBe("1");
    expect(seen).toEqual([
      { phase: "upload", fraction: 0 },
      { phase: "upload", fraction: 0.5 },
      { phase: "upload", fraction: 1 },
      { phase: "process", fraction: null },
    ]);
    const archive = fakeXhr(201, result);
    await uploadImport(
      file,
      "archive",
      () => {},
      () => archive.xhr,
    );
    expect(archive.sent.url).toBe("/api/v1/decks/import");
    expect(archive.sent.headers["Content-Type"]).toBe("application/zip");
  });

  it("turns refusals into ApiErrors with the server's message and hint", async () => {
    const { xhr } = fakeXhr(400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "This is a PowerPoint 97-2003 (.ppt) file, which cannot be imported",
        hint: "Save it as .pptx",
      },
    });
    await expect(
      uploadImport(
        new Blob(["x"]),
        "pptx",
        () => {},
        () => xhr,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      hint: "Save it as .pptx",
    });
    const limited = fakeXhr(
      429,
      { error: { code: "RATE_LIMITED", message: "Too many imports" } },
      { "Retry-After": "30" },
    );
    await expect(
      uploadImport(
        new Blob(["x"]),
        "pptx",
        () => {},
        () => limited.xhr,
      ),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfter: 30,
    });
  });
});

describe("interactive mode (ADR-021)", () => {
  const D = "a".repeat(64);
  const status = {
    presentationId: "01J",
    revision: 2,
    enabled: true,
    state: "pending",
    digest: D,
    approvedDigest: null,
    approvedAt: null,
    slides: ["sim"],
    libs: [
      { name: "uPlot", version: "1.6.32", sha256: "b".repeat(64), source: "https://x.test/u.js" },
    ],
    chars: 10,
    capability: { contentOrigin: "same-origin", separateSiteContent: false, freezeWarning: true },
  };
  const review = {
    ...status,
    sources: [{ slideId: "sim", index: 1, source: "x()", sha256: "c".repeat(64), bytes: 3 }],
    warnings: [
      {
        code: "ELEMENT_REMOVED",
        message: "Removed <canvas>",
        path: "slides[1].html",
        name: "canvas",
      },
    ],
    presenterPassword: { set: false },
  };

  it("reads the review and validates fingerprints", async () => {
    const { api } = fakeFetch(200, review);
    const r = await api.scriptsReview("01J");
    expect(r.sources[0]?.bytes).toBe(3);
    expect(r.libs[0]?.version).toBe("1.6.32");
    const bad = fakeFetch(200, { ...review, digest: "NOT-HEX" });
    await expect(bad.api.scriptsReview("01J")).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("approves with the reviewed digest, POST + CSRF, and surfaces a 409", async () => {
    const ok = fakeFetch(200, { ...status, state: "approved", approvedDigest: D });
    await ok.api.approveScripts("01J", D);
    expect(ok.calls[0]?.url).toBe("/api/v1/decks/01J/scripts/approve");
    expect(ok.calls[0]?.init.method).toBe("POST");
    expect((ok.calls[0]?.init.headers as Record<string, string>)["X-PPTaken-CSRF"]).toBe("1");
    expect(JSON.parse(String(ok.calls[0]?.init.body))).toEqual({ digest: D });
    const stale = fakeFetch(409, {
      error: { code: "VALIDATION_ERROR", message: "The scripts changed since they were reviewed" },
    });
    await expect(stale.api.approveScripts("01J", D)).rejects.toMatchObject({ status: 409 });
  });

  it("manages the presenter password", async () => {
    const set = fakeFetch(200, { set: true, change: "set" });
    expect(await set.api.setPresenterPassword("lantern folds 9 maps")).toEqual({
      set: true,
      change: "set",
    });
    expect(set.calls[0]?.url).toBe("/api/v1/presenter/password");
    const del = fakeFetch(204, undefined);
    await del.api.removePresenterPassword();
    expect(del.calls[0]?.init.method).toBe("DELETE");
    const get = fakeFetch(200, { set: false });
    expect(await get.api.presenterPassword()).toEqual({ set: false });
  });

  it("accepts deck summaries with and without the scripts state", async () => {
    const base = {
      id: "01J",
      title: "T",
      lang: "en",
      slideCount: 1,
      revision: 1,
      updatedAt: NOW,
      createdBy: "agent",
    };
    const { api } = fakeFetch(200, {
      decks: [base, { ...base, scripts: "approved" }],
      nextCursor: null,
    });
    const page = await api.listDecks();
    expect(page.decks.map((d) => d.scripts)).toEqual([null, "approved"]);
  });
});
