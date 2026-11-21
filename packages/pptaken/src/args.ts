// SPDX-License-Identifier: AGPL-3.0-or-later
// Command line of `npx pptaken`: a small, strict parser with messages written for people who are not developers.
// Pure (no I/O), so every rule is unit tested. Long options only, as `--name value` or `--name=value`.

export type Command = "start" | "backup" | "reset-password" | "help" | "version";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Flags {
  port?: number;
  host?: string;
  dataDir?: string;
  publicUrl?: string;
  scripts?: "owner" | "off";
  adminPasswordFile?: string;
  logLevel?: LogLevel;
  open: boolean;
  jsonLogs: boolean;
  clearPresenterPassword: boolean;
}

export interface ParsedArgs {
  command: Command;
  flags: Flags;
  /** Arguments after the command (only `backup <dir>` takes one). */
  positionals: string[];
}

/** A mistake on the command line: printed as is (no stack trace), exit code 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

type OptionName =
  | "port"
  | "host"
  | "data-dir"
  | "public-url"
  | "scripts"
  | "admin-password-file"
  | "log-level"
  | "open"
  | "json-logs"
  | "clear-presenter-password"
  | "help"
  | "version";

interface OptionSpec {
  kind: "string" | "boolean";
  /** Commands that accept the option (help and version are accepted everywhere). */
  commands: readonly Command[];
  example?: string;
}

const START: readonly Command[] = ["start"];
const DATA: readonly Command[] = ["start", "backup", "reset-password"];

const OPTIONS: Record<OptionName, OptionSpec> = {
  port: { kind: "string", commands: START, example: "--port 8080" },
  host: { kind: "string", commands: START, example: "--host 127.0.0.1" },
  "data-dir": { kind: "string", commands: DATA, example: "--data-dir ./pptaken-data" },
  "public-url": {
    kind: "string",
    commands: START,
    example: "--public-url https://slides.example.com",
  },
  scripts: { kind: "string", commands: START, example: "--scripts owner" },
  "admin-password-file": {
    kind: "string",
    commands: START,
    example: "--admin-password-file ./owner-password.txt",
  },
  "log-level": { kind: "string", commands: DATA, example: "--log-level info" },
  open: { kind: "boolean", commands: START },
  "json-logs": { kind: "boolean", commands: DATA },
  "clear-presenter-password": { kind: "boolean", commands: ["reset-password"] },
  help: { kind: "boolean", commands: ["start", "backup", "reset-password", "help", "version"] },
  version: { kind: "boolean", commands: ["start", "backup", "reset-password", "help", "version"] },
};

const COMMANDS: Record<string, Command> = {
  start: "start",
  serve: "start",
  backup: "backup",
  "reset-password": "reset-password",
  help: "help",
  version: "version",
};

const SHORT: Record<string, OptionName> = { "-h": "help", "-v": "version", "-V": "version" };

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const HOST = /^[A-Za-z0-9.:%-]{1,253}$/;

function isOptionName(name: string): name is OptionName {
  return Object.hasOwn(OPTIONS, name);
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new UsageError(`--port must be a number between 1 and 65535 (got "${value}").`);
  }
  return Number(value);
}

function parseHost(value: string): string {
  // `[::1]` is how people write IPv6 in URLs; listening wants the bare address.
  const host = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (!HOST.test(host)) {
    throw new UsageError(
      `--host must be an IP address or a host name such as 127.0.0.1 or 0.0.0.0 (got "${value}").`,
    );
  }
  return host;
}

function parsePublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(
      `--public-url must be a full address such as https://slides.example.com (got "${value}").`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("--public-url must start with https:// (or http:// for local use).");
  }
  return value;
}

function parseChoice<T extends string>(name: string, value: string, choices: readonly T[]): T {
  const v = value.toLowerCase();
  if (!(choices as readonly string[]).includes(v)) {
    throw new UsageError(`--${name} must be ${choices.join(" or ")} (got "${value}").`);
  }
  return v as T;
}

function apply(flags: Flags, name: OptionName, value: string | true): void {
  const text = typeof value === "string" ? value : "";
  switch (name) {
    case "port":
      flags.port = parsePort(text);
      return;
    case "host":
      flags.host = parseHost(text);
      return;
    case "data-dir":
      if (text.trim() === "") throw new UsageError("--data-dir needs a folder path.");
      flags.dataDir = text;
      return;
    case "public-url":
      flags.publicUrl = parsePublicUrl(text);
      return;
    case "scripts":
      flags.scripts = parseChoice("scripts", text, ["owner", "off"] as const);
      return;
    case "admin-password-file":
      if (text.trim() === "") throw new UsageError("--admin-password-file needs a file path.");
      flags.adminPasswordFile = text;
      return;
    case "log-level":
      flags.logLevel = parseChoice("log-level", text, LOG_LEVELS);
      return;
    case "open":
      flags.open = true;
      return;
    case "json-logs":
      flags.jsonLogs = true;
      return;
    case "clear-presenter-password":
      flags.clearPresenterPassword = true;
      return;
    case "help":
    case "version":
      return;
  }
}

/** Parses `process.argv.slice(2)`. Throws {@link UsageError} with a message meant for the person typing. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Flags = { open: false, jsonLogs: false, clearPresenterPassword: false };
  const seen: { name: OptionName; value: string | true }[] = [];
  const positionals: string[] = [];
  let command: Command | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const short = SHORT[arg];
    if (short !== undefined) {
      if (short === "help") help = true;
      else version = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!isOptionName(name)) {
        throw new UsageError(`Unknown option "--${name}".`);
      }
      const spec = OPTIONS[name];
      if (spec.kind === "boolean") {
        if (eq !== -1) throw new UsageError(`--${name} does not take a value.`);
        if (name === "help") help = true;
        else if (name === "version") version = true;
        else seen.push({ name, value: true });
        continue;
      }
      let value: string | undefined;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i++;
        }
      }
      if (value === undefined || value === "") {
        throw new UsageError(
          `--${name} needs a value${spec.example ? `, for example ${spec.example}` : ""}.`,
        );
      }
      seen.push({ name, value });
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      throw new UsageError(`Unknown option "${arg}".`);
    }
    if (command === undefined && positionals.length === 0) {
      const known = COMMANDS[arg];
      if (known === undefined) throw new UsageError(`Unknown command "${arg}".`);
      command = known;
      continue;
    }
    positionals.push(arg);
  }

  const resolved: Command = help ? "help" : version ? "version" : (command ?? "start");
  if (resolved === "help" || resolved === "version") {
    return { command: resolved, flags, positionals: command === undefined ? [] : [command] };
  }
  for (const { name, value } of seen) {
    if (!OPTIONS[name].commands.includes(resolved)) {
      throw new UsageError(`--${name} cannot be used with "${resolved}".`);
    }
    apply(flags, name, value);
  }
  if (resolved === "backup") {
    if (positionals.length !== 1) {
      throw new UsageError(
        "backup needs exactly one new folder to write to, for example: pptaken backup ./pptaken-backup",
      );
    }
  } else if (positionals.length > 0) {
    throw new UsageError(`Unexpected argument "${positionals[0]}".`);
  }
  return { command: resolved, flags, positionals };
}

export const USAGE = `Usage: npx pptaken [command] [options]

Commands:
  start (default)            start PPTaken
  backup <new folder>        write a consistent copy of the database and files to a new folder
  reset-password             set a new owner password (signs out every session)
    --clear-presenter-password   also remove the presenter password
  help                       show this help
  version                    print the version

Options for start:
  --port <number>            port to listen on (default 8080; the next free port is used when 8080 is busy,
                             unless you chose the port yourself)
  --host <address>           address to listen on (default 127.0.0.1: this computer only). 0.0.0.0 exposes
                             PPTaken to your network over plain HTTP
  --data-dir <folder>        where your presentations are stored (default: see below)
  --public-url <url>         the address people and Claude use, e.g. https://slides.example.com
                             (default http://localhost:<port>)
  --scripts <owner|off>      interactive decks run only after you approve them; off never runs them (default owner)
  --admin-password-file <f>  create the owner account from the password in this file (no install code)
  --open                     open the browser once PPTaken is ready
  --log-level <level>        debug, info, warn or error (default warn)
  --json-logs                write logs as JSON lines (for log collectors)
  -h, --help                 show this help
  -v, --version              print the version

Data folder (default): Windows %LOCALAPPDATA%\\PPTaken, macOS ~/Library/Application Support/PPTaken,
Linux $XDG_DATA_HOME/pptaken or ~/.local/share/pptaken. --data-dir also applies to backup and reset-password.

Environment variables work too (PPTAKEN_PORT, PPTAKEN_HOST, PPTAKEN_DATA_DIR, PPTAKEN_PUBLIC_URL, PPTAKEN_SCRIPTS,
PPTAKEN_ADMIN_PASSWORD_FILE, PPTAKEN_LOG_LEVEL and the rest of https://docs-pkn.arroz.dev/reference/configuration/);
an option on the command line wins over the variable.

Exit codes: 0 stopped normally, 1 unexpected error, 2 invalid option or setting, 3 port busy (or PPTaken already
running with this data folder), 4 data folder not usable, 5 Node.js too old, 6 the SQLite module cannot load on
this system, 130 stopped at once by a second Ctrl+C.

Docs: https://docs-pkn.arroz.dev   Source: https://github.com/Arroztek/pptaken
`;
