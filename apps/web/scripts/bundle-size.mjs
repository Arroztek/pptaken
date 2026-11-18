// SPDX-License-Identifier: AGPL-3.0-or-later
// Report the gzip size of the JS and CSS each page loads (entry + its page chunk + their static imports)
// from the Vite manifest, and fail the build if the welcome page exceeds its budget.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8"));
const BUDGET_WELCOME_JS = 100 * 1024;

const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length;

/** Every chunk key a set of entries pulls in statically. */
function closure(keys) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const dep of manifest[key]?.imports ?? []) visit(dep);
  };
  keys.forEach(visit);
  return seen;
}

function sizeOf(keys) {
  const chunks = closure(keys);
  let js = 0;
  const css = new Set();
  for (const key of chunks) {
    const chunk = manifest[key];
    js += gz(chunk.file);
    for (const c of chunk.css ?? []) css.add(c);
  }
  let cssBytes = 0;
  for (const c of css) cssBytes += gz(c);
  return { js, css: cssBytes };
}

const entry = "index.html";
const page = (name) => `src/pages/${name}.svelte`;
const pages = {
  "/welcome (setup + connect)": [entry, page("Setup"), page("Connect")],
  "/login": [entry, page("Login")],
  "/decks": [entry, page("Decks")],
  "/decks/:id": [entry, page("Deck")],
  "/tokens": [entry, page("Tokens")],
  "/security": [entry, page("Security")],
};

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log("\nGzip size per page (JS / CSS, fonts excluded):");
let failed = false;
for (const [name, keys] of Object.entries(pages)) {
  const missing = keys.filter((k) => !manifest[k]);
  if (missing.length) throw new Error(`Manifest has no entry for ${missing.join(", ")}`);
  const { js, css } = sizeOf(keys);
  console.log(`  ${name.padEnd(28)} ${kb(js).padStart(9)} / ${kb(css).padStart(8)}`);
  if (name.startsWith("/welcome") && js > BUDGET_WELCOME_JS) failed = true;
}
if (failed) {
  console.error(`\nThe welcome page exceeds its ${kb(BUDGET_WELCOME_JS)} gzip JS budget.`);
  process.exit(1);
}
