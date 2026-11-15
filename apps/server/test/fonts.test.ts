// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFontFaces } from "../src/fonts.js";

const FONTS_DIR = new URL("../../../packages/ui/fonts/", import.meta.url);

describe("loadFontFaces", () => {
  it("reads the bundled fonts of @pptaken/ui", () => {
    const faces = loadFontFaces(FONTS_DIR.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const families = new Set(faces.map((f) => f.family));
    expect(families).toEqual(new Set(["Inter", "Bricolage Grotesque", "JetBrains Mono"]));
    // Latin and Latin Extended for each family.
    expect(faces.length).toBe(6);
    const inter = faces.find((f) => f.family === "Inter" && f.file.includes("latin-wght"));
    expect(inter?.weight).toBe("100 900");
    expect(inter?.unicodeRange).toMatch(/^U\+0000-00FF/);
  });

  it("skips unknown families, missing files and odd paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "pptaken-fonts-"));
    try {
      mkdirSync(join(dir, "inter"));
      writeFileSync(join(dir, "inter", "inter-a.woff2"), "x");
      writeFileSync(
        join(dir, "fonts.css"),
        [
          '@font-face { font-family: "Inter"; font-weight: 400; src: url("./inter/inter-a.woff2") format("woff2"); }',
          '@font-face { font-family: "Comic Sans"; font-weight: 400; src: url("./inter/inter-a.woff2") format("woff2"); }',
          '@font-face { font-family: "Inter"; font-weight: 400; src: url("./inter/missing.woff2") format("woff2"); }',
          '@font-face { font-family: "Inter"; font-weight: 400; src: url("../etc/passwd") format("woff2"); }',
        ].join("\n"),
      );
      const faces = loadFontFaces(dir);
      expect(faces).toEqual([
        { family: "Inter", file: "inter/inter-a.woff2", weight: "400", unicodeRange: undefined },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns nothing when there is no fonts.css", () => {
    expect(loadFontFaces(join(tmpdir(), "pptaken-no-such-dir"))).toEqual([]);
  });
});
