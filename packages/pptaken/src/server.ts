// SPDX-License-Identifier: AGPL-3.0-or-later
// The one place the CLI reaches into the server. A relative path on purpose: `pptaken` is built after the rest of
// the workspace (root `build` script) and bundles the server's compiled output, so it needs no workspace dependency
// in its published manifest. esbuild follows this import and inlines the whole server (scripts/build.mjs).
export {
  backup,
  ConfigError,
  createLogger,
  type Logger,
  type LogLevel,
  loadConfig,
  type RunningServer,
  resetPassword,
  type ServerConfig,
  startServer,
} from "../../../apps/server/dist/start.js";
