// SPDX-License-Identifier: AGPL-3.0-or-later
// Performance sanity on a real database file. Bounds are generous; numbers are printed for the record.
import { join } from "node:path";
import { agentPrincipal, createTestCore } from "@pptaken/testing";
import { afterAll, describe, expect, it } from "vitest";
import { openSqliteStorage } from "../src/index.js";
import { tempDir } from "./helpers.js";

const tmp = tempDir();
afterAll(() => tmp.remove());
const agent = agentPrincipal();

function slides(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s-${i + 1}`,
    title: `Slide ${i + 1}`,
    html: `<h1>Slide ${i + 1}</h1><ul>${'<li data-step="">Point with <strong>bold</strong> text</li>'.repeat(8)}</ul>`,
    css: "h1 { color: #333; font-size: 64px } li { margin: 8px 0 }",
    notes: "Speaker notes ".repeat(20),
  }));
}

describe("performance (SQLite file)", () => {
  it("creates a 200-slide deck and lists 1,000 decks quickly", async () => {
    const storage = openSqliteStorage({ filename: join(tmp.dir, "perf.db") });
    const t = createTestCore({ store: storage });

    let start = performance.now();
    const big = await t.core.createPresentation(agent, { title: "Big", slides: slides(200) });
    const createMs = performance.now() - start;
    start = performance.now();
    await t.core.getPresentation(agent, {
      presentationId: big.presentationId,
      include: ["slides"],
    });
    const readMs = performance.now() - start;

    start = performance.now();
    for (let i = 0; i < 1000; i++) {
      await t.core.createPresentation(agent, {
        title: `Deck ${i}`,
        slides: [{ html: "<p>x</p>" }],
      });
    }
    const fillMs = performance.now() - start;

    start = performance.now();
    let cursor: string | undefined;
    let total = 0;
    do {
      const page = await t.core.listPresentations(agent, {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      total += page.items.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const listMs = performance.now() - start;
    start = performance.now();
    const search = await t.core.listPresentations(agent, { query: "deck 99", limit: 100 });
    const searchMs = performance.now() - start;
    await storage.close();

    console.info(
      `[perf] sqlite: create 200 slides ${createMs.toFixed(0)} ms, read 200 slides ${readMs.toFixed(0)} ms, ` +
        `create 1000 decks ${fillMs.toFixed(0)} ms, list 1001 decks (pages of 100) ${listMs.toFixed(0)} ms, ` +
        `search ${searchMs.toFixed(1)} ms`,
    );
    expect(total).toBe(1001);
    expect(search.items.map((d) => d.title).sort()).toEqual(
      ["Deck 99", ...Array.from({ length: 10 }, (_, i) => `Deck 99${i}`)].sort(),
    );
    expect(createMs).toBeLessThan(10_000);
    expect(readMs).toBeLessThan(2_000);
    expect(fillMs).toBeLessThan(60_000);
    expect(listMs).toBeLessThan(2_000);
  });
});
