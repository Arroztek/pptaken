// SPDX-License-Identifier: AGPL-3.0-or-later
// Embeddable start-up: builds the server, listens, and returns a handle that stops it cleanly. Used by `main.ts`
// (the Docker image and source checkouts) and by the single-package npm distribution `pptaken` (packages/pptaken,
// ADR-025), which brings its own command line. Listening errors (a busy port) are returned, never thrown later.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createServer, type PPTakenServer } from "./app.js";
import type { ServerConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";

export { backup, resetPassword } from "./cli.js";
export { ConfigError, loadConfig, type ServerConfig } from "./config.js";
export { createLogger, type Logger, type LogLevel, type LogSink } from "./logger.js";
export { runtimePaths } from "./runtime-paths.js";

export interface StartOptions {
  /** Defaults to JSON lines on stdout at `config.logLevel`. */
  logger?: Logger;
}

export interface RunningServer {
  pptaken: PPTakenServer;
  /** The one-time install code while no owner exists; null once installed. */
  installCode: string | null;
  /** The port actually bound. */
  port: number;
  host: string;
  /**
   * Stops accepting connections, closes the WebSockets (1001), lets running requests finish (idle keep-alive
   * connections are closed at once, the rest after a short grace period), then closes the database. Idempotent.
   */
  close(): Promise<void>;
}

/** Grace period for in-flight requests before the remaining connections are cut. */
const CLOSE_GRACE_MS = 3_000;

function listen(
  pptaken: PPTakenServer,
  config: ServerConfig,
): Promise<{ server: Server; info: AddressInfo }> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: pptaken.fetch, port: config.port, hostname: config.host },
      (info: AddressInfo) => {
        server.off("error", reject);
        resolve({ server: server as unknown as Server, info });
      },
    );
    server.once("error", reject);
  });
}

/** Builds the server and listens on `config.host:config.port`. Rejects (with the database closed) if it cannot. */
export async function startServer(
  config: ServerConfig,
  options: StartOptions = {},
): Promise<RunningServer> {
  const logger = options.logger ?? createLogger(config.logLevel);
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
  let listening: { server: Server; info: AddressInfo };
  try {
    listening = await listen(pptaken, config);
  } catch (error) {
    await pptaken.close().catch(() => {});
    throw error;
  }
  const { server: http, info } = listening;
  // Longer than a reverse proxy's idle backend connection (Traefik keeps them ~90 s) avoids rare 502s;
  // headersTimeout must stay above keepAliveTimeout.
  http.keepAliveTimeout = 95_000;
  http.headersTimeout = 100_000;
  http.requestTimeout = 60_000;
  // Remote control: /ws on the same port (WebSocket upgrades bypass Hono; see realtime.ts).
  pptaken.attach(http);
  logger.info("listening", { port: info.port, host: config.host, version: config.version });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      // Sockets first (1001 "going away": clients reconnect with backoff), so close() is not held open by them.
      pptaken.realtime.close();
      const cut = setTimeout(() => http.closeAllConnections(), CLOSE_GRACE_MS);
      cut.unref();
      http.close(() => {
        clearTimeout(cut);
        pptaken
          .close()
          .catch((error: unknown) =>
            logger.error("close failed", {
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          .finally(() => resolve());
      });
      // Idle keep-alive connections would hold close() open.
      http.closeIdleConnections();
    });
    return closing;
  };

  return { pptaken, installCode: pptaken.installCode, port: info.port, host: config.host, close };
}
