// SPDX-License-Identifier: AGPL-3.0-or-later
// Cover mode (the panel's grid view): the signed cover URLs of a page of decks (owner session only) and the cover
// document of a revision's first slide. Static, no script of any kind, a sandbox that grants nothing, framable only
// by the app origin, and a token of its own that opens nothing else.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Principal } from "@pptaken/core";
import { afterEach, describe, expect, it } from "vitest";
import { appCsp } from "../src/http.js";
import { createToken, type Harness, makeHarness, ORIGIN, setupOwner } from "./helpers.js";

const agent: Principal = {
  actor: "agent",
  workspaceId: "default",
  scopes: new Set(["decks:read", "decks:write"]),
  tokenId: "tok",
};

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

interface Cover {
  id: string;
  revision: number;
  url: string;
  width: number;
  height: number;
  expiresAt: string;
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const h = await makeHarness(env);
  harnesses.push(h);
  return h;
}

async function setup(env: Record<string, string> = { PPTAKEN_SCRIPTS: "owner" }) {
  const h = await harness(env);
  const cookie = await setupOwner(h);
  const core = h.server.services.core;
  const plain = await core.createPresentation(agent, {
    title: "Plain",
    slides: [
      { id: "one", html: "<h1>FIRST-SLIDE</h1><p data-step>step</p>", css: "h1{color:#c00}" },
      { id: "two", html: "<h1>SECOND-SLIDE</h1>", notes: "SECRET-NOTE" },
    ],
  });
  const withScript = await core.createPresentation(agent, {
    title: "Scripted",
    libs: ["uplot@1"],
    slides: [
      {
        id: "sim",
        html: "<canvas width='10' height='10'></canvas><p>static-copy</p>",
        script: "slide.onEnter(function(){});",
      },
      { id: "after", html: "<p>AFTER</p>" },
    ],
  });
  return { h, cookie, plain: plain.presentationId, scripted: withScript.presentationId };
}

async function covers(h: Harness, cookie: string, ids: string[]) {
  const res = await h.api("GET", `/api/v1/decks/covers?ids=${ids.join(",")}`, { cookie });
  return { res, covers: res.status === 200 ? ((await res.json()).covers as Cover[]) : [] };
}

const fetchCover = (h: Harness, url: string) =>
  h.server.app.request(url.replace(/^https?:\/\/[^/]+/, ORIGIN));

const tokenOf = (url: string) => new URL(url).searchParams.get("ct") ?? "";

describe("GET /api/v1/decks/covers", () => {
  it("signs one cover URL per deck, with the canvas size and an expiry", async () => {
    const { h, cookie, plain, scripted } = await setup();
    const { res, covers: list } = await covers(h, cookie, [plain, scripted, plain]);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(list.map((c) => c.id)).toEqual([plain, scripted]);
    for (const c of list) {
      expect(c).toMatchObject({ revision: 1, width: 1920, height: 1080 });
      expect(c.url).toMatch(new RegExp(`^${ORIGIN}/c/${c.id}/1/cover\\?ct=[A-Za-z0-9_.-]+$`));
      expect(Date.parse(c.expiresAt)).toBe(h.clock.now() + 30 * 60 * 1000);
    }
  });

  it("reports the canvas of a 4:3 deck", async () => {
    const { h, cookie } = await setup();
    const four = await h.server.services.core.createPresentation(agent, {
      title: "Four three",
      aspectRatio: "4:3",
      slides: [{ html: "<p>x</p>" }],
    });
    const { covers: list } = await covers(h, cookie, [four.presentationId]);
    expect(list[0]).toMatchObject({ width: 1440, height: 1080 });
  });

  it("is owner-only: no session and an API token are both refused", async () => {
    const { h, cookie, plain } = await setup();
    const path = `/api/v1/decks/covers?ids=${plain}`;
    expect((await h.api("GET", path)).status).toBe(401);
    const { secret } = await createToken(h, cookie);
    const withToken = await h.api("GET", path, { headers: { Authorization: `Bearer ${secret}` } });
    expect(withToken.status).toBe(401);
    const grant = await h.api("GET", path, { headers: { "X-PPTaken-View": "x.y" } });
    expect(grant.status).toBe(401);
  });

  it("validates the ids and leaves out decks that are gone", async () => {
    const { h, cookie, plain } = await setup();
    expect((await h.api("GET", "/api/v1/decks/covers", { cookie })).status).toBe(400);
    expect((await h.api("GET", "/api/v1/decks/covers?ids=nope", { cookie })).status).toBe(400);
    const many = Array.from(
      { length: 25 },
      (_, i) => `01HZZZZZZZZZZZZZZZZZZZZZ${String(i).padStart(2, "0")}`,
    );
    const tooMany = await h.api("GET", `/api/v1/decks/covers?ids=${many.join(",")}`, { cookie });
    expect(tooMany.status).toBe(400);
    const unknown = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
    expect((await covers(h, cookie, [unknown, plain])).covers.map((c) => c.id)).toEqual([plain]);
    expect((await h.api("DELETE", `/api/v1/decks/${plain}`, { cookie })).status).toBe(200);
    expect((await covers(h, cookie, [plain])).covers).toEqual([]);
  });

  it("points at the current revision after an edit", async () => {
    const { h, cookie, plain } = await setup();
    await h.server.services.core.updateSlides(agent, {
      presentationId: plain,
      expectedRevision: 1,
      upsert: [{ id: "one", html: "<h1>EDITED-COVER</h1>" }],
    });
    const { covers: list } = await covers(h, cookie, [plain]);
    expect(list[0]?.revision).toBe(2);
    const doc = await (await fetchCover(h, list[0]?.url ?? "")).text();
    expect(doc).toContain("EDITED-COVER");
  });
});

describe("the cover document", () => {
  it("is the first slide only, visible, static and without any script", async () => {
    const { h, cookie, plain } = await setup();
    const { covers: list } = await covers(h, cookie, [plain]);
    const res = await fetchCover(h, list[0]?.url ?? "");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("FIRST-SLIDE");
    expect(html).not.toContain("SECOND-SLIDE");
    expect(html).not.toContain("SECRET-NOTE");
    expect(html.match(/<section /g)).toHaveLength(1);
    expect(html).not.toMatch(/<section [^>]*\bhidden\b/);
    expect(html).not.toMatch(/<script|nonce|pptaken\.register|onload=|javascript:/i);
    expect(html).toContain("color:#c00");
    // Every step is shown (the runtime would reveal them one by one).
    expect(html).toContain("[data-step]{visibility:visible!important}");
  });

  it("carries a CSP whose sandbox grants nothing, and frames only by the app origin", async () => {
    const { h, cookie, plain } = await setup();
    const { covers: list } = await covers(h, cookie, [plain]);
    const res = await fetchCover(h, list[0]?.url ?? "");
    const csp = res.headers.get("content-security-policy") ?? "";
    const directives = csp.split("; ");
    expect(directives[0]).toBe("sandbox");
    expect(csp).not.toMatch(/allow-/);
    expect(directives).toContain("script-src 'none'");
    expect(csp).not.toMatch(/nonce|sha256-|unsafe-eval|strict-dynamic/);
    for (const d of [
      "default-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      `frame-ancestors ${ORIGIN}`,
    ]) {
      expect(directives, d).toContain(d);
    }
    expect(directives.find((d) => d.startsWith("img-src"))).toMatch(
      new RegExp(`^img-src ${ORIGIN}/c/asset/[^/]+/$`),
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-dns-prefetch-control")).toBe("off");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("is always the simple version of a scripted deck, with no approval needed", async () => {
    const { h, cookie, scripted } = await setup();
    const { covers: list } = await covers(h, cookie, [scripted]);
    const html = await (await fetchCover(h, list[0]?.url ?? "")).text();
    expect(html).toContain("static-copy");
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("AFTER");
    expect(html).not.toMatch(/<script|pptaken\.register/);

    // With the instance switch off the cover is the same static document.
    const off = await harness({ PPTAKEN_SCRIPTS: "off" });
    const cookieOff = await setupOwner(off);
    const created = await off.server.services.core.createPresentation(agent, {
      title: "S",
      slides: [{ html: "<p>simple</p>", script: "slide.onEnter(function(){});" }],
    });
    const listOff = await covers(off, cookieOff, [created.presentationId]);
    const doc = await (await fetchCover(off, listOff.covers[0]?.url ?? "")).text();
    expect(doc).toContain("simple");
    expect(doc).not.toMatch(/<script|pptaken\.register/);
  });

  it("is a single slide even for a deck of many", async () => {
    const { h, cookie } = await setup();
    const big = await h.server.services.core.createPresentation(agent, {
      title: "Big",
      slides: Array.from({ length: 30 }, (_, i) => ({ html: `<p>slide-${i}</p>` })),
    });
    const { covers: list } = await covers(h, cookie, [big.presentationId]);
    const html = await (await fetchCover(h, list[0]?.url ?? "")).text();
    expect(html).toContain("slide-0<");
    expect(html).not.toContain("slide-1<");
    expect(html.match(/<section /g)).toHaveLength(1);
  });
});

describe("cover tokens", () => {
  it("are required, bound to one deck and revision, and expire", async () => {
    const { h, cookie, plain, scripted } = await setup();
    const { covers: list } = await covers(h, cookie, [plain, scripted]);
    const [a, b] = list as [Cover, Cover];
    const base = `${ORIGIN}/c/${a.id}/1/cover`;
    for (const url of [base, `${base}?ct=`, `${base}?ct=garbage`, `${base}?ct=a.b`]) {
      const res = await fetchCover(h, url);
      expect(res.status, url).toBe(403);
      expect(await res.text()).toBe("");
    }
    // The other deck's token, and a token used for another revision.
    expect((await fetchCover(h, `${base}?ct=${tokenOf(b.url)}`)).status).toBe(403);
    expect((await fetchCover(h, `${ORIGIN}/c/${a.id}/2/cover?ct=${tokenOf(a.url)}`)).status).toBe(
      403,
    );
    expect((await fetchCover(h, `${base}?ct=${tokenOf(a.url)}`)).status).toBe(200);
    // Expired.
    h.clock.t += 30 * 60 * 1000 + 1;
    expect((await fetchCover(h, a.url)).status).toBe(403);
  });

  it("do not open the full document, and a document token does not open a cover", async () => {
    const { h, cookie, plain } = await setup();
    const { covers: list } = await covers(h, cookie, [plain]);
    const cover = list[0] as Cover;
    expect((await fetchCover(h, `${ORIGIN}/c/${plain}/1?ct=${tokenOf(cover.url)}`)).status).toBe(
      403,
    );
    const res = await h.api("GET", `/api/v1/decks/${plain}/content-url`, { cookie });
    const docToken = tokenOf((await res.json()).url as string);
    const asCover = await fetchCover(h, `${ORIGIN}/c/${plain}/1/cover?ct=${docToken}`);
    expect(asCover.status).toBe(403);
    // The cover document itself holds no document token.
    expect(await (await fetchCover(h, cover.url)).text()).not.toMatch(/\?ct=/);
  });

  it("failures are empty, inert documents (never text a thumbnail would show)", async () => {
    const { h, plain } = await setup();
    const res = await fetchCover(h, `${ORIGIN}/c/${plain}/1/cover`);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(
      `default-src 'none'; sandbox; frame-ancestors ${ORIGIN}`,
    );
    const bad = await fetchCover(h, `${ORIGIN}/c/not-a-ulid/1/cover?ct=x`);
    expect(bad.status).toBe(404);
    expect(await bad.text()).toBe("");
  });
});

describe("a separate content origin", () => {
  it("serves covers on the content origin, framable by the public origin only", async () => {
    const content = "http://127.0.0.1:9999";
    const { h, cookie, plain } = await setup({
      PPTAKEN_PUBLIC_URL: ORIGIN,
      PPTAKEN_CONTENT_URL: content,
      PPTAKEN_SCRIPTS: "owner",
    });
    const { covers: list } = await covers(h, cookie, [plain]);
    const url = list[0]?.url ?? "";
    expect(url.startsWith(`${content}/c/${plain}/1/cover?ct=`)).toBe(true);
    const res = await h.server.app.request(url);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`frame-ancestors ${ORIGIN}`);
    expect(csp).not.toMatch(/frame-ancestors [^;]*127\.0\.0\.1/);
    // The app host never serves content.
    const onApp = await h.server.app.request(
      `${ORIGIN}${new URL(url).pathname}${new URL(url).search}`,
    );
    expect(onApp.status).toBe(404);
  });
});

describe("the panel's own CSP", () => {
  it("allows frames from its own origin and the content origin, nothing else", () => {
    expect(/frame-src ([^;]+)/.exec(appCsp([]))?.[1]).toBe("'self'");
    const csp = appCsp(["http://127.0.0.1:9999"]);
    expect(/frame-src ([^;]+)/.exec(csp)?.[1]).toBe("'self' http://127.0.0.1:9999");
    // Framing covers loosens nothing else: scripts stay 'self', the panel is never framable.
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it("is what the served panel sends, with the content origin when it is separate", async () => {
    const cases: [Record<string, string>, string][] = [
      [{}, "'self'"],
      [
        { PPTAKEN_PUBLIC_URL: ORIGIN, PPTAKEN_CONTENT_URL: "http://127.0.0.1:9999" },
        "'self' http://127.0.0.1:9999",
      ],
    ];
    for (const [env, expected] of cases) {
      const probe = await harness();
      const web = join(probe.dataDir, "web");
      mkdirSync(web, { recursive: true });
      writeFileSync(join(web, "index.html"), "<!doctype html><title>x</title>");
      const h = await harness({ ...env, PPTAKEN_WEB_DIR: web });
      const res = await h.api("GET", "/decks");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(/frame-src ([^;]+)/.exec(csp)?.[1]).toBe(expected);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
  });
});
