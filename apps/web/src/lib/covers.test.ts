// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { DeckCover } from "./api";
import { COVER_EXPIRY_MARGIN_MS, COVER_RETRY_MS, createCoverStore, createLimiter } from "./covers";

const NOW = Date.parse("2026-11-14T10:00:00.000Z");

function cover(id: string, revision = 1, expiresInMs = 30 * 60_000): DeckCover {
  return {
    id,
    revision,
    url: `https://content.example/c/${id}/${revision}/cover?ct=t${id}`,
    width: 1920,
    height: 1080,
    expiresAt: new Date(NOW + expiresInMs).toISOString(),
  };
}

function backend(
  answer: (ids: readonly string[]) => DeckCover[] = (ids) => ids.map((i) => cover(i)),
) {
  const calls: string[][] = [];
  const clock = { t: NOW };
  const fetchCovers = async (ids: readonly string[]) => {
    calls.push([...ids]);
    return answer(ids);
  };
  return { calls, clock, store: createCoverStore(fetchCovers, { now: () => clock.t }) };
}

describe("cover store", () => {
  it("asks once for a whole page and then serves the cache", async () => {
    const { calls, store } = backend();
    const page = ["a", "b", "c"].map((id) => ({ id, revision: 1 }));
    await store.resolve(page);
    expect(calls).toEqual([["a", "b", "c"]]);
    expect(store.peek({ id: "b", revision: 1 })).toMatchObject({ status: "ready", width: 1920 });
    await store.resolve(page);
    expect((await store.get({ id: "a", revision: 1 })).status).toBe("ready");
    expect(calls).toHaveLength(1);
  });

  it("splits a long list into chunks of at most the limit", async () => {
    const { calls, store } = backend();
    const many = Array.from({ length: 45 }, (_, i) => ({ id: `d${i}`, revision: 1 }));
    await store.resolve(many);
    expect(calls.map((c) => c.length)).toEqual([20, 20, 5]);
  });

  it("shares one request between concurrent askers", async () => {
    const { calls, store } = backend();
    const one = { id: "a", revision: 1 };
    await Promise.all([store.resolve([one]), store.resolve([one]), store.get(one, [one])]);
    expect(calls).toEqual([["a"]]);
  });

  it("marks a deck the server left out as having no cover, and keeps asking about nothing else", async () => {
    const { calls, store } = backend((ids) => ids.filter((i) => i !== "gone").map((i) => cover(i)));
    await store.resolve([
      { id: "gone", revision: 1 },
      { id: "here", revision: 1 },
    ]);
    expect(store.peek({ id: "gone", revision: 1 })).toEqual({ status: "none" });
    expect(store.peek({ id: "here", revision: 1 })?.status).toBe("ready");
    await store.resolve([{ id: "gone", revision: 1 }]);
    expect(calls).toHaveLength(1);
  });

  it("asks again when the cached URL is about to expire", async () => {
    const { calls, clock, store } = backend();
    const one = { id: "a", revision: 1 };
    await store.resolve([one]);
    clock.t += 30 * 60_000 - COVER_EXPIRY_MARGIN_MS - 1;
    expect(store.peek(one)?.status).toBe("ready");
    clock.t += 2;
    expect(store.peek(one)).toBeUndefined();
    await store.resolve([one]);
    expect(calls).toHaveLength(2);
  });

  it("keys the cache by revision", async () => {
    const { calls, store } = backend();
    await store.resolve([{ id: "a", revision: 1 }]);
    await store.resolve([{ id: "a", revision: 2 }]);
    expect(calls).toHaveLength(2);
  });

  it("treats a failing request as no cover now, and asks again only after a pause", async () => {
    let fail = true;
    const clock = { t: NOW };
    const store = createCoverStore(
      async (ids) => {
        if (fail) throw new Error("offline");
        return ids.map((i) => cover(i));
      },
      { now: () => clock.t },
    );
    const one = { id: "a", revision: 1 };
    expect(await store.get(one)).toEqual({ status: "failed" });
    expect(store.peek(one)).toBeUndefined();
    fail = false;
    expect(await store.get(one)).toEqual({ status: "failed" }); // still backing off
    clock.t += COVER_RETRY_MS + 1;
    expect((await store.get(one)).status).toBe("ready");
  });

  it("survives a fetcher that throws synchronously", async () => {
    const store = createCoverStore(() => {
      throw new Error("boom");
    });
    expect(await store.get({ id: "a", revision: 1 })).toEqual({ status: "failed" });
  });
});

describe("limiter", () => {
  it("runs at most N at a time and starts the next when one is released", () => {
    const limiter = createLimiter(2);
    const releases: (() => void)[] = [];
    const started: number[] = [];
    for (let i = 0; i < 5; i++)
      limiter.acquire((release) => {
        started.push(i);
        releases.push(release);
      });
    expect(started).toEqual([0, 1]);
    expect(limiter.active).toBe(2);
    expect(limiter.waiting).toBe(3);
    releases[0]?.();
    expect(started).toEqual([0, 1, 2]);
    releases[0]?.(); // a second release of the same slot does nothing
    expect(started).toEqual([0, 1, 2]);
    releases[1]?.();
    releases[2]?.();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(limiter.active).toBe(2);
  });

  it("cancel withdraws a waiting request and releases a granted one", () => {
    const limiter = createLimiter(1);
    const started: string[] = [];
    const cancelA = limiter.acquire(() => started.push("a"));
    const cancelB = limiter.acquire(() => started.push("b"));
    limiter.acquire(() => started.push("c"));
    cancelB();
    expect(limiter.waiting).toBe(1);
    cancelA();
    expect(started).toEqual(["a", "c"]);
    expect(limiter.active).toBe(1);
  });
});
