// SPDX-License-Identifier: AGPL-3.0-or-later
// Basic performance sanity with in-memory ports (the SQLite adapter has its own). Bounds are generous: they catch
// accidental quadratic behaviour, not small regressions. Numbers are printed for the record.
import { agentPrincipal, createTestCore } from "@pptaken/testing";
import { describe, expect, it } from "vitest";

const agent = agentPrincipal();

function slides(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s-${i + 1}`,
    title: `Slide ${i + 1}`,
    html: `<section><h1>Slide ${i + 1}</h1><ul>${'<li data-step="">Point with <strong>bold</strong> text</li>'.repeat(8)}</ul><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg></section>`,
    css: "h1 { color: #333; font-size: 64px } li { margin: 8px 0 }",
    notes: "Speaker notes ".repeat(20),
  }));
}

describe("performance (in-memory ports)", () => {
  it("creates a 200-slide deck and edits one slide quickly", async () => {
    const t = createTestCore();
    let start = performance.now();
    const { presentationId } = await t.core.createPresentation(agent, {
      title: "Big",
      slides: slides(200),
    });
    const createMs = performance.now() - start;
    start = performance.now();
    await t.core.updateSlides(agent, {
      presentationId,
      expectedRevision: 1,
      upsert: [{ id: "s-100", html: "<p>changed</p>" }],
    });
    const updateMs = performance.now() - start;
    console.info(
      `[perf] memory: create 200 slides ${createMs.toFixed(0)} ms, update 1 slide ${updateMs.toFixed(0)} ms`,
    );
    expect(createMs).toBeLessThan(10_000);
    expect(updateMs).toBeLessThan(10_000);
  });

  it("lists 1,000 decks quickly", async () => {
    const t = createTestCore();
    for (let i = 0; i < 1000; i++) {
      await t.core.createPresentation(agent, {
        title: `Deck ${i}`,
        slides: [{ html: "<p>x</p>" }],
      });
    }
    const start = performance.now();
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
    console.info(`[perf] memory: list 1000 decks in pages of 100 ${listMs.toFixed(0)} ms`);
    expect(total).toBe(1000);
    expect(listMs).toBeLessThan(5_000);
  });
});
