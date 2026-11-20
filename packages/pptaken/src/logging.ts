// SPDX-License-Identifier: AGPL-3.0-or-later
// Logs of `npx pptaken`: the server's structured logger (with its secret redaction) either as JSON lines on stdout
// (`--json-logs`, the same format as the Docker image) or as short human lines on stderr, so they never mix with
// the ready banner on stdout.
import { paint, type Style } from "./banner.js";

export type LogLine = (line: string) => void;

/** Formats one JSON log record of the server as `12:00:01 WARN message key=value …`. */
export function humanLine(json: string, style: Style): string {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return json;
  }
  const { time, level, msg, ...rest } = record;
  const clock = typeof time === "string" ? time.slice(11, 19) : "";
  const lvl = String(level ?? "info").toUpperCase();
  const tone = lvl === "ERROR" || lvl === "WARN" ? "yellow" : "dim";
  const fields = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${paint(style, "dim", clock)} ${paint(style, tone, lvl.padEnd(5))} ${String(msg ?? "")}${fields ? ` ${paint(style, "dim", fields)}` : ""}`;
}

export function logSink(json: boolean, style: Style): LogLine {
  if (json) return (line) => process.stdout.write(`${line}\n`);
  return (line) => process.stderr.write(`${humanLine(line, style)}\n`);
}
