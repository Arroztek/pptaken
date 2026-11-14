// SPDX-License-Identifier: AGPL-3.0-or-later
// Two connections to the same database file (as two processes would have): writers serialize on the write lock
// without blocking the event loop, and optimistic concurrency lets exactly one stale writer win.
import { join } from "node:path";
import { isDomainError } from "@pptaken/core";
import { agentPrincipal, createTestCore, makeDeckRecord, makeSlideInputs } from "@pptaken/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteStorage, type SqliteStorage } from "../src/index.js";
import { tempDir } from "./helpers.js";

let tmp: ReturnType<typeof tempDir>;
const open: SqliteStorage[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  tmp?.remove();
});

function pair(): [SqliteStorage, SqliteStorage] {
  tmp = tempDir();
  const file = join(tmp.dir, "shared.db");
  const a = openSqliteStorage({ filename: file });
  const b = openSqliteStorage({ filename: file });
  open.push(a, b);
  return [a, b];
}

describe("two connections to one file", () => {
  it("a second writer waits for the first transaction instead of failing", async () => {
    const [a, b] = pair();
    const deck = makeDeckRecord();
    let releaseA: () => void = () => undefined;
    let aStarted: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      aStarted = r;
    });
    const txA = a.transaction(async (tx) => {
      await tx.decks.insert(deck);
      aStarted();
      await new Promise<void>((r) => {
        releaseA = r;
      });
    });
    await started;
    const t0 = Date.now();
    const txB = b.transaction(async (tx) => (await tx.decks.get("default", deck.id))?.id ?? null);
    // The event loop is free while B waits: A can finish.
    setTimeout(() => releaseA(), 100);
    await txA;
    expect(await txB).toBe(deck.id);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it("reports a lock timeout when the other writer never finishes", async () => {
    tmp = tempDir();
    const file = join(tmp.dir, "locked.db");
    const a = openSqliteStorage({ filename: file });
    const b = openSqliteStorage({ filename: file, lockTimeoutMs: 100 });
    open.push(a, b);
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const held = a.transaction(async () => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await ready;
    const failure = await b.transaction(async () => 1).catch((e: unknown) => e);
    expect((failure as { code?: string }).code).toMatch(/^SQLITE_BUSY/);
    release();
    await held;
    expect(await b.transaction(async () => 2)).toBe(2);
  });

  it("concurrent use cases on two connections: exactly one stale writer wins", async () => {
    const [a, b] = pair();
    const ta = createTestCore({ store: a });
    const tb = createTestCore({ store: b, seed: 2 });
    const agent = agentPrincipal();
    const { presentationId } = await ta.core.createPresentation(agent, {
      title: "Race",
      slides: makeSlideInputs(2),
    });
    for (let round = 1; round <= 10; round++) {
      const results = await Promise.allSettled([
        ta.core.updateSlides(agent, {
          presentationId,
          expectedRevision: round,
          upsert: [{ id: "slide-1", html: `<p>A${round}</p>` }],
        }),
        tb.core.updateSlides(agent, {
          presentationId,
          expectedRevision: round,
          upsert: [{ id: "slide-1", html: `<p>B${round}</p>` }],
        }),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(isDomainError(lost[0]?.reason) && lost[0]?.reason.code).toBe("REVISION_CONFLICT");
    }
    const numbers = await b.revisions.listNumbers("default", presentationId);
    expect(numbers).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  });
});
