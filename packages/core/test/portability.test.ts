// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  agentPrincipal,
  createTestCore,
  gifBytes,
  ownerPrincipal,
  pngBytes,
  svgBytes,
} from "@pptaken/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { type DomainError, isDomainError } from "../src/errors.js";
import { sha256Hex } from "../src/sha256.js";

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

let t: ReturnType<typeof createTestCore>;
let deckId: string;
const png = pngBytes(40, 30);
const gif = gifBytes(8, 8);
const unused = pngBytes(2, 2);
const pngSha = sha256Hex(png);
const gifSha = sha256Hex(gif);

beforeEach(async () => {
  t = createTestCore();
  const created = await t.core.createPresentation(agent, {
    title: "Portable",
    lang: "es",
    theme: { css: ".x{color:red}", fonts: ["Inter"] },
    slides: [
      { id: "one", title: "One", html: "<h1>Uno</h1>", notes: "Nota secreta" },
      { id: "two", title: "Two", html: '<p data-step="1">Dos</p>', section: "Body" },
    ],
  });
  deckId = created.presentationId;
  for (const bytes of [png, gif, unused]) {
    await t.core.addAsset(agent, {
      presentationId: deckId,
      bytes,
      mediaType: bytes === gif ? "image/gif" : "image/png",
    });
  }
  await t.core.updateSlides(agent, {
    presentationId: deckId,
    expectedRevision: 1,
    upsert: [
      { id: "one", html: `<h1>Uno</h1><img src="asset:${pngSha}" alt="">` },
      { id: "two", css: `[data-slide="two"] p{background:url(asset:${gifSha.slice(0, 20)})}` },
    ],
  });
});

describe("exportPresentation", () => {
  it("returns the stored deck and only the referenced assets, without notes by default", async () => {
    const out = await t.core.exportPresentation(owner, { presentationId: deckId });
    expect(out.revision).toBe(2);
    expect(out.includesNotes).toBe(false);
    expect(out.deck.slides[0]?.notes).toBeUndefined();
    expect(out.assets.map((a) => a.sha256).sort()).toEqual([pngSha, gifSha].sort());
    const p = out.assets.find((a) => a.sha256 === pngSha);
    expect(p).toMatchObject({ mediaType: "image/png", width: 40, height: 30 });
    expect(p?.bytes).toEqual(png);
    expect(out.warnings).toEqual([]);
    const audit = await t.core.listAuditLog(owner, { target: `deck:${deckId}` });
    expect(audit.items[0]).toMatchObject({
      action: "presentation.export",
      actor: "owner",
      result: "ok",
    });
  });

  it("includes notes on request and exports older revisions", async () => {
    const out = await t.core.exportPresentation(owner, {
      presentationId: deckId,
      includeNotes: true,
      revision: 1,
    });
    expect(out.revision).toBe(1);
    expect(out.deck.slides[0]?.notes).toBe("Nota secreta");
    expect(out.assets).toEqual([]);
  });

  it("is owner only, and trashed or unknown decks are NOT_FOUND", async () => {
    expect((await failure(t.core.exportPresentation(agent, { presentationId: deckId }))).code).toBe(
      "FORBIDDEN_ACTOR",
    );
    expect(
      (
        await failure(
          t.core.exportPresentation(agentPrincipal(["decks:read"]), { presentationId: deckId }),
        )
      ).code,
    ).toBe("FORBIDDEN_ACTOR");
    expect(
      (await failure(t.core.exportPresentation(owner, { presentationId: deckId, revision: 9 })))
        .code,
    ).toBe("NOT_FOUND");
    await t.core.trashPresentation(owner, { presentationId: deckId });
    expect((await failure(t.core.exportPresentation(owner, { presentationId: deckId }))).code).toBe(
      "NOT_FOUND",
    );
    expect((await failure(t.core.exportPresentation(owner, { presentationId: "nope" }))).code).toBe(
      "NOT_FOUND",
    );
  });

  it("reports a blob missing from storage", async () => {
    await t.blobs.delete(pngSha);
    const out = await t.core.exportPresentation(owner, { presentationId: deckId });
    expect(out.assets.map((a) => a.sha256)).toEqual([gifSha]);
    expect(out.warnings.map((w) => w.code)).toEqual(["MISSING_ASSET"]);
  });
});

describe("importPresentation", () => {
  async function exported(includeNotes = true) {
    const out = await t.core.exportPresentation(owner, { presentationId: deckId, includeNotes });
    return {
      deck: JSON.parse(JSON.stringify(out.deck)),
      assets: out.assets.map((a) => ({ sha256: a.sha256, mediaType: a.mediaType, bytes: a.bytes })),
    };
  }

  it("round-trips into a fresh instance as a new presentation with the same revision-1 content", async () => {
    const data = await exported();
    const other = createTestCore({ seed: 7 });
    const result = await other.core.importPresentation(owner, data);
    expect(result).toMatchObject({ revision: 1, slideCount: 2, assetCount: 2, warnings: [] });
    const rev = await other.store.revisions.get("default", result.presentationId, 1);
    expect(rev?.document).toEqual(data.deck);
    expect(rev?.summary).toBe("Imported with 2 slide(s)");
    const assets = await other.core.listAssets(owner, { presentationId: result.presentationId });
    expect(assets.map((a) => a.sha256).sort()).toEqual([pngSha, gifSha].sort());
    expect(await other.blobs.get(pngSha)).toEqual(png);
    const audit = await other.core.listAuditLog(owner, { target: `deck:${result.presentationId}` });
    expect(audit.items[0]).toMatchObject({ action: "presentation.import", result: "ok" });
    // Importing again creates another presentation and reuses the asset rows (deduplicated by hash).
    const again = await other.core.importPresentation(owner, { ...data, title: "Copy" });
    expect(again.presentationId).not.toBe(result.presentationId);
    expect((await other.store.decks.get("default", again.presentationId))?.title).toBe("Copy");
    expect(
      (await other.core.listAssets(owner, { presentationId: again.presentationId })).length,
    ).toBe(2);
  });

  it("re-sanitizes hostile content and warns about unused and missing assets", async () => {
    const data = await exported();
    data.deck.slides[0].html = `<h1 onclick="alert(1)">Hi</h1><script>alert(2)</script><img src="asset:${"e".repeat(64)}">`;
    const result = await t.core.importPresentation(owner, {
      ...data,
      assets: [...data.assets, { mediaType: "image/png", bytes: unused }],
    });
    const rev = await t.store.revisions.get("default", result.presentationId, 1);
    expect(rev?.document.slides[0]?.html).not.toMatch(/script|onclick/);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("UNKNOWN_ASSET_REF");
    expect(codes.filter((c) => c === "UNUSED_ASSET")).toHaveLength(2); // the png (no longer used) and `unused`
    expect(result.assetCount).toBe(1);
  });

  it("verifies every asset like addAsset", async () => {
    const data = await exported();
    const bad = (assets: unknown) => t.core.importPresentation(owner, { ...data, assets } as never);
    expect(
      (await failure(bad([{ sha256: "0".repeat(64), mediaType: "image/png", bytes: png }]))).code,
    ).toBe("VALIDATION_ERROR");
    expect((await failure(bad([{ mediaType: "image/gif", bytes: png }]))).code).toBe(
      "UNSUPPORTED_MEDIA",
    );
    expect((await failure(bad([{ mediaType: "image/svg+xml", bytes: svgBytes() }]))).code).toBe(
      "UNSUPPORTED_MEDIA",
    );
    expect(
      (await failure(bad([{ mediaType: "image/png", bytes: new TextEncoder().encode("<html>") }])))
        .code,
    ).toBe("UNSUPPORTED_MEDIA");
    expect((await failure(bad([{ mediaType: "image/png", bytes: "not bytes" }]))).code).toBe(
      "VALIDATION_ERROR",
    );
    const small = createTestCore({ config: { limits: { maxAssetsPerDeck: 1 } } });
    expect((await failure(small.core.importPresentation(owner, data))).code).toBe("LIMIT_EXCEEDED");
    const tiny = createTestCore({ config: { limits: { maxAssetBytes: 10 } } });
    expect((await failure(tiny.core.importPresentation(owner, data))).code).toBe("LIMIT_EXCEEDED");
  });

  it("validates the deck and writes nothing on failure", async () => {
    const before = await t.core.listPresentations(owner);
    const err = await failure(
      t.core.importPresentation(owner, { deck: { schemaVersion: 1, title: "", slides: [] } }),
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.path).toMatch(/^deck\./);
    expect((await failure(t.core.importPresentation(owner, { deck: "nope" }))).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      (
        await failure(
          t.core.importPresentation(owner, {
            deck: { schemaVersion: 2, title: "x", slides: [{ id: "a", html: "" }] },
          }),
        )
      ).code,
    ).toBe("VALIDATION_ERROR");
    const after = await t.core.listPresentations(owner);
    expect(after.items.length).toBe(before.items.length);
  });

  it("is owner only", async () => {
    const data = await exported();
    expect((await failure(t.core.importPresentation(agent, data))).code).toBe("FORBIDDEN_ACTOR");
    const audit = await t.core.listAuditLog(owner);
    expect(audit.items[0]).toMatchObject({ action: "presentation.import", result: "denied" });
  });
});
