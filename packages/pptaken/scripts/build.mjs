// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the publishable `pptaken` package from the already built workspace (run `pnpm build` at the root; the
// root script builds every other package first, then this one):
//
//   dist/app/cli.js       the CLI + the whole server + every @pptaken/* package + npm dependencies, one ESM file
//   dist/app/worker.js    the PowerPoint import worker thread (started by @pptaken/import-pptx as ./worker.js)
//   dist/migrations/      SQL migrations          dist/web/        the built web app (apps/web/dist)
//   dist/fonts/           bundled fonts + OFL     dist/player/     player browser modules
//   dist/realtime/        remote-control modules  dist/qr/qr.js    QR encoder served to phones
//   LICENSE, LICENSE-APACHE-2.0.txt, THIRD-PARTY-NOTICES.md   (generated; the licence gate can stop the build)
//   npm-shrinkwrap.json   pins better-sqlite3 and its dependencies to the versions and hashes in pnpm-lock.yaml
//
// better-sqlite3 stays external: it is a native addon, installed by npm as the package's only dependency.
// Bundler: esbuild, pinned exactly in package.json and already in the workspace lockfile (used by Vite and tsx), so
// it adds no new third-party code to the supply chain. No minification: the output stays readable and auditable.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  componentFromDir,
  componentsFromMetafile,
  enforceGate,
  licenseFiles,
  packageDirFrom,
  renderNotices,
} from "./licenses.mjs";
import { shrinkwrapFromPnpmLock } from "./shrinkwrap.mjs";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(pkgDir, "../..");
const dist = join(pkgDir, "dist");
const at = (...parts) => join(root, ...parts);

function fail(message) {
  console.error(`pptaken build: ${message}`);
  process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// --- 0. Preconditions --------------------------------------------------------------------------------------------
const required = {
  "apps/server/dist/start.js": "the server (pnpm --filter @pptaken/server build)",
  "apps/web/dist/index.html": "the web app (pnpm --filter @pptaken/web build)",
  "packages/player/dist/shell.js": "the player (pnpm --filter @pptaken/player build)",
  "packages/player/dist/sw.js": "the player service worker",
  "packages/realtime/dist/index.js": "the realtime package",
  "packages/import-pptx/dist/worker.js": "the PowerPoint import worker",
  "packages/ui/fonts/fonts.css": "the bundled fonts",
};
for (const [file, what] of Object.entries(required)) {
  if (!existsSync(at(file)))
    fail(`${file} is missing: build ${what} first, or run "pnpm build" at the root.`);
}

const pkg = readJson(join(pkgDir, "package.json"));
const serverPkg = readJson(at("apps/server/package.json"));
if (pkg.version !== serverPkg.version) {
  fail(
    `version ${pkg.version} differs from apps/server (${serverPkg.version}); use node scripts/bump-version.mjs.`,
  );
}
const storagePkg = readJson(at("packages/storage-sqlite/package.json"));
if (pkg.dependencies?.["better-sqlite3"] !== storagePkg.dependencies?.["better-sqlite3"]) {
  fail(
    `better-sqlite3 must be pinned to the same version as @pptaken/storage-sqlite (${storagePkg.dependencies?.["better-sqlite3"]}).`,
  );
}
if (Object.keys(pkg.dependencies ?? {}).join() !== "better-sqlite3") {
  fail("the published package must depend on better-sqlite3 only (everything else is bundled).");
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// --- 1. Bundle ---------------------------------------------------------------------------------------------------
const serverDist = at("apps/server/dist");
const ownRuntimePaths = join(pkgDir, "src", "runtime-paths.ts");

/** Swaps the server's runtime-paths module (workspace layout) for ours (package layout). */
const runtimePathsPlugin = {
  name: "pptaken-runtime-paths",
  setup(b) {
    b.onResolve({ filter: /^\.\/runtime-paths\.js$/ }, (args) =>
      resolve(args.resolveDir) === serverDist ? { path: ownRuntimePaths } : undefined,
    );
  },
};

/**
 * css-tree reads its data with `createRequire(import.meta.url)` (JSON files of mdn-data and its own package.json),
 * which a bundle cannot follow. The package ships the same data pre-built as plain ES modules for browsers
 * (`browser` field: lib/data.js -> dist/data.js, lib/version.js -> dist/version.js); use those.
 */
const cssTreePlugin = {
  name: "pptaken-css-tree-data",
  setup(b) {
    b.onLoad({ filter: /[\\/]css-tree[\\/]lib[\\/](data|version)\.js$/ }, (args) => {
      const prebuilt = join(
        dirname(args.path),
        "..",
        "dist",
        args.path.endsWith("data.js") ? "data.js" : "version.js",
      );
      if (!existsSync(prebuilt)) throw new Error(`css-tree pre-built data not found: ${prebuilt}`);
      return {
        contents: readFileSync(prebuilt, "utf8"),
        loader: "js",
        resolveDir: dirname(prebuilt),
      };
    });
  },
};

const result = await build({
  absWorkingDir: pkgDir,
  entryPoints: {
    "app/cli": join(pkgDir, "src", "cli.ts"),
    "app/worker": at("packages/import-pptx/dist/worker.js"),
  },
  outdir: dist,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // The native SQLite addon is installed by npm; ws's optional native helpers are looked up at runtime and skipped.
  external: ["better-sqlite3", "bufferutil", "utf-8-validate"],
  // CommonJS dependencies (ws, …) call require() for Node built-ins: give the ESM bundle a real one.
  banner: {
    js: 'import { createRequire as __pptakenCreateRequire } from "node:module";\nconst require = __pptakenCreateRequire(import.meta.url);',
  },
  plugins: [runtimePathsPlugin, cssTreePlugin],
  metafile: true,
  legalComments: "eof",
  charset: "utf8",
  sourcemap: false,
  minify: false,
  logLevel: "warning",
});
if (result.errors.length > 0) fail("esbuild reported errors");

// The bundle must not depend on anything but Node built-ins and better-sqlite3, nor read files the way the
// workspace does (import.meta.resolve of workspace packages, createRequire on JSON data).
const ALLOWED_EXTERNAL = new Set(["better-sqlite3", "bufferutil", "utf-8-validate"]);
for (const file of ["app/cli.js", "app/worker.js"]) {
  const code = readFileSync(join(dist, file), "utf8");
  const output = Object.entries(result.metafile.outputs).find(([path]) =>
    path.replace(/\\/g, "/").endsWith(`dist/${file}`),
  );
  if (output === undefined) fail(`${file} is not in the esbuild metafile`);
  const foreign = output[1].imports
    .filter((i) => i.external)
    .map((i) => i.path)
    .filter((s) => !isBuiltin(s) && !ALLOWED_EXTERNAL.has(s));
  if (foreign.length > 0)
    fail(`${file} imports packages that are not bundled: ${[...new Set(foreign)].join(", ")}`);
  if (code.includes("import.meta.resolve(")) fail(`${file} still calls import.meta.resolve()`);
  const requires = code.match(/createRequire\(import\.meta\.url\)/g) ?? [];
  if (requires.length > 0)
    fail(`${file} still uses createRequire(import.meta.url) outside the banner`);
}
if (
  !readFileSync(join(dist, "app/cli.js"), "utf8").includes(
    'new URL("./worker.js", import.meta.url)',
  )
) {
  fail(
    "the PowerPoint worker is no longer started as ./worker.js next to the bundle; update the layout.",
  );
}

// --- 2. Runtime files ----------------------------------------------------------------------------------------------
const copy = (from, to, filter) => cpSync(from, to, { recursive: true, filter });
copy(
  at("packages/storage-sqlite/migrations"),
  join(dist, "migrations"),
  (src) => statSync(src).isDirectory() || /^\d{4}_[a-z0-9_]+\.sql$/.test(src.split(/[\\/]/).pop()),
);
// The web app without source maps and without Vite's build manifest (not served, not needed).
copy(
  at("apps/web/dist"),
  join(dist, "web"),
  (src) => !src.endsWith(".map") && !/[\\/]\.vite([\\/]|$)/.test(src),
);
copy(
  at("packages/ui/fonts"),
  join(dist, "fonts"),
  (src) => statSync(src).isDirectory() || /\.(woff2|css)$|[\\/]OFL\.txt$/.test(src),
);

const player = await import(pathToFileURL(at("packages/player/dist/index.js")).href);
const GENERATED = new Set(["page.js", "page.css", "presenter-page.js", "presenter.css"]);
mkdirSync(join(dist, "player"));
for (const file of [...player.SHELL_FILES.filter((f) => !GENERATED.has(f)), "sw.js"]) {
  const src = at("packages/player/dist", file);
  if (!existsSync(src)) fail(`player file ${file} is missing`);
  cpSync(src, join(dist, "player", file));
}
const realtime = await import(pathToFileURL(at("packages/realtime/dist/index.js")).href);
mkdirSync(join(dist, "realtime"));
for (const file of realtime.BROWSER_FILES) {
  const src = at("packages/realtime/dist", file);
  if (!existsSync(src)) fail(`realtime file ${file} is missing`);
  cpSync(src, join(dist, "realtime", file));
}
// Browser modules must not point at source maps that are not shipped.
for (const dir of ["player", "realtime"]) {
  for (const file of readdirSync(join(dist, dir))) {
    const path = join(dist, dir, file);
    const code = readFileSync(path, "utf8");
    writeFileSync(path, code.replace(/\n\/\/# sourceMappingURL=\S+\.map\s*$/, "\n"));
  }
}
const serverRequire = createRequire(at("apps/server/package.json"));
const qrDir = packageDirFrom(at("apps/server"), "qr");
mkdirSync(join(dist, "qr"));
cpSync(serverRequire.resolve("qr"), join(dist, "qr", "qr.js"));

// --- 3. Licences ---------------------------------------------------------------------------------------------------
const { thirdParty, firstParty } = componentsFromMetafile(result.metafile, {
  workingDir: pkgDir,
  root,
});
const extra = [];
const has = (name) => thirdParty.some((c) => c.name === name);
if (has("css-tree")) {
  const cssTree = thirdParty.find((c) => c.name === "css-tree");
  const mdn = componentFromDir(
    packageDirFrom(packageDirFrom(at("packages/sanitizer"), "css-tree"), "mdn-data"),
    "data embedded in css-tree (bundled)",
  );
  mdn.note = `Its CSS syntax data is included in css-tree ${cssTree.version}'s pre-built data module.`;
  extra.push(mdn);
}
extra.push(componentFromDir(qrDir, "dist/qr/qr.js (served to phones)"));
// Code the web app's bundler (Vite) inlined into dist/web: the Svelte runtime, its two runtime helpers, and Vite's
// small module-preload helper.
const webDir = at("apps/web");
const svelteDir = packageDirFrom(webDir, "svelte");
extra.push(componentFromDir(svelteDir, "dist/web (runtime)"));
for (const name of ["clsx", "esm-env"])
  extra.push(componentFromDir(packageDirFrom(svelteDir, name), "dist/web (runtime)"));
extra.push(componentFromDir(packageDirFrom(webDir, "vite"), "dist/web (module preload helper)"));
// Vendored into the workspace (no package.json): declared here with their licence file, and every vendored
// directory must be declared, so a new one cannot slip in without a notice.
const VENDORED = {
  "packages/player/vendor/uplot-1.6.32": {
    name: "uPlot",
    version: "1.6.32",
    license: "MIT",
    homepage: "https://github.com/leeoniya/uPlot",
    how: "bundled into dist/app (deck chart library)",
  },
};
for (const dir of readdirSync(at("packages/player/vendor"))) {
  if (!VENDORED[`packages/player/vendor/${dir}`])
    fail(`vendored code packages/player/vendor/${dir} has no notice entry`);
}
for (const [dir, info] of Object.entries(VENDORED))
  extra.push({ ...info, texts: licenseFiles(at(dir)) });
extra.push({
  name: "Phosphor Icons (selected SVGs)",
  version: "-",
  license: "MIT",
  homepage: "https://phosphoricons.com",
  how: "dist/web (icons)",
  texts: [
    {
      name: "LICENSE-phosphor.txt",
      text: readFileSync(at("packages/ui/icons/LICENSE-phosphor.txt"), "utf8").replace(
        /\r\n/g,
        "\n",
      ),
    },
  ],
});
const FONTS = {
  inter: { name: "Inter", homepage: "https://github.com/rsms/inter" },
  "bricolage-grotesque": {
    name: "Bricolage Grotesque",
    homepage: "https://github.com/ateliertriay/bricolage",
  },
  "jetbrains-mono": {
    name: "JetBrains Mono",
    homepage: "https://github.com/JetBrains/JetBrainsMono",
  },
};
for (const dir of readdirSync(at("packages/ui/fonts"))) {
  if (!statSync(at("packages/ui/fonts", dir)).isDirectory()) continue;
  const font = FONTS[dir];
  if (!font) fail(`font folder packages/ui/fonts/${dir} has no notice entry`);
  const ofl = at("packages/ui/fonts", dir, "OFL.txt");
  extra.push({
    name: `${font.name} (font)`,
    version: "-",
    license: "OFL-1.1",
    homepage: font.homepage,
    how: `dist/fonts/${dir} and dist/web`,
    texts: existsSync(ofl)
      ? [{ name: "OFL.txt", text: readFileSync(ofl, "utf8").replace(/\r\n/g, "\n") }]
      : [],
  });
}
const sqliteDir = packageDirFrom(at("packages/storage-sqlite"), "better-sqlite3");
const sqlite = componentFromDir(sqliteDir, "npm dependency (installed separately, native)");
sqlite.note =
  "Installed by npm next to this package (not bundled). It includes SQLite, which is in the public domain (https://sqlite.org/copyright.html).";
extra.push(sqlite);

const components = { thirdParty: [...thirdParty, ...extra], firstParty };
enforceGate(components);
writeFileSync(
  join(pkgDir, "THIRD-PARTY-NOTICES.md"),
  renderNotices({ product: "PPTaken (npm package pptaken)", version: pkg.version, ...components }),
);
cpSync(at("LICENSE"), join(pkgDir, "LICENSE"));
// Pin the installed dependency tree (better-sqlite3 and what it needs) to the tested versions and hashes.
const shrinkwrap = shrinkwrapFromPnpmLock(readFileSync(at("pnpm-lock.yaml"), "utf8"), {
  name: pkg.name,
  version: pkg.version,
  license: pkg.license,
  dependencies: pkg.dependencies,
  bin: pkg.bin,
  engines: pkg.engines,
});
writeFileSync(join(pkgDir, "npm-shrinkwrap.json"), `${JSON.stringify(shrinkwrap, null, 2)}\n`);
const apache = readFileSync(at("packages/schema/LICENSE"), "utf8");
for (const p of ["packages/player/LICENSE", "packages/realtime/LICENSE"]) {
  if (readFileSync(at(p), "utf8") !== apache) fail(`${p} differs from packages/schema/LICENSE`);
}
writeFileSync(join(pkgDir, "LICENSE-APACHE-2.0.txt"), apache);

// --- 4. Summary ----------------------------------------------------------------------------------------------------
function sizeOf(path) {
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`pptaken ${pkg.version} built in ${relative(root, dist)}:`);
for (const entry of readdirSync(dist).sort())
  console.log(`  ${entry.padEnd(12)} ${mb(sizeOf(join(dist, entry)))}`);
console.log(`  total        ${mb(sizeOf(dist))}`);
console.log(
  `  ${thirdParty.length} bundled npm packages and ${extra.length} other components passed the licence gate.`,
);
