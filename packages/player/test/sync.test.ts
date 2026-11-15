// SPDX-License-Identifier: Apache-2.0
// Window sync messages (BroadcastChannel), presenter data validation and overview navigation.

import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SLIDES,
  MAX_STEPS,
  navigation,
  openSync,
  overviewColumns,
  overviewMove,
  parsePresenterData,
  parseSyncMessage,
  type SyncMessage,
  syncChannelName,
} from "../dist/index.js";

describe("sync messages", () => {
  it("accepts hello, nav and black and returns copies", () => {
    const good: SyncMessage[] = [
      { v: 1, type: "hello" },
      { v: 1, type: "nav", slide: 0, step: 0 },
      { v: 1, type: "nav", slide: MAX_SLIDES - 1, step: MAX_STEPS },
      { v: 1, type: "black", on: true },
      { v: 1, type: "black", on: false },
    ];
    for (const m of good) {
      const parsed = parseSyncMessage(m);
      expect(parsed).toEqual(m);
      expect(parsed).not.toBe(m);
    }
  });

  it("drops anything else", () => {
    const bad: unknown[] = [
      null,
      "hello",
      [],
      {},
      { type: "hello" },
      { v: 2, type: "hello" },
      { v: 1, type: "hello", from: "x" },
      { v: 1, type: "nav", slide: -1, step: 0 },
      { v: 1, type: "nav", slide: MAX_SLIDES, step: 0 },
      { v: 1, type: "nav", slide: 0, step: MAX_STEPS + 1 },
      { v: 1, type: "nav", slide: 0.5, step: 0 },
      { v: 1, type: "nav", slide: 0 },
      { v: 1, type: "nav", slide: 0, step: 0, notes: "secret" },
      { v: 1, type: "black", on: 1 },
      { v: 1, type: "black", on: "true" },
      { v: 1, type: "black" },
      { v: 1, type: "notes", html: "<p>x</p>" },
      { v: 1, type: "goto", slide: 0, step: 0 },
      { v: 1, type: "mode", mode: "print" },
      Object.assign(Object.create({ x: 1 }), { v: 1, type: "hello" }),
    ];
    for (const m of bad) expect(parseSyncMessage(m), JSON.stringify(m)).toBeNull();
  });

  it("names channels per deck", () => {
    expect(syncChannelName("01JABCDEFGHJKMNPQRSTVWXYZ0")).toBe(
      "pptaken:01JABCDEFGHJKMNPQRSTVWXYZ0",
    );
    expect(syncChannelName("talk")).toBe("pptaken:talk");
    expect(syncChannelName("")).toBeNull();
    expect(syncChannelName("a b")).toBeNull();
    expect(syncChannelName("x".repeat(65))).toBeNull();
  });
});

describe("sync over BroadcastChannel (Node)", () => {
  const open: { close(): void }[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });

  it("delivers valid messages to other channels and drops invalid ones", async () => {
    const received: SyncMessage[] = [];
    const a = openSync("pptaken:test-a", () => {});
    const b = openSync("pptaken:test-a", (m) => received.push(m));
    expect(a && b).toBeTruthy();
    if (!a || !b) return;
    open.push(a, b);
    // A raw channel can post anything: the receiver validates.
    const raw = new BroadcastChannel("pptaken:test-a");
    open.push(raw);
    raw.postMessage({ v: 1, type: "nav", slide: 999, step: 0 });
    raw.postMessage({ v: 1, type: "evil" });
    a.send({ v: 1, type: "nav", slide: 3, step: 1 });
    a.send({ v: 1, type: "nav", slide: -3, step: 1 } as unknown as SyncMessage);
    a.send({ v: 1, type: "black", on: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([
      { v: 1, type: "nav", slide: 3, step: 1 },
      { v: 1, type: "black", on: true },
    ]);
  });

  it("refuses bad channel names", () => {
    expect(openSync("other:x", () => {})).toBeNull();
  });
});

describe("presenter data", () => {
  const ok = {
    title: "Talk",
    revision: 3,
    aspectRatio: "16:9",
    targetMinutes: 20,
    slides: [
      { id: "a", title: "A", section: "Intro", durationHintSec: 60, notesHtml: "<p>x</p>" },
      { id: "b", title: "B", notesHtml: "", steps: 2 },
    ],
  };

  it("accepts the server's shape", () => {
    expect(parsePresenterData(ok)).toEqual(ok);
    expect(
      parsePresenterData({ title: "T", slides: [{ id: "a", title: "", notesHtml: "" }] }),
    ).not.toBeNull();
  });

  it("drops bad shapes and out-of-range values", () => {
    const slide = ok.slides[0];
    const bad: unknown[] = [
      null,
      [],
      { ...ok, extra: 1 },
      { ...ok, title: 1 },
      { ...ok, slides: [] },
      { ...ok, aspectRatio: "21:9" },
      { ...ok, targetMinutes: 0 },
      { ...ok, targetMinutes: 1.5 },
      { ...ok, slides: [{ ...slide, id: "A" }] },
      { ...ok, slides: [slide, slide] },
      { ...ok, slides: [{ ...slide, durationHintSec: -1 }] },
      { ...ok, slides: [{ ...slide, steps: MAX_STEPS + 1 }] },
      { ...ok, slides: [{ ...slide, notesHtml: 5 }] },
      { ...ok, slides: [{ ...slide, extra: true }] },
      {
        ...ok,
        slides: Array.from({ length: MAX_SLIDES + 1 }, (_, i) => ({ ...slide, id: `s${i}` })),
      },
    ];
    for (const d of bad) expect(parsePresenterData(d), JSON.stringify(d).slice(0, 80)).toBeNull();
  });
});

describe("overview navigation", () => {
  it("uses a column count that depends on the slide count only", () => {
    expect(overviewColumns(1)).toBe(1);
    expect(overviewColumns(3)).toBe(2);
    expect(overviewColumns(20)).toBe(5);
    expect(overviewColumns(200)).toBe(6);
    for (let n = 1; n <= MAX_SLIDES; n++) {
      const c = overviewColumns(n);
      expect(c).toBeGreaterThanOrEqual(1);
      expect(c).toBeLessThanOrEqual(6);
    }
  });

  it("moves the highlight by one slide or one row, clamped", () => {
    const cols = 5;
    expect(overviewMove(20, cols, 0, "ArrowRight")).toBe(1);
    expect(overviewMove(20, cols, 0, "ArrowLeft")).toBe(0);
    expect(overviewMove(20, cols, 19, "ArrowRight")).toBe(19);
    expect(overviewMove(20, cols, 2, "ArrowDown")).toBe(7);
    expect(overviewMove(20, cols, 17, "ArrowDown")).toBe(17);
    expect(overviewMove(20, cols, 7, "ArrowUp")).toBe(2);
    expect(overviewMove(20, cols, 2, "ArrowUp")).toBe(2);
    expect(overviewMove(20, cols, 9, "Home")).toBe(0);
    expect(overviewMove(20, cols, 9, "End")).toBe(19);
    expect(overviewMove(20, cols, 9, "Enter")).toBeNull();
    expect(overviewMove(20, cols, 9, "KeyB")).toBeNull();
    expect(navigation.KEY_ACTIONS.KeyO).toBe("overview");
  });
});
