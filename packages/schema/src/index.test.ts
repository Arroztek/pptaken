import { describe, expect, it } from "vitest";
import {
  ASSET_REF_PATTERN,
  canvasSize,
  DECK_SCHEMA_VERSION,
  deckJsonSchema,
  deckSchema,
  FONT_CATALOG,
  LIMITS,
  parseDeck,
} from "./index.js";

const slide = (id: string, html = "<h1>Hi</h1>") => ({ id, html });
const deck = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: DECK_SCHEMA_VERSION,
  title: "Hello",
  slides: [slide("intro")],
  ...overrides,
});

describe("deckSchema", () => {
  it("accepts a minimal deck and applies defaults", () => {
    const result = parseDeck(deck());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deck.aspectRatio).toBe("16:9");
      expect(result.deck.slides[0]?.title).toBe("");
    }
  });

  it("accepts a full deck", () => {
    const full = deck({
      lang: "es-PE",
      aspectRatio: "4:3",
      targetMinutes: 45,
      theme: { css: ":root{--x:1}", fonts: ["Inter", "JetBrains Mono"] },
      slides: [
        {
          id: "a",
          title: "A",
          html: "<p data-step='1'>x</p>",
          css: "p{color:red}",
          notes: "**note**",
          section: "Intro",
          durationHintSec: 60,
        },
        slide("b"),
      ],
    });
    expect(parseDeck(full).ok).toBe(true);
  });

  it("rejects a deck without slides", () => {
    expect(deckSchema.safeParse(deck({ slides: [] })).success).toBe(false);
  });

  it("rejects an unsupported schema version", () => {
    expect(deckSchema.safeParse(deck({ schemaVersion: 2 })).success).toBe(false);
  });

  it("rejects bad slide ids", () => {
    for (const id of ["", "Has Caps", "has_underscore", "x".repeat(41)]) {
      expect(deckSchema.safeParse(deck({ slides: [slide(id)] })).success).toBe(false);
    }
  });

  it("rejects duplicate slide ids and points at the second one", () => {
    const result = parseDeck(deck({ slides: [slide("a"), slide("a")] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("slides[1].id");
      expect(result.issues[0]?.message).toContain("Duplicate");
    }
  });

  it("enforces size limits", () => {
    const tooBig = "x".repeat(LIMITS.maxSlideHtml + 1);
    expect(parseDeck(deck({ slides: [slide("a", tooBig)] })).ok).toBe(false);
    const tooMany = Array.from({ length: LIMITS.maxSlides + 1 }, (_, i) => slide(`s${i}`));
    expect(parseDeck(deck({ slides: tooMany })).ok).toBe(false);
  });

  it("rejects fonts outside the catalog and duplicates", () => {
    expect(parseDeck(deck({ theme: { fonts: ["Comic Sans"] } })).ok).toBe(false);
    expect(parseDeck(deck({ theme: { fonts: ["Inter", "Inter"] } })).ok).toBe(false);
  });

  it("rejects bad language tags and aspect ratios", () => {
    expect(parseDeck(deck({ lang: "english please" })).ok).toBe(false);
    expect(parseDeck(deck({ aspectRatio: "21:9" })).ok).toBe(false);
  });

  it("rejects unknown fields so typos do not pass silently", () => {
    const result = parseDeck(
      deck({ slides: [{ id: "a", html: "<p>x</p>", note: "typo for notes" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("slides[0]");
    expect(parseDeck(deck({ extra: true })).ok).toBe(false);
  });

  it("reports agent-friendly issue paths", () => {
    const result = parseDeck(deck({ slides: [slide("a"), { id: "b" }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path)).toContain("slides[1].html");
  });
});

describe("helpers", () => {
  it("returns canvas sizes", () => {
    expect(canvasSize("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(canvasSize("4:3")).toEqual({ width: 1440, height: 1080 });
  });

  it("matches asset references", () => {
    expect(ASSET_REF_PATTERN.test(`asset:${"a".repeat(64)}`)).toBe(true);
    expect(ASSET_REF_PATTERN.test("asset:ZZ")).toBe(false);
    expect(ASSET_REF_PATTERN.test("https://example.com/x.png")).toBe(false);
  });

  it("exposes the font catalog", () => {
    expect(FONT_CATALOG).toContain("Inter");
  });
});

describe("JSON Schema", () => {
  it("describes the envelope", () => {
    const schema = deckJsonSchema() as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["schemaVersion", "title", "slides", "aspectRatio", "theme"]),
    );
    expect(schema.required).toEqual(expect.arrayContaining(["schemaVersion", "title", "slides"]));
  });
});
