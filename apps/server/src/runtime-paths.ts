// SPDX-License-Identifier: AGPL-3.0-or-later
// Where the server finds the files it reads at runtime: its own package.json (the version), the built web app, the
// bundled fonts, the browser modules of @pptaken/player and @pptaken/realtime, and the QR encoder served to phones.
//
// In the workspace and in the Docker image they are found through the workspace layout and node_modules. The
// single-package npm distribution (packages/pptaken, ADR-025) replaces THIS module at bundle time with one that
// resolves the same files inside the published package, so keep the exported shape small and stable.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface RuntimePaths {
  /** The package.json whose `version` is the product version. */
  packageJson: string;
  /** Default of PPTAKEN_WEB_DIR: the built web app. */
  webDir: string;
  /** Default of PPTAKEN_FONTS_DIR: the bundled font files and their `fonts.css`. */
  fontsDir: string;
  /** Directory of the @pptaken/player browser modules (`shell.js`, `sw.js`, …). */
  playerDir: string;
  /** Directory of the @pptaken/realtime browser modules (`phone.js`, `screen.js`, …). */
  realtimeDir: string;
  /** The single-file QR encoder module served at `/_rt/qr.js`. */
  qrFile: string;
}

export const runtimePaths: RuntimePaths = {
  packageJson: resolve(PACKAGE_DIR, "package.json"),
  webDir: resolve(PACKAGE_DIR, "../web/dist"),
  fontsDir: resolve(PACKAGE_DIR, "../../packages/ui/fonts"),
  playerDir: dirname(fileURLToPath(import.meta.resolve("@pptaken/player/shell"))),
  realtimeDir: dirname(fileURLToPath(import.meta.resolve("@pptaken/realtime"))),
  qrFile: fileURLToPath(import.meta.resolve("qr")),
};
