import { describe, expect, it } from "vitest";
import { deckSchema } from "./index.js";

describe("deckSchema", () => {
  it("accepts a minimal deck", () => {
    const deck = { format: 1, title: "Hello", slides: [{ id: "s1", html: "<h1>Hi</h1>" }] };
    expect(deckSchema.safeParse(deck).success).toBe(true);
  });

  it("rejects a deck without slides", () => {
    expect(deckSchema.safeParse({ format: 1, title: "Empty", slides: [] }).success).toBe(false);
  });
});
