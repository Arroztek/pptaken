// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract suites of the storage ports. Every adapter (in-memory, storage-sqlite, a future storage-postgres)
// must pass them unchanged: they are the definition of the ports' behaviour.
import type { UnitOfWork } from "@pptaken/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeAssetRecord,
  makeAuditEntry,
  makeDeck,
  makeDeckRecord,
  makeRevisionRecord,
  makeSlides,
  TEST_WORKSPACE,
} from "../factories.js";

export interface StorageHarness {
  uow: UnitOfWork;
  /** Called after each test (close connections, delete temp files). */
  cleanup?: () => Promise<void> | void;
}

/** Creates a fresh, empty storage for each test. */
export type StorageFactory = () => Promise<StorageHarness> | StorageHarness;

const WS = TEST_WORKSPACE;
const OTHER_WS = "other-workspace";

function useHarness(factory: StorageFactory): () => UnitOfWork {
  let harness: StorageHarness | undefined;
  beforeEach(async () => {
    harness = await factory();
  });
  afterEach(async () => {
    await harness?.cleanup?.();
    harness = undefined;
  });
  return () => {
    if (harness === undefined) throw new Error("Storage harness not ready");
    return harness.uow;
  };
}

export function runDeckRepositoryContract(name: string, factory: StorageFactory): void {
  describe(`${name}: DeckRepository contract`, () => {
    const uow = useHarness(factory);

    it("round-trips every field, including nulls", async () => {
      const deck = makeDeckRecord({ lang: null, title: "Ünïcode ✓ \"quotes\" 'x'" });
      await uow().decks.insert(deck);
      expect(await uow().decks.get(WS, deck.id)).toEqual(deck);
      const withToken = makeDeckRecord({ createdBy: { actor: "owner", tokenId: null } });
      await uow().decks.insert(withToken);
      expect(await uow().decks.get(WS, withToken.id)).toEqual(withToken);
    });

    it("returns null for unknown ids and isolates workspaces", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      expect(await uow().decks.get(WS, "01JDNOPE0000000000000000000")).toBeNull();
      expect(await uow().decks.get(OTHER_WS, deck.id)).toBeNull();
      await uow().decks.insert({ ...deck, workspaceId: OTHER_WS, title: "Other" });
      expect((await uow().decks.get(OTHER_WS, deck.id))?.title).toBe("Other");
      expect((await uow().decks.get(WS, deck.id))?.title).toBe(deck.title);
    });

    it("rejects a duplicate id in the same workspace", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      await expect(uow().decks.insert(deck)).rejects.toThrow();
    });

    it("returns copies that do not alias stored state", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      const read = await uow().decks.get(WS, deck.id);
      if (read === null) throw new Error("missing");
      read.title = "mutated";
      read.createdBy.actor = "system";
      expect(await uow().decks.get(WS, deck.id)).toEqual(deck);
    });

    it("updateHead is a compare-and-set on currentRevision", async () => {
      const deck = makeDeckRecord({ currentRevision: 3 });
      await uow().decks.insert(deck);
      const head = { currentRevision: 4, title: "New", lang: "es", slideCount: 7, updatedAt: 99 };
      expect(await uow().decks.updateHead(WS, deck.id, 2, head)).toBe(false);
      expect(await uow().decks.updateHead(WS, deck.id, 3, head)).toBe(true);
      expect(await uow().decks.get(WS, deck.id)).toEqual({ ...deck, ...head });
      expect(await uow().decks.updateHead(WS, deck.id, 3, head)).toBe(false);
      expect(await uow().decks.updateHead(OTHER_WS, deck.id, 4, head)).toBe(false);
      expect(await uow().decks.updateHead(WS, "01JDNOPE0000000000000000000", 1, head)).toBe(false);
    });

    it("updateHead refuses a deck in the trash", async () => {
      const deck = makeDeckRecord({ deletedAt: 5 });
      await uow().decks.insert(deck);
      const head = { currentRevision: 2, title: "x", lang: null, slideCount: 1, updatedAt: 6 };
      expect(await uow().decks.updateHead(WS, deck.id, 1, head)).toBe(false);
    });

    it("sets and clears deletedAt", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      expect(await uow().decks.setDeletedAt(WS, deck.id, 1234)).toBe(true);
      expect((await uow().decks.get(WS, deck.id))?.deletedAt).toBe(1234);
      expect(await uow().decks.setDeletedAt(WS, deck.id, null)).toBe(true);
      expect((await uow().decks.get(WS, deck.id))?.deletedAt).toBeNull();
      expect(await uow().decks.setDeletedAt(WS, "01JDNOPE0000000000000000000", 1)).toBe(false);
    });

    it("lists newest first, excludes the trash by default and paginates by id", async () => {
      const decks = [1, 2, 3, 4, 5].map((i) => makeDeckRecord({ title: `Deck ${i}` }));
      for (const d of decks) await uow().decks.insert(d);
      await uow().decks.setDeletedAt(WS, (decks[1] as { id: string }).id, 10);
      await uow().decks.insert(makeDeckRecord({ workspaceId: OTHER_WS }));
      const all = await uow().decks.list({ workspaceId: WS, limit: 10 });
      expect(all.map((d) => d.title)).toEqual(["Deck 5", "Deck 4", "Deck 3", "Deck 1"]);
      const page1 = await uow().decks.list({ workspaceId: WS, limit: 2 });
      expect(page1.map((d) => d.title)).toEqual(["Deck 5", "Deck 4"]);
      const page2 = await uow().decks.list({
        workspaceId: WS,
        limit: 2,
        beforeId: (page1[1] as { id: string }).id,
      });
      expect(page2.map((d) => d.title)).toEqual(["Deck 3", "Deck 1"]);
      const trash = await uow().decks.list({ workspaceId: WS, limit: 10, trash: "only" });
      expect(trash.map((d) => d.title)).toEqual(["Deck 2"]);
    });

    it("searches titles case-insensitively (ASCII) and treats LIKE wildcards literally", async () => {
      for (const title of [
        "Quarterly Review",
        "quarterly plan",
        "Roadmap",
        "100% done",
        "a_b",
        "axb",
      ]) {
        await uow().decks.insert(makeDeckRecord({ title }));
      }
      const find = async (titleContains: string) =>
        (await uow().decks.list({ workspaceId: WS, limit: 10, titleContains }))
          .map((d) => d.title)
          .sort();
      expect(await find("QUARTERLY")).toEqual(["Quarterly Review", "quarterly plan"]);
      expect(await find("%")).toEqual(["100% done"]);
      expect(await find("_")).toEqual(["a_b"]);
      expect(await find("nothing")).toEqual([]);
    });

    it("lists the trash expired before a cutoff, oldest first", async () => {
      const a = makeDeckRecord({ deletedAt: 300 });
      const b = makeDeckRecord({ deletedAt: 100 });
      const c = makeDeckRecord({ deletedAt: 900 });
      const live = makeDeckRecord();
      for (const d of [a, b, c, live]) await uow().decks.insert(d);
      const expired = await uow().decks.listTrashedBefore(WS, 500, 10);
      expect(expired.map((d) => d.id)).toEqual([b.id, a.id]);
      expect(await uow().decks.listTrashedBefore(WS, 500, 1)).toHaveLength(1);
      expect(await uow().decks.listTrashedBefore(OTHER_WS, 500, 10)).toEqual([]);
    });

    it("deletes a deck without revisions or assets", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      expect(await uow().decks.delete(WS, deck.id)).toBe(true);
      expect(await uow().decks.get(WS, deck.id)).toBeNull();
      expect(await uow().decks.delete(WS, deck.id)).toBe(false);
    });

    it("refuses to delete a deck that still has revisions", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      await uow().revisions.insert(makeRevisionRecord(deck));
      await expect(uow().decks.delete(WS, deck.id)).rejects.toThrow();
      expect(await uow().decks.get(WS, deck.id)).not.toBeNull();
    });
  });
}

export function runRevisionRepositoryContract(name: string, factory: StorageFactory): void {
  describe(`${name}: RevisionRepository contract`, () => {
    const uow = useHarness(factory);

    async function deckWithRevisions(count: number) {
      const deck = makeDeckRecord({ currentRevision: count });
      await uow().decks.insert(deck);
      for (let n = 1; n <= count; n++) {
        await uow().revisions.insert(
          makeRevisionRecord(deck, { number: n, summary: `rev ${n}`, createdAt: 1000 + n }),
        );
      }
      return deck;
    }

    it("round-trips the document exactly", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      const document = makeDeck({
        title: "Ünïcode ✓ 🎉",
        lang: "es-PE",
        theme: { css: "h1{color:red}", fonts: ["Inter"] },
        targetMinutes: 20,
        slides: [
          ...makeSlides(2),
          { id: "x", title: "", html: "<p>  \\ \" '</p>", section: "S", durationHintSec: 30 },
        ],
      });
      const rev = makeRevisionRecord(deck, {
        document,
        createdBy: { actor: "owner", tokenId: null },
      });
      await uow().revisions.insert(rev);
      expect(await uow().revisions.get(WS, deck.id, 1)).toEqual(rev);
      expect(await uow().revisions.get(WS, deck.id, 2)).toBeNull();
      expect(await uow().revisions.get(OTHER_WS, deck.id, 1)).toBeNull();
    });

    it("rejects a duplicate revision number", async () => {
      const deck = await deckWithRevisions(1);
      await expect(
        uow().revisions.insert(makeRevisionRecord(deck, { number: 1 })),
      ).rejects.toThrow();
    });

    it("lists newest first without documents and paginates", async () => {
      const deck = await deckWithRevisions(5);
      const page = await uow().revisions.list(WS, deck.id, { limit: 2 });
      expect(page.map((r) => r.number)).toEqual([5, 4]);
      expect(page[0]).not.toHaveProperty("document");
      expect(page[0]).toMatchObject({ summary: "rev 5", createdAt: 1005, slideCount: 3 });
      const next = await uow().revisions.list(WS, deck.id, { limit: 10, beforeNumber: 4 });
      expect(next.map((r) => r.number)).toEqual([3, 2, 1]);
    });

    it("lists numbers ascending and deletes selected revisions", async () => {
      const deck = await deckWithRevisions(5);
      expect(await uow().revisions.listNumbers(WS, deck.id)).toEqual([1, 2, 3, 4, 5]);
      expect(await uow().revisions.deleteMany(WS, deck.id, [1, 3, 42])).toBe(2);
      expect(await uow().revisions.listNumbers(WS, deck.id)).toEqual([2, 4, 5]);
      expect(await uow().revisions.deleteMany(WS, deck.id, [])).toBe(0);
      expect(await uow().revisions.deleteAllForDeck(WS, deck.id)).toBe(3);
      expect(await uow().revisions.listNumbers(WS, deck.id)).toEqual([]);
    });

    it("returns documents that do not alias stored state", async () => {
      const deck = await deckWithRevisions(1);
      const read = await uow().revisions.get(WS, deck.id, 1);
      if (read === null) throw new Error("missing");
      read.document.title = "mutated";
      (read.document.slides[0] as { html: string }).html = "mutated";
      const again = await uow().revisions.get(WS, deck.id, 1);
      expect(again?.document.title).toBe("Test deck");
      expect(again?.document.slides[0]?.html).not.toBe("mutated");
    });
  });
}

export function runAssetRepositoryContract(name: string, factory: StorageFactory): void {
  describe(`${name}: AssetRepository contract`, () => {
    const uow = useHarness(factory);

    it("inserts once and reads back", async () => {
      const asset = makeAssetRecord({ width: null, height: null, mediaType: "image/avif" });
      expect(await uow().assets.insertIfAbsent(asset)).toBe(true);
      expect(await uow().assets.insertIfAbsent({ ...asset, bytes: 1 })).toBe(false);
      expect(await uow().assets.get(WS, asset.sha256)).toEqual(asset);
      expect(await uow().assets.get(OTHER_WS, asset.sha256)).toBeNull();
    });

    it("links assets to decks idempotently and reports stats", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      const a = makeAssetRecord({ bytes: 100 });
      const b = makeAssetRecord({ bytes: 50 });
      await uow().assets.insertIfAbsent(a);
      await uow().assets.insertIfAbsent(b);
      expect(await uow().assets.link(WS, deck.id, a.sha256, 1)).toBe(true);
      expect(await uow().assets.link(WS, deck.id, a.sha256, 2)).toBe(false);
      expect(await uow().assets.link(WS, deck.id, b.sha256, 3)).toBe(true);
      expect(await uow().assets.isLinked(WS, deck.id, a.sha256)).toBe(true);
      expect(await uow().assets.isLinked(OTHER_WS, deck.id, a.sha256)).toBe(false);
      expect(await uow().assets.statsForDeck(WS, deck.id)).toEqual({ count: 2, bytes: 150 });
      const listed = await uow().assets.listForDeck(WS, deck.id);
      expect(listed.map((x) => x.sha256)).toEqual([a.sha256, b.sha256].sort());
    });

    it("unlinks a deck and deletes assets nobody links", async () => {
      const d1 = makeDeckRecord();
      const d2 = makeDeckRecord();
      await uow().decks.insert(d1);
      await uow().decks.insert(d2);
      const shared = makeAssetRecord();
      const own = makeAssetRecord();
      await uow().assets.insertIfAbsent(shared);
      await uow().assets.insertIfAbsent(own);
      await uow().assets.link(WS, d1.id, shared.sha256, 1);
      await uow().assets.link(WS, d1.id, own.sha256, 1);
      await uow().assets.link(WS, d2.id, shared.sha256, 1);
      expect(await uow().assets.deleteIfUnlinked(WS, own.sha256)).toBe(false);
      expect(await uow().assets.unlinkAllForDeck(WS, d1.id)).toEqual(
        [shared.sha256, own.sha256].sort(),
      );
      expect(await uow().assets.statsForDeck(WS, d1.id)).toEqual({ count: 0, bytes: 0 });
      expect(await uow().assets.deleteIfUnlinked(WS, shared.sha256)).toBe(false);
      expect(await uow().assets.deleteIfUnlinked(WS, own.sha256)).toBe(true);
      expect(await uow().assets.get(WS, own.sha256)).toBeNull();
      expect(await uow().assets.deleteIfUnlinked(WS, own.sha256)).toBe(false);
    });

    it("knows whether any workspace references a hash", async () => {
      const asset = makeAssetRecord({ workspaceId: OTHER_WS });
      expect(await uow().assets.isReferencedAnywhere(asset.sha256)).toBe(false);
      await uow().assets.insertIfAbsent(asset);
      expect(await uow().assets.isReferencedAnywhere(asset.sha256)).toBe(true);
    });
  });
}

export function runAuditLogContract(name: string, factory: StorageFactory): void {
  describe(`${name}: AuditLog contract`, () => {
    const uow = useHarness(factory);

    it("appends and lists newest first with filters and pagination", async () => {
      const entries = [1, 2, 3, 4].map((i) =>
        makeAuditEntry({
          at: i,
          target: i % 2 ? "deck:a" : "deck:b",
          detail: { n: i, nested: { ok: true } },
        }),
      );
      for (const e of entries) await uow().audit.append(e);
      await uow().audit.append(makeAuditEntry({ workspaceId: OTHER_WS }));
      const all = await uow().audit.list(WS, { limit: 10 });
      expect(all.map((e) => e.at)).toEqual([4, 3, 2, 1]);
      expect(all[3]).toEqual(entries[0]);
      const page = await uow().audit.list(WS, {
        limit: 10,
        beforeId: (all[1] as { id: string }).id,
      });
      expect(page.map((e) => e.at)).toEqual([2, 1]);
      const filtered = await uow().audit.list(WS, { limit: 10, target: "deck:a" });
      expect(filtered.map((e) => e.at)).toEqual([3, 1]);
    });

    it("stores entries with null optional fields", async () => {
      const entry = makeAuditEntry({
        tokenId: null,
        target: null,
        ip: null,
        detail: null,
        result: "denied",
      });
      await uow().audit.append(entry);
      expect(await uow().audit.list(WS, { limit: 1 })).toEqual([entry]);
    });
  });
}

export function runIdempotencyRepositoryContract(name: string, factory: StorageFactory): void {
  describe(`${name}: IdempotencyRepository contract`, () => {
    const uow = useHarness(factory);

    it("stores, rejects duplicates and deletes by deck", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      const record = {
        workspaceId: WS,
        key: "agent:tok:k1",
        requestHash: "ab".repeat(32),
        deckId: deck.id,
        result: { presentationId: deck.id, revision: 1, warnings: [] },
        createdAt: 5,
      };
      await uow().idempotency.insert(record);
      expect(await uow().idempotency.get(WS, record.key)).toEqual(record);
      expect(await uow().idempotency.get(OTHER_WS, record.key)).toBeNull();
      await expect(uow().idempotency.insert(record)).rejects.toThrow();
      expect(await uow().idempotency.deleteForDeck(WS, deck.id)).toBe(1);
      expect(await uow().idempotency.get(WS, record.key)).toBeNull();
    });
  });
}

export function runScriptApprovalRepositoryContract(name: string, factory: StorageFactory): void {
  describe(`${name}: ScriptApprovalRepository contract`, () => {
    const uow = useHarness(factory);

    it("sets, replaces, isolates workspaces and deletes", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      expect(await uow().scriptApprovals.get(WS, deck.id)).toBeNull();
      const first = {
        workspaceId: WS,
        deckId: deck.id,
        digest: "a".repeat(64),
        approvedAt: 10,
        approvedBy: { actor: "owner" as const, tokenId: null },
      };
      await uow().scriptApprovals.set(first);
      expect(await uow().scriptApprovals.get(WS, deck.id)).toEqual(first);
      expect(await uow().scriptApprovals.get(OTHER_WS, deck.id)).toBeNull();
      const second = { ...first, digest: "b".repeat(64), approvedAt: 20 };
      await uow().scriptApprovals.set(second);
      expect(await uow().scriptApprovals.get(WS, deck.id)).toEqual(second);
      expect(await uow().scriptApprovals.delete(WS, deck.id)).toBe(true);
      expect(await uow().scriptApprovals.delete(WS, deck.id)).toBe(false);
      expect(await uow().scriptApprovals.get(WS, deck.id)).toBeNull();
    });

    it("refuses an approval for an unknown deck and keeps a deck with an approval", async () => {
      await expect(
        uow().scriptApprovals.set({
          workspaceId: WS,
          deckId: makeDeckRecord().id,
          digest: "c".repeat(64),
          approvedAt: 1,
          approvedBy: { actor: "owner", tokenId: null },
        }),
      ).rejects.toThrow();
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      await uow().scriptApprovals.set({
        workspaceId: WS,
        deckId: deck.id,
        digest: "d".repeat(64),
        approvedAt: 1,
        approvedBy: { actor: "owner", tokenId: null },
      });
      await expect(uow().decks.delete(WS, deck.id)).rejects.toThrow();
    });
  });
}

export function runUnitOfWorkContract(name: string, factory: StorageFactory): void {
  describe(`${name}: UnitOfWork (transaction) contract`, () => {
    const uow = useHarness(factory);

    it("commits every write when the work resolves", async () => {
      const deck = makeDeckRecord();
      const out = await uow().transaction(async (tx) => {
        await tx.decks.insert(deck);
        await tx.revisions.insert(makeRevisionRecord(deck));
        expect(await tx.decks.get(WS, deck.id)).toEqual(deck);
        return 42;
      });
      expect(out).toBe(42);
      expect(await uow().decks.get(WS, deck.id)).toEqual(deck);
      expect(await uow().revisions.listNumbers(WS, deck.id)).toEqual([1]);
    });

    it("rolls back every write when the work throws, and rethrows the same error", async () => {
      const deck = makeDeckRecord();
      const boom = new Error("boom");
      await expect(
        uow().transaction(async (tx) => {
          await tx.decks.insert(deck);
          await tx.revisions.insert(makeRevisionRecord(deck));
          await tx.audit.append(makeAuditEntry());
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(await uow().decks.get(WS, deck.id)).toBeNull();
      expect(await uow().revisions.listNumbers(WS, deck.id)).toEqual([]);
      expect(await uow().audit.list(WS, { limit: 10 })).toEqual([]);
    });

    it("rolls back when a write inside fails (constraint violation)", async () => {
      const deck = makeDeckRecord();
      await uow().decks.insert(deck);
      const other = makeDeckRecord();
      await expect(
        uow().transaction(async (tx) => {
          await tx.decks.insert(other);
          await tx.decks.insert(deck); // duplicate
        }),
      ).rejects.toThrow();
      expect(await uow().decks.get(WS, other.id)).toBeNull();
    });

    it("serializes concurrent transactions (read-modify-write never loses an update)", async () => {
      const deck = makeDeckRecord({ currentRevision: 1 });
      await uow().decks.insert(deck);
      const bump = () =>
        uow().transaction(async (tx) => {
          const current = await tx.decks.get(WS, deck.id);
          if (current === null) throw new Error("missing");
          await new Promise((r) => setTimeout(r, 5));
          const ok = await tx.decks.updateHead(WS, deck.id, current.currentRevision, {
            currentRevision: current.currentRevision + 1,
            title: current.title,
            lang: current.lang,
            slideCount: current.slideCount,
            updatedAt: current.updatedAt,
          });
          if (!ok) throw new Error("lost update");
        });
      await Promise.all([bump(), bump(), bump(), bump()]);
      expect((await uow().decks.get(WS, deck.id))?.currentRevision).toBe(5);
    });

    it("keeps working after a rolled back transaction", async () => {
      await expect(
        uow().transaction(async () => {
          throw new Error("first");
        }),
      ).rejects.toThrow("first");
      const deck = makeDeckRecord();
      await uow().transaction((tx) => tx.decks.insert(deck));
      expect(await uow().decks.get(WS, deck.id)).not.toBeNull();
    });
  });
}

/** Every storage contract suite. */
export function runStorageContract(name: string, factory: StorageFactory): void {
  runDeckRepositoryContract(name, factory);
  runRevisionRepositoryContract(name, factory);
  runAssetRepositoryContract(name, factory);
  runAuditLogContract(name, factory);
  runIdempotencyRepositoryContract(name, factory);
  runScriptApprovalRepositoryContract(name, factory);
  runUnitOfWorkContract(name, factory);
}
