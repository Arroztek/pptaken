// SPDX-License-Identifier: AGPL-3.0-or-later
// The CommonJS entry point bin/pptaken.cjs: the Node.js version gate must work, and the file must stay parseable
// by old Node.js versions (so people with one get the message, not a syntax error).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface Shim {
  MIN_NODE_MAJOR: number;
  EXIT_NODE_TOO_OLD: number;
  checkNodeVersion(version: string): string | null;
  main(options: {
    version?: string;
    dryRun?: boolean;
    stderr?: { write(text: string): void };
  }): number | null;
}

const shimPath = new URL("../bin/pptaken.cjs", import.meta.url);
const shim = createRequire(import.meta.url)("../bin/pptaken.cjs") as Shim;

describe("bin/pptaken.cjs", () => {
  it("needs Node.js 22", () => {
    expect(shim.MIN_NODE_MAJOR).toBe(22);
    expect(shim.EXIT_NODE_TOO_OLD).toBe(5);
  });

  it("accepts 22 and newer", () => {
    for (const v of ["22.0.0", "22.18.0", "v22.12.1", "24.1.0", "26.0.0-pre", "100.0.0"]) {
      expect(shim.checkNodeVersion(v)).toBeNull();
    }
  });

  it("refuses older versions with a readable message naming both versions", () => {
    for (const v of [
      "21.7.3",
      "20.19.0",
      "18.19.0",
      "v16.20.2",
      "12.22.12",
      "0.10.48",
      "garbage",
    ]) {
      const message = shim.checkNodeVersion(v);
      expect(message).toContain("PPTaken needs Node.js 22 or newer");
      expect(message).toContain("https://nodejs.org/");
    }
    expect(shim.checkNodeVersion("18.19.0")).toContain("but this is Node.js 18.19.0.");
    expect(shim.checkNodeVersion("v16.20.2")).toContain("but this is Node.js 16.20.2.");
  });

  it("main() prints the message and returns exit code 5 without loading the program", () => {
    let written = "";
    const code = shim.main({ version: "18.19.0", stderr: { write: (t) => (written += t) } });
    expect(code).toBe(5);
    expect(written).toMatch(
      /^PPTaken needs Node\.js 22 or newer, but this is Node\.js 18\.19\.0\.\n/,
    );
  });

  it("main() passes on a supported version (dry run)", () => {
    expect(shim.main({ version: "22.18.0", dryRun: true })).toBe(0);
  });

  it("uses only syntax that old Node.js versions can parse", () => {
    const code = readFileSync(shimPath, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/=>/);
    expect(code).not.toMatch(/\b(const|let|class|async|await)\s/);
    expect(code).not.toMatch(/`/);
    expect(code).not.toMatch(/\?\?|\?\./);
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).toContain('"use strict"');
  });
});
