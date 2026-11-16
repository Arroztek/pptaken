// SPDX-License-Identifier: AGPL-3.0-or-later
// OAuth building blocks (token formats, PKCE, redirect URIs, scopes, resources, display names), the OAuthStore
// contract on the memory store, and the OAuthService/LocalAuth seams (audience restriction, password reset).
import { describe, expect, it } from "vitest";
import { runOAuthStoreContract } from "../src/contract.js";
import {
  bearerTokenOf,
  canonicalResource,
  createLocalAuth,
  createOAuthService,
  displayClientName,
  generateAccessToken,
  generateAuthorizationCode,
  generateRefreshToken,
  isCimdClientId,
  MemoryAuthStore,
  MemoryOAuthStore,
  OAUTH_ACCESS_PATTERN,
  OAUTH_REFRESH_PATTERN,
  parseScopeRequest,
  pkceChallengeOf,
  redirectKind,
  redirectUriMatches,
  redirectUriProblem,
  verifyPkceS256,
} from "../src/index.js";

runOAuthStoreContract("memory", async () => ({ store: new MemoryOAuthStore() }));

describe("token formats", () => {
  it("are prefixed, 256-bit, distinct and fit the bearer parser", () => {
    const access = generateAccessToken();
    const refresh = generateRefreshToken();
    expect(access).toMatch(OAUTH_ACCESS_PATTERN);
    expect(refresh).toMatch(OAUTH_REFRESH_PATTERN);
    expect(generateAuthorizationCode()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 200 }, generateAccessToken)).size).toBe(200);
    expect(bearerTokenOf(`Bearer ${access}`)).toBe(access);
    expect(`Bearer ${access}`.length).toBeLessThan(200);
  });
});

describe("PKCE S256", () => {
  it("matches the RFC 7636 example and refuses malformed verifiers", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(pkceChallengeOf(verifier)).toBe(challenge);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256(`${verifier}A`, challenge)).toBe(false);
    expect(verifyPkceS256("short", pkceChallengeOf("short"))).toBe(false);
    expect(verifyPkceS256(`${"a".repeat(42)} `, challenge)).toBe(false);
    expect(verifyPkceS256(undefined, challenge)).toBe(false);
    expect(verifyPkceS256("a".repeat(129), pkceChallengeOf("a".repeat(129)))).toBe(false);
  });
});

describe("redirect URIs", () => {
  it("accepts https and loopback http only", () => {
    expect(redirectUriProblem("https://claude.ai/api/mcp/auth_callback")).toBeNull();
    expect(redirectUriProblem("http://localhost:3000/cb")).toBeNull();
    expect(redirectUriProblem("http://127.0.0.1/cb")).toBeNull();
    expect(redirectUriProblem("http://[::1]:8080/cb")).toBeNull();
    for (const bad of [
      "http://example.com/cb",
      "myapp://cb",
      "javascript:alert(1)",
      "https://a.example/cb#frag",
      "https://u:p@a.example/cb",
      "https://a.example/ cb",
      "relative/cb",
      `https://a.example/${"x".repeat(250)}`,
      "",
      42,
    ]) {
      expect(redirectUriProblem(bad), String(bad)).not.toBeNull();
    }
  });

  it("matches exactly, ignoring only the loopback port", () => {
    const claude = "https://claude.ai/api/mcp/auth_callback";
    expect(redirectUriMatches(claude, claude)).toBe(true);
    expect(redirectUriMatches(claude, `${claude}/`)).toBe(false);
    expect(redirectUriMatches(claude, "https://CLAUDE.ai/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriMatches("https://a.example:443/cb", "https://a.example:8443/cb")).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1/cb", "http://127.0.0.1:51234/cb")).toBe(true);
    expect(redirectUriMatches("http://localhost:1/cb", "http://localhost:2/cb")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1/cb", "http://127.0.0.1:5/other")).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1/cb", "http://localhost:5/cb")).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1/cb?a=1", "http://127.0.0.1:5/cb?a=2")).toBe(false);
    expect(redirectKind(claude)).toBe("claude");
    expect(redirectKind(`${claude}?x=1`)).toBe("web");
    expect(redirectKind("http://localhost:9/cb")).toBe("loopback");
  });
});

describe("scopes and resources", () => {
  it("drops unknown scopes, ignores offline_access and never grants share:write", () => {
    expect(parseScopeRequest(undefined)).toEqual({
      ok: true,
      scopes: ["decks:read", "decks:write", "quiz:draft"],
    });
    expect(parseScopeRequest("offline_access")).toMatchObject({ ok: true });
    expect(parseScopeRequest("quiz:draft decks:read openid")).toEqual({
      ok: true,
      scopes: ["decks:read", "quiz:draft"],
    });
    expect(parseScopeRequest("share:write admin")).toEqual({
      ok: false,
      reason: "nothing_grantable",
    });
  });

  it("canonicalises resource indicators", () => {
    expect(canonicalResource("https://Slides.Example.com:443/mcp/")).toBe(
      "https://slides.example.com/mcp",
    );
    expect(canonicalResource("http://127.0.0.1:8080/mcp")).toBe("http://127.0.0.1:8080/mcp");
    expect(canonicalResource("https://slides.example.com/mcp#x")).toBeNull();
    expect(canonicalResource("urn:pptaken")).toBeNull();
  });

  it("recognises CIMD client ids", () => {
    expect(isCimdClientId("https://claude.ai/oauth/mcp-oauth-client-metadata")).toBe(true);
    expect(isCimdClientId("https://claude.ai/")).toBe(false);
    expect(isCimdClientId("http://claude.ai/x")).toBe(false);
    expect(isCimdClientId("https://claude.ai/a/../b")).toBe(false);
    expect(isCimdClientId("https://u@claude.ai/x")).toBe(false);
  });
});

describe("client names for display", () => {
  it("strips control and bidi characters and caps at 60", () => {
    const rlo = String.fromCharCode(0x202e);
    expect(displayClientName(`Cla${rlo}ude\u0007`)).toBe("Claude");
    expect(displayClientName("  ")).toBeNull();
    expect(displayClientName(42)).toBeNull();
    const long = displayClientName("x".repeat(100)) as string;
    expect([...long].length).toBe(60);
  });
});

describe("OAuthService and LocalAuth", () => {
  const ids = (() => {
    let n = 0;
    return { ulid: () => `01TEST${String(n++).padStart(20, "0")}` };
  })();

  async function connected() {
    const oauthStore = new MemoryOAuthStore();
    const oauth = createOAuthService({
      store: oauthStore,
      ids,
      issuer: "https://slides.example.com",
    });
    const auth = createLocalAuth({
      store: new MemoryAuthStore(),
      secret: new Uint8Array(32).fill(7),
      ids,
      oauth,
      scrypt: { ln: 10, r: 8, p: 1 },
    });
    await auth.bootstrapOwner("violet otter climbs 7 dunes");
    const reg = await oauth.registerClient({ redirect_uris: ["http://127.0.0.1/cb"] });
    const verifier = "v".repeat(43);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id as string,
      redirect_uri: "http://127.0.0.1/cb",
      code_challenge: pkceChallengeOf(verifier),
      code_challenge_method: "S256",
    });
    const outcome = await oauth.authorize(params);
    if (outcome.kind !== "redirect") throw new Error("expected a redirect");
    const id = outcome.location.split("/connect/")[1];
    const { redirectUrl } = await oauth.decide(id, { approve: true });
    const code = new URL(redirectUrl).searchParams.get("code") as string;
    const tokens = await oauth.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1/cb",
        code_verifier: verifier,
        client_id: reg.client_id as string,
      }),
    );
    return { auth, oauth, tokens };
  }

  it("access tokens authenticate only with the /mcp resource; tokenId is the grant id", async () => {
    const { auth, tokens } = await connected();
    const header = `Bearer ${tokens.access_token}`;
    expect(await auth.authenticateBearer(header)).toBeNull();
    expect(await auth.authenticate({ authorization: header })).toBeNull();
    expect(
      await auth.authenticateBearer(header, { resource: "https://slides.example.com/api" }),
    ).toBeNull();
    const ok = await auth.authenticateBearer(header, {
      resource: "https://slides.example.com/mcp",
    });
    expect(ok).toMatchObject({ kind: "token", via: "oauth" });
    expect(ok?.principal.tokenId).toBe(ok?.kind === "token" ? ok.token.id : "");
    expect([...(ok?.principal.scopes ?? [])]).toEqual(["decks:read", "decks:write", "quiz:draft"]);
  });

  it("a password reset disconnects every application", async () => {
    const { auth, oauth, tokens } = await connected();
    expect(await auth.resetPassword("a brand new passphrase 99")).toBe(1);
    expect(
      await oauth.authenticateAccessToken(tokens.access_token, "https://slides.example.com/mcp"),
    ).toBeNull();
    expect(await oauth.connectedApps()).toEqual([]);
  });

  it("is inert without an issuer", async () => {
    const oauth = createOAuthService({ store: new MemoryOAuthStore(), ids, issuer: null });
    expect(oauth.enabled).toBe(false);
    expect(() => oauth.metadata()).toThrow();
    await expect(
      oauth.registerClient({ redirect_uris: ["https://a.example/cb"] }),
    ).rejects.toThrow();
    expect(await oauth.authenticateAccessToken(generateAccessToken(), "https://x/mcp")).toBeNull();
  });
});
