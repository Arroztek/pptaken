// SPDX-License-Identifier: AGPL-3.0-or-later
// Interactive mode (ADR-020) on the server: the instance switch, the content origin capability, which document
// each path serves (scripted only for the owner's approved session, static everywhere else), the approval API
// (owner session + CSRF, never tokens), exports and offline copies, the player page CSP, and the rule that every
// GET route of the app origin is side-effect free.
import type { Principal } from "@pptaken/core";
import { readArchive, writeArchive } from "@pptaken/export";
import type { Deck } from "@pptaken/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, contentOriginRelation, loadConfig } from "../src/config.js";
import { createToken, type Harness, makeHarness, ORIGIN, setupOwner } from "./helpers.js";

const agent: Principal = {
  actor: "agent",
  workspaceId: "default",
  scopes: new Set(["decks:read", "decks:write"]),
  tokenId: "tok",
};

const SCRIPT = "slide.onEnter(function(){ slide.root.dataset.entered = '1'; });";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function scripted(env: Record<string, string> = { PPTAKEN_SCRIPTS: "owner" }) {
  h = await makeHarness(env);
  const cookie = await setupOwner(h);
  const created = await h.server.services.core.createPresentation(agent, {
    title: "Qubits",
    libs: ["uplot@1"],
    slides: [
      { id: "intro", html: "<h1>Intro</h1>" },
      { id: "sim", html: "<canvas width='10' height='10'></canvas><p>static</p>", script: SCRIPT },
    ],
  });
  return { h, cookie, id: created.presentationId, digest: created.scripts.digest as string };
}

async function contentUrl(hh: Harness, cookie: string, id: string, query = "") {
  const res = await hh.api("GET", `/api/v1/decks/${id}/content-url${query}`, { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as { url: string; scripts: string; expect?: Record<string, unknown> };
}

async function documentOf(hh: Harness, url: string) {
  const res = await hh.server.app.request(url.replace(/^https?:\/\/[^/]+/, ORIGIN));
  return { res, html: await res.text(), csp: res.headers.get("content-security-policy") ?? "" };
}

describe("configuration", () => {
  it("keeps scripts off by default and validates PPTAKEN_SCRIPTS", () => {
    expect(loadConfig({}).scripts).toBe("off");
    expect(loadConfig({ PPTAKEN_SCRIPTS: "owner" }).scripts).toBe("owner");
    expect(loadConfig({ PPTAKEN_SCRIPTS: "OFF" }).scripts).toBe("off");
    expect(() => loadConfig({ PPTAKEN_SCRIPTS: "public" })).toThrow(ConfigError);
    expect(() => loadConfig({ PPTAKEN_SCRIPTS: "true" })).toThrow(ConfigError);
  });

  it("detects a separate-site content origin conservatively", () => {
    const rel = contentOriginRelation;
    expect(rel(null, null)).toBe("same-origin");
    expect(rel("https://slides.example.com", null)).toBe("same-origin");
    expect(rel("https://slides.example.com", "https://slides.example.com:8443")).toBe("same-site");
    expect(rel("https://slides.example.com", "https://content.example.com")).toBe("same-site");
    expect(rel("https://example.com", "https://content.example.com")).toBe("same-site");
    expect(rel("https://slides.example.com", "https://usercontent.example.net")).toBe(
      "separate-site",
    );
    expect(rel("http://localhost:8080", "http://127.0.0.1:8081")).toBe("separate-site");
    expect(rel("http://127.0.0.1:8080", "http://127.0.0.1:8081")).toBe("same-site");
    // Known conservative limits: browsers treat these as different sites, we do not.
    expect(rel("https://a.example.co.uk", "https://b.other.co.uk")).toBe("same-site");
    expect(rel("https://x.github.io", "https://y.github.io")).toBe("same-site");
    expect(loadConfig({}).contentOrigin).toBe("same-origin");
    expect(
      loadConfig({
        PPTAKEN_PUBLIC_URL: "https://slides.example.com",
        PPTAKEN_CONTENT_URL: "https://usercontent.example.net",
      }).contentOrigin,
    ).toBe("separate-site");
  });
});

describe("which document is served", () => {
  it("pending: the owner gets the static version until approval", async () => {
    const { h, cookie, id } = await scripted();
    const r = await contentUrl(h, cookie, id);
    expect(r.scripts).toBe("pending");
    expect(r.expect).toBeUndefined();
    const doc = await documentOf(h, r.url);
    expect(doc.res.status).toBe(200);
    expect(doc.html).not.toContain("pptaken.register");
    expect(doc.html).not.toContain("<canvas");
    expect(doc.html).toContain("<p>static</p>");
    expect(doc.csp).toMatch(/script-src 'nonce-/);
  });

  it("approved: the owner's session gets the scripted document with a hash-only CSP", async () => {
    const { h, cookie, id, digest } = await scripted();
    const ok = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      cookie,
      body: { digest },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).state).toBe("approved");
    const r = await contentUrl(h, cookie, id);
    expect(r.scripts).toBe("running");
    expect(r.expect).toEqual({ slides: ["intro", "sim"], width: 1920, height: 1080 });
    const doc = await documentOf(h, r.url);
    expect(doc.html).toContain('pptaken.register("sim"');
    expect(doc.html).toContain("<canvas");
    expect(doc.html).not.toMatch(/nonce/i);
    expect(doc.csp).not.toMatch(/nonce|strict-dynamic|unsafe-eval/);
    expect(doc.csp).toMatch(/script-src 'sha256-[^;]+; /);
    for (const d of [
      "script-src-attr 'none'",
      "worker-src 'none'",
      "webrtc 'block'",
      "frame-src 'none'",
    ]) {
      expect(doc.csp).toContain(d);
    }
    expect(doc.res.headers.get("x-dns-prefetch-control")).toBe("off");
    expect(doc.csp).toContain(`frame-ancestors ${ORIGIN}`);
    // ?safe=1 forces the static version.
    const safe = await contentUrl(h, cookie, id, "?safe=1");
    expect(safe.scripts).toBe("safe");
    expect((await documentOf(h, safe.url)).html).not.toContain("pptaken.register");
  });

  it("a revocation or an edit after signing turns the scripted URL into the static version at once", async () => {
    const { h, cookie, id, digest } = await scripted();
    await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, { cookie, body: { digest } });
    const r = await contentUrl(h, cookie, id);
    await h.api("POST", `/api/v1/decks/${id}/scripts/revoke`, { cookie });
    expect((await documentOf(h, r.url)).html).not.toContain("pptaken.register");
    // A forged digest in the token subject: refused (signature).
    const forged = r.url.replace(/ct=([^&]+)/, (_m, t: string) => `ct=${t.slice(0, -2)}xx`);
    expect((await documentOf(h, forged)).res.status).toBe(403);
  });

  it("off: never scripted, even with an approval stored earlier", async () => {
    const { h, cookie, id, digest } = await scripted({ PPTAKEN_SCRIPTS: "off" });
    const refused = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      cookie,
      body: { digest },
    });
    expect(refused.status).toBe(400);
    // Simulate an approval left from a time the switch was on.
    await h.server.services.storage.scriptApprovals.set({
      workspaceId: "default",
      deckId: id,
      digest,
      approvedAt: 1,
      approvedBy: { actor: "owner", tokenId: null },
    });
    const r = await contentUrl(h, cookie, id);
    expect(r.scripts).toBe("off");
    expect((await documentOf(h, r.url)).html).not.toContain("pptaken.register");
  });

  it("phones, the presenter previews, offline copies and exports are always static", async () => {
    const { h, cookie, id, digest } = await scripted();
    await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, { cookie, body: { digest } });
    const offline = await h.api("GET", `/api/v1/decks/${id}/offline`, { cookie });
    const bundle = (await offline.json()) as { html: string };
    expect(bundle.html).not.toContain("pptaken.register");
    expect(bundle.html).not.toContain("<canvas");
    for (const format of ["html", "pptaken"]) {
      const res = await h.api("GET", `/api/v1/decks/${id}/export?format=${format}`, { cookie });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-pptaken-scripts")).toBe("omitted");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (format === "html") {
        const text = Buffer.from(bytes).toString("utf8");
        expect(text).not.toContain("pptaken.register");
        expect(text).not.toContain("slide.root.dataset.entered");
      } else {
        const archive = readArchive(bytes) as { deck: Deck; manifest: { requires?: string[] } };
        expect(archive.deck.libs).toBeUndefined();
        expect(archive.deck.slides.some((s) => s.script !== undefined)).toBe(false);
        expect(archive.manifest.requires).toBeUndefined();
      }
    }
    // A phone (device credential) only ever gets "doc" tokens: the static document.
    const remoteToken = (await contentUrl(h, cookie, id, "?safe=1")).url;
    expect((await documentOf(h, remoteToken)).html).not.toContain("pptaken.register");
  });

  it("an archive with scripts declares and checks requires: [scripts]", async () => {
    const { h, id } = await scripted();
    const exported = await h.server.services.core.exportPresentation(
      { actor: "owner", workspaceId: "default", scopes: new Set(["decks:read", "decks:write"]) },
      { presentationId: id },
    );
    const written = writeArchive({ deck: exported.deck, assets: [], generator: "test" });
    expect(written.manifest.requires).toEqual(["scripts"]);
    expect((readArchive(written.bytes).deck as Deck).slides[1]?.script).toBe(SCRIPT);
  });
});

describe("approval API", () => {
  it("needs the owner session and the CSRF header; tokens never work", async () => {
    const { h, cookie, id, digest } = await scripted();
    const anonymous = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      body: { digest },
    });
    expect(anonymous.status).toBe(401);
    const noCsrf = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      cookie,
      body: { digest },
      headers: { "X-PPTaken-CSRF": "" },
    });
    expect(noCsrf.status).toBe(403);
    const crossSite = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      cookie,
      body: { digest },
      headers: { Origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    const { secret } = await createToken(h, cookie);
    const bearer = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      body: { digest },
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(bearer.status).toBe(401);
    const status = await h.api("GET", `/api/v1/decks/${id}/scripts`, { cookie });
    expect(await status.json()).toMatchObject({
      state: "pending",
      digest,
      enabled: true,
      slides: ["sim"],
      libs: [expect.objectContaining({ name: "uPlot" })],
      capability: { contentOrigin: "same-origin", separateSiteContent: false, freezeWarning: true },
    });
    const wrong = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      cookie,
      body: { digest: "0".repeat(64) },
    });
    expect(wrong.status).toBe(409);
  });
});

describe("player page CSP", () => {
  it("frames exactly the content origin, never 'self' with a separate content origin", async () => {
    h = await makeHarness({
      PPTAKEN_PUBLIC_URL: ORIGIN,
      PPTAKEN_CONTENT_URL: "http://127.0.0.1:9999",
    });
    const cookie = await setupOwner(h);
    const created = await h.server.services.core.createPresentation(agent, {
      title: "T",
      slides: [{ html: "<p>x</p>" }],
    });
    for (const path of [`/p/${created.presentationId}`, `/p/${created.presentationId}/presenter`]) {
      const res = await h.api("GET", path, { cookie });
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(/frame-src ([^;]+)/.exec(csp)?.[1], path).toBe("http://127.0.0.1:9999");
    }
  });

  it("frames 'self' only when content shares the app origin", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const created = await h.server.services.core.createPresentation(agent, {
      title: "T",
      slides: [{ html: "<p>x</p>" }],
    });
    const res = await h.api("GET", `/p/${created.presentationId}`, { cookie });
    expect(/frame-src ([^;]+)/.exec(res.headers.get("content-security-policy") ?? "")?.[1]).toBe(
      "'self'",
    );
  });
});

/**
 * Every GET (and catch-all) route of the server, reviewed: none changes state in a way a navigation could abuse.
 * Without PPTAKEN_CONTENT_URL a scripted frame can navigate itself to app-origin URLs, and WebKit sends the
 * SameSite=Lax session cookie along (spike S5 §1), so a GET must never act. Adding a GET route makes this test fail
 * until it is reviewed and listed here. `ALL` entries are middleware or 404 catch-alls.
 */
const REVIEWED_GET_ROUTES: Record<string, string> = {
  "ALL /*": "middleware: request id, security headers, Host check",
  "ALL /api/*": "middleware (body limit) and the 404 catch-all",
  "ALL /api/v1/*": "middleware: rate limit, CSRF on unsafe methods, JSON only; 404 catch-all",
  "ALL /api/v1/live": "middleware of the live routes (CSRF on unsafe methods)",
  "ALL /api/v1/live/*": "middleware of the live routes (CSRF on unsafe methods)",
  "ALL /api/v1/remote/*": "middleware of the phone routes",
  "ALL /mcp": "MCP: bearer token only (never cookies); stateless, GET does not run tools",
  "ALL /oauth/*": "404 catch-all of the OAuth routes",
  "ALL /c/*": "404 catch-all of the content routes",
  "GET /*": "static web app files",
  "GET /healthz": "status only",
  "GET /readyz": "status only",
  "GET /.well-known/oauth-protected-resource": "metadata",
  "GET /.well-known/oauth-protected-resource/mcp": "metadata",
  "GET /.well-known/oauth-authorization-server": "metadata",
  "GET /oauth/authorize":
    "records a pending authorization request (rate limited); nothing is granted without the owner's POST consent",
  "GET /api/v1/setup/status": "read",
  "GET /api/v1/auth/me": "read (a sliding session may be extended)",
  "GET /api/v1/oauth/requests/:id": "read",
  "GET /api/v1/oauth/apps": "read",
  "GET /api/v1/tokens": "read",
  "GET /api/v1/connect/status": "read",
  "GET /api/v1/decks": "read",
  "GET /api/v1/decks/:id": "read",
  "GET /api/v1/decks/:id/content-url":
    "signs a short-lived content URL; no state (guests: view grant + optional unlock token headers, ADR-021)",
  "GET /api/v1/presenter/password": "read (whether a presenter password is set; never the hash)",
  "GET /api/v1/decks/:id/scripts": "read",
  "GET /api/v1/decks/:id/script-errors": "read (ADR-023)",
  "ALL /api/v1/decks/:id/script-errors": "middleware: small body limit of the script error reports",
  "GET /api/v1/decks/:id/export": "file download (audited read)",
  "GET /api/v1/decks/:id/presenter": "read",
  "GET /api/v1/decks/:id/offline": "read",
  "GET /api/v1/live": "read",
  "GET /api/v1/live/lan": "read",
  "GET /api/v1/live/:id/devices": "read",
  "GET /api/v1/remote/deck": "read (device credential header)",
  "GET /p/:deckId/presenter": "page",
  "GET /p/:deckId": "page",
  "GET /p/sw.js": "file",
  "GET /r": "page",
  "GET /_rt/:file": "file",
  "GET /_player/fonts/:family/:file": "file",
  "GET /_player/:file": "file",
  "GET /c/fonts/:family/:file": "file",
  "GET /c/asset/:token/:sha256": "file (signed token)",
  "GET /c/:deckId/:revision": "document (signed token)",
};

describe("GET routes of the app origin", () => {
  it("are all reviewed as side-effect free (no state change on navigation)", async () => {
    h = await makeHarness({ PPTAKEN_PUBLIC_URL: ORIGIN, PPTAKEN_SCRIPTS: "owner" });
    const found = new Set<string>();
    for (const route of h.server.app.routes) {
      if (route.method === "GET" || route.method === "ALL")
        found.add(`${route.method} ${route.path}`);
    }
    expect([...found].sort()).toEqual(Object.keys(REVIEWED_GET_ROUTES).sort());
  });

  it("state changes need POST with the CSRF header (the scripts approval included)", async () => {
    const { h, cookie, id, digest } = await scripted();
    const viaGet = await h.api("GET", `/api/v1/decks/${id}/scripts/approve?digest=${digest}`, {
      cookie,
    });
    expect(viaGet.status).toBe(404);
    expect(
      (await h.server.services.core.getScriptsStatus(agent, { presentationId: id })).state,
    ).toBe("pending");
  });
});
