// SPDX-License-Identifier: AGPL-3.0-or-later
// ADR-024: approval bound to a trust lineage. The owner's first click starts it; edits of already-approved code by
// the owner's agent continue it without a click while the setting is on; a new library, the setting off, a revoke or
// the instance switch off break it. No agent-callable input can approve anything.
import { agentPrincipal, createTestCore, ownerPrincipal } from "@pptaken/testing";
import { describe, expect, it } from "vitest";
import { libKey, lineageDecision, untrustedLibs } from "../src/scripts.js";

const owner = ownerPrincipal();
const agent = agentPrincipal();

const scripted = (code: string) => [
  { id: "a", html: "<p>a</p>" },
  { id: "b", html: "<canvas width='10' height='10'></canvas>", script: code },
];

function setup(options: { auto?: boolean; enabled?: boolean } = {}) {
  const setting = { on: options.auto ?? true };
  const t = createTestCore({
    config: { scriptsEnabled: options.enabled ?? true },
    trust: { autoApproveUpdates: async () => setting.on },
  });
  return { t, setting };
}

async function approvedDeck(t: ReturnType<typeof setup>["t"], libs: string[] = []) {
  const created = await t.core.createPresentation(agent, {
    title: "Charts",
    slides: scripted("slide.onEnter(function(){ var root = slide.root; });"),
    ...(libs.length > 0 ? { libs } : {}),
  });
  const id = created.presentationId;
  expect(created.scripts.state).toBe("pending");
  await t.core.approveScripts(owner, { presentationId: id, digest: created.scripts.digest ?? "" });
  return { id, revision: created.revision };
}

async function editScript(
  t: ReturnType<typeof setup>["t"],
  id: string,
  expectedRevision: number,
  code: string,
) {
  return t.core.updateSlides(agent, {
    presentationId: id,
    expectedRevision,
    upsert: [{ id: "b", html: "<canvas width='10' height='10'></canvas>", script: code }],
  });
}

async function actions(t: ReturnType<typeof setup>["t"]) {
  const page = await t.core.listAuditLog(owner, { limit: 100 });
  return page.items.map((e) => e.action);
}

describe("lineageDecision (pure)", () => {
  const lib = { name: "x", sha256: "a".repeat(64), source: "https://cdn.example/x.js" };
  const base = {
    scriptsEnabled: true,
    autoApprove: true,
    approvedDigest: "1".repeat(64),
    previousDigest: "1".repeat(64),
    nextDigest: "2".repeat(64),
    next: { libs: [lib] },
    trustedLibs: [libKey(lib)],
  };

  it("continues an approved lineage for changed code with known libraries", () => {
    expect(lineageDecision(base)).toEqual({ continue: true });
  });

  it("breaks on a new library: new source OR new bytes under a known source", () => {
    const newSource = { ...lib, source: "https://evil.example/x.js" };
    const newBytes = { ...lib, sha256: "b".repeat(64) };
    for (const next of [newSource, newBytes]) {
      const d = lineageDecision({ ...base, next: { libs: [lib, next] } });
      expect(d).toMatchObject({ continue: false, reason: "new_library" });
      expect(untrustedLibs({ libs: [lib, next] }, base.trustedLibs)).toEqual([next]);
    }
  });

  it("never continues without an approved previous version, with the setting off or scripts off", () => {
    expect(lineageDecision({ ...base, approvedDigest: null })).toMatchObject({
      reason: "no_lineage",
    });
    expect(lineageDecision({ ...base, approvedDigest: "9".repeat(64) })).toMatchObject({
      reason: "no_lineage",
    });
    expect(lineageDecision({ ...base, autoApprove: false })).toMatchObject({
      reason: "setting_off",
    });
    expect(lineageDecision({ ...base, scriptsEnabled: false })).toMatchObject({
      reason: "scripts_off",
    });
    expect(lineageDecision({ ...base, nextDigest: null })).toMatchObject({ reason: "no_scripts" });
  });
});

describe("trust lineage in the write path", () => {
  it("first approval needs the owner; later agent edits are allowed automatically and audited", async () => {
    const { t } = setup();
    const { id, revision } = await approvedDeck(t);
    const edited = await editScript(t, id, revision, "slide.onEnter(function(){ /* v2 */ });");
    expect(edited.scripts.state).toBe("approved");
    const status = await t.core.getScriptsStatus(owner, { presentationId: id });
    expect(status).toMatchObject({
      state: "approved",
      approvalMode: "auto",
      ownerApproved: false,
      previousRevision: revision,
    });
    const review = await t.core.getScriptsReview(owner, { presentationId: id });
    expect(review.previous?.revision).toBe(revision);
    expect(review.previous?.sources[0]?.source).toContain("var root");
    expect(review.sources[0]?.source).toContain("v2");
    expect(await actions(t)).toContain("presentation.scripts_auto_approve");
    // A chain of edits keeps the lineage alive.
    const again = await editScript(
      t,
      id,
      edited.revision,
      "slide.onEnter(function(){ /* v3 */ });",
    );
    expect(again.scripts.state).toBe("approved");
  });

  it("a brand-new deck is never allowed automatically (no lineage yet)", async () => {
    const { t } = setup();
    const created = await t.core.createPresentation(agent, {
      title: "New",
      slides: scripted("slide.onEnter(function(){});"),
    });
    expect(created.scripts.state).toBe("pending");
  });

  it("a new library always needs a click, even with the setting on", async () => {
    const { t } = setup();
    const { id, revision } = await approvedDeck(t);
    const r = await t.core.updatePresentation(agent, {
      presentationId: id,
      expectedRevision: revision,
      libs: ["uplot@1"],
    });
    expect(r.scripts.state).toBe("pending");
    const status = await t.core.getScriptsStatus(owner, { presentationId: id });
    expect(status.newLibs.map((l) => l.name)).toEqual([expect.stringMatching(/uplot/i)]);
    expect(await actions(t)).toContain("presentation.scripts_lineage_break");
    // Once the owner allows it, the library is part of the lineage: later code edits continue.
    await t.core.approveScripts(owner, { presentationId: id, digest: r.scripts.digest ?? "" });
    const next = await editScript(t, id, r.revision, "slide.onEnter(function(){ /* v4 */ });");
    expect(next.scripts.state).toBe("approved");
  });

  it("libraries of the approved version stay trusted (dropping and re-adding one is no new library)", async () => {
    const { t } = setup();
    const { id, revision } = await approvedDeck(t, ["uplot@1"]);
    const dropped = await t.core.updatePresentation(agent, {
      presentationId: id,
      expectedRevision: revision,
      libs: null,
    });
    expect(dropped.scripts.state).toBe("approved");
    const back = await t.core.updatePresentation(agent, {
      presentationId: id,
      expectedRevision: dropped.revision,
      libs: ["uplot@1"],
    });
    expect(back.scripts.state).toBe("approved");
  });

  it("the setting off restores 'ask for every change'", async () => {
    const { t, setting } = setup();
    const { id, revision } = await approvedDeck(t);
    setting.on = false;
    const r = await editScript(t, id, revision, "slide.onEnter(function(){ /* v2 */ });");
    expect(r.scripts.state).toBe("pending");
  });

  it("without a policy (library default) nothing is approved automatically", async () => {
    const t = createTestCore({ config: { scriptsEnabled: true } });
    const created = await t.core.createPresentation(agent, {
      title: "X",
      slides: scripted("slide.onEnter(function(){});"),
    });
    await t.core.approveScripts(owner, {
      presentationId: created.presentationId,
      digest: created.scripts.digest ?? "",
    });
    const r = await editScript(t, created.presentationId, created.revision, "slide.onEnter(1);");
    expect(r.scripts.state).toBe("pending");
  });

  it("a failing policy fails closed", async () => {
    const t = createTestCore({
      config: { scriptsEnabled: true },
      trust: {
        autoApproveUpdates: async () => {
          throw new Error("settings store down");
        },
      },
    });
    const created = await t.core.createPresentation(agent, {
      title: "X",
      slides: scripted("slide.onEnter(function(){});"),
    });
    await t.core.approveScripts(owner, {
      presentationId: created.presentationId,
      digest: created.scripts.digest ?? "",
    });
    const r = await editScript(t, created.presentationId, created.revision, "slide.onEnter(2);");
    expect(r.scripts.state).toBe("pending");
  });

  it("revoking ends the lineage: the next edit waits for the owner", async () => {
    const { t } = setup();
    const { id, revision } = await approvedDeck(t);
    await t.core.revokeScripts(owner, { presentationId: id });
    const r = await editScript(t, id, revision, "slide.onEnter(function(){ /* v2 */ });");
    expect(r.scripts.state).toBe("pending");
  });

  it("a stale deck (edited while the setting was off) does not resume on its own", async () => {
    const { t, setting } = setup();
    const { id, revision } = await approvedDeck(t);
    setting.on = false;
    const stale = await editScript(t, id, revision, "slide.onEnter(function(){ /* v2 */ });");
    setting.on = true;
    const r = await editScript(t, id, stale.revision, "slide.onEnter(function(){ /* v3 */ });");
    expect(r.scripts.state).toBe("pending");
  });

  it("instance switch off: no automatic approval", async () => {
    const { t } = setup({ enabled: false });
    const created = await t.core.createPresentation(agent, {
      title: "X",
      slides: scripted("slide.onEnter(function(){});"),
    });
    // Approval itself is refused while scripts are off, so no lineage can exist.
    await expect(
      t.core.approveScripts(owner, {
        presentationId: created.presentationId,
        digest: created.scripts.digest ?? "",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("an agent can never approve through the approval use case", async () => {
    const { t } = setup();
    const created = await t.core.createPresentation(agent, {
      title: "X",
      slides: scripted("slide.onEnter(function(){});"),
    });
    await expect(
      t.core.approveScripts(agent, {
        presentationId: created.presentationId,
        digest: created.scripts.digest ?? "",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
  });
});
