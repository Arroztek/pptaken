// SPDX-License-Identifier: AGPL-3.0-or-later
// Prints a machine-readable JSON reference of every environment variable the server reads, taken from the
// declarative table in src/config-vars.ts (built to dist/). Run with: pnpm -s --filter @pptaken/server docs:config
// It also records which variables docker/compose.yaml passes through to the container, read from that file.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { CONFIG_VARS } = await import(new URL("../dist/config-vars.js", import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

/** Names listed under `environment:` of the `pptaken` service in docker/compose.yaml. */
export function composeVariables(compose) {
  const names = new Set();
  let inEnvironment = false;
  for (const line of compose.split(/\r?\n/)) {
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (inEnvironment && /^ {4}\S/.test(line)) inEnvironment = false;
    const match = inEnvironment ? /^ {6}(PPTAKEN_[A-Z0-9_]+):/.exec(line) : null;
    if (match) names.add(match[1]);
  }
  return names;
}

const composeFile = resolve(root, "../../docker/compose.yaml");
const inCompose = composeVariables(readFileSync(composeFile, "utf8"));

const reference = {
  generatedFrom: "apps/server/src/config-vars.ts",
  serverVersion: pkg.version,
  variables: CONFIG_VARS.map((v) => ({ ...v, passedByCompose: inCompose.has(v.name) })),
};
process.stdout.write(`${JSON.stringify(reference, null, 2)}\n`);
