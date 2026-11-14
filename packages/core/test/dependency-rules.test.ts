// SPDX-License-Identifier: AGPL-3.0-or-later
// Dependency rule (architecture §3): the core performs no I/O and imports no adapter. Every import in the core's
// production sources must be relative or one of the allowed workspace packages.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ALLOWED = new Set(["@pptaken/schema", "@pptaken/sanitizer"]);
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

/** Module specifiers of static imports/exports, dynamic `import()` and `require()`. */
export function specifiersOf(code: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) out.push(m[1] as string);
  return out;
}

describe("core dependency rules", () => {
  const files = sources(SRC);

  it("finds the sources", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("only imports relative modules, @pptaken/schema and @pptaken/sanitizer", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
        if (spec.startsWith("./") || spec.startsWith("../")) continue;
        if (!ALLOWED.has(spec)) violations.push(`${file}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("uses no Node or browser I/O globals", () => {
    const forbidden =
      /\b(?:process\.|Buffer\b|fetch\s*\(|setTimeout\s*\(|setInterval\s*\(|XMLHttpRequest|WebSocket|globalThis\.crypto)/;
    const withoutComments = (code: string) =>
      code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const violations = files.filter((file) =>
      forbidden.test(withoutComments(readFileSync(file, "utf8"))),
    );
    expect(violations).toEqual([]);
  });

  it("declares only the allowed runtime dependencies", () => {
    expect(Object.keys(PKG.dependencies ?? {}).sort()).toEqual([...ALLOWED].sort());
  });

  it("the checker catches forbidden imports", () => {
    const sample = [
      'import Database from "better-sqlite3";',
      'import { Kysely } from "kysely";',
      'import { readFile } from "node:fs";',
      'export { Hono } from "hono";',
      'const ws = await import("ws");',
      'const fs = require("fs");',
      'import type { X } from "../ports.js";',
    ].join("\n");
    expect(specifiersOf(sample)).toEqual([
      "better-sqlite3",
      "kysely",
      "node:fs",
      "hono",
      "../ports.js",
      "ws",
      "fs",
    ]);
  });
});
