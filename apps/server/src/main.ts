#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Entry point: `pptaken` (serve, the default), `pptaken reset-password`, `pptaken backup <dir>`.
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createServer } from "./app.js";
import { backup, resetPassword } from "./cli.js";
import { ConfigError, loadConfig, type ServerConfig } from "./config.js";
import { createLogger } from "./logger.js";

const USAGE = `Usage:
  pptaken                    start the server
  pptaken reset-password     set a new owner password (reads it from the terminal or stdin)
  pptaken backup <dir>       write a consistent copy of the database and the blobs to a new directory

Configuration (environment): PPTAKEN_PUBLIC_URL, PPTAKEN_PORT (8080), PPTAKEN_DATA_DIR (./data),
PPTAKEN_TRUST_PROXY, PPTAKEN_WEB_DIR, PPTAKEN_CONTENT_URL, PPTAKEN_ALLOWED_HOSTS, PPTAKEN_LANG,
PPTAKEN_SECRET_KEY / PPTAKEN_SECRET_KEY_FILE, PPTAKEN_MAX_API_BODY_KB, PPTAKEN_MAX_MCP_BODY_MB, PPTAKEN_LOG_LEVEL.
`;

async function runServer(config: ServerConfig): Promise<void> {
  const logger = createLogger(config.logLevel);
  const pptaken = await createServer(config, {
    logger,
    socketIp: (raw, env) => {
      try {
        return getConnInfo({ req: { raw }, env } as never).remote.address;
      } catch {
        return undefined;
      }
    },
  });
  const server = serve(
    { fetch: pptaken.fetch, port: config.port, hostname: config.host },
    (info: AddressInfo) => {
      const url = config.publicUrl ?? `http://localhost:${info.port}`;
      const line =
        pptaken.installCode === null
          ? `PPTaken ready at ${url}`
          : `PPTaken ready at ${url} · Install code: ${pptaken.installCode}`;
      // Printed as a plain line on purpose: the install code is meant to be read by the administrator here.
      process.stdout.write(`${line}\n`);
      logger.info("listening", { port: info.port, host: config.host, version: config.version });
    },
  );
  const http = server as unknown as import("node:http").Server;
  // Longer than a reverse proxy's idle backend connection (Traefik keeps them ~90 s) avoids rare 502s;
  // headersTimeout must stay above keepAliveTimeout.
  http.keepAliveTimeout = 95_000;
  http.headersTimeout = 100_000;
  http.requestTimeout = 60_000;
  // Remote control: /ws on the same port (WebSocket upgrades bypass Hono; see realtime.ts).
  pptaken.attach(http);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    // Sockets first (1001 "going away": clients reconnect with backoff), so close() is not held open by them.
    pptaken.realtime.close();
    server.close(async () => {
      await pptaken.close();
      logger.info("stopped");
      process.exit(0);
    });
    // Idle keep-alive connections would hold close() open.
    (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
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
  if (command === "reset-password") return resetPassword(config);
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
