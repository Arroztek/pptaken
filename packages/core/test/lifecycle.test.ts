// SPDX-License-Identifier: AGPL-3.0-or-later
// Trash, restore, purge, revisions, retention and assets.

import { createHash } from "node:crypto";
import {
  agentPrincipal,
  avifBytes,
  createTestCore,
  gifBytes,
  hostileImages,
  jpegBytes,
  makeSlideInputs,
  ownerPrincipal,
  pngBytes,
  svgBytes,
  webpBytes,
} from "@pptaken/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { DAY_MS } from "../src/config.js";
import { type DomainError, isDomainError } from "../src/errors.js";
import { systemPrincipal } from "../src/principal.js";

const agent = agentPrincipal();
const owner = ownerPrincipal();
const system = systemPrincipal();

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
beforeEach(() => {
  t = createTestCore();
});

async function newDeck(title = "Deck") {
  return (await t.core.createPresentation(agent, { title, slides: makeSlideInputs(2) }))
    .presentationId;
}

describe("trash, restore and purge", () => {
  it("moves to the trash with a 30-day restore window", async () => {
    const id = await newDeck();
    const result = await t.core.trashPresentation(agent, { presentationId: id });
    expect(result).toEqual({
      presentationId: id,
      trashed: true,
      restorableUntil: t.clock.now() + 30 * DAY_MS,
    });
    expect((await failure(t.core.trashPresentation(agent, { presentationId: id }))).code).toBe(
      "NOT_FOUND",
    );
    expect(
      (
        await failure(
          t.core.updateSlides(agent, {
            presentationId: id,
            expectedRevision: 1,
            remove: ["slide-1"],
          }),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });

  it("restore is human only", async () => {
    const id = await newDeck();
    await t.core.trashPresentation(agent, { presentationId: id });
    expect(await failure(t.core.restorePresentation(agent, { presentationId: id }))).toMatchObject({
      code: "FORBIDDEN_ACTOR",
    });
    expect((await failure(t.core.restorePresentation(system, { presentationId: id }))).code).toBe(
      "FORBIDDEN_ACTOR",
    );
    const restored = await t.core.restorePresentation(owner, { presentationId: id });
    expect(restored).toMatchObject({ presentationId: id, deletedAt: null });
    expect((await t.core.getPresentation(agent, { presentationId: id })).revision).toBe(1);
    expect((await failure(t.core.restorePresentation(owner, { presentationId: id }))).code).toBe(
      "NOT_FOUND",
    );
  });

  it("purge is human only, needs the trash first and removes everything", async () => {
    const id = await newDeck();
    const keep = await newDeck("Keep");
    const shared = pngBytes(10, 10);
    const own = gifBytes(5, 5);
    await t.core.addAsset(agent, { presentationId: id, bytes: shared, mediaType: "image/png" });
    await t.core.addAsset(agent, { presentationId: keep, bytes: shared, mediaType: "image/png" });
    const ownRef = await t.core.addAsset(agent, {
      presentationId: id,
      bytes: own,
      mediaType: "image/gif",
    });
    await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      remove: ["slide-2"],
    });

    expect(await failure(t.core.purgePresentation(agent, { presentationId: id }))).toMatchObject({
      code: "FORBIDDEN_ACTOR",
    });
    expect(await failure(t.core.purgePresentation(owner, { presentationId: id }))).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await t.core.trashPresentation(agent, { presentationId: id });
    const result = await t.core.purgePresentation(owner, { presentationId: id });
    expect(result).toEqual({
      presentationId: id,
      purged: true,
      revisionsDeleted: 2,
      assetsDeleted: 1,
      blobsDeleted: 1,
    });
    expect(await t.store.decks.get("default", id)).toBeNull();
    expect(await t.store.revisions.listNumbers("default", id)).toEqual([]);
    expect(await t.blobs.has(ownRef.sha256)).toBe(false);
    // The shared asset survives for the other deck.
    const kept = await t.core.listAssets(agent, { presentationId: keep });
    expect(kept).toHaveLength(1);
    expect(await t.blobs.has(kept[0]?.sha256 as string)).toBe(true);
    expect((await failure(t.core.purgePresentation(owner, { presentationId: id }))).code).toBe(
      "NOT_FOUND",
    );
    const log = await t.core.listAuditLog(owner, { target: `deck:${id}` });
    expect(log.items.map((e) => `${e.action}:${e.result}`)).toContain("presentation.purge:ok");
    expect(log.items.map((e) => `${e.action}:${e.result}`)).toContain("presentation.purge:denied");
  });

  it("an idempotency key can be reused after the presentation is purged", async () => {
    const input = { title: "Idem", slides: makeSlideInputs(1), idempotencyKey: "k" };
    const first = await t.core.createPresentation(agent, input);
    await t.core.trashPresentation(agent, { presentationId: first.presentationId });
    expect((await t.core.createPresentation(agent, input)).replayed).toBe(true);
    await t.core.purgePresentation(owner, { presentationId: first.presentationId });
    const second = await t.core.createPresentation(agent, input);
    expect(second.replayed).toBe(false);
    expect(second.presentationId).not.toBe(first.presentationId);
  });

  it("purgeExpiredTrash deletes only what is past the retention window", async () => {
    const old = await newDeck("Old");
    const recent = await newDeck("Recent");
    await t.core.trashPresentation(agent, { presentationId: old });
    t.clock.advance(20 * DAY_MS);
    await t.core.trashPresentation(agent, { presentationId: recent });
    t.clock.advance(11 * DAY_MS);
    expect(await failure(t.core.purgeExpiredTrash(agent))).toMatchObject({
      code: "FORBIDDEN_ACTOR",
    });
    expect(await t.core.purgeExpiredTrash(system)).toEqual({ purged: [old] });
    expect(await t.store.decks.get("default", recent)).not.toBeNull();
  });
});

describe("revisions", () => {
  it("lists revisions newest first with a cursor", async () => {
    const id = await newDeck();
    for (let rev = 1; rev <= 4; rev++) {
      await t.core.updatePresentation(agent, {
        presentationId: id,
        expectedRevision: rev,
        title: `T${rev}`,
      });
    }
    const p1 = await t.core.listRevisions(agent, { presentationId: id, limit: 3 });
    expect(p1.items.map((r) => r.revision)).toEqual([5, 4, 3]);
    expect(p1.items[0]?.current).toBe(true);
    const p2 = await t.core.listRevisions(agent, {
      presentationId: id,
      limit: 3,
      cursor: p1.nextCursor as string,
    });
    expect(p2.items.map((r) => r.revision)).toEqual([2, 1]);
    expect(p2.nextCursor).toBeNull();
  });

  it("restoreRevision is human only and creates a new revision from an old one", async () => {
    const id = await newDeck("Original");
    await t.core.updatePresentation(agent, {
      presentationId: id,
      expectedRevision: 1,
      title: "Changed",
    });
    expect(
      await failure(
        t.core.restoreRevision(agent, { presentationId: id, revision: 1, expectedRevision: 2 }),
      ),
    ).toMatchObject({ code: "FORBIDDEN_ACTOR" });
    const result = await t.core.restoreRevision(owner, {
      presentationId: id,
      revision: 1,
      expectedRevision: 2,
    });
    expect(result.revision).toBe(3);
    const view = await t.core.getPresentation(agent, { presentationId: id });
    expect(view).toMatchObject({ title: "Original", revision: 3 });
    expect(
      await failure(
        t.core.restoreRevision(owner, { presentationId: id, revision: 1, expectedRevision: 2 }),
      ),
    ).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      await failure(
        t.core.restoreRevision(owner, { presentationId: id, revision: 99, expectedRevision: 3 }),
      ),
    ).toMatchObject({ code: "NOT_FOUND", path: "revision" });
  });

  it("pruneRevisions keeps the newest N and never the current one", async () => {
    const id = await newDeck();
    for (let rev = 1; rev <= 9; rev++) {
      await t.core.updatePresentation(agent, {
        presentationId: id,
        expectedRevision: rev,
        title: `T${rev}`,
      });
    }
    const other = await newDeck();
    expect(await failure(t.core.pruneRevisions(agent))).toMatchObject({ code: "FORBIDDEN_ACTOR" });
    const result = await t.core.pruneRevisions(system, { keep: 3 });
    expect(result).toEqual({ decks: 2, revisionsDeleted: 7 });
    expect(await t.store.revisions.listNumbers("default", id)).toEqual([8, 9, 10]);
    expect(await t.store.revisions.listNumbers("default", other)).toEqual([1]);
    expect(
      (await t.core.pruneRevisions(owner, { presentationId: id, keep: 1 })).revisionsDeleted,
    ).toBe(2);
    expect(await t.store.revisions.listNumbers("default", id)).toEqual([10]);
  });

  it("uses the configured retention by default", async () => {
    const t2 = createTestCore({ config: { revisionsKept: 2 } });
    const { presentationId } = await t2.core.createPresentation(agent, {
      title: "x",
      slides: makeSlideInputs(1),
    });
    for (let rev = 1; rev <= 4; rev++) {
      await t2.core.updatePresentation(agent, {
        presentationId,
        expectedRevision: rev,
        title: `T${rev}`,
      });
    }
    await t2.core.pruneRevisions(system);
    expect(await t2.store.revisions.listNumbers("default", presentationId)).toEqual([4, 5]);
  });
});

describe("assets", () => {
  it.each([
    ["image/png", pngBytes(800, 600)],
    ["image/jpeg", jpegBytes(800, 600)],
    ["image/gif", gifBytes(800, 600)],
    ["image/webp", webpBytes(800, 600)],
    ["image/avif", avifBytes(800, 600)],
  ])(
    "accepts %s, verified by content, with its size and an asset ref",
    async (mediaType, bytes) => {
      const id = await newDeck();
      const result = await t.core.addAsset(agent, {
        presentationId: id,
        bytes,
        mediaType,
        filename: "x.bin",
      });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      expect(result).toEqual({
        ref: `asset:${sha256}`,
        sha256,
        mediaType,
        bytes: bytes.length,
        width: 800,
        height: 600,
        deduplicated: false,
      });
      expect(result.ref).toMatch(/^asset:[0-9a-f]{16,64}$/);
      const got = await t.core.getAsset(agent, { ref: result.ref, presentationId: id });
      expect(got.content).toEqual(bytes);
    },
  );

  it("deduplicates by hash, within and across presentations", async () => {
    const a = await newDeck();
    const b = await newDeck();
    const bytes = pngBytes();
    const first = await t.core.addAsset(agent, {
      presentationId: a,
      bytes,
      mediaType: "image/png",
    });
    const again = await t.core.addAsset(agent, {
      presentationId: a,
      bytes,
      mediaType: "image/png",
    });
    const other = await t.core.addAsset(agent, {
      presentationId: b,
      bytes,
      mediaType: "image/png",
    });
    expect(first.deduplicated).toBe(false);
    expect(again).toEqual({ ...first, deduplicated: true });
    expect(other).toEqual({ ...first, deduplicated: true });
    const blobs = [];
    for await (const blob of t.blobs.list()) blobs.push(blob);
    expect(blobs).toHaveLength(1);
  });

  it("silences UNKNOWN_ASSET_REF once the asset belongs to the presentation", async () => {
    const id = await newDeck();
    const { ref } = await t.core.addAsset(agent, {
      presentationId: id,
      bytes: pngBytes(),
      mediaType: "image/png",
    });
    const r = await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "slide-1", html: `<img src="${ref}" alt="logo">` }],
    });
    expect(r.warnings).toEqual([]);
  });

  it("never trusts the declared type: a PNG renamed .svg or declared as JPEG is refused", async () => {
    const id = await newDeck();
    const asSvg = await failure(
      t.core.addAsset(agent, {
        presentationId: id,
        bytes: pngBytes(),
        mediaType: "image/svg+xml",
        filename: "a.svg",
      }),
    );
    expect(asSvg).toMatchObject({ code: "UNSUPPORTED_MEDIA", path: "mediaType" });
    expect(asSvg.hint).toContain("image/png");
    const asJpeg = await failure(
      t.core.addAsset(agent, { presentationId: id, bytes: pngBytes(), mediaType: "image/jpeg" }),
    );
    expect(asJpeg.code).toBe("UNSUPPORTED_MEDIA");
  });

  it("rejects SVG uploads with a hint to inline them", async () => {
    const id = await newDeck();
    const error = await failure(
      t.core.addAsset(agent, { presentationId: id, bytes: svgBytes(), mediaType: "image/svg+xml" }),
    );
    expect(error).toMatchObject({ code: "UNSUPPORTED_MEDIA", path: "bytes" });
    expect(error.hint).toContain("inline");
    expect(error.details?.accepted).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
    ]);
  });

  it.each([
    ["PNG/HTML polyglot", hostileImages.pngWithTrailingHtml(), "image/png"],
    ["GIF/script polyglot", hostileImages.gifWithTrailingScript(), "image/gif"],
    ["SVG embedding a PNG", hostileImages.svgWithPngInside(), "image/png"],
    ["HTML", hostileImages.html(), "image/png"],
    ["truncated PNG", hostileImages.truncatedPng(), "image/png"],
    ["truncated JPEG", hostileImages.truncatedJpeg(), "image/jpeg"],
    ["truncated WebP", hostileImages.truncatedWebp(), "image/webp"],
    ["truncated AVIF", hostileImages.truncatedAvif(), "image/avif"],
  ])("rejects %s", async (_name, bytes, mediaType) => {
    const id = await newDeck();
    const error = await failure(t.core.addAsset(agent, { presentationId: id, bytes, mediaType }));
    expect(error.code).toBe("UNSUPPORTED_MEDIA");
    const blobs = [];
    for await (const blob of t.blobs.list()) blobs.push(blob);
    expect(blobs).toEqual([]);
  });

  it("enforces size, pixel and per-presentation limits", async () => {
    const small = createTestCore({
      config: {
        limits: {
          maxAssetBytes: 200,
          maxAssetsPerDeck: 2,
          maxAssetBytesPerDeck: 10_000,
          maxImagePixels: 10_000,
        },
      },
    });
    const { presentationId } = await small.core.createPresentation(agent, {
      title: "x",
      slides: makeSlideInputs(1),
    });
    const add = (bytes: Uint8Array) =>
      small.core.addAsset(agent, { presentationId, bytes, mediaType: "image/png" });
    expect(await failure(add(pngBytes(4, 4, 400)))).toMatchObject({
      code: "LIMIT_EXCEEDED",
      path: "bytes",
    });
    expect(await failure(add(hostileImages.hugePng()))).toMatchObject({ code: "LIMIT_EXCEEDED" });
    await add(pngBytes(1, 1, 100));
    await add(pngBytes(1, 2, 100));
    expect(await failure(add(pngBytes(1, 3, 10)))).toMatchObject({
      code: "LIMIT_EXCEEDED",
      details: { limit: 2, received: 3 },
    });
    const bytesLimited = createTestCore({ config: { limits: { maxAssetBytesPerDeck: 300 } } });
    const d = await bytesLimited.core.createPresentation(agent, {
      title: "x",
      slides: makeSlideInputs(1),
    });
    await bytesLimited.core.addAsset(agent, {
      presentationId: d.presentationId,
      bytes: pngBytes(1, 1, 150),
      mediaType: "image/png",
    });
    expect(
      await failure(
        bytesLimited.core.addAsset(agent, {
          presentationId: d.presentationId,
          bytes: pngBytes(1, 2, 150),
          mediaType: "image/png",
        }),
      ),
    ).toMatchObject({ code: "LIMIT_EXCEEDED", path: "bytes" });
  });

  it("checks scope, presentation and input", async () => {
    const id = await newDeck();
    const reader = agentPrincipal(["decks:read"]);
    expect(
      (
        await failure(
          t.core.addAsset(reader, {
            presentationId: id,
            bytes: pngBytes(),
            mediaType: "image/png",
          }),
        )
      ).code,
    ).toBe("FORBIDDEN_SCOPE");
    expect(
      (
        await failure(
          t.core.addAsset(agent, {
            presentationId: "01JDXXXXXXXXXXXXXXXXXXXXXX",
            bytes: pngBytes(),
            mediaType: "image/png",
          }),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await failure(
          t.core.addAsset(agent, {
            presentationId: id,
            bytes: new Uint8Array(0),
            mediaType: "image/png",
          }),
        )
      ).code,
    ).toBe("VALIDATION_ERROR");
    expect(
      (
        await failure(
          t.core.addAsset(agent, {
            presentationId: id,
            bytes: "x" as unknown as Uint8Array,
            mediaType: "image/png",
          }),
        )
      ).code,
    ).toBe("VALIDATION_ERROR");
    expect((await failure(t.core.getAsset(agent, { ref: "asset:zz" }))).code).toBe(
      "VALIDATION_ERROR",
    );
    expect((await failure(t.core.getAsset(agent, { sha256: "0".repeat(64) }))).code).toBe(
      "NOT_FOUND",
    );
  });

  it("getAsset with presentationId only serves that presentation's assets", async () => {
    const a = await newDeck();
    const b = await newDeck();
    const { ref } = await t.core.addAsset(agent, {
      presentationId: a,
      bytes: pngBytes(),
      mediaType: "image/png",
    });
    expect((await failure(t.core.getAsset(agent, { ref, presentationId: b }))).code).toBe(
      "NOT_FOUND",
    );
    expect((await t.core.getAsset(agent, { ref })).asset.ref).toBe(ref);
  });
});

describe("collectOrphanBlobs", () => {
  it("deletes unreferenced blobs past the grace period only", async () => {
    const id = await newDeck();
    const used = await t.core.addAsset(agent, {
      presentationId: id,
      bytes: pngBytes(),
      mediaType: "image/png",
    });
    const orphanOld = await t.blobs.put(Uint8Array.of(1, 2, 3));
    t.blobs.setCreatedAt(orphanOld.sha256, t.clock.now() - 2 * 60 * 60 * 1000);
    const orphanFresh = await t.blobs.put(Uint8Array.of(4, 5, 6));
    expect(await failure(t.core.collectOrphanBlobs(agent))).toMatchObject({
      code: "FORBIDDEN_ACTOR",
    });
    const dry = await t.core.collectOrphanBlobs(system, { dryRun: true });
    expect(dry.deleted).toEqual([orphanOld.sha256]);
    expect(await t.blobs.has(orphanOld.sha256)).toBe(true);
    const result = await t.core.collectOrphanBlobs(system);
    expect(result).toEqual({ scanned: 3, deleted: [orphanOld.sha256] });
    expect(await t.blobs.has(used.sha256)).toBe(true);
    expect(await t.blobs.has(orphanFresh.sha256)).toBe(true);
    const all = await t.core.collectOrphanBlobs(system, { graceMs: 0 });
    expect(all.deleted).toEqual([orphanFresh.sha256]);
  });
});
