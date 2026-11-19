// SPDX-License-Identifier: AGPL-3.0-or-later
// ADR-021 on the server: the approval screen API, the presenter password (set/change/remove, separate from the owner
// password, audited, never logged), the unlock endpoint (generic failures, rate limits, lockouts), and what an
// unlock token can and cannot do (bound to deck + approved digest + password epoch; no API, no panel; an edit, a
// revocation, a password change or the switch turned off ends it).
import type { Principal } from "@pptaken/core";
import { afterEach, describe, expect, it } from "vitest";
import { createToken, type Harness, makeHarness, ORIGIN, PASSWORD, setupOwner } from "./helpers.js";

const agent: Principal = {
  actor: "agent",
  workspaceId: "default",
  scopes: new Set(["decks:read", "decks:write"]),
  tokenId: "tok",
};
const PRESENTER = "lantern quietly folds 9 maps";
const SCRIPT = "slide.onEnter(function(){ slide.root.dataset.entered = '1'; });";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** A harness whose client IP comes from the `x-test-ip` header (no proxy needed). */
async function harness(
  env: Record<string, string> = { PPTAKEN_SCRIPTS: "owner" },
  testRoutes = false,
) {
  h = await makeHarness(env, {
    socketIp: (raw) => raw.headers.get("x-test-ip") ?? "10.0.0.1",
    testRoutes,
  });
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

async function approve(hh: Harness, cookie: string, id: string, digest: string) {
  const res = await hh.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
    cookie,
    body: { digest },
  });
  expect(res.status).toBe(200);
}

async function setPresenter(hh: Harness, cookie: string, password = PRESENTER) {
  return hh.api("POST", "/api/v1/presenter/password", { cookie, body: { password } });
}

function unlock(hh: Harness, deckId: string, password: string, ip = "10.0.0.1") {
  return hh.api("POST", "/api/v1/presenter/unlock", {
    body: { deckId, password },
    headers: { "x-test-ip": ip },
  });
}

/** content-url as a guest page asks for it: view grant, optional unlock token, no cookie. */
async function guestContent(hh: Harness, id: string, token?: string, query = "") {
  const { signViewGrant } = await import("../src/presenter-unlock.js");
  const headers: Record<string, string> = {
    "X-PPTaken-View": signViewGrant(hh.server.services, id),
  };
  if (token !== undefined) headers["X-PPTaken-Unlock"] = token;
  return hh.api("GET", `/api/v1/decks/${id}/content-url${query}`, { headers });
}

async function documentOf(hh: Harness, url: string) {
  const res = await hh.server.app.request(url.replace(/^https?:\/\/[^/]+/, ORIGIN));
  return res.text();
}

describe("approval screen API", () => {
  it("returns every script's source, hash and size, the static-fallback warnings and the capability", async () => {
    const { h, cookie, id, digest } = await harness();
    const res = await h.api("GET", `/api/v1/decks/${id}/scripts`, { cookie });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.digest).toBe(digest);
    expect(body.sources).toEqual([
      {
        slideId: "sim",
        index: 1,
        source: SCRIPT,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        bytes: Buffer.byteLength(SCRIPT),
      },
    ]);
    expect(body.libs[0]).toMatchObject({ name: "uPlot", sha256: expect.any(String) });
    // The static fallback removes the canvas: the reviewer sees it.
    expect(body.warnings).toContainEqual(
      expect.objectContaining({ path: "slides[1].html", name: "canvas" }),
    );
    expect(body.presenterPassword).toEqual({ set: false });
    expect(body.capability.freezeWarning).toBe(true);
  });

  it("refuses a wrong digest and a stale one after an agent edit (409); agents never approve", async () => {
    const { h, cookie, id, digest } = await harness();
    const wrong = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      cookie,
      body: { digest: "f".repeat(64) },
    });
    expect(wrong.status).toBe(409);
    await h.server.services.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "sim", html: "<p>static</p>", script: `${SCRIPT}\n// v2` }],
    });
    const stale = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      cookie,
      body: { digest },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.message).toMatch(/changed since they were reviewed/);
    const { secret } = await createToken(h, cookie);
    const viaToken = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      body: { digest },
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(viaToken.status).toBe(401);
    await expect(
      h.server.services.core.approveScripts(agent, { presentationId: id, digest }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
  });

  it("the deck list and detail carry the scripts state and the manage URL", async () => {
    const { h, cookie, id, digest } = await harness();
    const list = await (await h.api("GET", "/api/v1/decks", { cookie })).json();
    expect(list.decks[0]).toMatchObject({ id, scripts: "pending" });
    await approve(h, cookie, id, digest);
    const detail = await (await h.api("GET", `/api/v1/decks/${id}`, { cookie })).json();
    expect(detail).toMatchObject({
      scripts: "approved",
      urls: { manage: `${ORIGIN}/decks/${id}` },
    });
  });
});

describe("presenter password", () => {
  it("is set, changed and removed by the owner only, audited, and never logged", async () => {
    const { h, cookie } = await harness();
    expect(
      (await h.api("POST", "/api/v1/presenter/password", { body: { password: PRESENTER } })).status,
    ).toBe(401);
    expect(await (await h.api("GET", "/api/v1/presenter/password", { cookie })).json()).toEqual({
      set: false,
    });
    const set = await setPresenter(h, cookie);
    expect(await set.json()).toEqual({ set: true, change: "set" });
    expect((await (await setPresenter(h, cookie, `${PRESENTER}!`)).json()).change).toBe("changed");
    expect(await (await h.api("GET", "/api/v1/presenter/password", { cookie })).json()).toEqual({
      set: true,
    });
    // Equal to the owner password, weak, or without the CSRF header: refused.
    const equal = await setPresenter(h, cookie, PASSWORD);
    expect(equal.status).toBe(400);
    expect((await equal.json()).error.message).toMatch(/different from the owner password/);
    expect((await setPresenter(h, cookie, "short")).status).toBe(400);
    const noCsrf = await h.api("POST", "/api/v1/presenter/password", {
      cookie,
      body: { password: PRESENTER },
      headers: { "X-PPTaken-CSRF": "" },
    });
    expect(noCsrf.status).toBe(403);
    expect((await h.api("DELETE", "/api/v1/presenter/password", { cookie })).status).toBe(204);
    expect(await (await h.api("GET", "/api/v1/presenter/password", { cookie })).json()).toEqual({
      set: false,
    });
    const audit = await h.server.services.core.listAuditLog(
      { actor: "owner", workspaceId: "default", scopes: new Set() },
      { limit: 50 },
    );
    const actions = audit.items.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "presenter_password.set",
        "presenter_password.change",
        "presenter_password.remove",
      ]),
    );
    const everything = `${h.logs.join("\n")}\n${JSON.stringify(audit.items)}`;
    expect(everything).not.toContain(PRESENTER);
    // The owner password cannot become equal to it either.
    await setPresenter(h, cookie);
    const change = await h.api("POST", "/api/v1/auth/password", {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: PRESENTER },
    });
    expect(change.status).toBe(400);
  });
});

describe("unlock", () => {
  it("fails generically without a presenter password, with a wrong one, with the owner password, or for an unapproved deck", async () => {
    const { h, cookie, id, digest } = await harness();
    const none = await unlock(h, id, PRESENTER);
    expect(none.status).toBe(401);
    const generic = await none.json();
    expect(generic.error).toMatchObject({ code: "UNAUTHENTICATED", message: "Unlock failed" });
    await setPresenter(h, cookie);
    // Unapproved deck with the right password: the same answer.
    const pending = await unlock(h, id, PRESENTER, "10.0.0.2");
    expect(await pending.json()).toEqual(generic);
    await approve(h, cookie, id, digest);
    expect(await (await unlock(h, id, PASSWORD, "10.0.0.3")).json()).toEqual(generic);
    expect(await (await unlock(h, id, "wrong presenter pass", "10.0.0.4")).json()).toEqual(generic);
    expect(
      await (await unlock(h, "01ARZ3NDEKTSV4RRFFQ69G5FAV", PRESENTER, "10.0.0.5")).json(),
    ).toEqual(generic);
    const ok = await unlock(h, id, PRESENTER, "10.0.0.6");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = await ok.json();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(body.expiresAt) - h.clock.now()).toBeLessThanOrEqual(8 * 3600 * 1000);
    expect(h.logs.join("\n")).not.toContain(PRESENTER);
    expect(h.logs.join("\n")).not.toContain(body.token);
    const audit = await h.server.services.core.listAuditLog(
      { actor: "owner", workspaceId: "default", scopes: new Set() },
      { limit: 50 },
    );
    const unlocks = audit.items.filter((e) => e.action === "presenter.unlock");
    expect(unlocks.filter((e) => e.result === "ok")).toHaveLength(1);
    expect(unlocks.filter((e) => e.result === "denied").length).toBeGreaterThanOrEqual(5);
  });

  it("never unlocks with the instance switch off", async () => {
    const { h, cookie, id, digest } = await harness({ PPTAKEN_SCRIPTS: "off" });
    await setPresenter(h, cookie);
    await h.server.services.storage.scriptApprovals.set({
      workspaceId: "default",
      deckId: id,
      digest,
      approvedAt: 1,
      approvedBy: { actor: "owner", tokenId: null },
      mode: "owner",
      ownerDigest: digest,
      trustedLibs: [],
      previousRevision: null,
    });
    expect((await unlock(h, id, PRESENTER)).status).toBe(401);
  });

  it("rate limits per IP with an increasing delay, and caps failures per deck across IPs", async () => {
    const { h, cookie, id, digest } = await harness();
    await setPresenter(h, cookie);
    await approve(h, cookie, id, digest);
    for (let i = 0; i < 3; i++)
      expect((await unlock(h, id, "nope nope nope 1", "10.1.0.1")).status).toBe(401);
    const locked = await unlock(h, id, PRESENTER, "10.1.0.1");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    h.clock.t += 2000;
    expect((await unlock(h, id, PRESENTER, "10.1.0.1")).status).toBe(200);
    // 5 attempts per minute per IP even when they succeed.
    for (let i = 0; i < 4; i++) await unlock(h, id, PRESENTER, "10.1.0.2");
    expect((await unlock(h, id, PRESENTER, "10.1.0.2")).status).toBe(200);
    expect((await unlock(h, id, PRESENTER, "10.1.0.2")).status).toBe(429);
    // Per deck: 10 failures from 10 different IPs lock the deck for everyone, right password included.
    for (let i = 0; i < 10; i++) await unlock(h, id, "nope nope nope 2", `10.2.0.${i}`);
    expect((await unlock(h, id, PRESENTER, "10.3.0.1")).status).toBe(429);
    h.clock.t += 10 * 60_000;
    expect((await unlock(h, id, PRESENTER, "10.3.0.1")).status).toBe(200);
  });

  it("the global failure cap pauses every IP during a distributed attack", async () => {
    const { h, cookie, id, digest } = await harness();
    await setPresenter(h, cookie);
    await approve(h, cookie, id, digest);
    // Unknown deck ids spread over keys, so the per-deck cap does not trigger first.
    for (let i = 0; i < 30; i++) {
      await unlock(
        h,
        `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, "0")}`,
        "x".repeat(12),
        `10.9.${i}.1`,
      );
    }
    expect((await unlock(h, id, PRESENTER, "10.10.0.1")).status).toBe(429);
  });
});

describe("what an unlock token does", () => {
  async function unlocked(env?: Record<string, string>) {
    const ctx = await harness(env);
    await setPresenter(ctx.h, ctx.cookie);
    await approve(ctx.h, ctx.cookie, ctx.id, ctx.digest);
    const res = await unlock(ctx.h, ctx.id, PRESENTER);
    expect(res.status).toBe(200);
    return { ...ctx, token: (await res.json()).token as string };
  }

  it("upgrades a view grant of its deck to the scripted document, and nothing else", async () => {
    const { h, id, token } = await unlocked();
    const locked = await (await guestContent(h, id)).json();
    expect(locked).toMatchObject({ scripts: "locked" });
    expect(await documentOf(h, locked.url)).not.toContain("pptaken.register");
    const running = await (await guestContent(h, id, token)).json();
    expect(running).toMatchObject({ scripts: "running", expect: { slides: ["intro", "sim"] } });
    expect(await documentOf(h, running.url)).toContain('pptaken.register("sim"');
    // ?safe=1 still forces the static version.
    expect((await (await guestContent(h, id, token, "?safe=1")).json()).scripts).toBe("safe");
    // Without a view grant the token alone gets nothing; it is not an API credential either.
    const alone = await h.api("GET", `/api/v1/decks/${id}/content-url`, {
      headers: { "X-PPTaken-Unlock": token },
    });
    expect(alone.status).toBe(401);
    for (const path of ["/api/v1/decks", `/api/v1/decks/${id}`, `/api/v1/decks/${id}/scripts`]) {
      expect(
        (await h.api("GET", path, { headers: { Authorization: `Bearer ${token}` } })).status,
      ).toBe(401);
      expect((await h.api("GET", path, { headers: { "X-PPTaken-Unlock": token } })).status).toBe(
        401,
      );
    }
    const mcp = await h.server.app.request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(mcp.status).toBe(401);
  });

  it("is bound to its deck", async () => {
    const { h, token } = await unlocked();
    const other = await h.server.services.core.createPresentation(agent, {
      title: "Other",
      slides: [{ id: "a", html: "<p>a</p>", script: SCRIPT }],
    });
    const res = await (await guestContent(h, other.presentationId, token)).json();
    expect(res.scripts).toBe("pending");
    expect(res.unlockRejected).toBe(true);
  });

  it("an edited deck invalidates it, even after the new code is approved", async () => {
    const { h, cookie, id, token } = await unlocked();
    const edited = await h.server.services.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "sim", html: "<p>static</p>", script: `${SCRIPT}\n// v2` }],
    });
    const pending = await (await guestContent(h, id, token)).json();
    expect(pending).toMatchObject({ scripts: "pending", unlockRejected: true });
    await approve(h, cookie, id, edited.scripts.digest as string);
    expect(await (await guestContent(h, id, token)).json()).toMatchObject({
      scripts: "locked",
      unlockRejected: true,
    });
  });

  it("a revocation, a password change, a removal or the expiry ends it", async () => {
    const { h, cookie, id, digest, token } = await unlocked();
    await h.api("POST", `/api/v1/decks/${id}/scripts/revoke`, { cookie });
    expect((await (await guestContent(h, id, token)).json()).scripts).toBe("pending");
    await approve(h, cookie, id, digest);
    expect((await (await guestContent(h, id, token)).json()).scripts).toBe("running");
    await setPresenter(h, cookie, `${PRESENTER} two`);
    expect(await (await guestContent(h, id, token)).json()).toMatchObject({
      scripts: "locked",
      unlockRejected: true,
    });
    const fresh = (await (await unlock(h, id, `${PRESENTER} two`, "10.0.0.9")).json())
      .token as string;
    expect((await (await guestContent(h, id, fresh)).json()).scripts).toBe("running");
    await h.api("DELETE", "/api/v1/presenter/password", { cookie });
    expect((await (await guestContent(h, id, fresh)).json()).scripts).toBe("locked");
    await setPresenter(h, cookie);
    const last = (await (await unlock(h, id, PRESENTER, "10.0.0.10")).json()).token as string;
    h.clock.t += 8 * 3600 * 1000 + 1;
    expect((await (await guestContent(h, id, last)).json()).scripts).toBe("locked");
  });

  it("an owner password change does not touch the presenter password", async () => {
    const { h, cookie, id, token } = await unlocked();
    const changed = await h.api("POST", "/api/v1/auth/password", {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: "a brand new owner phrase 3" },
    });
    expect(changed.status).toBe(200);
    expect((await (await guestContent(h, id, token)).json()).scripts).toBe("running");
  });

  it("a forged view grant or an unlock token used as a view grant is refused", async () => {
    const { h, id, token } = await unlocked();
    const forged = await h.api("GET", `/api/v1/decks/${id}/content-url`, {
      headers: { "X-PPTaken-View": token, "X-PPTaken-Unlock": token },
    });
    expect(forged.status).toBe(401);
  });
});

describe("guest page and presenter data", () => {
  it("the guest page exists only with test routes", async () => {
    const plain = await harness();
    const res = await plain.h.api("GET", `/__test/guest/${plain.id}`, { cookie: "" });
    expect(res.status).toBe(404);
    await plain.h.cleanup();
    h = undefined;
    const withRoutes = await harness({ PPTAKEN_SCRIPTS: "owner" }, true);
    const page = await withRoutes.h.api("GET", `/__test/guest/${withRoutes.id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-viewer="guest"');
    expect(html).not.toContain("pptaken.register");
    expect(page.headers.get("content-security-policy")).toContain("frame-src");
  });

  it("presenter data says when the deck runs interactive code online", async () => {
    const { h, cookie, id, digest } = await harness();
    const before = await (await h.api("GET", `/api/v1/decks/${id}/presenter`, { cookie })).json();
    expect(before.interactive).toBeUndefined();
    await approve(h, cookie, id, digest);
    const after = await (await h.api("GET", `/api/v1/decks/${id}/presenter`, { cookie })).json();
    expect(after.interactive).toBe(true);
  });
});
