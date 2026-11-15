// SPDX-License-Identifier: AGPL-3.0-or-later
// Log redaction: secrets never reach the logs (security §8). Applied by the server's logger to every record.

const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|newpassword|currentpassword|secret|token|accesstoken|refreshtoken|apikey|api_key|installcode|install_code|sessionid|secretkey|secret_key)$/i;

export const REDACTED = "[REDACTED]";

/** Redacts secret-looking substrings of a string (tokens, bearer values, session cookies, query secrets). */
export function redactString(value: string): string {
  return value
    .replace(/ppt_[A-Za-z0-9_-]{20,}/g, REDACTED)
    .replace(/Bearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED}`)
    .replace(/((?:__Host-)?pptaken_session=)[^;\s"']+/g, `$1${REDACTED}`)
    .replace(/([?&](?:ct|at|token|code|key)=)[^&#\s"']+/g, `$1${REDACTED}`);
}

/**
 * Deep copy of `value` with sensitive keys replaced by `[REDACTED]` and secret-looking substrings removed from
 * strings. Bounded depth; cycles are cut.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (depth > 8 || seen.has(value)) return "[…]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}
