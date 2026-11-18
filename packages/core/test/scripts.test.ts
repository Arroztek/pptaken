// SPDX-License-Identifier: AGPL-3.0-or-later
// Interactive mode (ADR-020) in the core: the digest the owner's consent binds to, the derived state, the
// sanitizer profile chosen on ingest, approval and revocation (human only, audited), and every path that creates
// a revision or a deck (edits, restore, import, PowerPoint, purge).
import { agentPrincipal, createTestCore, ownerPrincipal } from "@pptaken/testing";
import { describe, expect, it } from "vitest";
import { type DomainError, isDomainError } from "../src/errors.js";
import { scriptsDigest as digestOf, scriptsStateOf } from "../src/scripts.js";

/** Loosely typed digest helper: the tests build partial decks on purpose. */
const scriptsDigest = (deck: unknown) => digestOf(deck as Parameters<typeof digestOf>[0]);

const owner = ownerPrincipal();
const agent = agentPrincipal();

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error("Expected a DomainError");
}

const slides = [
  { id: "a", html: "<p>a</p>" },
  {
    id: "b",
    html: "<canvas width='10' height='10'></canvas><button type='button' onclick='x()'>Go</button>",
    script: "slide.onEnter(function(){});",
  },
];

async function scriptedDeck(enabled = true) {
  const t = createTestCore({ config: { scriptsEnabled: enabled } });
  const r = await t.core.createPresentation(agent, { title: "S", slides, libs: ["uplot@1"] });
  return { t, id: r.presentationId, created: r };
}

describe("scriptsDigest", () => {
  const slide = { id: "a", html: "", title: "", script: "x()" };
  const base = { libs: ["uplot@1"], slides: [slide] };

  it("is null without scripts and libraries, and stable otherwise", () => {
    expect(scriptsDigest({ slides: [{ id: "a", html: "<p>", title: "" }] })).toBeNull();
    expect(scriptsDigest(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(scriptsDigest(base)).toBe(scriptsDigest(structuredClone(base)));
  });

  it("changes with any script byte, the library list, or which slide holds the script", () => {
    const d = scriptsDigest(base);
    expect(scriptsDigest({ ...base, slides: [{ ...slide, script: "x() " }] })).not.toBe(d);
    expect(scriptsDigest({ ...base, libs: [] })).not.toBe(d);
    expect(scriptsDigest({ ...base, slides: [{ ...slide, id: "b" }] })).not.toBe(d);
    expect(scriptsDigest({ ...base, slides: [{ ...slide, html: "<b>" }] })).toBe(d);
  });

  it("derives the state", () => {
    expect(scriptsStateOf(null, null)).toBe("none");
    expect(scriptsStateOf("a".repeat(64), null)).toBe("pending");
    expect(scriptsStateOf("a".repeat(64), "b".repeat(64))).toBe("pending");
    expect(scriptsStateOf("a".repeat(64), "a".repeat(64))).toBe("approved");
  });
});

describe("ingest", () => {
  it("uses the interactive profile for scripted decks: controls kept, on* removed", async () => {
    const { t, id, created } = await scriptedDeck();
    expect(created.scripts.state).toBe("pending");
    expect(created.scripts.slides).toEqual(["b"]);
    expect(created.warnings.map((w) => w.code)).toContain("REMOVED_ATTRIBUTE");
    const view = await t.core.getPresentation(agent, { presentationId: id, include: ["slides"] });
    const html = view.slides?.[1]?.html ?? "";
    expect(html).toContain("<canvas");
    expect(html).toContain('<button type="button">');
    expect(html).not.toContain("onclick");
    expect(view.slides?.[1]?.script).toBe("slide.onEnter(function(){});");
  });

  it("keeps the safe profile for decks without scripts", async () => {
    const t = createTestCore();
    const r = await t.core.createPresentation(agent, {
      title: "Plain",
      slides: [{ html: "<canvas></canvas><p>x</p>" }],
    });
    expect(r.scripts).toMatchObject({ digest: null, state: "none" });
    expect(r.warnings.map((w) => w.code)).toContain("REMOVED_ELEMENT");
  });

  it("points <script> in html to the script field", async () => {
    const t = createTestCore();
    const r = await t.core.createPresentation(agent, {
      title: "X",
      slides: [{ html: "<script>alert(1)</script><p>x</p>" }],
    });
    expect(r.warnings.find((w) => w.name === "script")?.message).toMatch(/`script` field/);
  });

  it("refuses scripts that could escape their element, and too much code", async () => {
    const t = createTestCore();
    for (const script of ["a='</script>'", "<!--", "x\u0000"]) {
      const e = await failure(
        t.core.createPresentation(agent, { title: "X", slides: [{ html: "<p>", script }] }),
      );
      expect(e.code).toBe("VALIDATION_ERROR");
      expect(e.path).toBe("slides[0].script");
    }
    const big = "x".repeat(128 * 1024);
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, html: "<p>", script: big }));
    expect(
      (await failure(t.core.createPresentation(agent, { title: "X", slides: many }))).code,
    ).toBe("VALIDATION_ERROR");
    expect(
      (
        await failure(
          t.core.createPresentation(agent, {
            title: "X",
            slides: [{ html: "<p>" }],
            libs: ["d3@7"],
          }),
        )
      ).code,
    ).toBe("VALIDATION_ERROR");
  });

  it("stores libs as vendored script references and refuses one not stored on the instance", async () => {
    const { t, id } = await scriptedDeck();
    const view = await t.core.getPresentation(agent, { presentationId: id });
    expect(view.libs).toEqual([
      {
        name: "uPlot",
        version: "1.6.32",
        sha256: "19c8d4c6ad88929a79f4ae49d6f7161566dfd0ba3d15cc495e974f787eb78f1f",
        source: "https://registry.npmjs.org/uplot/-/uplot-1.6.32.tgz#dist/uPlot.iife.min.js",
      },
    ]);
    const unknown = { name: "d3", sha256: "b".repeat(64), source: "https://cdn.example/d3.js" };
    const e = await failure(
      t.core.createPresentation(agent, { title: "X", slides: [{ html: "<p>" }], libs: [unknown] }),
    );
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.path).toBe("libs[0].sha256");
  });
});

describe("approval", () => {
  it("is human only: agents are refused and the refusal is audited", async () => {
    const { t, id, created } = await scriptedDeck();
    const digest = created.scripts.digest as string;
    const e = await failure(t.core.approveScripts(agent, { presentationId: id, digest }));
    expect(e.code).toBe("FORBIDDEN_ACTOR");
    const e2 = await failure(t.core.revokeScripts(agent, { presentationId: id }));
    expect(e2.code).toBe("FORBIDDEN_ACTOR");
    const log = await t.core.listAuditLog(owner, { target: `deck:${id}` });
    expect(
      log.items
        .filter((x) => x.result === "denied")
        .map((x) => x.action)
        .sort(),
    ).toEqual(["presentation.scripts_approve", "presentation.scripts_revoke"]);
  });

  it("binds to the digest the owner reviewed", async () => {
    const { t, id, created } = await scriptedDeck();
    const digest = created.scripts.digest as string;
    const stale = await failure(
      t.core.approveScripts(owner, { presentationId: id, digest: "f".repeat(64) }),
    );
    expect(stale.code).toBe("REVISION_CONFLICT");
    const st = await t.core.approveScripts(owner, { presentationId: id, digest });
    expect(st).toMatchObject({ state: "approved", approvedDigest: digest, enabled: true });
    const log = await t.core.listAuditLog(owner, { target: `deck:${id}` });
    expect(log.items[0]).toMatchObject({
      action: "presentation.scripts_approve",
      result: "ok",
      actor: "owner",
      detail: { digest, revision: 1 },
    });
  });

  it("is refused when the instance switch is off", async () => {
    const { t, id, created } = await scriptedDeck(false);
    const e = await failure(
      t.core.approveScripts(owner, {
        presentationId: id,
        digest: created.scripts.digest as string,
      }),
    );
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.message).toMatch(/disabled/);
  });

  it("goes back to pending on any script change, restore included, and revokes", async () => {
    const { t, id, created } = await scriptedDeck();
    const d1 = created.scripts.digest as string;
    await t.core.approveScripts(owner, { presentationId: id, digest: d1 });
    const r2 = await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "b", script: "slide.onEnter(function(){ evil(); });" }],
    });
    expect(r2.scripts.state).toBe("pending");
    expect((await t.core.getScriptsStatus(agent, { presentationId: id })).state).toBe("pending");
    // Restoring revision 1 restores code the owner approved: approved again, without a new approval.
    const r3 = await t.core.restoreRevision(owner, {
      presentationId: id,
      revision: 1,
      expectedRevision: 2,
    });
    expect(r3.scripts).toMatchObject({ state: "approved", digest: d1 });
    // Removing every script and library: state none.
    const r4 = await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 3,
      upsert: [{ id: "b", script: null }],
    });
    expect(r4.scripts.state).toBe("pending"); // libs remain
    const r5 = await t.core.updatePresentation(agent, {
      presentationId: id,
      expectedRevision: 4,
      libs: null,
    });
    expect(r5.scripts).toMatchObject({ state: "none", digest: null });
    const revoked = await t.core.revokeScripts(owner, { presentationId: id });
    expect(revoked.approvedDigest).toBeNull();
  });
});

describe("other paths", () => {
  it("purge deletes the approval with the deck", async () => {
    const { t, id, created } = await scriptedDeck();
    await t.core.approveScripts(owner, {
      presentationId: id,
      digest: created.scripts.digest as string,
    });
    await t.core.trashPresentation(agent, { presentationId: id });
    await t.core.purgePresentation(owner, { presentationId: id });
    expect(await t.store.scriptApprovals.get("default", id)).toBeNull();
  });

  it("a .pkn import keeps the scripts and starts pending; it never inherits an approval", async () => {
    const { t, id, created } = await scriptedDeck();
    await t.core.approveScripts(owner, {
      presentationId: id,
      digest: created.scripts.digest as string,
    });
    const exported = await t.core.exportPresentation(owner, { presentationId: id });
    const imported = await t.core.importPresentation(owner, {
      deck: exported.deck,
      assets: [],
    });
    expect(imported.scripts).toMatchObject({ state: "pending", digest: created.scripts.digest });
    const st = await t.core.getScriptsStatus(owner, { presentationId: imported.presentationId });
    expect(st.state).toBe("pending");
  });

  it("a PowerPoint import never keeps scripts, whatever the converter returns", async () => {
    const t = createTestCore({
      convertPptx: async () => ({
        deck: {
          schemaVersion: 1,
          title: "P",
          libs: ["uplot@1"],
          slides: [{ id: "a", html: "<p>a</p>", script: "steal()" }],
        },
        assets: [],
        warnings: [],
      }),
    });
    const r = await t.core.importPptx(owner, { bytes: new Uint8Array([0x50, 0x4b, 3, 4]) });
    expect(r.scripts).toMatchObject({ state: "none", digest: null });
    const view = await t.core.getPresentation(owner, {
      presentationId: r.presentationId,
      include: ["slides"],
    });
    expect(view.slides?.[0]?.script).toBeUndefined();
    expect(view.libs).toBeUndefined();
  });
});

describe("getScriptsReview (ADR-021 approval screen)", () => {
  it("returns every script with its hash and UTF-8 size, from the revision the digest binds", async () => {
    const { t, id, created } = await scriptedDeck();
    const review = await t.core.getScriptsReview(owner, { presentationId: id });
    expect(review.digest).toBe(created.scripts.digest);
    expect(review.sources).toEqual([
      {
        slideId: "b",
        index: 1,
        source: "slide.onEnter(function(){});",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        bytes: 28,
      },
    ]);
    // Agents may read the code they wrote, never approve it.
    expect((await t.core.getScriptsReview(agent, { presentationId: id })).sources).toHaveLength(1);
    const plain = await t.core.createPresentation(agent, {
      title: "P",
      slides: [{ html: "<p>x</p>" }],
    });
    const none = await t.core.getScriptsReview(owner, { presentationId: plain.presentationId });
    expect(none).toMatchObject({ digest: null, state: "none", sources: [] });
    const multibyte = await t.core.createPresentation(agent, {
      title: "M",
      slides: [{ id: "m", html: "<p>m</p>", script: "var s = 'ñ';" }],
    });
    const mb = await t.core.getScriptsReview(owner, { presentationId: multibyte.presentationId });
    expect(mb.sources[0]?.bytes).toBe(13);
  });
});
