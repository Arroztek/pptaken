// Interactive mode (ADR-020): the optional `slides[].script` and `libs` fields of deck format v1.
import { describe, expect, it } from "vitest";
import {
  bundledScript,
  hasScripts,
  LIB_CATALOG,
  LIB_IDS,
  LIMITS,
  parseDeck,
  scriptProblem,
} from "./index.js";

const deck = (over: Record<string, unknown> = {}, slide: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  title: "T",
  slides: [{ id: "a", html: "<p>a</p>", ...slide }],
  ...over,
});

describe("script and libs", () => {
  it("are optional, compatible additions (no schemaVersion bump)", () => {
    const r = parseDeck(deck({ libs: ["uplot@1"] }, { script: "slide.onEnter(function(){})" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(hasScripts(r.deck)).toBe(true);
    const plain = parseDeck(deck());
    expect(plain.ok && hasScripts(plain.deck)).toBe(false);
  });

  it("refuse text that could leave its <script> element or change its hash", () => {
    for (const script of [
      "x='</script>'",
      "x='</SCRIPT >'",
      "y='<script>'",
      "<!-- comment",
      "a\u0000b",
      "lone \ud83d surrogate",
      "",
    ]) {
      expect(parseDeck(deck({}, { script })).ok, JSON.stringify(script)).toBe(false);
    }
    expect(scriptProblem("ok('<\\/script>'); a < b; c<!d")).toBeNull();
    expect(scriptProblem("emoji 🎉 fine")).toBeNull();
  });

  it("enforce the per-slide and per-deck limits", () => {
    expect(parseDeck(deck({}, { script: "x".repeat(LIMITS.maxSlideScript + 1) })).ok).toBe(false);
    const big = "x".repeat(LIMITS.maxSlideScript);
    const slides = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, html: "", script: big }));
    const r = parseDeck({ schemaVersion: 1, title: "T", slides });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("slides");
  });

  it("model libs as vendored script assets; a bundled id expands to its reference", () => {
    const r = parseDeck(deck({ libs: ["uplot@1"] }));
    expect(r.ok && r.deck.libs).toEqual([bundledScript("uplot@1")]);
    const ref = {
      name: "d3",
      version: "7.9.0",
      sha256: "a".repeat(64),
      source: "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js",
    };
    const own = parseDeck(deck({ libs: [ref] }));
    expect(own.ok && own.deck.libs).toEqual([ref]);
    for (const bad of [
      { ...ref, sha256: "A".repeat(64) },
      { ...ref, source: "http://cdn.example/x.js" },
      { ...ref, source: "javascript:alert(1)" },
      { ...ref, name: "<b>" },
      { ...ref, extra: 1 },
    ]) {
      expect(parseDeck(deck({ libs: [bad] })).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseDeck(deck({ libs: [ref, { ...ref, name: "again" }] })).ok).toBe(false);
  });

  it("accept only unique catalog libraries, at most sixteen", () => {
    expect(parseDeck(deck({ libs: ["d3@7"] })).ok).toBe(false);
    expect(parseDeck(deck({ libs: ["uplot@1", "uplot@1"] })).ok).toBe(false);
    expect(parseDeck(deck({ libs: [] })).ok).toBe(true);
    expect(LIB_IDS).toEqual(Object.keys(LIB_CATALOG));
    for (const lib of Object.values(LIB_CATALOG)) {
      expect(lib.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(lib.license).toBe("MIT");
    }
  });

  it("stay strict: an unknown field is still refused (older servers fail closed on new fields)", () => {
    expect(parseDeck(deck({}, { scripts: "x" })).ok).toBe(false);
    expect(parseDeck(deck({ library: ["uplot@1"] })).ok).toBe(false);
  });
});
