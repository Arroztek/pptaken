// SPDX-License-Identifier: AGPL-3.0-or-later
// The SQLite adapter must pass the same storage contract as the in-memory reference implementation, both with an
// in-memory database and with a real file in WAL mode. The core's use cases also run end to end on it.
import { join } from "node:path";
import { isDomainError } from "@pptaken/core";
import {
  agentPrincipal,
  createTestCore,
  makeSlideInputs,
  ownerPrincipal,
  pngBytes,
  runLiveSessionContract,
  runStorageContract,
} from "@pptaken/testing";
import { sql } from "kysely";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createSqliteLiveStore, openSqliteStorage, type SqliteStorage } from "../src/index.js";
import { tempDir } from "./helpers.js";

runStorageContract("sqlite :memory:", () => {
  const uow = openSqliteStorage({ filename: ":memory:" });
  return { uow, cleanup: () => uow.close() };
});

runStorageContract("sqlite file (WAL)", () => {
  const tmp = tempDir();
  const uow = openSqliteStorage({ filename: join(tmp.dir, "pptaken.db") });
  return {
    uow,
    cleanup: async () => {
      await uow.close();
      tmp.remove();
    },
  };
});

runLiveSessionContract("sqlite :memory:", () => {
  const storage = openSqliteStorage({ filename: ":memory:" });
  return { store: createSqliteLiveStore(storage), cleanup: () => storage.close() };
});

runLiveSessionContract("sqlite file (WAL)", () => {
  const tmp = tempDir();
  const storage = openSqliteStorage({ filename: join(tmp.dir, "pptaken.db") });
  return {
    store: createSqliteLiveStore(storage),
    cleanup: async () => {
      await storage.close();
      tmp.remove();
    },
  };
});

describe("core use cases on SQLite", () => {
  let storage: SqliteStorage | undefined;
  const tmp = tempDir();
  afterEach(async () => {
    await storage?.close();
    storage = undefined;
  });
  afterAll(() => tmp.remove());

  it("creates, edits, trashes, restores and purges a presentation", async () => {
    storage = openSqliteStorage({ filename: join(tmp.dir, `flow-${Date.now()}.db`) });
    const t = createTestCore({ store: storage });
    const agent = agentPrincipal();
    const owner = ownerPrincipal();
    const created = await t.core.createPresentation(agent, {
      title: "SQLite flow",
      slides: makeSlideInputs(3),
      idempotencyKey: "abc",
    });
    expect(
      (
        await t.core.createPresentation(agent, {
          title: "SQLite flow",
          slides: makeSlideInputs(3),
          idempotencyKey: "abc",
        })
      ).replayed,
    ).toBe(true);
    const id = created.presentationId;
    const asset = await t.core.addAsset(agent, {
      presentationId: id,
      bytes: pngBytes(),
      mediaType: "image/png",
    });
    const r2 = await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "slide-1", html: `<img src="${asset.ref}" alt="">` }],
      remove: ["slide-3"],
    });
    expect(r2).toMatchObject({ revision: 2, slideCount: 2, warnings: [] });
    const conflict = await t.core
      .updatePresentation(agent, { presentationId: id, expectedRevision: 1, title: "stale" })
      .catch((e: unknown) => e);
    expect(isDomainError(conflict) && conflict.details).toEqual({
      currentRevision: 2,
      expectedRevision: 1,
    });
    await t.core.trashPresentation(agent, { presentationId: id });
    await t.core.restorePresentation(owner, { presentationId: id });
    await t.core.trashPresentation(agent, { presentationId: id });
    expect(await t.core.purgePresentation(owner, { presentationId: id })).toMatchObject({
      revisionsDeleted: 2,
      assetsDeleted: 1,
      blobsDeleted: 1,
    });
    const audit = await t.core.listAuditLog(owner, { target: `deck:${id}` });
    expect(audit.items.map((e) => e.action)).toContain("presentation.purge");
  });

  it("rolls back a use case whose transaction fails midway", async () => {
    storage = openSqliteStorage({ filename: ":memory:" });
    const t = createTestCore({ store: storage });
    const agent = agentPrincipal();
    const { presentationId } = await t.core.createPresentation(agent, {
      title: "x",
      slides: makeSlideInputs(1),
    });
    // Make the revision insert fail after the head moved: the head move must be rolled back.
    await sql`CREATE TRIGGER fail_revision BEFORE INSERT ON revision BEGIN SELECT RAISE(ABORT, 'injected'); END`.execute(
      storage.kysely,
    );
    const error = await t.core
      .updatePresentation(agent, { presentationId, expectedRevision: 1, title: "never" })
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe("INTERNAL");
    const deck = await storage.decks.get("default", presentationId);
    expect(deck).toMatchObject({ currentRevision: 1, title: "x" });
  });
});
