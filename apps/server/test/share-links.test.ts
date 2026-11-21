// SPDX-License-Identifier: AGPL-3.0-or-later
// ADR-026 on the server: public links. Management is owner-session + CSRF only (never an API/OAuth token); every
// dead link answers one generic page (byte for byte); view links never run scripts, never reveal notes and never
// offer the unlock; presenter links reveal notes and unlock approved code with the presenter password; turning a
// link off (or the trash, an expiry, the switches) stops grants, documents and assets at once; secrets never reach
// logs or the audit log; rate limits hold.
import type { Principal } from "@pptaken/core";
import { pngBytes } from "@pptaken/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createToken, type Harness, makeHarness, ORIGIN, setupOwner } from "./helpers.js";

const agent: Principal = {
  actor: "agent",
  workspaceId: "default",
  scopes: new Set(["decks:read", "decks:write"]),
  tokenId: "tok",
};
const PRESENTER = "lantern quietly folds 9 maps";
const SCRIPT = "slide.onEnter(function(){ slide.root.dataset.entered = '1'; });";
const NOTES = "Remember to thank the volunteers";
const DAY = 24 * 60 * 60 * 1000;

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function setup(env: Record<string, string> = { PPTAKEN_SCRIPTS: "owner" }) {
  h = await makeHarness(env, { socketIp: (raw) => raw.headers.get("x-test-ip") ?? "10.0.0.1" });
  const cookie = await setupOwner(h);
  const created = await h.server.services.core.createPresentation(agent, {
    title: "Q3 review",
    slides: [
      { id: "intro", html: "<h1>Intro</h1>", notes: NOTES },
      { id: "sim", html: "<canvas width='10' height='10'></canvas><p>static</p>", script: SCRIPT },
    ],
  });
  return { h, cookie, id: created.presentationId, digest: created.scripts.digest as string };
}

async function createLink(
  hh: Harness,
  cookie: string,
  id: string,
  body: Record<string, unknown> = { kind: "view" },
) {
  const res = await hh.api("POST", `/api/v1/decks/${id}/links`, { cookie, body });
  expect(res.status).toBe(201);
  const { link } = await res.json();
  const secret = String(link.url).split("/s/")[1] as string;
  return { link, secret };
}

/** Opens a link page as a guest (no cookie) and returns the page, its grant and its deck id. */
async function openLink(hh: Harness, secret: string, suffix = "", ip = "10.0.0.1") {
  const res = await hh.server.app.request(`${ORIGIN}/s/${secret}${suffix}`, {
    headers: { "x-test-ip": ip, "Accept-Language": "en" },
  });
  const html = await res.text();
  const grant = /data-view="([^"]+)"/.exec(html)?.[1] ?? "";
  return { res, html, grant };
}

function guestApi(
  hh: Harness,
  method: string,
  path: string,
  grant: string,
  extra: Record<string, string> = {},
  body?: unknown,
) {
  return hh.api(method, path, {
    headers: { "X-PPTaken-View": grant, ...extra },
    ...(body === undefined ? {} : { body }),
  });
}

async function fetchContent(hh: Harness, url: string) {
  return hh.server.app.request(url.replace(/^https?:\/\/[^/]+/, ORIGIN));
}

describe("managing links (owner session only)", () => {
  it("creates, lists with the URL, renames, extends, freezes, turns off one and all", async () => {
    const { h, cookie, id } = await setup();
    const { link, secret } = await createLink(h, cookie, id, {
      kind: "presenter",
      label: "  Q3 review for Ana‮ ",
      expires: "7d",
    });
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(link).toMatchObject({
      kind: "presenter",
      label: "Q3 review for Ana",
      state: "active",
      pinnedRevision: null,
      openCount: 0,
      lastOpenedAt: null,
    });
    expect(Date.parse(link.expiresAt) - h.clock.now()).toBe(7 * DAY);
    const list = await (await h.api("GET", `/api/v1/decks/${id}/links`, { cookie })).json();
    expect(list.links).toHaveLength(1);
    expect(list.links[0].url).toBe(`${ORIGIN}/s/${secret}`);
    expect(list.sharing).toMatchObject({ enabled: true, presenterPassword: false });
    // No IPs, user agents or hashes in the list.
    expect(JSON.stringify(list)).not.toMatch(/10\.0\.0|secretHash|sealed|userAgent/i);
    const patched = await h.api("PATCH", `/api/v1/decks/${id}/links/${link.id}`, {
      cookie,
      body: { label: "For Luis", expires: null, pinned: true },
    });
    expect(await patched.json()).toMatchObject({
      link: { label: "For Luis", expiresAt: null, pinnedRevision: 1 },
    });
    await createLink(h, cookie, id);
    expect((await h.api("DELETE", `/api/v1/decks/${id}/links/${link.id}`, { cookie })).status).toBe(
      204,
    );
    expect((await (await openLink(h, secret)).res).status).toBe(404);
    const all = await h.api("DELETE", `/api/v1/decks/${id}/links`, { cookie });
    expect(await all.json()).toEqual({ revoked: 1 });
    expect(
      (await (await h.api("GET", `/api/v1/decks/${id}/links`, { cookie })).json()).links,
    ).toEqual([]);
  });

  it("refuses API tokens, missing CSRF, foreign origins and bad input", async () => {
    const { h, cookie, id } = await setup();
    const { secret: token } = await createToken(h, cookie);
    const bearer = { Authorization: `Bearer ${token}` };
    expect((await h.api("GET", `/api/v1/decks/${id}/links`, { headers: bearer })).status).toBe(401);
    expect(
      (
        await h.api("POST", `/api/v1/decks/${id}/links`, {
          headers: bearer,
          body: { kind: "view" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.api("POST", `/api/v1/decks/${id}/links`, {
          cookie,
          body: { kind: "view" },
          headers: { "X-PPTaken-CSRF": "" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.api("POST", `/api/v1/decks/${id}/links`, {
          cookie,
          body: { kind: "view" },
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    for (const body of [
      { kind: "edit" },
      { kind: "view", label: "x".repeat(81) },
      { kind: "view", expires: "2d" },
      { kind: "view", expires: "2020-01-01T00:00:00Z" },
      { kind: "view", extra: true },
    ]) {
      expect((await h.api("POST", `/api/v1/decks/${id}/links`, { cookie, body })).status).toBe(400);
    }
    // The agent use cases refuse too (no route reaches them with a token anyway).
    await expect(
      h.server.services.core.createShareLink(agent, { presentationId: id, kind: "view" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
  });

  it("audits by link id, never the secret or the label; logs never carry the secret", async () => {
    const { h, cookie, id } = await setup();
    const { link, secret } = await createLink(h, cookie, id, { kind: "view", label: "For Ana" });
    const page = await openLink(h, secret);
    await openLink(h, `${secret}x`);
    await guestApi(h, "POST", `/api/v1/share/${id}/opened`, page.grant);
    await h.api("DELETE", `/api/v1/decks/${id}/links/${link.id}`, { cookie });
    const audit = await h.server.services.core.listAuditLog(
      { actor: "owner", workspaceId: "default", scopes: new Set() },
      { limit: 100 },
    );
    const text = JSON.stringify(audit.items);
    expect(text).toContain(`share:${link.id}`);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("For Ana");
    const logs = h.logs.join("\n");
    expect(logs).not.toContain(secret);
    expect(logs).toContain("/s/<link>");
    expect(logs).not.toContain(page.grant);
  });
});

describe("the link page", () => {
  it("serves the guest player with the privacy headers, and no notes", async () => {
    const { h, cookie, id } = await setup();
    const { secret } = await createLink(h, cookie, id);
    const { res, html } = await openLink(h, secret);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(html).toContain('data-viewer="guest"');
    expect(html).toContain('data-kind="view"');
    expect(html).not.toContain("data-presenter=");
    expect(html).not.toContain(NOTES);
    // Nothing about the owner, the panel or other decks; no third-party URL.
    expect(html).not.toMatch(/\/decks|\/login|https?:\/\/(?!localhost)/);
  });

  it("answers ONE generic page for every dead link, byte for byte", async () => {
    const { h, cookie, id } = await setup();
    const other = await h.server.services.core.createPresentation(agent, {
      title: "Other",
      slides: [{ id: "a", html: "<p>a</p>" }],
    });
    const revoked = await createLink(h, cookie, id);
    await h.api("DELETE", `/api/v1/decks/${id}/links/${revoked.link.id}`, { cookie });
    const expiring = await createLink(h, cookie, id, { kind: "view", expires: "1d" });
    const trashed = await createLink(h, cookie, other.presentationId);
    await h.api("DELETE", `/api/v1/decks/${other.presentationId}`, { cookie });
    const view = await createLink(h, cookie, id);
    h.clock.t += DAY + 1;
    const samples = [
      "AAAAAAAAAAAAAAAAAAAAAA", // unknown, well formed
      "short",
      "%2e%2e%2fetc",
      revoked.secret,
      expiring.secret,
      trashed.secret,
      `${view.secret}/presenter`, // a view link has no presenter window
      `${view.secret}/anything`,
    ];
    const bodies = new Set<string>();
    const headerSets = new Set<string>();
    for (const [i, s] of samples.entries()) {
      const { res, html } = await openLink(h, s, "", `10.5.0.${i}`);
      expect(res.status, s).toBe(404);
      bodies.add(html);
      headerSets.add(
        JSON.stringify(
          [
            "content-type",
            "cache-control",
            "x-robots-tag",
            "referrer-policy",
            "content-security-policy",
          ].map((n) => res.headers.get(n)),
        ),
      );
    }
    expect(bodies.size).toBe(1);
    expect(headerSets.size).toBe(1);
    const [body] = [...bodies];
    expect(body).toContain(
      "This link is not available anymore. Ask the person who shared it for a new one.",
    );
    expect(body).not.toMatch(/script|expired|revoked|trash/i);
    // Spanish by browser language.
    const es = await h.server.app.request(`${ORIGIN}/s/nope`, {
      headers: { "Accept-Language": "es-PE,es;q=0.9", "x-test-ip": "10.6.0.1" },
    });
    expect(await es.text()).toContain("Este enlace ya no está disponible.");
    // The link that works still works.
    expect((await openLink(h, view.secret, "", "10.7.0.1")).res.status).toBe(200);
  });

  it("does the same lookup work for malformed and well-formed secrets (no timing oracle by shape)", async () => {
    const { h } = await setup();
    const repo = h.server.services.storage.shareLinks;
    const original = repo.findByHash.bind(repo);
    const hashes: string[] = [];
    repo.findByHash = async (ws, hash) => {
      hashes.push(hash);
      return original(ws, hash);
    };
    for (const s of ["x", "AAAAAAAAAAAAAAAAAAAAAB", "../../etc/passwd", "a".repeat(300)]) {
      await openLink(h, encodeURIComponent(s));
    }
    expect(hashes).toHaveLength(4);
    expect(hashes.every((x) => /^[0-9a-f]{64}$/.test(x))).toBe(true);
  });

  it("rate limits failed lookups per IP and instance-wide, with a calm page", async () => {
    const { h } = await setup();
    for (let i = 0; i < 20; i++) {
      expect((await openLink(h, `nope${i}`, "", "10.8.0.1")).res.status).toBe(404);
    }
    const limited = await openLink(h, "nope", "", "10.8.0.1");
    expect(limited.res.status).toBe(429);
    expect(limited.html).toContain("Too many tries");
    expect(Number(limited.res.headers.get("retry-after"))).toBeGreaterThan(0);
    // Other IPs still work, until the global cap.
    expect((await openLink(h, "nope", "", "10.8.0.2")).res.status).toBe(404);
    for (let i = 0; i < 300; i++) await openLink(h, `n${i}`, "", `10.9.${i >> 8}.${i & 255}`);
    expect((await openLink(h, "nope", "", "10.10.0.1")).res.status).toBe(429);
  });

  it("is turned off by PPTAKEN_PUBLIC_LINKS=off and by the owner's setting", async () => {
    const { h, cookie, id } = await setup();
    const { secret } = await createLink(h, cookie, id);
    const page = await openLink(h, secret);
    const put = await h.api("PUT", "/api/v1/settings", { cookie, body: { publicLinks: false } });
    expect(await put.json()).toMatchObject({ publicLinks: false, publicLinksInstance: "on" });
    expect((await openLink(h, secret)).res.status).toBe(404);
    expect((await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, page.grant)).status).toBe(
      401,
    );
    const refused = await h.api("POST", `/api/v1/decks/${id}/links`, {
      cookie,
      body: { kind: "view" },
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.hint).toMatch(/Settings/);
    await h.api("PUT", "/api/v1/settings", { cookie, body: { publicLinks: true } });
    expect((await openLink(h, secret)).res.status).toBe(200);
    await h.cleanup();
    const off = await setup({ PPTAKEN_PUBLIC_LINKS: "off" });
    const r = await off.h.api("POST", `/api/v1/decks/${off.id}/links`, {
      cookie: off.cookie,
      body: { kind: "view" },
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error.hint).toMatch(/PPTAKEN_PUBLIC_LINKS/);
    expect((await openLink(off.h, "AAAAAAAAAAAAAAAAAAAAAA")).res.status).toBe(404);
  });
});

describe("view links", () => {
  it("static only: no scripts, no notes, no unlock, no presenter data, no export", async () => {
    const { h, cookie, id, digest } = await setup();
    await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, { cookie, body: { digest } });
    await h.api("POST", "/api/v1/presenter/password", { cookie, body: { password: PRESENTER } });
    const { secret } = await createLink(h, cookie, id);
    const { grant } = await openLink(h, secret);
    const content = await (
      await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, grant)
    ).json();
    expect(content.scripts).toBe("none");
    expect(content.expect).toBeUndefined();
    const doc = await (await fetchContent(h, content.url)).text();
    expect(doc).not.toContain("pptaken.register");
    expect(doc).not.toContain(NOTES);
    expect(doc).toContain("Intro");
    // Even asking for the unlocked version with a valid-looking token gets the static one.
    const unlock = await h.api("POST", "/api/v1/presenter/unlock", {
      body: { deckId: id, password: PRESENTER },
      headers: { "X-PPTaken-View": grant },
    });
    expect(unlock.status).toBe(401);
    expect((await guestApi(h, "GET", `/api/v1/share/${id}/presenter`, grant)).status).toBe(404);
    // No panel API, no export, no presenter page, no offline document with a grant.
    for (const path of [
      `/api/v1/decks/${id}`,
      `/api/v1/decks/${id}/presenter`,
      `/api/v1/decks/${id}/offline`,
      `/api/v1/decks/${id}/export?format=html`,
      `/api/v1/decks/${id}/links`,
      "/api/v1/decks",
    ]) {
      expect((await guestApi(h, "GET", path, grant)).status, path).toBe(401);
    }
    expect((await openLink(h, secret, "/presenter")).res.status).toBe(404);
    // The owner opening their own view link in a signed-in browser sees what viewers see.
    const asOwner = await (
      await h.api("GET", `/api/v1/decks/${id}/content-url`, {
        cookie,
        headers: { "X-PPTaken-View": grant },
      })
    ).json();
    expect(asOwner.scripts).toBe("none");
    expect(asOwner.digest).toBeUndefined();
  });

  it("is bound to its deck, follows the latest revision or the frozen one", async () => {
    const { h, cookie, id } = await setup();
    const other = await h.server.services.core.createPresentation(agent, {
      title: "Other",
      slides: [{ id: "a", html: "<p>a</p>" }],
    });
    const follow = await openLink(h, (await createLink(h, cookie, id)).secret);
    const frozen = await openLink(
      h,
      (await createLink(h, cookie, id, { kind: "view", pinRevision: true })).secret,
    );
    expect(
      (await guestApi(h, "GET", `/api/v1/decks/${other.presentationId}/content-url`, follow.grant))
        .status,
    ).toBe(401);
    await h.server.services.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "intro", html: "<h1>Intro v2</h1>" }],
    });
    const latest = await (
      await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, follow.grant)
    ).json();
    expect(latest.url).toContain(`/c/${id}/2?`);
    expect(await (await fetchContent(h, latest.url)).text()).toContain("Intro v2");
    const pinned = await (
      await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, frozen.grant)
    ).json();
    expect(pinned.url).toContain(`/c/${id}/1?`);
    // A frozen link's document token cannot be pointed at another revision.
    const forged = pinned.url.replace(`/c/${id}/1?`, `/c/${id}/2?`);
    expect((await fetchContent(h, forged)).status).toBe(403);
  });

  it("turning it off stops grants, documents and assets at once", async () => {
    const { h, cookie, id } = await setup();
    const asset = await h.server.services.core.addAsset(agent, {
      presentationId: id,
      bytes: pngBytes(),
      mediaType: "image/png",
    });
    await h.server.services.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "intro", html: `<h1>Intro</h1><img src="${asset.ref}" alt="">` }],
    });
    const { link, secret } = await createLink(h, cookie, id);
    const { grant } = await openLink(h, secret);
    const content = await (
      await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, grant)
    ).json();
    const doc = await (await fetchContent(h, content.url)).text();
    const assetUrl = new RegExp(`https?://[^"')]+/c/asset/[^"')]+/${asset.sha256}`).exec(doc)?.[0];
    expect(assetUrl).toBeDefined();
    expect((await fetchContent(h, assetUrl as string)).status).toBe(200);
    await h.api("DELETE", `/api/v1/decks/${id}/links/${link.id}`, { cookie });
    expect((await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, grant)).status).toBe(401);
    expect((await fetchContent(h, content.url)).status).toBe(403);
    expect((await fetchContent(h, assetUrl as string)).status).toBe(403);
    // An expired link stops the same way.
    const expiring = await createLink(h, cookie, id, { kind: "view", expires: "1d" });
    const g2 = (await openLink(h, expiring.secret)).grant;
    expect((await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, g2)).status).toBe(200);
    h.clock.t += DAY + 1;
    expect((await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, g2)).status).toBe(401);
  });

  it("counts openings on the page's POST, never on GET", async () => {
    const { h, cookie, id } = await setup();
    const { secret } = await createLink(h, cookie, id);
    const { grant } = await openLink(h, secret);
    await openLink(h, secret);
    let [listed] = (await (await h.api("GET", `/api/v1/decks/${id}/links`, { cookie })).json())
      .links;
    expect(listed.openCount).toBe(0);
    expect((await guestApi(h, "POST", `/api/v1/share/${id}/opened`, grant)).status).toBe(204);
    // Cross-site POST refused (CSRF check applies to guests too).
    expect(
      (await guestApi(h, "POST", `/api/v1/share/${id}/opened`, grant, { "X-PPTaken-CSRF": "" }))
        .status,
    ).toBe(403);
    [listed] = (await (await h.api("GET", `/api/v1/decks/${id}/links`, { cookie })).json()).links;
    expect(listed.openCount).toBe(1);
    expect(listed.lastOpenedAt).toBe(new Date(h.clock.now()).toISOString());
    expect((await guestApi(h, "POST", `/api/v1/share/${id}/opened`, "forged.grant")).status).toBe(
      404,
    );
  });
});

describe("presenter links", () => {
  it("reveal notes, and unlock approved code with the presenter password only", async () => {
    const { h, cookie, id, digest } = await setup();
    await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, { cookie, body: { digest } });
    await h.api("POST", "/api/v1/presenter/password", { cookie, body: { password: PRESENTER } });
    const { secret } = await createLink(h, cookie, id, { kind: "presenter" });
    const page = await openLink(h, secret);
    expect(page.html).toContain('data-kind="presenter"');
    expect(page.html).toContain(`data-presenter="/s/${secret}/presenter"`);
    expect(page.html).not.toContain(NOTES);
    const presenterPage = await openLink(h, secret, "/presenter");
    expect(presenterPage.res.status).toBe(200);
    expect(presenterPage.html).toContain("/_player/presenter-page.js");
    const data = await (
      await guestApi(h, "GET", `/api/v1/share/${id}/presenter`, page.grant)
    ).json();
    expect(JSON.stringify(data)).toContain(NOTES);
    expect(data.interactive).toBe(true);
    const locked = await (
      await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, page.grant)
    ).json();
    expect(locked.scripts).toBe("locked");
    expect(await (await fetchContent(h, locked.url)).text()).not.toContain("pptaken.register");
    const wrong = await h.api("POST", "/api/v1/presenter/unlock", {
      body: { deckId: id, password: "not the presenter pass" },
      headers: { "X-PPTaken-View": page.grant },
    });
    expect(wrong.status).toBe(401);
    const ok = await h.api("POST", "/api/v1/presenter/unlock", {
      body: { deckId: id, password: PRESENTER },
      headers: { "X-PPTaken-View": page.grant, "x-test-ip": "10.0.0.2" },
    });
    expect(ok.status).toBe(200);
    const { token } = await ok.json();
    const running = await (
      await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, page.grant, {
        "X-PPTaken-Unlock": token,
      })
    ).json();
    expect(running.scripts).toBe("running");
    expect(await (await fetchContent(h, running.url)).text()).toContain('pptaken.register("sim"');
    // The unlock is bound to its link: another presenter link of the same deck cannot reuse it.
    const second = await openLink(
      h,
      (await createLink(h, cookie, id, { kind: "presenter" })).secret,
    );
    const replay = await (
      await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, second.grant, {
        "X-PPTaken-Unlock": token,
      })
    ).json();
    expect(replay).toMatchObject({ scripts: "locked", unlockRejected: true });
    // Without a grant the password alone does nothing.
    const bare = await h.api("POST", "/api/v1/presenter/unlock", {
      body: { deckId: id, password: PRESENTER },
      headers: { "x-test-ip": "10.0.0.3" },
    });
    expect(bare.status).toBe(401);
  });

  it("guests only run code the owner approved with a click (never an automatic approval)", async () => {
    const { h, cookie, id, digest } = await setup();
    await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, { cookie, body: { digest } });
    await h.api("POST", "/api/v1/presenter/password", { cookie, body: { password: PRESENTER } });
    // An agent edit continues the lineage automatically (ADR-024): the owner's session would run it, a guest not.
    await h.server.services.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "sim", html: "<p>static</p>", script: `${SCRIPT}\n// v2` }],
    });
    const { secret } = await createLink(h, cookie, id, { kind: "presenter" });
    const page = await openLink(h, secret);
    const unlock = await h.api("POST", "/api/v1/presenter/unlock", {
      body: { deckId: id, password: PRESENTER },
      headers: { "X-PPTaken-View": page.grant },
    });
    expect(unlock.status).toBe(401);
    const content = await (
      await guestApi(h, "GET", `/api/v1/decks/${id}/content-url`, page.grant)
    ).json();
    expect(content.scripts).toBe("pending");
  });
});

describe("trash, restore and purge", () => {
  it("the trash turns links off at once; restore keeps them off unless the owner asks", async () => {
    const { h, cookie, id } = await setup();
    const { secret } = await createLink(h, cookie, id);
    await createLink(h, cookie, id, { kind: "presenter" });
    const listed = await (await h.api("GET", "/api/v1/decks", { cookie })).json();
    expect(listed.decks[0].sharedLinks).toBe(2);
    const del = await (await h.api("DELETE", `/api/v1/decks/${id}`, { cookie })).json();
    expect(del.linksTurnedOff).toBe(2);
    expect((await openLink(h, secret)).res.status).toBe(404);
    const trash = await (await h.api("GET", "/api/v1/decks?trash=1", { cookie })).json();
    expect(trash.decks[0].linksOff).toBe(2);
    await h.api("POST", `/api/v1/decks/${id}/restore`, { cookie });
    expect((await openLink(h, secret)).res.status).toBe(404);
    await h.api("DELETE", `/api/v1/decks/${id}`, { cookie });
    // Nothing left to turn off (they were already off); restoring with the owner's OK brings them back.
    const r = await h.api("POST", `/api/v1/decks/${id}/restore`, {
      cookie,
      body: { restoreLinks: true },
    });
    expect(r.status).toBe(200);
    expect((await openLink(h, secret)).res.status).toBe(200);
    await h.api("DELETE", `/api/v1/decks/${id}`, { cookie });
    expect((await h.api("DELETE", `/api/v1/trash/${id}`, { cookie })).status).toBe(204);
    expect(await h.server.services.storage.shareLinks.listForDeck("default", id)).toEqual([]);
  });
});
