// SPDX-License-Identifier: AGPL-3.0-or-later
// The panel's trash routes (owner session + CSRF, audited) and the trust lineage on the server (ADR-024): the
// owner-only setting, automatic approval of agent edits, the new-library exception, and guest contexts that never
// run automatically approved code.
import type { Principal } from "@pptaken/core";
import { afterEach, describe, expect, it } from "vitest";
import { unlockableDigest } from "../src/presenter-unlock.js";
import { createToken, type Harness, makeHarness, setupOwner } from "./helpers.js";

const agent: Principal = {
  actor: "agent",
  workspaceId: "default",
  scopes: new Set(["decks:read", "decks:write"]),
  tokenId: "tok",
};

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function plainDeck(hh: Harness, title = "Garden club") {
  const r = await hh.server.services.core.createPresentation(agent, {
    title,
    slides: [{ id: "a", html: "<h1>Hi</h1>" }],
  });
  return r.presentationId;
}

async function actions(hh: Harness) {
  return (await hh.server.services.storage.audit.list("default", { limit: 200 })).map(
    (e) => `${e.action}:${e.result}`,
  );
}

describe("trash routes", () => {
  it("moves to the trash, lists it with days left, restores and deletes for good", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const id = await plainDeck(h);

    const del = await h.api("DELETE", `/api/v1/decks/${id}`, { cookie });
    expect(del.status).toBe(200);
    expect((await del.json()).restorableUntil).toMatch(/^\d{4}-/);
    expect((await (await h.api("GET", "/api/v1/decks", { cookie })).json()).decks).toEqual([]);
    expect((await h.api("GET", `/api/v1/decks/${id}`, { cookie })).status).toBe(404);

    const trash = await (await h.api("GET", "/api/v1/decks?trash=1", { cookie })).json();
    expect(trash.decks).toHaveLength(1);
    expect(trash.decks[0]).toMatchObject({ id, title: "Garden club" });
    const left = Date.parse(trash.decks[0].restorableUntil) - h.clock.now();
    expect(Math.round(left / 86_400_000)).toBe(30);

    const restored = await h.api("POST", `/api/v1/decks/${id}/restore`, { cookie });
    expect(restored.status).toBe(200);
    expect((await restored.json()).id).toBe(id);
    expect((await h.api("GET", `/api/v1/decks/${id}`, { cookie })).status).toBe(200);

    // Permanent deletion only from the trash.
    const early = await h.api("DELETE", `/api/v1/trash/${id}`, { cookie });
    expect(early.status).toBe(400);
    await h.api("DELETE", `/api/v1/decks/${id}`, { cookie });
    expect((await h.api("DELETE", `/api/v1/trash/${id}`, { cookie })).status).toBe(204);
    expect((await (await h.api("GET", "/api/v1/decks?trash=1", { cookie })).json()).decks).toEqual(
      [],
    );
    expect((await h.api("POST", `/api/v1/decks/${id}/restore`, { cookie })).status).toBe(404);

    const log = await actions(h);
    for (const a of ["presentation.trash", "presentation.restore", "presentation.purge"]) {
      expect(log).toContain(`${a}:ok`);
    }
  });

  it("needs the owner session and the CSRF header; tokens cannot use it", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const id = await plainDeck(h);
    expect((await h.api("DELETE", `/api/v1/decks/${id}`)).status).toBe(401);
    expect(
      (await h.api("DELETE", `/api/v1/decks/${id}`, { cookie, headers: { "X-PPTaken-CSRF": "" } }))
        .status,
    ).toBe(403);
    const { secret } = await createToken(h, cookie);
    const bearer = await h.api("DELETE", `/api/v1/decks/${id}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(bearer.status).toBe(401);
    expect((await h.api("GET", "/api/v1/decks?trash=1")).status).toBe(401);
    expect((await h.api("DELETE", "/api/v1/trash/not-an-id", { cookie })).status).toBe(404);
  });
});

describe("settings (ADR-024)", () => {
  it("defaults to automatic updates on; only the owner session changes it, audited", async () => {
    h = await makeHarness({ PPTAKEN_SCRIPTS: "owner" });
    const cookie = await setupOwner(h);
    expect(
      (await (await h.api("GET", "/api/v1/settings", { cookie })).json()).autoApproveUpdates,
    ).toBe(true);
    expect(
      (await h.api("PUT", "/api/v1/settings", { body: { autoApproveUpdates: false } })).status,
    ).toBe(401);
    const { secret } = await createToken(h, cookie);
    expect(
      (
        await h.api("PUT", "/api/v1/settings", {
          body: { autoApproveUpdates: false },
          headers: { Authorization: `Bearer ${secret}` },
        })
      ).status,
    ).toBe(401);
    const bad = await h.api("PUT", "/api/v1/settings", {
      cookie,
      body: { autoApproveUpdates: "no" },
    });
    expect(bad.status).toBe(400);
    const off = await h.api("PUT", "/api/v1/settings", {
      cookie,
      body: { autoApproveUpdates: false },
    });
    expect((await off.json()).autoApproveUpdates).toBe(false);
    expect(
      (await (await h.api("GET", "/api/v1/settings", { cookie })).json()).autoApproveUpdates,
    ).toBe(false);
    expect(await actions(h)).toContain("settings.auto_approve_updates:ok");
  });
});

describe("trust lineage on the server (ADR-024)", () => {
  const code = (v: string) =>
    `slide.onEnter(function(){ var root = slide.root; root.dataset.v = '${v}'; });`;

  async function approved() {
    h = await makeHarness({ PPTAKEN_SCRIPTS: "owner" });
    const cookie = await setupOwner(h);
    const core = h.server.services.core;
    const created = await core.createPresentation(agent, {
      title: "Charts",
      slides: [{ id: "sim", html: "<canvas width='10' height='10'></canvas>", script: code("1") }],
    });
    const id = created.presentationId;
    const ok = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      cookie,
      body: { digest: created.scripts.digest },
    });
    expect(ok.status).toBe(200);
    return { hh: h, cookie, id, revision: created.revision };
  }

  const edit = (hh: Harness, id: string, expectedRevision: number, v: string) =>
    hh.server.services.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision,
      upsert: [{ id: "sim", html: "<canvas width='10' height='10'></canvas>", script: code(v) }],
    });

  it("allows an agent edit automatically, tells the panel, and the owner runs it", async () => {
    const { hh, cookie, id, revision } = await approved();
    const r = await edit(hh, id, revision, "2");
    expect(r.scripts.state).toBe("approved");
    const review = await (await hh.api("GET", `/api/v1/decks/${id}/scripts`, { cookie })).json();
    expect(review).toMatchObject({
      state: "approved",
      approvalMode: "auto",
      ownerApproved: false,
      previousRevision: revision,
      autoApproveUpdates: true,
    });
    expect(review.previous.sources[0].source).toContain("'1'");
    const url = await (await hh.api("GET", `/api/v1/decks/${id}/content-url`, { cookie })).json();
    expect(url.scripts).toBe("running");
    expect(await actions(hh)).toContain("presentation.scripts_auto_approve:ok");
  });

  it("never lets a guest (presenter password) context run automatically approved code", async () => {
    const { hh, id, revision } = await approved();
    const s = hh.server.services;
    expect(await unlockableDigest(s, id)).not.toBeNull(); // the owner clicked for this code
    await edit(hh, id, revision, "2");
    expect(await unlockableDigest(s, id)).toBeNull(); // guests: only owner-clicked code
    expect(await unlockableDigest(s, id, { guest: false })).not.toBeNull(); // the owner's own view
  });

  it("asks again with the setting off, and after a revoke", async () => {
    const { hh, cookie, id, revision } = await approved();
    await hh.api("PUT", "/api/v1/settings", { cookie, body: { autoApproveUpdates: false } });
    const r = await edit(hh, id, revision, "2");
    expect(r.scripts.state).toBe("pending");
    await hh.api("PUT", "/api/v1/settings", { cookie, body: { autoApproveUpdates: true } });
    await hh.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      cookie,
      body: { digest: r.scripts.digest },
    });
    await hh.api("POST", `/api/v1/decks/${id}/scripts/revoke`, { cookie });
    const after = await edit(hh, id, r.revision, "3");
    expect(after.scripts.state).toBe("pending");
  });

  it("a new library always needs the click and is reported as such", async () => {
    const { hh, cookie, id, revision } = await approved();
    const r = await hh.server.services.core.updatePresentation(agent, {
      presentationId: id,
      expectedRevision: revision,
      libs: ["uplot@1"],
    });
    expect(r.scripts.state).toBe("pending");
    const review = await (await hh.api("GET", `/api/v1/decks/${id}/scripts`, { cookie })).json();
    expect(review.state).toBe("pending");
    expect(review.newLibs).toHaveLength(1);
  });

  it("no agent-callable API can approve: tokens are refused by the approval and settings routes", async () => {
    const { hh, cookie, id, revision } = await approved();
    await hh.api("PUT", "/api/v1/settings", { cookie, body: { autoApproveUpdates: false } });
    const r = await edit(hh, id, revision, "2");
    const { secret } = await createToken(hh, cookie);
    const headers = { Authorization: `Bearer ${secret}` };
    expect(
      (
        await hh.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
          headers,
          body: { digest: r.scripts.digest },
        })
      ).status,
    ).toBe(401);
    const status = await hh.server.services.core.getScriptsStatus(agent, { presentationId: id });
    expect(status.state).toBe("pending");
  });
});
