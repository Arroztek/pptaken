// SPDX-License-Identifier: AGPL-3.0-or-later
// The built-in OAuth authorization server (ADR-0018) against a real listening server:
// (a) conformance with the official MCP client SDK (`auth()` + an in-memory OAuthClientProvider): 401 → resource
//     metadata → AS metadata → CIMD or DCR → scripted consent through the panel API → token → tool call → forced
//     expiry → refresh;
// (b) negative cases: PKCE, redirect URIs, codes, resources, audiences, refresh rotation and reuse, consent
//     without session/CSRF, issuer mix-up, DCR limits, CIMD SSRF and mismatch, revocation, OAuth off.
import {
  auth,
  Client,
  extractWWWAuthenticateParams,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { pkceChallengeOf } from "@pptaken/auth-local";
import { afterEach, describe, expect, it } from "vitest";
import type { CimdFetcherOverride } from "../src/safe-fetch.js";
import {
  freePort,
  type Harness,
  listen,
  makeHarness,
  PASSWORD,
  sessionCookie,
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

const CALLBACK = "http://127.0.0.1:43219/callback";
const CIMD_URL = "https://client.example/oauth/client.json";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 appendix B
const CHALLENGE = pkceChallengeOf(VERIFIER);

interface OAuthEnv {
  base: string;
  cookie: string;
}

/** A server whose PPTAKEN_PUBLIC_URL is its own loopback origin (OAuth on), with an owner signed in. */
async function start(
  options: { env?: Record<string, string>; cimd?: CimdFetcherOverride } = {},
): Promise<OAuthEnv> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  h = await makeHarness(
    { PPTAKEN_PUBLIC_URL: base, ...options.env },
    options.cimd === undefined ? {} : { fetchClientMetadata: options.cimd },
  );
  const cookie = await setupOwner(h);
  const live = await listen(h.server, port);
  stop = live.close;
  return { base, cookie };
}

const cimdDocument =
  (overrides: Record<string, unknown> = {}): CimdFetcherOverride =>
  async (url) => ({
    body: {
      client_id: url,
      client_name: "Example CIMD client",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      ...overrides,
    },
    maxAgeSec: 300,
  });

async function mcpPost(base: string, authorization?: string) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

async function register(base: string, body: Record<string, unknown> = {}, headers = {}) {
  return fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      client_name: "Test client",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      ...body,
    }),
  });
}

async function registerClient(base: string, body: Record<string, unknown> = {}): Promise<string> {
  const r = await register(base, body);
  expect(r.status).toBe(201);
  return (await r.json()).client_id;
}

function authorizeParams(clientId: string, over: Record<string, string | null> = {}) {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "decks:read decks:write quiz:draft",
    state: "st-123",
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null) q.set(k, v);
  return q;
}

async function authorize(base: string, params: URLSearchParams) {
  return fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" });
}

/** Runs authorize and approves the pending request through the panel API; returns the callback URL. */
async function approve(
  env: OAuthEnv,
  params: URLSearchParams,
  body: Record<string, unknown> = { decision: "approve" },
): Promise<URL> {
  const r = await authorize(env.base, params);
  expect(r.status).toBe(302);
  const location = new URL(r.headers.get("location") as string);
  expect(location.pathname).toMatch(/^\/connect\/[A-Za-z0-9_-]{32}$/);
  const id = location.pathname.split("/")[2] as string;
  const decided = await h?.api("POST", `/api/v1/oauth/requests/${id}`, {
    body,
    cookie: env.cookie,
  });
  expect(decided?.status).toBe(200);
  return new URL((await decided?.json()).redirectUrl);
}

async function codeFor(env: OAuthEnv, clientId: string, over: Record<string, string | null> = {}) {
  const cb = await approve(env, authorizeParams(clientId, over));
  return cb.searchParams.get("code") as string;
}

async function token(base: string, form: Record<string, string>) {
  return fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
}

async function exchange(env: OAuthEnv, clientId: string, code: string, extra = {}) {
  return token(env.base, {
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    code_verifier: VERIFIER,
    client_id: clientId,
    ...extra,
  });
}

async function tokensFor(env: OAuthEnv, clientId: string) {
  const r = await exchange(env, clientId, await codeFor(env, clientId));
  expect(r.status).toBe(200);
  return (await r.json()) as { access_token: string; refresh_token: string; scope: string };
}

const refresh = (base: string, clientId: string, refreshToken: string) =>
  token(base, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });

// -----------------------------------------------------------------------------------------------------------------
// (a) Conformance with the MCP client SDK

class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authUrl: URL | undefined;
  clientMetadataUrl?: string;
  constructor(clientMetadataUrl?: string) {
    if (clientMetadataUrl !== undefined) this.clientMetadataUrl = clientMetadataUrl;
  }
  get redirectUrl() {
    return CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "SDK conformance client",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() {
    return "sdk-state";
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

async function sdkFlow(env: OAuthEnv, provider: MemoryProvider) {
  const serverUrl = `${env.base}/mcp`;
  const challenge = await mcpPost(env.base);
  expect(challenge.status).toBe(401);
  const www = extractWWWAuthenticateParams(challenge);
  expect(www.resourceMetadataUrl?.href).toBe(
    `${env.base}/.well-known/oauth-protected-resource/mcp`,
  );
  expect(www.error).toBeUndefined();
  expect(
    await auth(provider, {
      serverUrl,
      ...(www.resourceMetadataUrl === undefined
        ? {}
        : { resourceMetadataUrl: www.resourceMetadataUrl }),
    }),
  ).toBe("REDIRECT");
  const authUrl = provider.authUrl as URL;
  expect(authUrl.origin + authUrl.pathname).toBe(`${env.base}/oauth/authorize`);
  expect(authUrl.searchParams.get("resource")).toBe(serverUrl);
  expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
  const cb = await approve(env, authUrl.searchParams);
  expect(cb.searchParams.get("state")).toBe("sdk-state");
  expect(cb.searchParams.get("iss")).toBe(env.base);
  expect(
    await auth(provider, {
      serverUrl,
      authorizationCode: cb.searchParams.get("code") as string,
      iss: cb.searchParams.get("iss") as string,
    }),
  ).toBe("AUTHORIZED");
  expect(provider.saved?.access_token).toMatch(/^ppto_[A-Za-z0-9_-]{43}$/);
  expect(provider.saved?.refresh_token).toMatch(/^pptr_[A-Za-z0-9_-]{43}$/);
  expect(provider.saved?.scope).toBe("decks:read decks:write quiz:draft");

  const callWhoami = async () => {
    const client = new Client({ name: "sdk-oauth-agent", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider }),
    );
    const r = await client.callTool({ name: "whoami", arguments: {} });
    await client.close();
    return JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}");
  };
  const who = await callWhoami();
  expect(who).toMatchObject({ actor: "agent", base_url: env.base });
  expect(who.scopes).toEqual(["decks:read", "decks:write", "quiz:draft"]);
  // tokenId is the grant id: stable across refreshes.
  const grantId = who.token_id;
  expect(grantId).toMatch(/^[0-9A-Z]{26}$/);

  // Forced expiry: the access token dies after one hour; the SDK refreshes with the rotated refresh token.
  const before = provider.saved as OAuthTokens;
  (h as Harness).clock.t += 3601_000;
  expect((await mcpPost(env.base, `Bearer ${before.access_token}`)).status).toBe(401);
  expect((await callWhoami()).token_id).toBe(grantId);
  expect(provider.saved?.access_token).not.toBe(before.access_token);
  expect(provider.saved?.refresh_token).not.toBe(before.refresh_token);
  expect((await mcpPost(env.base, `Bearer ${provider.saved?.access_token}`)).status).toBe(200);
}

describe("conformance with the MCP client SDK", () => {
  it("DCR: 401 → metadata → register → consent → token → tool call → expiry → refresh", async () => {
    const env = await start();
    const provider = new MemoryProvider();
    await sdkFlow(env, provider);
    expect(provider.info?.client_id).toMatch(/^pptc_/);
    const apps = await (await h?.api("GET", "/api/v1/oauth/apps", { cookie: env.cookie }))?.json();
    expect(apps.apps).toHaveLength(1);
    expect(apps.apps[0]).toMatchObject({
      clientName: "SDK conformance client",
      redirectHost: "127.0.0.1:43219",
      scopes: ["decks:read", "decks:write", "quiz:draft"],
    });
  });

  it("CIMD: the client_id is the metadata URL; nothing is stored before consent", async () => {
    const fetched: string[] = [];
    const env = await start({
      cimd: async (url) => {
        fetched.push(url);
        return cimdDocument()(url);
      },
    });
    const provider = new MemoryProvider(CIMD_URL);
    await sdkFlow(env, provider);
    expect(provider.info?.client_id).toBe(CIMD_URL);
    expect(fetched).toEqual([CIMD_URL]); // cached afterwards
    const apps = await (await h?.api("GET", "/api/v1/oauth/apps", { cookie: env.cookie }))?.json();
    expect(apps.apps[0]).toMatchObject({ clientId: CIMD_URL, clientKind: "cimd" });
  });
});

// -----------------------------------------------------------------------------------------------------------------
// Metadata and discovery

describe("metadata", () => {
  it("publishes RFC 8414 and RFC 9728 documents with CORS, and no OpenID configuration", async () => {
    const env = await start();
    const as = await fetch(`${env.base}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    expect(as.headers.get("access-control-allow-origin")).toBe("*");
    expect(as.headers.get("access-control-allow-credentials")).toBeNull();
    expect(as.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(await as.json()).toEqual({
      issuer: env.base,
      authorization_endpoint: `${env.base}/oauth/authorize`,
      token_endpoint: `${env.base}/oauth/token`,
      registration_endpoint: `${env.base}/oauth/register`,
      revocation_endpoint: `${env.base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["decks:read", "decks:write", "quiz:draft", "offline_access"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const prm = await fetch(`${env.base}${path}`);
      expect(prm.headers.get("access-control-allow-origin")).toBe("*");
      const body = await prm.json();
      expect(body).toMatchObject({
        resource: `${env.base}/mcp`,
        authorization_servers: [env.base],
        scopes_supported: ["decks:read", "decks:write", "quiz:draft"],
      });
      expect(body.scopes_supported).not.toContain("offline_access");
    }
    const preflight = await fetch(`${env.base}/oauth/token`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect((await fetch(`${env.base}/.well-known/openid-configuration`)).status).toBe(404);
    // /mcp keeps its Origin check and no CORS.
    const mcp = await mcpPost(env.base);
    expect(mcp.headers.get("access-control-allow-origin")).toBeNull();
    const authorizeCors = await authorize(env.base, new URLSearchParams());
    expect(authorizeCors.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("the pages of a sign-in window keep window.opener (no COOP isolation); the rest stays isolated", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const r = await authorize(env.base, authorizeParams(clientId));
    expect(r.headers.get("cross-origin-opener-policy")).toBe("unsafe-none");
    const consentPath = new URL(r.headers.get("location") as string).pathname;
    for (const path of [consentPath, "/login"]) {
      const page = await fetch(`${env.base}${path}`);
      expect(page.headers.get("cross-origin-opener-policy"), path).toBe("unsafe-none");
      expect(page.headers.get("x-frame-options"), path).toBe("DENY");
    }
    const other = await fetch(`${env.base}/decks`);
    expect(other.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("the issuer is PPTAKEN_PUBLIC_URL, never the Host header", async () => {
    const env = await start();
    const viaOtherHost = await h?.server.app.request(
      "http://localhost:8080/.well-known/oauth-authorization-server",
    );
    expect((await viaOtherHost?.json()).issuer).toBe(env.base);
  });

  it("401 challenges carry resource_metadata and scope; error only when a token was presented", async () => {
    const env = await start();
    const none = await mcpPost(env.base);
    expect(none.headers.get("www-authenticate")).toBe(
      `Bearer realm="pptaken", resource_metadata="${env.base}/.well-known/oauth-protected-resource/mcp", scope="decks:read decks:write quiz:draft"`,
    );
    expect((await none.json()).error.hint).toMatch(/OAuth/);
    const bad = await mcpPost(env.base, `Bearer ppto_${"A".repeat(43)}`);
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toMatch(/, error="invalid_token"$/);
  });

  it("OAuth is off without an https (or loopback) public URL: no AS metadata, no endpoints", async () => {
    for (const env of [{}, { PPTAKEN_PUBLIC_URL: "http://slides.example.com" }]) {
      h = await makeHarness(env);
      const as = await h.server.app.request(
        "http://localhost:8080/.well-known/oauth-authorization-server",
      );
      expect(as.status).toBe(404);
      const prm = await (
        await h.server.app.request("http://localhost:8080/.well-known/oauth-protected-resource/mcp")
      ).json();
      expect(prm.authorization_servers).toBeUndefined();
      expect(prm.resource).toMatch(/\/mcp$/);
      for (const [method, path] of [
        ["POST", "/oauth/token"],
        ["POST", "/oauth/register"],
        ["GET", "/oauth/authorize"],
      ] as const) {
        const r = await h.server.app.request(`http://localhost:8080${path}`, { method });
        expect(r.status, path).toBe(404);
      }
      await h.cleanup();
      h = undefined;
    }
  });

  it("the content origin keeps 404ing everything outside /c/", async () => {
    const port = await freePort();
    h = await makeHarness({
      PPTAKEN_PUBLIC_URL: `http://127.0.0.1:${port}`,
      PPTAKEN_CONTENT_URL: "https://content.example.com",
    });
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/oauth/token",
    ]) {
      const r = await h.server.app.request(`https://content.example.com${path}`);
      expect(r.status, path).toBe(404);
    }
  });
});

// -----------------------------------------------------------------------------------------------------------------
// (b) Negative cases

describe("authorization request", () => {
  it("never redirects for an unknown client or an unregistered redirect URI", async () => {
    const env = await start();
    const clientId = await registerClient(env.base, {
      redirect_uris: [CALLBACK, "https://app.example/cb"],
    });
    const cases: [string, URLSearchParams][] = [
      ["unknown client", authorizeParams("pptc_AAAAAAAAAAAAAAAAAAAAAA")],
      ["malformed client", authorizeParams("not a client")],
      ["missing client", authorizeParams(clientId, { client_id: null })],
      ["missing redirect", authorizeParams(clientId, { redirect_uri: null })],
      ["other redirect", authorizeParams(clientId, { redirect_uri: "https://evil.example/cb" })],
      ["https prefix", authorizeParams(clientId, { redirect_uri: "https://app.example/cb/x" })],
      [
        "loopback path",
        authorizeParams(clientId, { redirect_uri: "http://127.0.0.1:43219/other" }),
      ],
      [
        "loopback host",
        authorizeParams(clientId, { redirect_uri: "http://localhost:43219/callback" }),
      ],
    ];
    for (const [name, params] of cases) {
      const r = await authorize(env.base, params);
      expect(r.status, name).toBe(400);
      expect(r.headers.get("location"), name).toBeNull();
      expect(r.headers.get("content-type"), name).toMatch(/^text\/html/);
    }
    const dup = new URLSearchParams(authorizeParams(clientId));
    dup.append("redirect_uri", "https://evil.example/cb");
    expect((await authorize(env.base, dup)).status).toBe(400);
    // A loopback redirect on another port is the same registration (RFC 8252 §7.3).
    const otherPort = await authorize(
      env.base,
      authorizeParams(clientId, { redirect_uri: "http://127.0.0.1:5555/callback" }),
    );
    expect(otherPort.status).toBe(302);
  });

  it("returns protocol errors to the client with state and iss", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const cases: [string, Record<string, string | null>, string][] = [
      ["no PKCE", { code_challenge: null, code_challenge_method: null }, "invalid_request"],
      ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
      ["no method", { code_challenge_method: null }, "invalid_request"],
      ["bad challenge", { code_challenge: "short" }, "invalid_request"],
      ["token flow", { response_type: "token" }, "unsupported_response_type"],
      ["other resource", { resource: "https://other.example/mcp" }, "invalid_target"],
      ["other path", { resource: `${env.base}/api` }, "invalid_target"],
      ["share:write only", { scope: "share:write" }, "invalid_scope"],
    ];
    for (const [name, over, error] of cases) {
      const r = await authorize(env.base, authorizeParams(clientId, over));
      expect(r.status, name).toBe(302);
      const loc = new URL(r.headers.get("location") as string);
      expect(loc.origin + loc.pathname, name).toBe(CALLBACK);
      expect(loc.searchParams.get("error"), name).toBe(error);
      expect(loc.searchParams.get("state"), name).toBe("st-123");
      expect(loc.searchParams.get("iss"), name).toBe(env.base);
    }
    // The canonical resource (trailing slash, upper-case host) is the same resource.
    const ok = await authorize(
      env.base,
      authorizeParams(clientId, {
        resource: `${env.base.toUpperCase().replace("HTTP", "http")}/mcp/`,
      }),
    );
    expect(new URL(ok.headers.get("location") as string).pathname).toMatch(/^\/connect\//);
  });

  it("scopes: unknown dropped, offline_access ignored, share:write never granted, owner can untick", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const r = await authorize(
      env.base,
      authorizeParams(clientId, { scope: "decks:read share:write offline_access admin" }),
    );
    const id = new URL(r.headers.get("location") as string).pathname.split("/")[2];
    const view = await (
      await h?.api("GET", `/api/v1/oauth/requests/${id}`, { cookie: env.cookie })
    )?.json();
    expect(view).toMatchObject({
      scopes: ["decks:read"],
      redirectHost: "127.0.0.1:43219",
      redirectKind: "loopback",
      client: { kind: "dcr", name: "Test client", idHost: null },
    });
    const cb = await approve(env, authorizeParams(clientId), {
      decision: "approve",
      scopes: ["decks:read", "share:write"],
    });
    const t = await exchange(env, clientId, cb.searchParams.get("code") as string);
    expect((await t.json()).scope).toBe("decks:read");
    // Unticking everything is refused.
    const again = await authorize(env.base, authorizeParams(clientId));
    const id2 = new URL(again.headers.get("location") as string).pathname.split("/")[2];
    const none = await h?.api("POST", `/api/v1/oauth/requests/${id2}`, {
      body: { decision: "approve", scopes: [] },
      cookie: env.cookie,
    });
    expect(none?.status).toBe(400);
  });
});

describe("consent", () => {
  it("needs the owner session and the CSRF check; deny sends access_denied; iss is never client-controlled", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const r = await authorize(env.base, authorizeParams(clientId, { iss: "https://evil.example" }));
    const id = new URL(r.headers.get("location") as string).pathname.split("/")[2];
    const path = `/api/v1/oauth/requests/${id}`;
    expect((await h?.api("GET", path))?.status).toBe(401);
    expect((await h?.api("POST", path, { body: { decision: "approve" } }))?.status).toBe(401);
    const noCsrf = await h?.api("POST", path, {
      body: { decision: "approve" },
      cookie: env.cookie,
      headers: { "X-PPTaken-CSRF": "" },
    });
    expect(noCsrf?.status).toBe(403);
    const crossSite = await h?.api("POST", path, {
      body: { decision: "approve" },
      cookie: env.cookie,
      headers: { Origin: "https://evil.example" },
    });
    expect(crossSite?.status).toBe(403);
    const denied = await h?.api("POST", path, { body: { decision: "deny" }, cookie: env.cookie });
    const url = new URL((await denied?.json()).redirectUrl);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("st-123");
    expect(url.searchParams.getAll("iss")).toEqual([env.base]);
    // Answered once: gone.
    expect((await h?.api("GET", path, { cookie: env.cookie }))?.status).toBe(404);
    // An approval's iss is the configured issuer too.
    const cb = await approve(env, authorizeParams(clientId, { iss: "https://evil.example" }));
    expect(cb.searchParams.getAll("iss")).toEqual([env.base]);
  });

  it("pending requests expire after 10 minutes", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const r = await authorize(env.base, authorizeParams(clientId));
    const id = new URL(r.headers.get("location") as string).pathname.split("/")[2];
    (h as Harness).clock.t += 10 * 60_000 + 1;
    expect(
      (await h?.api("GET", `/api/v1/oauth/requests/${id}`, { cookie: env.cookie }))?.status,
    ).toBe(404);
  });
});

describe("token endpoint", () => {
  it("PKCE: missing or wrong verifier is invalid_grant", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    for (const verifier of [null, "x".repeat(43), `${VERIFIER}x`]) {
      const code = await codeFor(env, clientId);
      const form: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK,
        client_id: clientId,
      };
      if (verifier !== null) form.code_verifier = verifier;
      const r = await token(env.base, form);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("invalid_grant");
    }
  });

  it("codes are single use (reuse revokes the grant), expire after 60 s and are bound to client, redirect URI and resource", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const other = await registerClient(env.base);

    const code = await codeFor(env, clientId);
    const first = await exchange(env, clientId, code);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const issued = await first.json();
    expect(issued).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect((await mcpPost(env.base, `Bearer ${issued.access_token}`)).status).toBe(200);
    const replay = await exchange(env, clientId, code);
    expect((await replay.json()).error).toBe("invalid_grant");
    expect((await mcpPost(env.base, `Bearer ${issued.access_token}`)).status).toBe(401);
    expect((await (await refresh(env.base, clientId, issued.refresh_token)).json()).error).toBe(
      "invalid_grant",
    );

    const late = await codeFor(env, clientId);
    (h as Harness).clock.t += 61_000;
    expect((await (await exchange(env, clientId, late)).json()).error).toBe("invalid_grant");

    const stolen = await codeFor(env, clientId);
    expect((await (await exchange(env, other, stolen)).json()).error).toBe("invalid_grant");
    const redirect = await codeFor(env, clientId);
    const wrongRedirect = await exchange(env, clientId, redirect, {
      redirect_uri: "http://127.0.0.1:43219/other",
    });
    expect((await wrongRedirect.json()).error).toBe("invalid_grant");
    const resource = await codeFor(env, clientId);
    const wrongResource = await exchange(env, clientId, resource, {
      resource: "https://other.example/mcp",
    });
    expect((await wrongResource.json()).error).toBe("invalid_target");

    expect((await (await token(env.base, { grant_type: "password" })).json()).error).toBe(
      "unsupported_grant_type",
    );
    const json = await fetch(`${env.base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await json.json()).error).toBe("invalid_request");
    const noClient = await token(env.base, { grant_type: "authorization_code", code: "x" });
    expect((await noClient.json()).error).toBe("invalid_request");
    const badClient = await token(env.base, {
      grant_type: "authorization_code",
      code: "x",
      client_id: "evil",
    });
    expect((await badClient.json()).error).toBe("invalid_client");
  });

  it("answers fast", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const code = await codeFor(env, clientId);
    const started = performance.now();
    expect((await exchange(env, clientId, code)).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refresh tokens rotate; the immediate predecessor works for 60 s; any other reuse revokes the grant", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const t1 = await tokensFor(env, clientId);
    const r2 = await (await refresh(env.base, clientId, t1.refresh_token)).json();
    expect(r2.refresh_token).not.toBe(t1.refresh_token);
    expect(r2.scope).toBe("decks:read decks:write quiz:draft");
    // Retry with the predecessor inside the grace window (a lost response): accepted, rotates again.
    (h as Harness).clock.t += 30_000;
    const r3 = await (await refresh(env.base, clientId, t1.refresh_token)).json();
    expect(r3.access_token).toMatch(/^ppto_/);
    // t1 is no longer the immediate predecessor (r2 was rotated too): reuse → grant revoked.
    const reuse = await refresh(env.base, clientId, t1.refresh_token);
    expect((await reuse.json()).error).toBe("invalid_grant");
    expect((await refresh(env.base, clientId, r3.refresh_token)).status).toBe(400);
    expect((await mcpPost(env.base, `Bearer ${r3.access_token}`)).status).toBe(401);

    // Outside the grace window, even the immediate predecessor is reuse.
    const u1 = await tokensFor(env, clientId);
    const u2 = await (await refresh(env.base, clientId, u1.refresh_token)).json();
    (h as Harness).clock.t += 61_000;
    expect((await (await refresh(env.base, clientId, u1.refresh_token)).json()).error).toBe(
      "invalid_grant",
    );
    expect((await (await refresh(env.base, clientId, u2.refresh_token)).json()).error).toBe(
      "invalid_grant",
    );
  });

  it("a refresh token presented by another client is refused", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const other = await registerClient(env.base);
    const t = await tokensFor(env, clientId);
    expect((await (await refresh(env.base, other, t.refresh_token)).json()).error).toBe(
      "invalid_grant",
    );
    const widen = await token(env.base, {
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: clientId,
      scope: "share:write",
    });
    expect((await widen.json()).error).toBe("invalid_scope");
    expect((await refresh(env.base, clientId, t.refresh_token)).status).toBe(200);
  });

  it("refresh tokens expire after 60 days without use (sliding)", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const used = await tokensFor(env, clientId);
    const idle = await tokensFor(env, clientId);
    const day = 86_400_000;
    (h as Harness).clock.t += 59 * day;
    const r = await (await refresh(env.base, clientId, used.refresh_token)).json();
    (h as Harness).clock.t += 2 * day; // 61 days since issue: the idle grant is gone
    expect((await refresh(env.base, clientId, idle.refresh_token)).status).toBe(400);
    (h as Harness).clock.t += 57 * day; // 59 days since the refresh: still alive (sliding)
    expect((await refresh(env.base, clientId, r.refresh_token)).status).toBe(200);
  });
});

describe("audience and revocation", () => {
  it("ppto_ tokens work only at /mcp, never on the panel API", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const t = await tokensFor(env, clientId);
    expect((await mcpPost(env.base, `Bearer ${t.access_token}`)).status).toBe(200);
    for (const path of ["/api/v1/tokens", "/api/v1/decks", "/api/v1/oauth/apps"]) {
      const r = await fetch(`${env.base}${path}`, {
        headers: { Authorization: `Bearer ${t.access_token}` },
      });
      expect(r.status, path).toBe(401);
    }
    // A refresh token is not an access token.
    expect((await mcpPost(env.base, `Bearer ${t.refresh_token}`)).status).toBe(401);
  });

  it("revoking from the panel kills the grant and all its tokens; /oauth/revoke always answers 200", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const t = await tokensFor(env, clientId);
    const apps = await (await h?.api("GET", "/api/v1/oauth/apps", { cookie: env.cookie }))?.json();
    const id = apps.apps[0].id;
    expect(
      (await h?.api("DELETE", `/api/v1/oauth/apps/${id}`, { cookie: env.cookie }))?.status,
    ).toBe(204);
    expect((await mcpPost(env.base, `Bearer ${t.access_token}`)).status).toBe(401);
    expect((await refresh(env.base, clientId, t.refresh_token)).status).toBe(400);
    expect(
      (await (await h?.api("GET", "/api/v1/oauth/apps", { cookie: env.cookie }))?.json()).apps,
    ).toEqual([]);
    expect(
      (await h?.api("DELETE", "/api/v1/oauth/apps/01NOPE", { cookie: env.cookie }))?.status,
    ).toBe(404);

    const revoke = (form: Record<string, string>) =>
      fetch(`${env.base}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      });
    expect((await revoke({ token: "nonsense" })).status).toBe(200);
    const t2 = await tokensFor(env, clientId);
    expect((await revoke({ token: t2.refresh_token, client_id: clientId })).status).toBe(200);
    expect((await mcpPost(env.base, `Bearer ${t2.access_token}`)).status).toBe(401);
  });

  it("changing the password can disconnect every application", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    const kept = await tokensFor(env, clientId);
    const wrong = await h?.api("POST", "/api/v1/auth/password", {
      body: { currentPassword: "nope nope nope", newPassword: "another long passphrase 42" },
      cookie: env.cookie,
    });
    expect(wrong?.status).toBe(401);
    const changed = await h?.api("POST", "/api/v1/auth/password", {
      body: { currentPassword: PASSWORD, newPassword: "another long passphrase 42" },
      cookie: env.cookie,
    });
    expect(changed?.status).toBe(200);
    expect((await changed?.json()).disconnectedApps).toBe(0);
    expect((await mcpPost(env.base, `Bearer ${kept.access_token}`)).status).toBe(200);
    const cookie = sessionCookie(changed as Response);
    expect((await h?.api("GET", "/api/v1/auth/me", { cookie: env.cookie }))?.status).toBe(401);
    const again = await h?.api("POST", "/api/v1/auth/password", {
      body: {
        currentPassword: "another long passphrase 42",
        newPassword: "third long passphrase 4242",
        disconnectApps: true,
      },
      cookie,
    });
    expect((await again?.json()).disconnectedApps).toBe(1);
    expect((await mcpPost(env.base, `Bearer ${kept.access_token}`)).status).toBe(401);
  });

  it("the clean-up job removes expired codes and tokens, dead grants and unused clients", async () => {
    const env = await start();
    const clientId = await registerClient(env.base);
    await tokensFor(env, clientId);
    await registerClient(env.base); // never used
    (h as Harness).clock.t += 61 * 86_400_000;
    const result = await h?.server.services.oauth.cleanup();
    expect(result?.rows).toBeGreaterThan(0);
    expect(result?.clients).toBe(1); // the never-used registration (older than 24 h, no grant)
    expect(result?.grants).toBe(0); // dead for 1 day only: kept 30 days
    (h as Harness).clock.t += 31 * 86_400_000;
    const later = await h?.server.services.oauth.cleanup();
    expect(later?.grants).toBe(1);
    expect(later?.clients).toBe(1);
  });
});

describe("registration limits", () => {
  it("validates metadata and never issues a secret", async () => {
    const env = await start();
    const ok = await register(env.base, { token_endpoint_auth_method: "client_secret_basic" });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    const body = await ok.json();
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_id_issued_at).toEqual(expect.any(Number));
    expect(body.redirect_uris).toEqual([CALLBACK]);
    const bad: [string, Record<string, unknown>][] = [
      ["custom scheme", { redirect_uris: ["myapp://cb"] }],
      ["fragment", { redirect_uris: ["https://app.example/cb#x"] }],
      ["userinfo", { redirect_uris: ["https://u:p@app.example/cb"] }],
      ["plain http", { redirect_uris: ["http://app.example/cb"] }],
      [
        "too many",
        { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) },
      ],
      ["too long", { redirect_uris: [`https://app.example/${"a".repeat(240)}`] }],
      ["none", { redirect_uris: [] }],
      ["implicit", { response_types: ["token"] }],
      ["client credentials", { grant_types: ["client_credentials"] }],
    ];
    for (const [name, over] of bad) {
      const r = await register(env.base, over);
      expect(r.status, name).toBe(400);
      expect(["invalid_redirect_uri", "invalid_client_metadata"], name).toContain(
        (await r.json()).error,
      );
    }
  });

  it("caps body size, rate per IP and unapproved clients", async () => {
    const env = await start({ env: { PPTAKEN_TRUST_PROXY: "true" } });
    const big = await register(env.base, { client_name: "x".repeat(5000) });
    expect(big.status).toBe(413);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await register(env.base, {}, { "X-Forwarded-For": "203.0.113.50" })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    // ~100 clients without a grant instance-wide (10 already registered above).
    let last = 0;
    for (let i = 0; i < 91; i++) {
      last = (await register(env.base, {}, { "X-Forwarded-For": `198.51.100.${i + 1}` })).status;
    }
    expect(last).toBe(503);
  });
});

describe("CIMD", () => {
  it("refuses a document whose client_id differs from its URL, and unusable documents", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["mismatch", { client_id: "https://client.example/other.json" }],
      ["confidential", { token_endpoint_auth_method: "private_key_jwt" }],
      ["custom scheme", { redirect_uris: ["myapp://cb"] }],
    ];
    for (const [name, over] of cases) {
      const env = await start({ cimd: cimdDocument(over) });
      const r = await authorize(env.base, authorizeParams(CIMD_URL));
      expect(r.status, name).toBe(400);
      expect(r.headers.get("location"), name).toBeNull();
      await stop?.();
      stop = undefined;
      await h?.cleanup();
      h = undefined;
    }
  });

  it("the real fetcher refuses SSRF targets without contacting them", async () => {
    const env = await start(); // default, SSRF-safe fetcher
    for (const target of [
      "https://127.0.0.1/client.json",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/client.json",
      "https://[::ffff:10.0.0.1]/client.json",
      "https://localhost/client.json",
      "https://10.1.2.3:8443/client.json",
    ]) {
      const r = await authorize(env.base, authorizeParams(target));
      expect(r.status, target).toBe(400);
      expect(r.headers.get("location"), target).toBeNull();
    }
  });

  it("the consent view shows the client_id host for CIMD and flags claude.ai only for its exact callback", async () => {
    const claude = "https://claude.ai/api/mcp/auth_callback";
    const env = await start({
      cimd: cimdDocument({
        redirect_uris: [claude, "https://claude.ai/api/mcp/auth_callback2"],
        client_name:
          "Claude\u202e evil name that is definitely much longer than sixty characters in total",
      }),
    });
    const view = async (redirect: string) => {
      const r = await authorize(env.base, authorizeParams(CIMD_URL, { redirect_uri: redirect }));
      const id = new URL(r.headers.get("location") as string).pathname.split("/")[2];
      return (await h?.api("GET", `/api/v1/oauth/requests/${id}`, { cookie: env.cookie }))?.json();
    };
    const exact = await view(claude);
    expect(exact).toMatchObject({
      redirectKind: "claude",
      redirectHost: "claude.ai",
      client: { kind: "cimd", idHost: "client.example" },
    });
    expect(exact.client.name).not.toContain("\u202e");
    expect([...exact.client.name].length).toBeLessThanOrEqual(60);
    expect((await view("https://claude.ai/api/mcp/auth_callback2")).redirectKind).toBe("web");
  });
});
