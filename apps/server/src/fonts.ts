// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundled fonts: reads `fonts.css` of @pptaken/ui once at startup and turns each `@font-face` rule into the
// validated `FontFaceSpec` the document builder needs. The file is part of our own package (trusted), but every
// value still goes through the builder's validation before it reaches a document.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FontFaceSpec } from "@pptaken/player";
import { FONT_CATALOG, type FontName } from "@pptaken/schema";

const FACE = /@font-face\s*{([^}]*)}/g;

function field(block: string, name: string): string | undefined {
  const match = new RegExp(String.raw`${name}\s*:\s*([^;]+);`).exec(block);
  return match?.[1]?.trim();
}

/** Parses the `@font-face` rules of `fonts.css`. Rules with a family outside the catalog or without a file are skipped. */
export function loadFontFaces(fontsDir: string): FontFaceSpec[] {
  const cssPath = join(fontsDir, "fonts.css");
  if (!existsSync(cssPath)) return [];
  const css = readFileSync(cssPath, "utf8");
  const faces: FontFaceSpec[] = [];
  for (const [, block = ""] of css.matchAll(FACE)) {
    const family = field(block, "font-family")?.replace(/^["']|["']$/g, "");
    const weight = field(block, "font-weight");
    const src = /url\(["']?\.\/([a-z0-9-]+\/[a-z0-9-]+\.woff2)["']?\)/.exec(block)?.[1];
    const unicodeRange = field(block, "unicode-range");
    if (!family || !weight || !src) continue;
    if (!(FONT_CATALOG as readonly string[]).includes(family)) continue;
    if (!existsSync(join(fontsDir, src))) continue;
    faces.push({ family: family as FontName, file: src, weight, unicodeRange });
  }
  return faces;
}
