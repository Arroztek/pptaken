// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDeck } from "./index.js";

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
const exampleFiles = readdirSync(examplesDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

function loadExample(name: string): unknown {
  return JSON.parse(readFileSync(join(examplesDir, name), "utf8"));
}

describe("example decks", () => {
  it("finds the example files", () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
  });

  it.each(exampleFiles)("%s is a valid deck", (name) => {
    const result = parseDeck(loadExample(name));
    const message = result.ok
      ? ""
      : result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    expect(result.ok, message).toBe(true);
  });

  it.each(exampleFiles)("%s has no unsafe slide markup", (name) => {
    const deck = loadExample(name) as { slides: { id: string; html: string }[] };
    for (const slide of deck.slides) {
      expect(slide.html, `${name} slide ${slide.id}: <script`).not.toMatch(/<script/i);
      expect(slide.html, `${name} slide ${slide.id}: event handler`).not.toMatch(/\son[a-z]+\s*=/i);
      expect(slide.html, `${name} slide ${slide.id}: external URL`).not.toMatch(/https?:\/\//i);
    }
  });

  it("talk-20-slides has 20 slides and at least 4 sections", () => {
    const deck = loadExample("talk-20-slides.json") as { slides: { section?: string }[] };
    expect(deck.slides).toHaveLength(20);
    const sections = new Set(deck.slides.map((slide) => slide.section).filter(Boolean));
    expect(sections.size).toBeGreaterThanOrEqual(4);
  });
});
