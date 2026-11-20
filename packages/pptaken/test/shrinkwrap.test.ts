// SPDX-License-Identifier: AGPL-3.0-or-later
// npm-shrinkwrap.json generation from the pnpm lockfile: exact versions and integrity, or the build stops.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM build script without type declarations
import * as shrinkwrapModule from "../scripts/shrinkwrap.mjs";

const S = shrinkwrapModule as {
  splitKey(key: string): { name: string; version: string };
  shrinkwrapFromPnpmLock(
    lock: string,
    root: Record<string, unknown> & { dependencies: Record<string, string> },
  ): {
    packages: Record<
      string,
      {
        version?: string;
        integrity?: string;
        resolved?: string;
        dependencies?: Record<string, string>;
      }
    >;
  };
};

const LOCK = `lockfileVersion: '9.0'

importers:

  packages/pptaken:
    dependencies:
      better-sqlite3:
        specifier: 13.1.1
        version: 13.1.1

packages:

  '@scope/helper@1.0.0':
    resolution: {integrity: sha512-SCOPED==}

  better-sqlite3@13.1.1:
    resolution: {integrity: sha512-AAA==}
    engines: {node: '>=22'}

  node-addon-api@8.9.2:
    resolution: {integrity: sha512-BBB==}

snapshots:

  '@scope/helper@1.0.0': {}

  better-sqlite3@13.1.1:
    dependencies:
      node-addon-api: 8.9.2
      '@scope/helper': 1.0.0

  node-addon-api@8.9.2: {}
`;

const root = {
  name: "pptaken",
  version: "1.0.0",
  license: "AGPL-3.0-or-later",
  dependencies: { "better-sqlite3": "13.1.1" },
  bin: { pptaken: "bin/pptaken.cjs" },
  engines: { node: ">=22" },
};

describe("shrinkwrapFromPnpmLock", () => {
  it("splits plain, scoped and peer-suffixed keys", () => {
    expect(S.splitKey("a@1.2.3")).toEqual({ name: "a", version: "1.2.3" });
    expect(S.splitKey("'@s/b@2.0.0'")).toEqual({ name: "@s/b", version: "2.0.0" });
    expect(S.splitKey("c@3.0.0(react@18.0.0)")).toEqual({ name: "c", version: "3.0.0" });
  });

  it("pins the whole runtime tree with registry URLs and integrity", () => {
    const sw = S.shrinkwrapFromPnpmLock(LOCK, root);
    expect(Object.keys(sw.packages)).toEqual([
      "",
      "node_modules/@scope/helper",
      "node_modules/better-sqlite3",
      "node_modules/node-addon-api",
    ]);
    expect(sw.packages["node_modules/better-sqlite3"]).toEqual({
      version: "13.1.1",
      resolved: "https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.1.1.tgz",
      integrity: "sha512-AAA==",
      dependencies: { "node-addon-api": "8.9.2", "@scope/helper": "1.0.0" },
    });
    expect(sw.packages["node_modules/@scope/helper"]?.resolved).toBe(
      "https://registry.npmjs.org/@scope/helper/-/helper-1.0.0.tgz",
    );
    expect(sw.packages[""]).toMatchObject({ name: "pptaken", version: "1.0.0" });
  });

  it("refuses what it cannot pin exactly", () => {
    expect(() =>
      S.shrinkwrapFromPnpmLock(LOCK, { ...root, dependencies: { missing: "1.0.0" } }),
    ).toThrow(/missing@1.0.0 is not in pnpm-lock.yaml/);
    expect(() => S.shrinkwrapFromPnpmLock(LOCK.replace("sha512-BBB==", "sha1-old"), root)).toThrow(
      /no sha512 integrity/,
    );
    expect(() =>
      S.shrinkwrapFromPnpmLock(
        LOCK.replace(
          "  node-addon-api@8.9.2: {}",
          "  node-addon-api@8.9.2:\n    optionalDependencies:\n      x: 1.0.0",
        ),
        root,
      ),
    ).toThrow(/optional or peer dependencies/);
    expect(() => S.shrinkwrapFromPnpmLock("lockfileVersion: '6.0'\n", root)).toThrow(/pnpm v9/);
  });

  it("matches the real lockfile for better-sqlite3", () => {
    const lock = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const sw = S.shrinkwrapFromPnpmLock(lock, { ...root, dependencies: pkg.dependencies });
    const entry = sw.packages["node_modules/better-sqlite3"];
    expect(entry?.version).toBe(pkg.dependencies["better-sqlite3"]);
    expect(entry?.integrity).toMatch(/^sha512-/);
    for (const dep of Object.keys(entry?.dependencies ?? {})) {
      expect(sw.packages[`node_modules/${dep}`]?.integrity).toMatch(/^sha512-/);
    }
  });
});
