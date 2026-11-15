// SPDX-License-Identifier: AGPL-3.0-or-later
// Composition root: opens the data directory (secret key, SQLite, blobs), wires core + auth + MCP and builds the
// Hono app with the cross-cutting controls (Host validation, security headers, body limits, rate limits, logs).
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createLocalAuth,
  deriveKey,
  loadOrCreateSecretKey,
  type ScryptParams,
  SignInThrottle,
  TokenBucketLimiter,
} from "@pptaken/auth-local";
import { openFsBlobStore } from "@pptaken/blob-fs";
import { createCore, createLiveSessions, createUlidGenerator, systemClock } from "@pptaken/core";
import { RealtimeHub } from "@pptaken/realtime";
import {
  createSqliteAuthStore,
  createSqliteLiveStore,
  openSqliteStorage,
} from "@pptaken/storage-sqlite";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "./config.js";
import type { AppEnv, Clock, Services } from "./context.js";
import {
  apiError,
  appCsp,
  clientIp,
  contentOrigin,
  isAllowedHost,
  isHttps,
  NON_DOCUMENT_CSP,
  PERMISSIONS_POLICY,
  publicOrigin,
  requestHost,
} from "./http.js";
import { createLogger, type Logger, type LogSink } from "./logger.js";
import { createRealtime, type RealtimeServer } from "./realtime.js";
import { apiRoutes } from "./routes-api.js";
import { contentRoutes, playerRoutes } from "./routes-content.js";
import { exportRoutes } from "./routes-export.js";
import { liveRoutes } from "./routes-live.js";
import { mcpRoutes, protectedResourceMetadata } from "./routes-mcp.js";
import { presenterRoutes } from "./routes-present.js";
import { remotePageRoutes } from "./routes-remote.js";
import { WebApp } from "./static.js";

export interface CreateServerOptions {
  logSink?: LogSink;
  logger?: Logger;
  clock?: Clock;
  /** Password hashing cost (tests use cheaper parameters). */
  scrypt?: ScryptParams;
  /** Remote address of a request (set by the Node adapter in main.ts). */
  socketIp?: (raw: Request, env: unknown) => string | undefined;
}

/** A Node HTTP server whose `upgrade` events the realtime endpoint (`/ws`) handles. */
export type UpgradableServer = import("node:http").Server;

export interface PPTakenServer {
  app: Hono<AppEnv>;
  /** Web-standard fetch handler. Pass the Node adapter's env as the second argument. */
  fetch: (request: Request, env?: unknown) => Response | Promise<Response>;
  /** The install code printed at startup while no owner exists. */
  installCode: string | null;
  services: Services;
  /** The `/ws` endpoint (remote control). */
  realtime: RealtimeServer;
  /**
   * Wires `/ws` onto a Node HTTP server (its `upgrade` event; the fetch handler alone cannot accept sockets).
   * Returns a function that detaches it. Without it the presentation works and pairing simply cannot connect.
   */
  attach(server: UpgradableServer): () => void;
  /** Closes every socket (1001), marks the server not ready and closes the database. */
  close(): Promise<void>;
}

/** Opens the data directory and builds the server. */
export async function createServer(
  config: ServerConfig,
  options: CreateServerOptions = {},
): Promise<PPTakenServer> {
  const logger = options.logger ?? createLogger(config.logLevel, options.logSink);
  const clock = options.clock ?? systemClock;

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // Best effort (Windows ignores POSIX modes; a mounted volume may not allow it).
  }
  const secret = loadOrCreateSecretKey({
    dataDir: config.dataDir,
    value: config.secretKey,
    file: config.secretKeyFile,
  });
  if (secret.source === "generated")
    logger.info("generated a new instance secret", { file: "secret.key" });

  const storage = openSqliteStorage({ filename: join(config.dataDir, "pptaken.db") });
  if (storage.migration.applied.length > 0) {
    logger.info("database migrated", {
      from: storage.migration.from,
      to: storage.migration.to,
      backup: storage.migration.backupPath,
    });
  }
  const blobs = await openFsBlobStore({
    root: join(config.dataDir, "blobs"),
    maxBlobBytes: 10 * 1024 * 1024,
  });
  const ids = createUlidGenerator((n) => new Uint8Array(randomBytes(n)), clock);
  const core = createCore({
    store: storage,
    blobs,
    clock,
    ids,
    config: config.defaultLang === undefined ? {} : { defaultLang: config.defaultLang },
  });
  const auth = createLocalAuth({
    store: createSqliteAuthStore(storage),
    secret: secret.key,
    ids,
    clock,
    ...(options.scrypt === undefined ? {} : { scrypt: options.scrypt }),
  });
  const installCode = await auth.ensureInstallCode();

  const minute = 60_000;
  const services: Services = {
    config,
    core,
    auth,
    storage,
    logger,
    clock,
    contentKey: deriveKey(secret.key, "content-token"),
    liveKey: deriveKey(secret.key, "live-ticket"),
    live: createLiveSessions({
      store: createSqliteLiveStore(storage),
      clock,
      ids,
      random: (n) => new Uint8Array(randomBytes(n)),
      audit: storage.audit,
    }),
    hub: new RealtimeHub(),
    limits: {
      signIn: new SignInThrottle({ clock }),
      apiPerIp: new TokenBucketLimiter({ capacity: 300, refill: 300, intervalMs: minute, clock }),
      mcpAuthFailuresPerIp: new TokenBucketLimiter({
        capacity: 20,
        refill: 20,
        intervalMs: minute,
        clock,
      }),
      mcpRequestsPerToken: new TokenBucketLimiter({
        capacity: 300,
        refill: 300,
        intervalMs: minute,
        clock,
      }),
      mcpCallsPerToken: new TokenBucketLimiter({
        capacity: 120,
        refill: 120,
        intervalMs: minute,
        clock,
      }),
      mcpWritesPerToken: new TokenBucketLimiter({
        capacity: 20,
        refill: 20,
        intervalMs: minute,
        clock,
      }),
      pairPerIp: new TokenBucketLimiter({ capacity: 10, refill: 10, intervalMs: minute, clock }),
      pairFailures: new TokenBucketLimiter({
        capacity: 50,
        refill: 50,
        intervalMs: 10 * minute,
        clock,
      }),
    },
  };

  let closing = false;
  const web = new WebApp(config.webDir);
  const contentHost =
    config.contentUrl === null ? null : new URL(config.contentUrl).host.toLowerCase();
  const app = new Hono<AppEnv>();

  // 1. Request id, client IP and one structured log line per request (path only: queries can hold tokens).
  app.use("*", async (c, next) => {
    const started = performance.now();
    c.set("requestId", randomUUID());
    c.set("ip", clientIp(c, config, options.socketIp?.(c.req.raw, c.env)));
    try {
      await next();
    } finally {
      logger.info("request", {
        method: c.req.method,
        path: c.req.path.slice(0, 200),
        status: c.res.status,
        ms: Math.round(performance.now() - started),
        ip: c.get("ip"),
        requestId: c.get("requestId"),
      });
    }
  });

  // 2. Security headers on every response (route-specific ones win).
  app.use("*", async (c, next) => {
    await next();
    let headers = c.res.headers;
    try {
      headers.set("X-Content-Type-Options", "nosniff");
    } catch {
      c.res = new Response(c.res.body, c.res);
      headers = c.res.headers;
    }
    const setDefault = (name: string, value: string) => {
      if (!headers.has(name)) headers.set(name, value);
    };
    setDefault("X-Content-Type-Options", "nosniff");
    setDefault("Referrer-Policy", "no-referrer");
    if (isHttps(c, config)) setDefault("Strict-Transport-Security", "max-age=31536000");
    if (c.req.path.startsWith("/c/")) return; // the content route sets its own (CSP sandbox, frame-ancestors)
    setDefault("Permissions-Policy", PERMISSIONS_POLICY);
    setDefault("Cross-Origin-Opener-Policy", "same-origin");
    setDefault("Cross-Origin-Resource-Policy", "same-origin");
    setDefault("X-Frame-Options", "DENY");
    const type = headers.get("content-type") ?? "";
    if (type.startsWith("text/html")) {
      const frame = contentOrigin(c, config);
      setDefault(
        "Content-Security-Policy",
        appCsp(frame === publicOrigin(c, config) ? [] : [frame]),
      );
    } else {
      setDefault("Content-Security-Policy", NON_DOCUMENT_CSP);
    }
  });

  // 3. Host header validation (DNS rebinding, T14) and separation of the content origin.
  app.use("*", async (c, next) => {
    const host = requestHost(c);
    if (!isAllowedHost(host, config)) {
      return apiError(c, "FORBIDDEN", "This host name is not allowed", {
        hint: "Set PPTAKEN_PUBLIC_URL (or PPTAKEN_ALLOWED_HOSTS) to the name you use to reach PPTaken.",
      });
    }
    const path = c.req.path;
    if (contentHost !== null) {
      const onContentHost = host === contentHost;
      if (onContentHost && !path.startsWith("/c/") && path !== "/healthz")
        return c.text("Not found", 404);
      if (!onContentHost && path.startsWith("/c/")) return c.text("Not found", 404);
    }
    await next();
  });

  // Export/import: before the /api body limit (archives are larger); it applies its own limit, CSRF and rate limits.
  app.route("/api/v1", exportRoutes(services));

  // 4. Body size limits, enforced while reading (before parsing).
  const tooLarge = (c: Parameters<typeof apiError>[0]) =>
    apiError(c, "VALIDATION_ERROR", "Request body too large", { status: 413 });
  app.use("/api/*", bodyLimit({ maxSize: config.maxApiBodyBytes, onError: tooLarge }));
  app.use("/mcp", bodyLimit({ maxSize: config.maxMcpBodyBytes, onError: tooLarge }));

  // Operations.
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", (c) => {
    if (closing) return c.json({ status: "shutting_down" }, 503);
    try {
      storage.schemaVersion();
      if (!existsSync(join(config.dataDir, "blobs"))) throw new Error("blob directory missing");
      return c.json({ status: "ready" });
    } catch (error) {
      logger.error("not ready", { error: String(error) });
      return c.json({ status: "not_ready" }, 503);
    }
  });

  // RFC 9728 metadata for the MCP resource (the 401 points here).
  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(protectedResourceMetadata(publicOrigin(c, config))),
  );
  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(protectedResourceMetadata(publicOrigin(c, config))),
  );

  app.route("/", presenterRoutes(services)); // before the API router's catch-all
  app.route("/", liveRoutes(services));
  app.route("/", remotePageRoutes(services));
  app.route("/api/v1", apiRoutes(services));
  app.all("/api/*", (c) => apiError(c, "NOT_FOUND", "No such API route"));
  app.route("/mcp", mcpRoutes(services));
  app.route("/c", contentRoutes(services));
  app.route("/", playerRoutes(services));

  // The web app (if built), with SPA fallback; otherwise a minimal page.
  app.get("*", (c) => {
    const file = web.resolve(c.req.path);
    if (file !== null) {
      return c.body(new Uint8Array(file.body), 200, {
        "Content-Type": file.type,
        "Cache-Control": file.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
    }
    if (!web.available && c.req.path === "/") {
      return c.html(
        "<!doctype html><html lang=en><meta charset=utf-8><title>PPTaken</title><p>PPTaken is running. The web app is not built in this installation.</p></html>",
      );
    }
    return c.text("Not found", 404);
  });

  app.notFound((c) =>
    c.req.path.startsWith("/api/")
      ? apiError(c, "NOT_FOUND", "Not found")
      : c.text("Not found", 404),
  );
  app.onError((error, c) => {
    logger.error("unhandled error", {
      requestId: c.get("requestId"),
      path: c.req.path,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    });
    if (c.req.path.startsWith("/api/")) {
      return apiError(c, "INTERNAL", "Internal error", {
        hint: `Report request id ${c.get("requestId")} to the administrator.`,
      });
    }
    return c.text("Internal error", 500);
  });

  const realtime = createRealtime(services);
  return {
    app,
    fetch: (request, env) => app.fetch(request, env),
    installCode,
    services,
    realtime,
    attach: (server) => realtime.attach(server),
    async close() {
      closing = true;
      realtime.close();
      await storage.close();
    },
  };
}
