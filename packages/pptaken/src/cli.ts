// SPDX-License-Identifier: AGPL-3.0-or-later
// `npx pptaken`: the command line of the single-package npm distribution (ADR-025). It turns options into the
// server's usual PPTAKEN_* settings with safe local defaults (127.0.0.1, a per-user data folder), starts the
// server, prints a short friendly block, and stops cleanly on Ctrl+C. Loaded by bin/pptaken.cjs after the Node.js
// version check; common problems end with a one-paragraph explanation and a documented exit code, never a stack.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Flags, type ParsedArgs, parseArgs, USAGE, UsageError } from "./args.js";
import { detectStyle, formatBanner, paint } from "./banner.js";
import {
  DataDirError,
  ensureWritableDataDir,
  type PlatformContext,
  resolveDataDir,
} from "./data-dir.js";
import { readLiveLock, writeLock } from "./lock.js";
import { logSink } from "./logging.js";
import { openBrowser } from "./open.js";
import { planStart, publicUrlFor } from "./plan.js";
import { candidatePorts, isFree } from "./ports.js";
import { REQUIRED_PATHS, runtimePaths } from "./runtime-paths.js";
import {
  backup,
  ConfigError,
  createLogger,
  loadConfig,
  type RunningServer,
  resetPassword,
  startServer,
} from "./server.js";

/** Exit codes (also listed in `--help` and docs/guides/npx.md). */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  port: 3,
  dataDir: 4,
  node: 5,
  sqlite: 6,
} as const;

const SQLITE_DOCS = "https://docs-pkn.arroz.dev/start/requirements/";

/** A problem explained to the person: printed without a stack trace. */
class Friendly extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(runtimePaths.packageJson, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function platformContext(): PlatformContext {
  return { platform: process.platform, env: process.env, homedir: homedir() };
}

/** Configuration errors name environment variables; say which option sets each one too. */
const OPTION_OF: Record<string, string> = {
  PPTAKEN_PUBLIC_URL: "--public-url",
  PPTAKEN_PORT: "--port",
  PPTAKEN_HOST: "--host",
  PPTAKEN_SCRIPTS: "--scripts",
  PPTAKEN_ADMIN_PASSWORD_FILE: "--admin-password-file",
  PPTAKEN_ADMIN_PASSWORD: "--admin-password-file",
  PPTAKEN_LOG_LEVEL: "--log-level",
  PPTAKEN_DATA_DIR: "--data-dir",
};

export function explainConfigError(message: string): string {
  const name = Object.keys(OPTION_OF).find((n) => message.startsWith(n));
  return name === undefined
    ? message
    : `${message} (set with ${OPTION_OF[name]} or the ${name} environment variable)`;
}

/** Turns a start-up failure into a message and exit code; null for an unexpected error. */
export function explainStartError(
  error: unknown,
  ctx: { port: number; host: string; platform: string; arch: string; node: string },
): Friendly | null {
  const e = error as NodeJS.ErrnoException & { name?: string };
  const text = `${e?.message ?? ""} ${(e as { stack?: string })?.stack ?? ""}`;
  if (e instanceof ConfigError || e?.name === "ConfigError") {
    return new Friendly(`Invalid setting: ${explainConfigError(e.message)}`, EXIT.usage);
  }
  if (e?.code === "EADDRINUSE") {
    return new Friendly(portBusyMessage(ctx.port), EXIT.port);
  }
  if (e?.code === "EACCES" && /listen/i.test(text)) {
    return new Friendly(
      `PPTaken is not allowed to listen on port ${ctx.port}. Ports below 1024 need administrator rights on most systems: choose another one, for example --port 8080.`,
      EXIT.port,
    );
  }
  if (e?.code === "EADDRNOTAVAIL") {
    return new Friendly(
      `${ctx.host} is not an address of this computer. Use --host 127.0.0.1 (this computer only) or --host 0.0.0.0 (every network interface).`,
      EXIT.usage,
    );
  }
  if (
    /better[-_]sqlite3|\.node\b/i.test(text) &&
    (e?.code === "ERR_DLOPEN_FAILED" || e?.code === "MODULE_NOT_FOUND" || /\.node/.test(text))
  ) {
    return new Friendly(
      [
        `PPTaken stores its data with SQLite (the better-sqlite3 module), which could not be loaded on this system (${ctx.platform}-${ctx.arch}, Node.js ${ctx.node}).`,
        "Ready-made binaries exist for Windows, macOS and Linux (glibc and musl) on x64 and arm64.",
        `On other systems use the Docker image, or see ${SQLITE_DOCS}`,
        `Details: ${e?.message ?? String(error)}`,
      ].join("\n"),
      EXIT.sqlite,
    );
  }
  if (e?.name === "SchemaTooNewError") {
    return new Friendly(
      `${e.message}\nRun the latest version with: npx pptaken@latest`,
      EXIT.error,
    );
  }
  if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS") {
    return new Friendly(
      `PPTaken cannot write its data (${e.code}: ${e.message}). Choose a folder you own with --data-dir.`,
      EXIT.dataDir,
    );
  }
  return null;
}

export function portBusyMessage(port: number): string {
  return [
    `Port ${port} is already in use by another program (maybe another PPTaken).`,
    `Stop that program, or choose a different port, for example: npx pptaken --port ${port === 65535 ? 8081 : port + 1}`,
  ].join("\n");
}

function fail(problem: Friendly, title = "PPTaken could not start."): number {
  const style = detectStyle(process.stderr, process.env, process.platform);
  process.stderr.write(`\n${paint(style, "yellow", title)}\n${problem.message}\n\n`);
  return problem.code;
}

async function start(flags: Flags): Promise<number | null> {
  const missing = REQUIRED_PATHS.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    return fail(
      new Friendly(
        `This copy of PPTaken is incomplete (missing ${missing[0]}). Reinstall it, for example: npx pptaken@latest`,
        EXIT.error,
      ),
    );
  }
  const plan = planStart(flags, platformContext(), process.cwd());
  try {
    ensureWritableDataDir(plan.dataDir);
  } catch (error) {
    if (error instanceof DataDirError) return fail(new Friendly(error.message, EXIT.dataDir));
    throw error;
  }
  const other = readLiveLock(plan.dataDir);
  if (other !== null) {
    return fail(
      new Friendly(
        [
          `PPTaken is already running with this data folder (process ${other.pid}): open ${other.url}`,
          "To run a second, separate PPTaken, give it its own folder with --data-dir.",
          `If no PPTaken is running, delete ${join(plan.dataDir, "pptaken.lock")} and try again.`,
        ].join("\n"),
        EXIT.port,
      ),
    );
  }
  if (
    flags.adminPasswordFile !== undefined &&
    !existsSync(plan.env.PPTAKEN_ADMIN_PASSWORD_FILE ?? "")
  ) {
    return fail(
      new Friendly(
        `--admin-password-file: ${plan.env.PPTAKEN_ADMIN_PASSWORD_FILE} does not exist.`,
        EXIT.usage,
      ),
    );
  }

  const outStyle = detectStyle(process.stdout, process.env, process.platform);
  const errStyle = detectStyle(process.stderr, process.env, process.platform);
  const logger = createLogger(plan.logLevel, logSink(flags.jsonLogs, errStyle));
  const where = {
    host: plan.host,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
  };

  const busy: number[] = [];
  let running: RunningServer | null = null;
  let chosen = plan.startPort;
  for (const port of candidatePorts(plan.startPort, plan.explicitPort)) {
    chosen = port;
    if (!(await isFree(plan.host, port))) {
      busy.push(port);
      continue;
    }
    const env: Record<string, string | undefined> = { ...plan.env, PPTAKEN_PORT: String(port) };
    const publicUrl = publicUrlFor(plan, port);
    if (publicUrl === undefined) delete env.PPTAKEN_PUBLIC_URL;
    else env.PPTAKEN_PUBLIC_URL = publicUrl;
    try {
      running = await startServer(loadConfig(env), { logger });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && !plan.explicitPort) {
        busy.push(port);
        continue;
      }
      const problem = explainStartError(error, { ...where, port });
      if (problem !== null) return fail(problem);
      throw error;
    }
  }
  if (running === null) {
    if (plan.explicitPort) return fail(new Friendly(portBusyMessage(plan.startPort), EXIT.port));
    return fail(
      new Friendly(
        `Ports ${busy[0]} to ${busy[busy.length - 1]} are all in use. Choose a free port with --port.`,
        EXIT.port,
      ),
    );
  }

  // The address printed and opened: the public URL, or localhost on the bound port.
  const url = plan.publicUrl ?? `http://localhost:${running.port}`;
  const releaseLock = writeLock(plan.dataDir, url);
  process.stdout.write(
    formatBanner(
      {
        version: version(),
        url,
        installCode: running.installCode,
        dataDir: plan.dataDir,
        host: plan.host,
        exposed: plan.exposed,
        scripts: running.pptaken.services.config.scripts,
        portNote:
          busy.length > 0 && !plan.explicitPort
            ? `Port ${busy.join(", ")} ${busy.length === 1 ? "was" : "were"} busy, so PPTaken uses ${chosen}.`
            : undefined,
      },
      outStyle,
    ),
  );
  if (flags.open && !(await openBrowser(url))) {
    process.stderr.write(`Could not open a browser. Open ${url} yourself.\n`);
  }

  const server = running;
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) {
      process.stderr.write("Stopping now without waiting.\n");
      releaseLock();
      process.exit(130);
    }
    stopping = true;
    logger.info("shutting down", { reason });
    process.stderr.write("\nStopping PPTaken (press Ctrl+C again to force)...\n");
    const force = setTimeout(() => {
      process.stderr.write("PPTaken did not stop within 10 seconds; stopping it now.\n");
      releaseLock();
      process.exit(EXIT.error);
    }, 10_000);
    force.unref();
    void server.close().then(() => {
      releaseLock();
      process.stderr.write(`Stopped. Your data is in ${plan.dataDir}\n`);
      process.exit(EXIT.ok);
    });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  // Closing the console window on Windows sends SIGHUP and leaves a few seconds to shut down.
  process.on("SIGHUP", () => stop("SIGHUP"));
  // A parent process (a test harness, a process manager) can ask for the same clean stop over IPC; on Windows,
  // killing a child with a signal terminates it at once, so this is the portable graceful path.
  if (typeof process.send === "function") {
    process.on("message", (message) => {
      if (message === "pptaken:shutdown") stop("ipc");
    });
  }
  return null;
}

async function maintenance(args: ParsedArgs): Promise<number> {
  const dataDir = resolveDataDir(args.flags.dataDir, platformContext()).path;
  if (!existsSync(join(dataDir, "pptaken.db"))) {
    return fail(
      new Friendly(
        `There is no PPTaken data in ${dataDir}. If your data is elsewhere, pass --data-dir <folder>.`,
        EXIT.error,
      ),
      "Nothing was done.",
    );
  }
  const env: Record<string, string | undefined> = { ...process.env, PPTAKEN_DATA_DIR: dataDir };
  if (args.flags.logLevel !== undefined) env.PPTAKEN_LOG_LEVEL = args.flags.logLevel;
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return fail(
        new Friendly(`Invalid setting: ${explainConfigError(error.message)}`, EXIT.usage),
        "Nothing was done.",
      );
    }
    throw error;
  }
  if (args.command === "backup") return backup(config, args.positionals[0]);
  return resetPassword(config, { clearPresenterPassword: args.flags.clearPresenterPassword });
}

/** Runs the command line. Resolves once a one-shot command finished; `start` keeps the process alive. */
export async function run(argv: readonly string[]): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\nRun "npx pptaken --help" to see every option.\n`);
      process.exit(EXIT.usage);
    }
    throw error;
  }
  let code: number | null;
  try {
    if (args.command === "help") {
      process.stdout.write(USAGE);
      code = EXIT.ok;
    } else if (args.command === "version") {
      process.stdout.write(`${version()}\n`);
      code = EXIT.ok;
    } else if (args.command === "start") {
      code = await start(args.flags);
    } else {
      code = await maintenance(args);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(EXIT.usage);
    }
    const debug = args.flags.logLevel === "debug" || process.env.PPTAKEN_LOG_LEVEL === "debug";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `\nPPTaken stopped because of an unexpected error: ${message}\n${
        debug && error instanceof Error && error.stack
          ? `${error.stack}\n`
          : "Run again with --log-level debug to see the details, and report it at https://github.com/Arroztek/pptaken/issues\n"
      }`,
    );
    process.exit(EXIT.error);
  }
  if (code !== null) process.exit(code);
}
