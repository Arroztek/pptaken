// SPDX-License-Identifier: AGPL-3.0-or-later
// How `npx pptaken` turns its options into the server's PPTAKEN_* settings. Pure (environment and platform are
// injected), unit tested. Precedence: command-line option > environment variable > npx default.
import { resolve } from "node:path";
import { type Flags, type LogLevel, UsageError } from "./args.js";
import { isLoopbackHost } from "./banner.js";
import { type PlatformContext, resolveDataDir } from "./data-dir.js";

export const DEFAULT_PORT = 8080;
/** npx is for one person on one computer: listen on loopback unless told otherwise (Docker uses 0.0.0.0). */
export const DEFAULT_HOST = "127.0.0.1";
/** Quiet by default: the banner says what matters; `--log-level info` shows every request. */
export const DEFAULT_LOG_LEVEL: LogLevel = "warn";

export interface StartPlan {
  /** The environment handed to the server's loadConfig (PPTAKEN_PORT and PPTAKEN_PUBLIC_URL are set per port). */
  env: Record<string, string | undefined>;
  dataDir: string;
  host: string;
  /** Reachable from other devices (not a loopback address). */
  exposed: boolean;
  logLevel: LogLevel;
  startPort: number;
  /** The person chose the port (option or PPTAKEN_PORT): never move to another one. */
  explicitPort: boolean;
  publicUrl: string | undefined;
}

export function planStart(flags: Flags, ctx: PlatformContext, cwd: string): StartPlan {
  const env: Record<string, string | undefined> = { ...ctx.env };
  const dataDir = resolveDataDir(flags.dataDir, ctx).path;
  env.PPTAKEN_DATA_DIR = dataDir;
  const host = flags.host ?? (env.PPTAKEN_HOST || DEFAULT_HOST);
  env.PPTAKEN_HOST = host;
  if (flags.scripts !== undefined) env.PPTAKEN_SCRIPTS = flags.scripts;
  if (flags.adminPasswordFile !== undefined) {
    env.PPTAKEN_ADMIN_PASSWORD_FILE = resolve(cwd, flags.adminPasswordFile);
    // The file named on the command line wins over a password in the environment.
    delete env.PPTAKEN_ADMIN_PASSWORD;
  }
  const level = (flags.logLevel ?? (env.PPTAKEN_LOG_LEVEL || DEFAULT_LOG_LEVEL)).toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(level)) {
    throw new UsageError(`PPTAKEN_LOG_LEVEL must be debug, info, warn or error (got "${level}").`);
  }
  env.PPTAKEN_LOG_LEVEL = level;
  const envPort = env.PPTAKEN_PORT ?? "";
  if (flags.port === undefined && envPort !== "") {
    if (!/^\d{1,5}$/.test(envPort) || Number(envPort) < 1 || Number(envPort) > 65535) {
      throw new UsageError(
        `PPTAKEN_PORT must be a port number between 1 and 65535 (got "${envPort}").`,
      );
    }
  }
  const explicitPort = flags.port !== undefined || envPort !== "";
  const startPort = flags.port ?? (envPort !== "" ? Number(envPort) : DEFAULT_PORT);
  const publicUrl = flags.publicUrl ?? (env.PPTAKEN_PUBLIC_URL || undefined);
  return {
    env,
    dataDir,
    host,
    exposed: !isLoopbackHost(host),
    logLevel: level as LogLevel,
    startPort,
    explicitPort,
    publicUrl,
  };
}

/**
 * The PPTAKEN_PUBLIC_URL for a bound port: the one given; else `http://localhost:<port>` on a loopback host; else
 * none (exposed without a public URL: the server derives the address from each request, so links work from other
 * devices too).
 */
export function publicUrlFor(plan: StartPlan, port: number): string | undefined {
  if (plan.publicUrl !== undefined) return plan.publicUrl;
  return plan.exposed ? undefined : `http://localhost:${port}`;
}
