// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAuthStoreContract } from "../src/contract.js";
import {
  AuthError,
  bearerTokenOf,
  createLocalAuth,
  DAY_MS,
  type LocalAuth,
  MemoryAuthStore,
  SESSION_TTL_MS,
} from "../src/index.js";

runAuthStoreContract("memory", async () => ({ store: new MemoryAuthStore() }));

const FAST = { ln: 10, r: 8, p: 1 };
const GOOD_PASSWORD = "correct battery horse staple 42";

class FakeClock {
  constructor(public t = 1_700_000_000_000) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

function setupAuth(): { auth: LocalAuth; store: MemoryAuthStore; clock: FakeClock } {
  const store = new MemoryAuthStore();
  const clock = new FakeClock();
  let n = 0;
  const auth = createLocalAuth({
    store,
    clock,
    secret: randomBytes(32),
    ids: { ulid: () => `01TEST${String(++n).padStart(20, "0")}` },
    scrypt: FAST,
  });
  return { auth, store, clock };
}

async function expectAuthError(p: Promise<unknown>, code: string) {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).code).toBe(code);
}

async function installed() {
  const t = setupAuth();
  const code = (await t.auth.ensureInstallCode()) as string;
  const result = await t.auth.setup({ installCode: code, password: GOOD_PASSWORD });
  return { ...t, ...result };
}

describe("install code and setup", () => {
  it("issues a fresh single-use code on every boot until the owner exists", async () => {
    const { auth, store } = setupAuth();
    expect(await auth.isInstalled()).toBe(false);
    const first = await auth.ensureInstallCode();
    expect(first).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    const stored = await store.getSetting("default", "install_code");
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain((first as string).replace("-", ""));
    const second = await auth.ensureInstallCode();
    // The first boot's code no longer works.
    await expectAuthError(auth.setup({ installCode: first, password: GOOD_PASSWORD }), "FORBIDDEN");
    const { ownerId, sessionId } = await auth.setup({
      installCode: (second as string).toLowerCase().replace("-", " "),
      password: GOOD_PASSWORD,
    });
    expect(ownerId).toMatch(/^01TEST/);
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await auth.isInstalled()).toBe(true);
    expect(await auth.ensureInstallCode()).toBeNull();
    await expectAuthError(
      auth.setup({ installCode: second, password: GOOD_PASSWORD }),
      "ALREADY_SETUP",
    );
  });

  it("rejects malformed and wrong codes before looking at the password", async () => {
    const { auth } = setupAuth();
    await auth.ensureInstallCode();
    for (const installCode of [
      undefined,
      42,
      "",
      "AAAA-AAA",
      "0000-0000",
      "x".repeat(500),
      "ZZZZ-ZZZZ",
    ]) {
      await expectAuthError(auth.setup({ installCode, password: "short" }), "FORBIDDEN");
    }
  });

  it("enforces the password policy with a hint", async () => {
    const { auth } = setupAuth();
    const code = await auth.ensureInstallCode();
    for (const password of [
      "short",
      "password1234",
      "Qwertyuiop123",
      "aaaaaaaaaaaaaaaa",
      "ababababababab",
    ]) {
      const error = await auth.setup({ installCode: code, password }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe("VALIDATION_ERROR");
      expect((error as AuthError).hint).toBeTruthy();
    }
    expect(await auth.isInstalled()).toBe(false);
  });

  it("only one of two concurrent setups wins", async () => {
    const { auth } = setupAuth();
    const code = await auth.ensureInstallCode();
    const results = await Promise.allSettled([
      auth.setup({ installCode: code, password: GOOD_PASSWORD }),
      auth.setup({ installCode: code, password: "another strong passphrase 9" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("sessions", () => {
  it("login rotates the session id, logout invalidates only that session", async () => {
    const { auth, sessionId } = await installed();
    const a = await auth.login({ password: GOOD_PASSWORD });
    const b = await auth.login({ password: GOOD_PASSWORD });
    expect(new Set([sessionId, a.sessionId, b.sessionId]).size).toBe(3);
    await auth.logout(a.sessionId);
    expect(await auth.resolveSession(a.sessionId)).toBeNull();
    expect(await auth.resolveSession(b.sessionId)).not.toBeNull();
  });

  it("wrong password, no owner and malformed input", async () => {
    const fresh = setupAuth();
    await expectAuthError(fresh.auth.login({ password: GOOD_PASSWORD }), "SETUP_REQUIRED");
    const { auth } = await installed();
    for (const password of ["wrong password!!", "", undefined, 7, "x".repeat(5000)]) {
      await expectAuthError(auth.login({ password }), "UNAUTHENTICATED");
    }
  });

  it("expires after 30 days of inactivity and slides with use", async () => {
    const { auth, clock, sessionId } = await installed();
    clock.advance(SESSION_TTL_MS - DAY_MS);
    expect(await auth.resolveSession(sessionId)).toMatchObject({ refreshed: true });
    clock.advance(SESSION_TTL_MS - DAY_MS); // still within the slid window
    expect(await auth.resolveSession(sessionId)).not.toBeNull();
    clock.advance(SESSION_TTL_MS + 1);
    expect(await auth.resolveSession(sessionId)).toBeNull();
  });

  it("revoke all and password reset sign out every session", async () => {
    const { auth, sessionId } = await installed();
    const other = await auth.login({ password: GOOD_PASSWORD });
    expect(await auth.revokeAllSessions()).toBe(2);
    expect(await auth.resolveSession(sessionId)).toBeNull();
    const again = await auth.login({ password: GOOD_PASSWORD });
    await auth.resetPassword("a brand new passphrase 77");
    expect(await auth.resolveSession(again.sessionId)).toBeNull();
    expect(await auth.resolveSession(other.sessionId)).toBeNull();
    await expectAuthError(auth.login({ password: GOOD_PASSWORD }), "UNAUTHENTICATED");
    expect(await auth.login({ password: "a brand new passphrase 77" })).toBeTruthy();
  });

  it("rejects malformed and unknown session ids", async () => {
    const { auth } = await installed();
    for (const id of [
      undefined,
      null,
      "",
      "abc",
      "x".repeat(43),
      "A".repeat(43),
      "../../etc/passwd",
    ]) {
      expect(await auth.resolveSession(id)).toBeNull();
    }
  });

  it("authenticate gives the owner every scope through the session", async () => {
    const { auth, sessionId } = await installed();
    const a = await auth.authenticate({ sessionId });
    expect(a?.kind).toBe("session");
    expect(a?.principal.actor).toBe("owner");
    expect(a?.principal.scopes.has("admin")).toBe(true);
    // A present but bogus Authorization header never falls back to the cookie.
    expect(await auth.authenticate({ sessionId, authorization: "Bearer nope" })).toBeNull();
  });
});

describe("API tokens", () => {
  it("has the ppt_ + 43 base64url format, only its hash is stored, shown once", async () => {
    const { auth, store } = await installed();
    const { token, secret } = await auth.createToken({ name: "Claude Code" });
    expect(secret).toMatch(/^ppt_[A-Za-z0-9_-]{43}$/);
    expect(token.scopes).toEqual(["decks:read", "decks:write", "quiz:draft"]);
    const stored = await store.listTokens("default");
    expect(JSON.stringify(stored)).not.toContain(secret.slice(4));
    expect(JSON.stringify(await auth.listTokens())).not.toContain(secret.slice(4));
  });

  it("authenticates as an agent with the token's scopes and tracks last use", async () => {
    const { auth, clock } = await installed();
    const { token, secret } = await auth.createToken({ name: "reader", scopes: ["decks:read"] });
    const a = await auth.authenticate({ authorization: `Bearer ${secret}` });
    expect(a?.kind).toBe("token");
    expect(a?.principal).toMatchObject({ actor: "agent", tokenId: token.id });
    expect([...(a?.principal.scopes ?? [])]).toEqual(["decks:read"]);
    expect((await auth.listTokens())[0]?.lastUsedAt).toBe(clock.now());
    expect(await auth.authenticate({ authorization: `bearer   ${secret}` })).not.toBeNull();
  });

  it("refuses unassignable scopes, bad names and bad expiry", async () => {
    const { auth } = await installed();
    for (const input of [
      { name: "x", scopes: ["admin"] },
      { name: "x", scopes: ["share:write"] },
      { name: "x", scopes: ["live:control"] },
      { name: "x", scopes: [] },
      { name: "x", scopes: "decks:read" },
      { name: "" },
      { name: "a\nb" },
      { name: "x".repeat(101) },
      { name: 5 },
      { name: "x", expiresInDays: 0 },
      { name: "x", expiresInDays: 1.5 },
      { name: "x", expiresInDays: "7" },
    ]) {
      await expectAuthError(auth.createToken(input), "VALIDATION_ERROR");
    }
  });

  it("expires and revokes immediately", async () => {
    const { auth, clock } = await installed();
    const short = await auth.createToken({ name: "short", expiresInDays: 1 });
    expect(short.token.expiresAt).toBe(clock.now() + DAY_MS);
    expect(await auth.authenticateBearer(`Bearer ${short.secret}`)).not.toBeNull();
    clock.advance(DAY_MS);
    expect(await auth.authenticateBearer(`Bearer ${short.secret}`)).toBeNull();
    const long = await auth.createToken({ name: "long" });
    await auth.revokeToken(long.token.id);
    expect(await auth.authenticateBearer(`Bearer ${long.secret}`)).toBeNull();
    expect((await auth.listTokens()).find((t) => t.id === long.token.id)?.revokedAt).toBe(
      clock.now(),
    );
    await expectAuthError(auth.revokeToken("01UNKNOWN"), "NOT_FOUND");
  });

  it("rejects malformed bearer values", async () => {
    const { auth } = await installed();
    const { secret } = await auth.createToken({ name: "t" });
    for (const header of [
      secret,
      `Basic ${secret}`,
      `Bearer ${secret}x`,
      `Bearer ${secret.slice(0, -1)}`,
      `Bearer ${secret} extra`,
      `Bearer ppt_${"A".repeat(43)}`,
      "Bearer",
      "",
    ]) {
      expect(await auth.authenticateBearer(header)).toBeNull();
    }
    expect(bearerTokenOf(`Bearer ${secret}`)).toBe(secret);
  });
});

describe("agent connection", () => {
  it("records the last call with cleaned values", async () => {
    const { auth, clock } = await installed();
    expect(await auth.mcpStatus()).toBeNull();
    await auth.recordMcpCall({
      tool: "whoami",
      clientName: "claude-code\u0007 2.0",
      tokenId: "01X",
    });
    expect(await auth.mcpStatus()).toEqual({
      lastCallAt: clock.now(),
      lastTool: "whoami",
      clientName: "claude-code 2.0",
    });
  });
});
