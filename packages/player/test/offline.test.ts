// SPDX-License-Identifier: Apache-2.0
// Offline presenting, pure logic: the `preload` message validator, the indicator state machine, the offline
// document shape check and builder, and the service worker's allowlist, cache keys, response checks, cache
// names, eviction and quota handling, and page <-> worker messages. Tests run against the build (`dist`).

import { sanitizeDeck } from "@pptaken/sanitizer";
import { type Deck, parseDeck } from "@pptaken/schema";
import { describe, expect, it } from "vitest";
import {
  buildOfflineDocument,
  isOfflineDocument,
  MAX_PRELOAD_FAILED,
  offlineStateOf,
  offlineStatus,
  parseContentMessage,
  RUNTIME_SOURCE,
} from "../dist/index.js";
import {
  bytesToFree,
  CACHE_PREFIX,
  cacheKeyOf,
  type DeckMeta,
  deckCacheName,
  deckOfCache,
  fontPathsIn,
  isCacheable,
  isQuotaError,
  isStaleCache,
  parseClientMessage,
  parseMeta,
  parseOfflineBundle,
  parseWorkerReply,
  pickEvictions,
  type ResponseLike,
  type Route,
  routeOf,
  shellCacheName,
  signsOut,
  unavailablePage,
} from "../dist/offline-cache.js";
import { loadContent, SignedOutError } from "../dist/offline-client.js";

const O = "https://pptaken.example";
const ID = "01J9Z8Y7X6W5V4T3S2R1Q0P9N8";
const OTHER = "01J9Z8Y7X6W5V4T3S2R1Q0P9N9";
const NONCE = "q1w2e3r4t5y6u7i8o9p0aA==";

const ok = { v: 1, type: "preload", ok: true, images: 3, fonts: 6, failed: [] };

describe("preload message", () => {
  it("accepts a well-formed report and copies it", () => {
    const m = parseContentMessage(ok);
    expect(m).toEqual(ok);
    expect(m).not.toBe(ok);
    expect(
      parseContentMessage({ ...ok, ok: false, failed: ["image-error", "font-timeout"] }),
    ).toEqual({ ...ok, ok: false, failed: ["image-error", "font-timeout"] });
  });

  it("drops anything else", () => {
    const bad: unknown[] = [
      { ...ok, extra: 1 },
      { ...ok, v: 2 },
      { ...ok, ok: "yes" },
      { ...ok, images: -1 },
      { ...ok, images: 1.5 },
      { ...ok, fonts: 10_001 },
      { ...ok, failed: "image-error" },
      { ...ok, ok: false, failed: ["https://content.example/c/asset/x"] },
      { ...ok, ok: false, failed: ["image-error", 1] },
      { ...ok, ok: false, failed: Array(MAX_PRELOAD_FAILED + 1).fill("image-error") },
      // ok must match failed
      { ...ok, ok: true, failed: ["image-error"] },
      { ...ok, ok: false, failed: [] },
      Object.assign(Object.create({ evil: 1 }), ok),
    ];
    const { images: _images, ...missing } = ok;
    bad.push(missing);
    for (const b of bad) expect(parseContentMessage(b), JSON.stringify(b)).toBeNull();
  });

  it("is sent by the runtime (bounded, closed set of reasons)", () => {
    expect(RUNTIME_SOURCE).toContain('type: "preload"');
    expect(RUNTIME_SOURCE).toContain("MAX_PRELOAD_FAILED");
  });
});

describe("indicator state machine", () => {
  const report = (o: boolean) =>
    ({ ...ok, ok: o, failed: o ? [] : ["image-error"] }) as Parameters<typeof offlineStateOf>[0];
  it("loading until the preload report, then ready or partial", () => {
    expect(offlineStateOf(null, false)).toBe("loading");
    expect(offlineStateOf(null, true)).toBe("loading");
    expect(offlineStateOf(report(true), false)).toBe("ready");
    expect(offlineStateOf(report(false), false)).toBe("partial");
  });
  it("the offline copy upgrades ready, never partial", () => {
    expect(offlineStateOf(report(true), true)).toBe("service-worker");
    expect(offlineStateOf(report(false), true)).toBe("partial");
  });
  it("status carries counts and failures", () => {
    expect(offlineStatus(report(false), true)).toEqual({
      state: "partial",
      images: 3,
      fonts: 6,
      failed: ["image-error"],
      copy: true,
    });
    expect(offlineStatus(null, false)).toEqual({
      state: "loading",
      images: 0,
      fonts: 0,
      failed: [],
      copy: false,
    });
  });
});

const clean = (input: unknown): Deck => {
  const parsed = parseDeck(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return sanitizeDeck(parsed.deck).deck;
};
const SHA = "a".repeat(64);
const MISSING = "b".repeat(64);

describe("offline document", () => {
  const deck = clean({
    schemaVersion: 1,
    title: "Offline <deck>",
    lang: "es-419",
    theme: { css: `.x{background:url(asset:${SHA})}` },
    slides: [
      {
        id: "a",
        html: `<img src="asset:${SHA}" alt=""><img src="asset:${MISSING}" alt=""><p>asset:${SHA}</p>`,
        notes: "SECRET NOTE",
      },
      { id: "b", html: "<p data-step>x</p>", css: `p{background:url("asset:${SHA}")}` },
    ],
  });
  const assets = new Map([[SHA, { mediaType: "image/png", base64: "iVBORw0KGgo=" }]]);
  const fonts = [
    {
      family: "Inter" as const,
      weight: "100 900",
      unicodeRange: "U+0000-00FF",
      base64: "d09GMg==",
    },
  ];
  const { html, missing } = buildOfflineDocument(deck, { nonce: NONCE, assets, fonts });

  it("starts with the no-network CSP meta, before anything the content controls", () => {
    expect(isOfflineDocument(html)).toBe(true);
    const head = html.slice(0, html.indexOf("<meta charset"));
    expect(head).toContain(`script-src 'nonce-${NONCE}'`);
    expect(head).toContain("connect-src 'none'");
    expect(head).toContain("img-src data:; font-src data:");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<style>"));
  });

  it("inlines assets and fonts as data: URIs, leaves missing ones and text alone", () => {
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    // Theme CSS and slide CSS (the sanitizer normalizes the quoting).
    expect(html.match(/url\(["']?data:image\/png;base64,iVBORw0KGgo=["']?\)/g)?.length).toBe(2);
    expect(html).toContain(`<p>asset:${SHA}</p>`);
    expect(html).toContain(`src="asset:${MISSING}"`);
    expect(missing).toEqual([MISSING]);
    expect(html).toContain('src:url(data:font/woff2;base64,d09GMg==) format("woff2")');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("never contains the speaker notes, and carries the runtime", () => {
    expect(html).not.toContain("SECRET NOTE");
    expect(html).toContain(RUNTIME_SOURCE);
  });

  it("refuses invalid input", () => {
    expect(() => buildOfflineDocument(deck, { nonce: "short" })).toThrow(TypeError);
    expect(() =>
      buildOfflineDocument(deck, {
        nonce: NONCE,
        fonts: [{ family: "Inter", weight: "400;}", base64: "AA==" }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildOfflineDocument(deck, {
        nonce: NONCE,
        fonts: [{ family: "Comic" as never, weight: "400", base64: "AA==" }],
      }),
    ).toThrow(TypeError);
    // A media type that is not an allowed raster image is not inlined.
    const svg = buildOfflineDocument(deck, {
      nonce: NONCE,
      assets: new Map([[SHA, { mediaType: "image/svg+xml", base64: "PHN2Zz4=" }]]),
    });
    expect(svg.html).not.toContain("image/svg+xml");
    expect(svg.missing).toContain(SHA);
  });

  it("the shape check refuses anything else", () => {
    for (const bad of [
      null,
      42,
      "<p>x</p>",
      html.replace("connect-src 'none'", "connect-src *"),
      html.replace("<head>\n<meta http-equiv", "<head>\n<script>1</script><meta http-equiv"),
      `<!doctype html>\n<html>\n<head>\n<meta http-equiv="Content-Security-Policy" content="default-src *">\n`,
    ]) {
      expect(isOfflineDocument(bad)).toBe(false);
    }
  });
});

describe("service worker allowlist and cache keys", () => {
  it("allows exactly the player routes, keyed by origin + path", () => {
    const cases: [string, Route["kind"] | null][] = [
      [`${O}/p/${ID}`, "page"],
      [`${O}/p/${ID}/presenter`, "presenter-page"],
      [`${O}/api/v1/decks/${ID}/offline`, "offline"],
      [`${O}/api/v1/decks/${ID}/presenter`, "presenter-data"],
      [`${O}/_player/shell.js`, "shell"],
      [`${O}/_player/page.css`, "shell"],
      [`${O}/_player/fonts/inter/inter-latin-wght.woff2`, "font"],
      // never
      [`${O}/api/v1/auth/me`, null],
      [`${O}/api/v1/auth/logout`, null],
      [`${O}/api/v1/decks/${ID}/content-url`, null],
      [`${O}/api/v1/decks/${ID}/export?format=html`, null],
      [`${O}/api/v1/decks`, null],
      [`${O}/c/${ID}/3?ct=token`, null],
      [`${O}/c/asset/token/${"a".repeat(64)}`, null],
      [`${O}/c/fonts/inter/inter-latin-wght.woff2`, null],
      [`${O}/p/sw.js`, null],
      [`${O}/p/not-a-ulid`, null],
      [`${O}/p/${ID}/other`, null],
      [`${O}/_player/evil.js`, null],
      [`${O}/_player/../api/v1/decks`, null],
      [`${O}/_player/fonts/../../x.woff2`, null],
      [`${O}/`, null],
      [`https://other.example/p/${ID}`, null],
      [`https://user:pw@pptaken.example/p/${ID}`, null],
      ["not a url", null],
    ];
    for (const [url, kind] of cases) expect(routeOf(url, O)?.kind ?? null, url).toBe(kind);
  });

  it("ignores queries and fragments (no token ever reaches a key)", () => {
    expect(cacheKeyOf(`${O}/p/${ID}?ct=abc#/3/1`, O)).toBe(`${O}/p/${ID}`);
    expect(cacheKeyOf(`${O}/api/v1/decks/${ID}/offline?ct=x&t=1`, O)).toBe(
      `${O}/api/v1/decks/${ID}/offline`,
    );
    expect(cacheKeyOf(`${O}/_player/shell.js?v=2`, O)).toBe(`${O}/_player/shell.js`);
    expect(cacheKeyOf(`${O}/c/${ID}/1?ct=abc`, O)).toBeNull();
    expect(routeOf(`${O}/p/${ID}`, O)?.deck).toBe(ID);
    expect(routeOf(`${O}/_player/shell.js`, O)?.deck).toBeNull();
  });
});

const response = (over: Partial<ResponseLike> & { contentType?: string }): ResponseLike => ({
  status: 200,
  type: "basic",
  redirected: false,
  url: `${O}/p/${ID}`,
  headers: { get: (n) => (n.toLowerCase() === "content-type" ? (over.contentType ?? null) : null) },
  ...over,
});

describe("service worker response checks", () => {
  const page = routeOf(`${O}/p/${ID}`, O) as Route;
  const api = routeOf(`${O}/api/v1/decks/${ID}/offline`, O) as Route;
  const shell = routeOf(`${O}/_player/shell.js`, O) as Route;
  const font = routeOf(`${O}/_player/fonts/inter/x.woff2`, O) as Route;

  it("stores only direct 200s of the expected type", () => {
    expect(isCacheable(response({ contentType: "text/html; charset=utf-8" }), page)).toBe(true);
    expect(isCacheable(response({ contentType: "application/json" }), api)).toBe(true);
    expect(isCacheable(response({ contentType: "text/javascript; charset=utf-8" }), shell)).toBe(
      true,
    );
    expect(isCacheable(response({ contentType: "font/woff2" }), font)).toBe(true);
    for (const r of [
      response({ status: 404, contentType: "text/plain" }),
      response({ status: 401, contentType: "application/json" }),
      response({ status: 500, contentType: "text/html" }),
      response({ status: 0, type: "opaqueredirect" }),
      response({ redirected: true, contentType: "text/html" }),
      response({ type: "opaque", contentType: "text/html" }),
      response({ type: "cors", contentType: "text/html" }),
      response({ contentType: "application/json" }), // a JSON error body where a page is expected
    ]) {
      expect(isCacheable(r, page)).toBe(false);
    }
    expect(isCacheable(response({ contentType: "text/html" }), api)).toBe(false);
  });

  it("recognizes a signed-out answer on deck routes only", () => {
    expect(signsOut(response({ status: 401 }), api)).toBe(true);
    expect(signsOut(response({ status: 0, type: "opaqueredirect" }), page)).toBe(true);
    expect(signsOut(response({ redirected: true }), page)).toBe(true);
    expect(signsOut(response({ contentType: "text/html" }), page)).toBe(false);
    expect(signsOut(response({ status: 404 }), page)).toBe(false);
    expect(signsOut(response({ status: 401 }), shell)).toBe(false);
  });
});

describe("cache names and versions", () => {
  it("names shell caches per build and deck caches per deck and format", () => {
    expect(shellCacheName("abc")).toBe(`${CACHE_PREFIX}shell-abc`);
    expect(deckOfCache(deckCacheName(ID))).toBe(ID);
    expect(deckOfCache(`${CACHE_PREFIX}v0-deck-${ID}`)).toBeNull();
    expect(deckOfCache(`${CACHE_PREFIX}v1-deck-nope`)).toBeNull();
  });
  it("activation deletes other builds and formats, keeps decks and foreign caches", () => {
    expect(isStaleCache(shellCacheName("old"), "new")).toBe(true);
    expect(isStaleCache(shellCacheName("new"), "new")).toBe(false);
    expect(isStaleCache(deckCacheName(ID), "new")).toBe(false);
    expect(isStaleCache(`${CACHE_PREFIX}v0-deck-${ID}`, "new")).toBe(true);
    expect(isStaleCache("someone-else", "new")).toBe(false);
  });
});

describe("eviction and quota", () => {
  const metas: DeckMeta[] = [
    { deck: "A", revision: 1, bytes: 400, usedAt: 30 },
    { deck: "B", revision: 2, bytes: 300, usedAt: 10 },
    { deck: "C", revision: 1, bytes: 200, usedAt: 20 },
  ];
  it("computes the bytes to free against 80 % of the quota", () => {
    expect(bytesToFree({ usage: 0, quota: 1000 }, 500)).toBe(0);
    expect(bytesToFree({ usage: 700, quota: 1000 }, 200)).toBe(100);
    expect(bytesToFree({ usage: 900, quota: 1000 }, 0)).toBe(100);
    expect(bytesToFree(null, 10 ** 9)).toBe(0);
    expect(bytesToFree({ usage: 5 }, 10)).toBe(0);
    expect(bytesToFree({ usage: 5, quota: 0 }, 10)).toBe(0);
  });
  it("evicts least recently used decks first, never the one being kept", () => {
    expect(pickEvictions(metas, "Z", 0)).toEqual([]);
    expect(pickEvictions(metas, "Z", 1)).toEqual(["B"]);
    expect(pickEvictions(metas, "Z", 301)).toEqual(["B", "C"]);
    expect(pickEvictions(metas, "B", 1)).toEqual(["C"]);
    expect(pickEvictions(metas, "Z", 10_000)).toEqual(["B", "C", "A"]);
    expect(pickEvictions([], "Z", 5)).toEqual([]);
  });
  it("recognizes quota errors (fake errors, both names)", () => {
    expect(isQuotaError(new DOMException("full", "QuotaExceededError"))).toBe(true);
    expect(isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaError(new TypeError("x"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
  it("validates stored bookkeeping", () => {
    expect(parseMeta({ deck: ID, revision: 2, bytes: 10, usedAt: 5 })).toEqual({
      deck: ID,
      revision: 2,
      bytes: 10,
      usedAt: 5,
    });
    for (const bad of [null, { deck: "x", revision: 1, bytes: 1, usedAt: 1 }, { deck: ID }]) {
      expect(parseMeta(bad)).toBeNull();
    }
    expect(parseMeta({ deck: ID, revision: -1, bytes: 1, usedAt: 1 })).toBeNull();
  });
});

describe("page <-> worker messages", () => {
  it("accepts the three requests with exact keys", () => {
    expect(parseClientMessage({ v: 1, type: "keep", deck: ID })).toEqual({
      v: 1,
      type: "keep",
      deck: ID,
    });
    expect(parseClientMessage({ v: 1, type: "forget", deck: null })).toEqual({
      v: 1,
      type: "forget",
      deck: null,
    });
    for (const bad of [
      { v: 1, type: "keep", deck: null },
      { v: 1, type: "keep", deck: "../x" },
      { v: 1, type: "keep", deck: ID, url: "https://evil" },
      { v: 2, type: "status", deck: ID },
      { v: 1, type: "purge", deck: ID },
      { type: "keep", deck: ID },
      "keep",
    ]) {
      expect(parseClientMessage(bad)).toBeNull();
    }
  });
  it("validates replies", () => {
    expect(parseWorkerReply({ v: 1, type: "result", ok: true, revision: 3 })).toEqual({
      v: 1,
      type: "result",
      ok: true,
      revision: 3,
    });
    for (const bad of [
      { v: 1, type: "result", ok: true, revision: 0 },
      { v: 1, type: "result", ok: "yes", revision: null },
      { v: 1, type: "result", ok: true, revision: null, extra: 1 },
    ]) {
      expect(parseWorkerReply(bad)).toBeNull();
    }
  });
  it("validates the offline bundle against the deck asked for", () => {
    expect(parseOfflineBundle({ id: ID, revision: 2, html: "x" }, ID)).toEqual({
      id: ID,
      revision: 2,
      html: "x",
    });
    expect(parseOfflineBundle({ id: OTHER, revision: 2, html: "x" }, ID)).toBeNull();
    expect(parseOfflineBundle({ id: ID, revision: 0, html: "x" }, ID)).toBeNull();
    expect(parseOfflineBundle({ id: ID, revision: 1 }, ID)).toBeNull();
  });
});

describe("helpers", () => {
  it("finds our UI font URLs in our stylesheet", () => {
    const css =
      '@font-face{src:url(/_player/fonts/inter/inter-latin-wght.woff2) format("woff2")}@font-face{src:url(/_player/fonts/inter/inter-latin-wght.woff2)}@font-face{src:url(https://evil/x.woff2)}';
    expect(fontPathsIn(css)).toEqual(["/_player/fonts/inter/inter-latin-wght.woff2"]);
  });
  it("the never-opened page is static, localized and script-free", () => {
    expect(unavailablePage("es-AR")).toContain("no está disponible sin conexión");
    expect(unavailablePage("en-US")).toContain("not available offline");
    expect(unavailablePage("fr")).toContain('lang="en"');
    expect(unavailablePage("en")).not.toMatch(/<script/i);
  });
});

describe("loadContent", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const offlineHtml = buildOfflineDocument(
    clean({ schemaVersion: 1, title: "T", slides: [{ id: "a", html: "<p>a</p>" }] }),
    { nonce: NONCE },
  ).html;

  it("uses the signed content URL online", async () => {
    const calls: string[] = [];
    const src = await loadContent(ID, async (url) => {
      calls.push(url);
      return json(200, { url: "https://content.example/c/x?ct=1" });
    });
    expect(src).toEqual({ contentUrl: "https://content.example/c/x?ct=1", fromCopy: false });
    expect(calls).toEqual([`/api/v1/decks/${ID}/content-url`]);
  });

  it("falls back to the stored offline document when the network fails", async () => {
    const src = await loadContent(ID, async (url) => {
      if (url.endsWith("/content-url")) throw new TypeError("Failed to fetch");
      return json(200, { id: ID, revision: 4, html: offlineHtml });
    });
    expect(src).toEqual({ contentHtml: offlineHtml, fromCopy: true, revision: 4 });
  });

  it("signed out is never answered from a copy", async () => {
    await expect(loadContent(ID, async () => json(401, {}))).rejects.toBeInstanceOf(SignedOutError);
  });

  it("fails with the original error when there is no valid copy", async () => {
    const offline = async (url: string) => {
      if (url.endsWith("/content-url")) throw new TypeError("offline");
      return json(200, { id: ID, revision: 1, html: "<p>not an offline document</p>" });
    };
    await expect(loadContent(ID, offline)).rejects.toThrow("offline");
    await expect(
      loadContent(ID, async (url) => {
        if (url.endsWith("/content-url")) throw new TypeError("offline");
        throw new TypeError("no copy");
      }),
    ).rejects.toThrow("offline");
  });
});
