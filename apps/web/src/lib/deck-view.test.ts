// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { DECK_VIEW_KEY, parseDeckView, readDeckView, saveDeckView } from "./deck-view";

afterEach(() => vi.unstubAllGlobals());

describe("deck view preference", () => {
  it("defaults to the list; only an exact stored 'grid' opens the grid", () => {
    expect(parseDeckView(null)).toBe("list");
    expect(parseDeckView("list")).toBe("list");
    expect(parseDeckView("grid")).toBe("grid");
    expect(parseDeckView("GRID")).toBe("list");
    expect(parseDeckView("cards")).toBe("list");
    expect(parseDeckView("")).toBe("list");
  });

  it("round-trips through localStorage under its own key", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(readDeckView()).toBe("list");
    saveDeckView("grid");
    expect(store.get(DECK_VIEW_KEY)).toBe("grid");
    expect(readDeckView()).toBe("grid");
    saveDeckView("list");
    expect(readDeckView()).toBe("list");
  });

  it("works with storage that throws or is missing (blocked site data)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readDeckView()).toBe("list");
    expect(() => saveDeckView("grid")).not.toThrow();
    vi.stubGlobal("localStorage", undefined);
    expect(readDeckView()).toBe("list");
    expect(() => saveDeckView("grid")).not.toThrow();
  });
});
