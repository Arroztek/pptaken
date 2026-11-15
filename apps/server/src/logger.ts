// SPDX-License-Identifier: AGPL-3.0-or-later
// A tiny structured JSON logger (one line per record) with redaction of secrets (security §8). Chosen over pino to
// avoid a dependency for ~40 lines: we need levels, JSON lines and redaction, nothing else.
import { redact } from "@pptaken/auth-local";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Where log lines go (stdout by default; tests capture them). */
export type LogSink = (line: string) => void;

export function createLogger(
  level: LogLevel = "info",
  sink: LogSink = (l) => process.stdout.write(`${l}\n`),
): Logger {
  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = redact({ time: new Date().toISOString(), level: lvl, msg, ...fields });
    sink(JSON.stringify(record));
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
