#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Entry point: `pptaken` (serve, the default), `pptaken reset-password`, `pptaken backup <dir>`.
import { backup, resetPassword } from "./cli.js";
import { ConfigError, loadConfig, type ServerConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { startServer } from "./start.js";

const USAGE = `Usage:
  pptaken                    start the server
  pptaken reset-password     set a new owner password (reads it from the terminal or stdin)
    --clear-presenter-password   also remove the presenter password (ends every presenter unlock)
  pptaken backup <dir>       write a consistent copy of the database and the blobs to a new directory

Configuration (environment): PPTAKEN_PUBLIC_URL, PPTAKEN_PORT (8080), PPTAKEN_DATA_DIR (./data),
PPTAKEN_TRUST_PROXY, PPTAKEN_WEB_DIR, PPTAKEN_CONTENT_URL, PPTAKEN_ALLOWED_HOSTS, PPTAKEN_LANG,
PPTAKEN_SECRET_KEY / PPTAKEN_SECRET_KEY_FILE, PPTAKEN_MAX_API_BODY_KB, PPTAKEN_MAX_MCP_BODY_MB, PPTAKEN_LOG_LEVEL.
`;

async function runServer(config: ServerConfig): Promise<void> {
  const logger = createLogger(config.logLevel);
  const running = await startServer(config, { logger });
  const url = config.publicUrl ?? `http://localhost:${running.port}`;
  const line =
    running.installCode === null
      ? `PPTaken ready at ${url}`
      : `PPTaken ready at ${url} · Install code: ${running.installCode}`;
  // Printed as a plain line on purpose: the install code is meant to be read by the administrator here.
  process.stdout.write(`${line}\n`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    void running.close().then(() => {
      logger.info("stopped");
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (command === undefined || command === "serve") {
    await runServer(config);
    return -1; // keep running
  }
  if (command === "reset-password") {
    const unknown = rest.filter((arg) => arg !== "--clear-presenter-password");
    if (unknown.length > 0) {
      process.stderr.write(`Unknown option "${unknown[0]}".\n\n${USAGE}`);
      return 2;
    }
    return resetPassword(config, {
      clearPresenterPassword: rest.includes("--clear-presenter-password"),
    });
  }
  if (command === "backup") return backup(config, rest[0]);
  process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
