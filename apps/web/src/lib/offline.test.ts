// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { countOfflineCopies, forgetOfflineCopies } from "./offline";

function fakeCaches(names: string[], failing = false) {
  const store = new Set(names);
  return {
    store,
    keys: async () => {
      if (failing) throw new DOMException("blocked", "SecurityError");
      return [...store];
    },
    delete: async (name: string) => store.delete(name),
  };
}

const DECK = "pptaken-offline-v1-deck-01J9Z8Y7X6W5V4T3S2R1Q0P9N8";

describe("offline copies", () => {
  it("counts deck copies only", async () => {
    const c = fakeCaches([DECK, "pptaken-offline-shell-abc", "other-cache"]);
    expect(await countOfflineCopies(c)).toBe(1);
  });

  it("forgets every cache of the player, and nothing else", async () => {
    const c = fakeCaches([DECK, "pptaken-offline-shell-abc", "other-cache"]);
    await forgetOfflineCopies(c);
    expect([...c.store]).toEqual(["other-cache"]);
    expect(await countOfflineCopies(c)).toBe(0);
  });

  it("never throws without Cache Storage or when it is blocked", async () => {
    await expect(forgetOfflineCopies(null)).resolves.toBeUndefined();
    await expect(forgetOfflineCopies(fakeCaches([DECK], true))).resolves.toBeUndefined();
    expect(await countOfflineCopies(null)).toBe(0);
    expect(await countOfflineCopies(fakeCaches([DECK], true))).toBe(0);
  });
});
