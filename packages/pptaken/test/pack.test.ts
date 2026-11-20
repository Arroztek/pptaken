// SPDX-License-Identifier: AGPL-3.0-or-later
// What `npm publish` would upload: `npm pack --dry-run --json` must list exactly the runtime files (no sources, tests,
// maps, screenshots or secrets), every file the program needs, and stay within the size budget. Needs the build.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET_BYTES = 15 * 1024 * 1024;

interface PackResult {
  name: string;
  version: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: { path: string; size: number }[];
}

function npmCli(): string {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) throw new Error(`npm-cli.js not found next to ${process.execPath}`);
  return found;
}

let pack: PackResult;
let paths: string[];

beforeAll(() => {
  if (!existsSync(join(pkgDir, "dist", "app", "cli.js"))) {
    throw new Error('packages/pptaken is not built: run "pnpm build" at the repository root first');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
  const r = spawnSync(
    process.execPath,
    [npmCli(), "pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: pkgDir,
      env: { ...env, npm_config_loglevel: "error", npm_config_update_notifier: "false" },
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`npm pack failed: ${r.stderr}`);
  pack = (JSON.parse(r.stdout) as PackResult[])[0] as PackResult;
  paths = pack.files.map((f) => f.path.replace(/\\/g, "/"));
}, 120_000);

describe("npm pack (the files allowlist)", () => {
  it("publishes the unscoped package with the product version", () => {
    const server = JSON.parse(readFileSync(join(pkgDir, "../../apps/server/package.json"), "utf8"));
    expect(pack.name).toBe("pptaken");
    expect(pack.version).toBe(server.version);
  });

  it("contains every file the program needs", () => {
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "LICENSE-APACHE-2.0.txt",
      "THIRD-PARTY-NOTICES.md",
      "npm-shrinkwrap.json",
      "bin/pptaken.cjs",
      "dist/app/cli.js",
      "dist/app/worker.js",
      "dist/web/index.html",
      "dist/fonts/fonts.css",
      "dist/fonts/inter/OFL.txt",
      "dist/migrations/0001_init.sql",
      "dist/player/shell.js",
      "dist/player/sw.js",
      "dist/realtime/phone.js",
      "dist/qr/qr.js",
    ]) {
      expect(paths, required).toContain(required);
    }
  });

  it("contains nothing else: no sources, tests, scripts, maps, screenshots, secrets or archives", () => {
    const forbidden = [
      /^(src|test|scripts|licenses|node_modules)\//,
      /\.map$/,
      /\.(test|spec)\.[cm]?[jt]s$/,
      /\.d\.ts$/,
      /\.ts$/,
      /(^|\/)\.env/,
      /(^|\/)\.vite\//,
      /\.(png|jpe?g|gif|webp)$/i,
      /tsconfig/,
      /\.tgz$/,
      /(^|\/)\.(npmrc|git)/,
    ];
    const bad = paths.filter((p) => forbidden.some((re) => re.test(p)));
    expect(bad).toEqual([]);
    const allowedTop = new Set([
      "package.json",
      "README.md",
      "LICENSE",
      "LICENSE-APACHE-2.0.txt",
      "THIRD-PARTY-NOTICES.md",
      "npm-shrinkwrap.json",
      "bin",
      "dist",
    ]);
    expect(paths.filter((p) => !allowedTop.has(p.split("/")[0] as string))).toEqual([]);
    expect(paths.filter((p) => p.startsWith("bin/"))).toEqual(["bin/pptaken.cjs"]);
  });

  it(`stays under the ${BUDGET_BYTES / 1024 / 1024} MB unpacked budget`, () => {
    expect(pack.unpackedSize).toBeLessThan(BUDGET_BYTES);
    console.log(
      `pptaken ${pack.version}: ${pack.entryCount} files, ${(pack.size / 1024 / 1024).toFixed(2)} MB packed, ${(pack.unpackedSize / 1024 / 1024).toFixed(2)} MB unpacked`,
    );
  });

  it("has a manifest that is safe to install", () => {
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack"]) {
      expect(manifest.scripts?.[hook], hook).toBeUndefined();
    }
    expect(manifest.dependencies).toEqual({
      "better-sqlite3": expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
    expect(manifest.private).toBeUndefined();
    expect(manifest.engines.node).toBe(">=22");
    expect(manifest.bin).toEqual({ pptaken: "bin/pptaken.cjs" });
    expect(manifest.license).toBe("AGPL-3.0-or-later");
    expect(manifest.publishConfig).toEqual({ access: "public", provenance: true });
    for (const spec of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
      expect(spec, "exact versions only").toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
