// SPDX-License-Identifier: Apache-2.0
// Presenter-password unlock (ADR-021), pure parts: the key that opens the dialog, the unlock request and its
// answers, the token store (sessionStorage only), the guest content-url options and the presenter data flag. The
// dialog itself is covered in real browsers (apps/server/browser/unlock-e2e.mjs). Tests run against the build.
import { afterEach, describe, expect, it } from "vitest";
import { labelsFor, parsePresenterData } from "../dist/index.js";
import { loadContent } from "../dist/offline-client.js";
import { keyHelpRows } from "../dist/shell.js";
import {
  forgetUnlockToken,
  isUnlockKey,
  readUnlockToken,
  requestUnlock,
  storeUnlockToken,
  UNLOCK_STORAGE_PREFIX,
} from "../dist/unlock.js";

const DECK = "01JD0000000000000000000000";
const TOKEN = `${"a".repeat(80)}.${"b".repeat(43)}`;
const key = (over: Partial<Parameters<typeof isUnlockKey>[0]> = {}) => ({
  key: "u",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isTrusted: true,
  ...over,
});

describe("the unlock key", () => {
  it("is a plain U, never with a modifier, a repeat, IME composition or a synthetic event", () => {
    expect(isUnlockKey(key())).toBe(true);
    expect(isUnlockKey(key({ key: "U" }))).toBe(true); // Caps Lock
    for (const over of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
      { repeat: true },
      { isComposing: true },
      { isTrusted: false },
      { key: "w" },
      { key: "KeyU" },
    ]) {
      expect(isUnlockKey(key(over)), JSON.stringify(over)).toBe(false);
    }
  });

  it("is listed in the key help only where it works", () => {
    const t = labelsFor("en");
    expect(keyHelpRows(t, false, false, true).some(([k]) => k === "U")).toBe(true);
    expect(keyHelpRows(t, true, true).some(([k]) => k === "U")).toBe(false);
  });
});

describe("requestUnlock", () => {
  const fake = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const impl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers });
    };
    return { calls, impl };
  };

  it("posts JSON with the CSRF header and no cookies, and returns a well-formed token", async () => {
    const { calls, impl } = fake(200, { token: TOKEN, deckId: DECK });
    expect(await requestUnlock(DECK, "pw pw pw pw pw", impl)).toEqual({ ok: true, token: TOKEN });
    expect(calls[0]?.url).toBe("/api/v1/presenter/unlock");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("omit");
    expect((calls[0]?.init?.headers as Record<string, string>)["X-PPTaken-CSRF"]).toBe("1");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      deckId: DECK,
      password: "pw pw pw pw pw",
    });
  });

  it("maps refusals, lockouts, malformed answers and network errors", async () => {
    expect(await requestUnlock(DECK, "x", fake(401, {}).impl)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await requestUnlock(DECK, "x", fake(429, {}, { "Retry-After": "12" }).impl)).toEqual({
      ok: false,
      reason: "locked",
      retryAfterSec: 12,
    });
    expect(await requestUnlock(DECK, "x", fake(200, { token: "<script>" }).impl)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await requestUnlock(DECK, "x", fake(503, {}).impl)).toEqual({
      ok: false,
      reason: "network",
    });
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await requestUnlock(DECK, "x", offline)).toEqual({ ok: false, reason: "network" });
  });
});

describe("token storage", () => {
  const g = globalThis as { sessionStorage?: unknown };
  afterEach(() => {
    delete g.sessionStorage;
  });

  it("keeps a well-formed token per deck in sessionStorage", () => {
    const map = new Map<string, string>();
    g.sessionStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    storeUnlockToken(DECK, TOKEN);
    expect(map.get(UNLOCK_STORAGE_PREFIX + DECK)).toBe(TOKEN);
    expect(readUnlockToken(DECK)).toBe(TOKEN);
    storeUnlockToken(DECK, "not a token");
    storeUnlockToken("../x", TOKEN);
    expect(map.size).toBe(1);
    map.set(UNLOCK_STORAGE_PREFIX + DECK, "tampered");
    expect(readUnlockToken(DECK)).toBeNull();
    forgetUnlockToken(DECK);
    expect(map.size).toBe(0);
  });

  it("never throws when storage is missing or blocked", () => {
    expect(readUnlockToken(DECK)).toBeNull();
    Object.defineProperty(g, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    expect(() => storeUnlockToken(DECK, TOKEN)).not.toThrow();
    expect(readUnlockToken(DECK)).toBeNull();
    expect(() => forgetUnlockToken(DECK)).not.toThrow();
  });
});

describe("guest content and presenter data", () => {
  it("sends the guest headers, reads locked/unlockRejected, and never falls back to the offline copy", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const impl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          url: "https://c.test/c/x/1?ct=t",
          scripts: "locked",
          unlockRejected: true,
        }),
      );
    };
    const source = await loadContent(DECK, impl, {
      headers: { "X-PPTaken-View": "v", "X-PPTaken-Unlock": TOKEN },
      offline: false,
    });
    expect(source).toMatchObject({ scripts: "locked", unlockRejected: true, fromCopy: false });
    expect((calls[0]?.init?.headers as Record<string, string>)["X-PPTaken-Unlock"]).toBe(TOKEN);
    const failing = async (url: string) => {
      calls.push({ url });
      throw new TypeError("offline");
    };
    calls.length = 0;
    await expect(loadContent(DECK, failing, { offline: false })).rejects.toThrow("offline");
    expect(calls.map((c) => c.url)).toEqual([`/api/v1/decks/${DECK}/content-url`]);
  });

  it("accepts the interactive flag in presenter data, and nothing but a boolean", () => {
    const base = { title: "T", slides: [{ id: "a", title: "", notesHtml: "" }] };
    expect(parsePresenterData({ ...base, interactive: true })?.interactive).toBe(true);
    expect(parsePresenterData({ ...base, interactive: false })?.interactive).toBeUndefined();
    expect(parsePresenterData({ ...base, interactive: "yes" })).toBeNull();
  });
});
