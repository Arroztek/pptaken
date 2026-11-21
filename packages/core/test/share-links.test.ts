// SPDX-License-Identifier: AGPL-3.0-or-later
// ADR-026: public links. Only the human owner creates, lists, changes or turns off links; agents may only count
// them. Secrets resolve through one generic failure; expiry, pinning, revocation, the trash (turns links off),
// restore (keeps them off unless the owner asks) and purge (removes them) behave as documented; limits and label
// cleaning hold; audit entries never carry the secret or the label.
import { agentPrincipal, createTestCore, ownerPrincipal } from "@pptaken/testing";
import { describe, expect, it } from "vitest";
import { cleanShareLabel, SHARE_LINK_LIMITS } from "../src/usecases/share-links.js";

const owner = ownerPrincipal();
const agent = agentPrincipal();
const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const t = createTestCore();
  const created = await t.core.createPresentation(agent, {
    title: "Q3 review",
    slides: [
      { id: "a", html: "<p>a</p>", notes: "secret notes" },
      { id: "b", html: "<p>b</p>" },
    ],
  });
  return { t, id: created.presentationId };
}

describe("creating and listing links", () => {
  it("returns a 22-character secret once, and the owner can list it again", async () => {
    const { t, id } = await setup();
    const link = await t.core.createShareLink(owner, {
      presentationId: id,
      kind: "view",
      label: "Q3 review for Ana",
    });
    expect(link.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(link).toMatchObject({ kind: "view", label: "Q3 review for Ana", state: "active" });
    const listed = await t.core.listShareLinks(owner, { presentationId: id });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.secret).toBe(link.secret);
    // Stored only as a hash and a sealed copy.
    const row = await t.store.shareLinks.get("default", link.id);
    expect(JSON.stringify({ ...row, sealedSecret: "" })).not.toContain(link.secret ?? "?");
  });

  it("agents can never create, list, change or turn off links, only count them", async () => {
    const { t, id } = await setup();
    await expect(
      t.core.createShareLink(agent, { presentationId: id, kind: "view" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    const link = await t.core.createShareLink(owner, { presentationId: id, kind: "presenter" });
    for (const call of [
      () => t.core.listShareLinks(agent, { presentationId: id }),
      () => t.core.updateShareLink(agent, { presentationId: id, linkId: link.id, label: "x" }),
      () => t.core.revokeShareLink(agent, { presentationId: id, linkId: link.id }),
      () => t.core.revokeAllShareLinks(agent, { presentationId: id }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    }
    expect(await t.core.countShareLinks(agent, { presentationId: id })).toEqual({
      active: 1,
      turnedOffByTrash: 0,
    });
  });

  it("validates kind, label, expiry and the pin", async () => {
    const { t, id } = await setup();
    const now = t.clock.now();
    for (const bad of [
      { kind: "edit" },
      { kind: "view", label: "x".repeat(81) },
      { kind: "view", label: 42 },
      { kind: "view", expiresAt: now - 1 },
      { kind: "view", expiresAt: now + 400 * DAY },
      { kind: "view", expiresAt: "tomorrow" },
      { kind: "view", pinRevision: "yes" },
    ]) {
      await expect(
        t.core.createShareLink(owner, { presentationId: id, ...(bad as { kind: "view" }) }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await expect(
      t.core.createShareLink(owner, { presentationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "view" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cleans labels: plain text, no control, bidi or invisible characters, 80 characters", () => {
    expect(cleanShareLabel("  Q3‮ review\u0000 for​ Ana \n ")).toBe("Q3 review for Ana");
    expect(cleanShareLabel(undefined)).toBe("");
    expect(cleanShareLabel("<b>x</b>")).toBe("<b>x</b>"); // shown as text, never as HTML
    expect(cleanShareLabel("é".repeat(80))).toHaveLength(80);
    expect(() => cleanShareLabel("x".repeat(81))).toThrow();
  });

  it("caps active links per deck; turned-off and expired ones do not count", async () => {
    const { t, id } = await setup();
    for (let i = 0; i < SHARE_LINK_LIMITS.perDeck; i++) {
      await t.core.createShareLink(owner, { presentationId: id, kind: "view" });
    }
    await expect(
      t.core.createShareLink(owner, { presentationId: id, kind: "view" }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const [first] = await t.core.listShareLinks(owner, { presentationId: id });
    await t.core.revokeShareLink(owner, { presentationId: id, linkId: first?.id ?? "" });
    await t.core.createShareLink(owner, { presentationId: id, kind: "view" });
  });
});

describe("resolving a secret", () => {
  it("one generic null for malformed, unknown, revoked and expired secrets", async () => {
    const { t, id } = await setup();
    const link = await t.core.createShareLink(owner, {
      presentationId: id,
      kind: "view",
      expiresAt: t.clock.now() + DAY,
    });
    const secret = link.secret ?? "";
    expect(await t.core.resolveShareLink("default", secret)).toMatchObject({
      link: { id: link.id },
      revision: 1,
    });
    for (const bad of [undefined, "", "short", `${secret}x`, "A".repeat(22), 42, "../../etc"]) {
      expect(await t.core.resolveShareLink("default", bad)).toBeNull();
    }
    t.clock.advance(DAY);
    expect(await t.core.resolveShareLink("default", secret)).toBeNull();
    // Extending an expired link brings it back.
    await t.core.updateShareLink(owner, {
      presentationId: id,
      linkId: link.id,
      expiresAt: t.clock.now() + 7 * DAY,
    });
    expect(await t.core.resolveShareLink("default", secret)).not.toBeNull();
    await t.core.revokeShareLink(owner, { presentationId: id, linkId: link.id });
    expect(await t.core.resolveShareLink("default", secret)).toBeNull();
    expect(await t.core.checkShareLink("default", link.id, id)).toBeNull();
    // A revoked link is gone for the owner too.
    expect(await t.core.listShareLinks(owner, { presentationId: id })).toEqual([]);
  });

  it("follows the latest revision, or the pinned one", async () => {
    const { t, id } = await setup();
    const follow = await t.core.createShareLink(owner, { presentationId: id, kind: "view" });
    const pinned = await t.core.createShareLink(owner, {
      presentationId: id,
      kind: "view",
      pinRevision: true,
    });
    await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "c", html: "<p>c</p>" }],
    });
    expect((await t.core.resolveShareLink("default", follow.secret))?.revision).toBe(2);
    expect((await t.core.resolveShareLink("default", pinned.secret))?.revision).toBe(1);
    // Unfreeze, then freeze on the current revision again.
    await t.core.updateShareLink(owner, {
      presentationId: id,
      linkId: pinned.id,
      pinnedRevision: null,
    });
    expect((await t.core.resolveShareLink("default", pinned.secret))?.revision).toBe(2);
    await t.core.updateShareLink(owner, {
      presentationId: id,
      linkId: pinned.id,
      pinnedRevision: "current",
    });
    expect((await t.core.checkShareLink("default", pinned.id, id))?.revision).toBe(2);
    await expect(
      t.core.updateShareLink(owner, { presentationId: id, linkId: pinned.id, pinnedRevision: 9 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // A link of another deck never checks out against this one.
    expect(
      await t.core.checkShareLink("default", pinned.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    ).toBeNull();
  });

  it("retention never deletes a pinned revision", async () => {
    const { t, id } = await setup();
    await t.core.createShareLink(owner, { presentationId: id, kind: "view", pinRevision: true });
    let revision = 1;
    for (let i = 0; i < 3; i++) {
      const r = await t.core.updateSlides(agent, {
        presentationId: id,
        expectedRevision: revision,
        upsert: [{ id: `x${i}`, html: "<p>x</p>" }],
      });
      revision = r.revision;
    }
    await t.core.pruneRevisions(owner, { presentationId: id, keep: 1 });
    expect(await t.store.revisions.listNumbers("default", id)).toEqual([1, 4]);
  });

  it("counts openings", async () => {
    const { t, id } = await setup();
    const link = await t.core.createShareLink(owner, { presentationId: id, kind: "view" });
    await t.core.recordShareLinkOpen("default", link.id);
    t.clock.advance(1000);
    await t.core.recordShareLinkOpen("default", link.id);
    const [listed] = await t.core.listShareLinks(owner, { presentationId: id });
    expect(listed).toMatchObject({ openCount: 2, lastOpenedAt: t.clock.now() });
  });
});

describe("trash, restore and purge", () => {
  it("the trash turns links off at once; restore keeps them off unless the owner asks", async () => {
    const { t, id } = await setup();
    const a = await t.core.createShareLink(owner, { presentationId: id, kind: "view" });
    const b = await t.core.createShareLink(owner, { presentationId: id, kind: "presenter" });
    await t.core.revokeShareLink(owner, { presentationId: id, linkId: b.id });
    const c = await t.core.createShareLink(owner, { presentationId: id, kind: "presenter" });
    const trashed = await t.core.trashPresentation(agent, { presentationId: id });
    expect(trashed.linksTurnedOff).toBe(2);
    expect(await t.core.resolveShareLink("default", a.secret)).toBeNull();
    expect(await t.core.countShareLinks(owner, { presentationId: id })).toEqual({
      active: 0,
      turnedOffByTrash: 2,
    });
    await expect(t.core.countShareLinks(agent, { presentationId: id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Restore without asking: links stay off.
    await t.core.restorePresentation(owner, { presentationId: id });
    expect(await t.core.resolveShareLink("default", a.secret)).toBeNull();
    expect(await t.core.listShareLinks(owner, { presentationId: id })).toEqual([]);
    // Trash again (nothing left to turn off), then restore with the owner's OK: the trash-revoked ones return,
    // the one the owner turned off does not.
    await t.core.trashPresentation(owner, { presentationId: id });
    await t.core.restorePresentation(owner, { presentationId: id, restoreLinks: true });
    expect(await t.core.resolveShareLink("default", a.secret)).not.toBeNull();
    expect(await t.core.resolveShareLink("default", c.secret)).not.toBeNull();
    expect(await t.core.resolveShareLink("default", b.secret)).toBeNull();
  });

  it("purge removes the links", async () => {
    const { t, id } = await setup();
    const a = await t.core.createShareLink(owner, { presentationId: id, kind: "view" });
    await t.core.trashPresentation(owner, { presentationId: id });
    await t.core.purgePresentation(owner, { presentationId: id });
    expect(await t.store.shareLinks.get("default", a.id)).toBeNull();
  });
});

describe("audit", () => {
  it("names the link id and never carries the secret or the label", async () => {
    const { t, id } = await setup();
    const link = await t.core.createShareLink(owner, {
      presentationId: id,
      kind: "presenter",
      label: "For Ana Torres",
    });
    await t.core.updateShareLink(owner, {
      presentationId: id,
      linkId: link.id,
      label: "For Luis",
      expiresAt: t.clock.now() + DAY,
    });
    await t.core.revokeShareLink(owner, { presentationId: id, linkId: link.id });
    await t.core.revokeAllShareLinks(owner, { presentationId: id });
    const audit = (await t.core.listAuditLog(owner, { limit: 100 })).items;
    const actions = audit.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "share_link.create",
        "share_link.update",
        "share_link.revoke",
        "share_link.revoke_all",
      ]),
    );
    expect(audit.find((e) => e.action === "share_link.create")?.target).toBe(`share:${link.id}`);
    const text = JSON.stringify(audit);
    expect(text).not.toContain(link.secret ?? "?");
    expect(text).not.toContain("Ana");
    expect(text).not.toContain("Luis");
  });
});
