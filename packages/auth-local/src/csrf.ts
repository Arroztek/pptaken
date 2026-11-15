// SPDX-License-Identifier: AGPL-3.0-or-later
// CSRF defence for the panel API (security §3.1, T13): on state-changing methods the request must carry the custom
// header `X-PPTaken-CSRF: 1` (a cross-site form or image cannot set it, and setting it from another origin needs
// a CORS preflight we never grant) and an `Origin` (or, when absent, `Referer`) equal to one of the expected
// origins. `SameSite=Lax` on the session cookie is the third layer.

export const CSRF_HEADER = "x-pptaken-csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface CsrfInput {
  method: string;
  /** Header lookup, case-insensitive (e.g. `Headers.get`). */
  header: (name: string) => string | null | undefined;
  /** Allowed origins such as `https://slides.example.com` (scheme + host + port, no path). */
  allowedOrigins: readonly string[];
}

export type CsrfResult = { ok: true } | { ok: false; reason: "missing_header" | "bad_origin" };

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function checkCsrf(input: CsrfInput): CsrfResult {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  if (input.header(CSRF_HEADER) !== "1") return { ok: false, reason: "missing_header" };
  const origin = input.header("origin");
  let source: string | null = null;
  if (origin !== null && origin !== undefined && origin !== "") {
    // "null" (opaque origins, sandboxed frames) never matches.
    source = originOf(origin);
  } else {
    const referer = input.header("referer");
    if (referer !== null && referer !== undefined && referer !== "") source = originOf(referer);
  }
  if (source === null) return { ok: false, reason: "bad_origin" };
  const normalized = input.allowedOrigins.map((o) => originOf(o)).filter((o) => o !== null);
  return normalized.includes(source) ? { ok: true } : { ok: false, reason: "bad_origin" };
}
