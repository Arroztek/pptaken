// SPDX-License-Identifier: AGPL-3.0-or-later
// Licence gate and THIRD-PARTY-NOTICES generator of the `pptaken` npm package.
//
// Everything that ends up inside the package is accounted for: the npm packages esbuild actually bundled (read from
// its metafile, so nothing is guessed), the code that the web app's bundler inlined, the files shipped as they are
// (QR encoder, fonts), code vendored into the workspace (uPlot) and the one installed dependency (better-sqlite3).
// The build REFUSES to finish when a licence is unknown, not on the allowlist, or has no licence text to ship.
// Pure functions plus small file reads: unit tested in test/licenses.test.ts. Output is sorted, so it is reproducible.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Licences that may be combined into, and redistributed with, an AGPL-3.0-or-later application. Extend this list
 * only after reading the licence: copyleft licences other than our own (GPL-2.0-only, MPL with conditions, SSPL,
 * …) and "source available" licences are deliberately absent.
 */
export const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "OFL-1.1",
  "Unlicense",
  "Zlib",
]);

/** Our own licences (first-party workspace packages). */
export const FIRST_PARTY_LICENSES = new Set(["AGPL-3.0-or-later", "Apache-2.0"]);

export class LicenseGateError extends Error {
  constructor(problems) {
    super(
      `Licence gate failed:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        "Review the licence; if it is compatible, add it to ALLOWED_LICENSES in scripts/licenses.mjs.",
    );
    this.name = "LicenseGateError";
    this.problems = problems;
  }
}

/** Normalizes the `license` / `licenses` field of a package.json into one SPDX expression (or null). */
export function licenseOf(pkg) {
  if (typeof pkg.license === "string" && pkg.license.trim() !== "") return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const ids = pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    return ids.length === 0 ? null : ids.length === 1 ? ids[0] : `(${ids.join(" OR ")})`;
  }
  return null;
}

function tokenize(expression) {
  return expression
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter((t) => t !== "");
}

/**
 * True when the SPDX expression is acceptable: `A OR B` needs one acceptable side, `A AND B` both, `A WITH X`
 * (licence exceptions) is refused, and any unknown identifier is refused.
 */
export function isAllowedExpression(expression, allowed = ALLOWED_LICENSES) {
  if (typeof expression !== "string" || expression.trim() === "") return false;
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function primary() {
    const token = next();
    if (token === undefined) throw new Error("unexpected end");
    if (token === "(") {
      const value = orExpr();
      if (next() !== ")") throw new Error("missing )");
      return value;
    }
    if (token === ")" || token === "AND" || token === "OR" || token === "WITH") {
      throw new Error(`unexpected ${token}`);
    }
    if (peek() === "WITH") {
      next();
      next();
      return false;
    }
    return allowed.has(token.replace(/\+$/, ""));
  }
  function andExpr() {
    let value = primary();
    while (peek() === "AND") {
      next();
      const right = primary();
      value = value && right;
    }
    return value;
  }
  function orExpr() {
    let value = andExpr();
    while (peek() === "OR") {
      next();
      const right = andExpr();
      value = value || right;
    }
    return value;
  }
  try {
    const value = orExpr();
    return pos === tokens.length && value;
  } catch {
    return false;
  }
}

const TEXT_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** Licence and notice files at the root of a package directory, sorted by name. */
export function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => TEXT_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n") }));
}

/** Walks up from a file to the nearest package.json that has a name and a version (skips `{ "type": … }` stubs). */
export function packageRootOf(file) {
  let dir = dirname(file);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (typeof pkg.name === "string" && typeof pkg.version === "string") return { dir, pkg };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const LICENSES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "licenses");

/**
 * Licence texts for packages that publish none in their npm tarball, copied from the upstream repository at the
 * exact released tag and reviewed by hand. Keyed by exact `name@version`: an upgrade fails the gate again until
 * the text is re-checked.
 */
export const TEXT_OVERRIDES = {
  "saxes@6.0.0": {
    file: "saxes-6.0.0-LICENSE.txt",
    source: "https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE",
  },
};

/** A component entry from a package directory. */
export function componentFromDir(dir, how) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const component = {
    name: pkg.name,
    version: pkg.version,
    license: licenseOf(pkg),
    homepage: typeof pkg.homepage === "string" ? pkg.homepage : repositoryUrl(pkg),
    how,
    texts: licenseFiles(dir),
  };
  const override = TEXT_OVERRIDES[`${pkg.name}@${pkg.version}`];
  if (component.texts.length === 0 && override !== undefined) {
    component.texts = [
      {
        name: `LICENSE (from ${override.source}; not included in the npm package)`,
        text: readFileSync(join(LICENSES_DIR, override.file), "utf8").replace(/\r\n/g, "\n"),
      },
    ];
  }
  return component;
}

function repositoryUrl(pkg) {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (typeof repo !== "string") return undefined;
  return repo.replace(/^git\+/, "").replace(/\.git$/, "");
}

/**
 * Splits the inputs of an esbuild metafile into third-party npm packages and first-party workspace packages.
 * `workingDir` is esbuild's absWorkingDir (metafile paths are relative to it); `root` is the monorepo root.
 */
export function componentsFromMetafile(metafile, { workingDir, root }) {
  const thirdParty = new Map();
  const firstParty = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (input.startsWith("<") || input.includes("(disabled)")) continue;
    const file = realpathSync(resolve(workingDir, input));
    const found = packageRootOf(file);
    if (found === null) continue;
    const insideNodeModules = file.split(sep).includes("node_modules");
    const key = `${found.pkg.name}@${found.pkg.version}`;
    if (!insideNodeModules && relative(root, found.dir).split(sep)[0] !== "..") {
      firstParty.set(key, {
        name: found.pkg.name,
        version: found.pkg.version,
        license: licenseOf(found.pkg),
        dir: found.dir,
      });
    } else if (!thirdParty.has(key)) {
      thirdParty.set(key, componentFromDir(found.dir, "bundled into dist/app"));
    }
  }
  return {
    thirdParty: [...thirdParty.values()],
    firstParty: [...firstParty.values()],
  };
}

/** Resolves `name/package.json` as seen from `fromDir` (a package directory) and returns its directory. */
export function packageDirFrom(fromDir, name) {
  const require = createRequire(join(fromDir, "package.json"));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // Packages whose `exports` hide package.json: resolve the entry and walk up.
    const found = packageRootOf(require.resolve(name));
    if (found === null) throw new Error(`cannot find ${name} from ${fromDir}`);
    return found.dir;
  }
}

/** Every problem that must stop the build; an empty list means the gate passes. */
export function gateProblems({ thirdParty, firstParty }) {
  const problems = [];
  for (const c of thirdParty) {
    const id = `${c.name}@${c.version}`;
    if (c.license === null) problems.push(`${id}: no licence declared`);
    else if (!isAllowedExpression(c.license)) {
      problems.push(`${id}: licence "${c.license}" is not on the allowlist`);
    }
    if (c.texts.length === 0) problems.push(`${id}: no LICENSE/NOTICE file to ship with it`);
  }
  for (const c of firstParty) {
    if (!FIRST_PARTY_LICENSES.has(c.license ?? "")) {
      problems.push(
        `${c.name}: first-party licence "${c.license}" is neither AGPL-3.0-or-later nor Apache-2.0`,
      );
    }
  }
  return problems;
}

/** Throws {@link LicenseGateError} when any component fails the gate. */
export function enforceGate(components) {
  const problems = gateProblems(components);
  if (problems.length > 0) throw new LicenseGateError(problems);
}

/** THIRD-PARTY-NOTICES.md: deterministic (sorted, no dates), every licence text in full. */
export function renderNotices({ product, version, thirdParty, firstParty }) {
  const byName = (a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name);
  const lines = [
    `# Third-party notices for ${product} ${version}`,
    "",
    `${product} is licensed under AGPL-3.0-or-later (see LICENSE). The packages @pptaken/schema, @pptaken/player and`,
    "@pptaken/realtime are licensed under Apache-2.0 (see LICENSE-APACHE-2.0.txt). This file lists the third-party",
    "software included in this package or installed with it, with its licence and the full licence text, as required",
    "by those licences. It is generated by packages/pptaken/scripts/build.mjs; do not edit it by hand.",
    "",
    "## First-party components",
    "",
    "| Package | Licence |",
    "| --- | --- |",
    ...[...firstParty].sort(byName).map((c) => `| ${c.name} | ${c.license} |`),
    "",
    "## Summary of third-party components",
    "",
    "| Component | Version | Licence | Where |",
    "| --- | --- | --- | --- |",
    ...[...thirdParty]
      .sort(byName)
      .map((c) => `| ${c.name} | ${c.version} | ${c.license} | ${c.how} |`),
    "",
    "## Licence texts",
    "",
  ];
  for (const c of [...thirdParty].sort(byName)) {
    lines.push(`### ${c.name} ${c.version}`, "");
    lines.push(`Licence: ${c.license}${c.homepage ? ` · ${c.homepage}` : ""}`, "");
    if (c.note) lines.push(c.note, "");
    for (const t of c.texts) {
      // A fence longer than any backtick run inside the text, so no licence can close it early.
      const longest = Math.max(0, ...(t.text.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      lines.push(`#### ${t.name}`, "", `${fence}text`, t.text.trimEnd(), fence, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
