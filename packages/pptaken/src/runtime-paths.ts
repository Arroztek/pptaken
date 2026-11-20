// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundle-time replacement of apps/server/src/runtime-paths.ts (see scripts/build.mjs): inside the published package
// every runtime file sits next to the bundle, so paths are resolved from this module's own location
// (`<package>/dist/app/cli.js`) and never from the current directory, the monorepo layout or environment variables.
//
//   <package>/package.json         version
//   <package>/dist/app/            cli.js (this code), worker.js (PowerPoint import worker)
//   <package>/dist/migrations/     SQL migrations (found by @pptaken/storage-sqlite as ../migrations from dist/app)
//   <package>/dist/web/            built web app        <package>/dist/fonts/      bundled fonts
//   <package>/dist/player/         player modules       <package>/dist/realtime/   remote-control modules
//   <package>/dist/qr/qr.js        QR encoder for the phone page
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimePaths } from "../../../apps/server/dist/runtime-paths.js";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const runtimePaths: RuntimePaths = {
  packageJson: resolve(DIST, "..", "package.json"),
  webDir: join(DIST, "web"),
  fontsDir: join(DIST, "fonts"),
  playerDir: join(DIST, "player"),
  realtimeDir: join(DIST, "realtime"),
  qrFile: join(DIST, "qr", "qr.js"),
};

/** The files and folders the package cannot run without (checked at start for a clear error). */
export const REQUIRED_PATHS: readonly string[] = [
  runtimePaths.packageJson,
  join(runtimePaths.webDir, "index.html"),
  join(runtimePaths.fontsDir, "fonts.css"),
  join(runtimePaths.playerDir, "shell.js"),
  join(runtimePaths.playerDir, "sw.js"),
  join(runtimePaths.realtimeDir, "phone.js"),
  runtimePaths.qrFile,
  join(DIST, "migrations", "0001_init.sql"),
  join(DIST, "app", "worker.js"),
];
