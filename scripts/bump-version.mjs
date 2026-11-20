// SPDX-License-Identifier: AGPL-3.0-or-later
// Sets the product version in every package.json that carries it, so a release starts from one consistent state.
//
//   node scripts/bump-version.mjs 0.2.0           # or 0.2.0-rc.1
//   node scripts/bump-version.mjs 0.2.0 --dry-run # print what would change
//
// Only the root package.json and apps/server/package.json carry the product version: the server reports it at
// runtime (MCP server info, startup log) and the release workflow checks the git tag against it. The libraries under
// packages/ and apps/web stay at 0.0.0 (private, versioned with the product, never published separately).
// The script refuses to run on a dirty working tree, so the version bump is a clean, reviewable commit.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["package.json", "apps/server/package.json"];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((a) => !a.startsWith("--"))?.replace(/^v/, "");

function fail(message) {
  console.error(`bump-version: ${message}`);
  process.exit(1);
}

if (!version || !SEMVER.test(version)) {
  fail("usage: node scripts/bump-version.mjs <X.Y.Z[-prerelease]> [--dry-run]");
}

if (!dryRun) {
  let status;
  try {
    status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  } catch {
    fail("could not run `git status`; run this inside the repository");
  }
  if (status.trim() !== "") {
    fail("the working tree is not clean; commit or stash your changes first");
  }
}

for (const file of FILES) {
  const path = resolve(root, file);
  const text = readFileSync(path, "utf8");
  const current = JSON.parse(text).version;
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next === text && current !== version) fail(`no "version" field found in ${file}`);
  console.log(`${file}: ${current} -> ${version}${dryRun ? " (dry run)" : ""}`);
  if (!dryRun) writeFileSync(path, next);
}

if (!dryRun) {
  console.log(
    `\nNext: move the Unreleased entries of CHANGELOG.md under "## [${version}] - <date>", commit, tag v${version}.`,
  );
}
