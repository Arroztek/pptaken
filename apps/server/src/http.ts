// SPDX-License-Identifier: AGPL-3.0-or-later
// Cross-cutting HTTP helpers: error shape, client IP, host validation (DNS rebinding), origins, security headers.
import { isIP } from "node:net";
import type { Context } from "hono";
import type { ServerConfig } from "./config.js";

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SETUP_REQUIRED"
  | "ALREADY_SETUP"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ApiErrorCode, 400 | 401 | 403 | 404 | 409 | 429 | 500> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SETUP_REQUIRED: 409,
  ALREADY_SETUP: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** The panel API error shape: `{ error: { code, message, hint? } }`. */
export function apiError(
  c: Context,
  code: ApiErrorCode,
  message: string,
  options: { hint?: string | undefined; status?: number; retryAfterSec?: number } = {},
): Response {
  const error: Record<string, string> = { code, message };
  if (options.hint !== undefined) error.hint = options.hint;
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (options.retryAfterSec !== undefined)
    headers["Retry-After"] = String(Math.max(1, options.retryAfterSec));
  return new Response(JSON.stringify({ error }), {
    status: options.status ?? STATUS[code],
    headers,
  });
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

/** Header lookup, case-insensitive; `undefined` when absent. Used by the request-agnostic helpers below. */
export type HeaderLookup = (name: string) => string | undefined;

/** `host[:port]` of the request (from the Host header, as reconstructed by the adapter). */
export function requestHost(c: Context): string {
  return new URL(c.req.url).host.toLowerCase();
}

/** The host name of a `host[:port]` value (IPv6 literals keep their brackets). */
export function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  const i = host.lastIndexOf(":");
  return i === -1 ? host : host.slice(0, i);
}

/**
 * DNS-rebinding defence (T14): the Host header must name this server. Accepted: the public and content host
 * names, `localhost` and `*.localhost`, IP literals (a rebinding attack needs a domain name) and the extra names
 * in PPTAKEN_ALLOWED_HOSTS.
 */
export function isAllowedHost(host: string, config: ServerConfig): boolean {
  const name = hostnameOf(host.toLowerCase());
  if (name === "") return false;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const bare = name.startsWith("[") ? name.slice(1, -1) : name;
  if (isIP(bare) !== 0) return true;
  for (const url of [config.publicUrl, config.contentUrl]) {
    if (url !== null && new URL(url).hostname.toLowerCase() === name) return true;
  }
  return config.allowedHosts.includes(name);
}

/**
 * Scheme of a request, request-agnostic (also used for WebSocket upgrades, which bypass Hono): X-Forwarded-Proto
 * behind a trusted proxy, otherwise whether the connection itself is TLS.
 */
export function protoFrom(
  header: HeaderLookup,
  encrypted: boolean,
  config: ServerConfig,
): "http" | "https" {
  if (config.trustProxy) {
    const fwd = header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (fwd === "https" || fwd === "http") return fwd;
  }
  return encrypted ? "https" : "http";
}

/** Scheme of the request: X-Forwarded-Proto behind a trusted proxy, or the connection's. */
export function requestProto(c: Context, config: ServerConfig): "http" | "https" {
  return protoFrom((n) => c.req.header(n), new URL(c.req.url).protocol === "https:", config);
}

/** Origin the request was sent to (scheme + Host). */
export function ownOrigin(c: Context, config: ServerConfig): string {
  return `${requestProto(c, config)}://${requestHost(c)}`;
}

/** The public origin: PPTAKEN_PUBLIC_URL, or the request's own origin when it is not configured. */
export function publicOrigin(c: Context, config: ServerConfig): string {
  return config.publicUrl ?? ownOrigin(c, config);
}

/** Origin serving `/c/*`: PPTAKEN_CONTENT_URL, or the public origin. */
export function contentOrigin(c: Context, config: ServerConfig): string {
  return config.contentUrl ?? publicOrigin(c, config);
}

export function isHttps(c: Context, config: ServerConfig): boolean {
  return publicOrigin(c, config).startsWith("https:");
}

/**
 * Client IP for rate limits: the socket address, or the last X-Forwarded-For entry (the one appended by our own
 * proxy) when PPTAKEN_TRUST_PROXY is on. Never trusted otherwise: anyone can forge the header.
 */
/** Client IP, request-agnostic (also used for WebSocket upgrades): see {@link clientIp}. */
export function clientIpFrom(
  header: HeaderLookup,
  config: ServerConfig,
  socketIp: string | undefined,
): string {
  if (config.trustProxy) {
    const parts = (header("x-forwarded-for") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const last = parts[parts.length - 1];
    if (last !== undefined && isIP(last) !== 0) return last;
  }
  return socketIp ?? "unknown";
}

export function clientIp(c: Context, config: ServerConfig, socketIp: string | undefined): string {
  return clientIpFrom((n) => c.req.header(n), config, socketIp);
}

/**
 * Whether an `Origin` header names this server: the origin the request was sent to (scheme + Host) or the public
 * origin. Request-agnostic (WebSocket upgrades: browsers always send `Origin`, and a page on another site must not
 * open a socket with its visitor's network position, T14).
 */
export function isSameOrigin(
  origin: string | undefined,
  own: string,
  config: ServerConfig,
): boolean {
  if (origin === undefined || origin === "" || origin === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const allowed = [own, ...(config.publicUrl === null ? [] : [config.publicUrl])].map(
    (o) => new URL(o).origin,
  );
  return allowed.includes(parsed.origin);
}

export const PERMISSIONS_POLICY =
  "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), serial=(), usb=(), fullscreen=(self)";

/** Strict CSP for the app's HTML pages (web app, player page). */
export function appCsp(frameSrc: string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${["'self'", ...frameSrc].join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * CSP of the player and presenter pages: the app CSP plus what an offline (srcdoc) deck document needs, because a
 * srcdoc frame inherits its parent's CSP (spike S4): the runtime's exact hash (no other inline script) and `data:`
 * fonts. The deck document's own `<meta>` CSP still blocks every network request from the content.
 *
 * `frame-src` names exactly the content origin (ADR-020, S5 §1): `contentOrigin` when content has its own origin,
 * never `'self'` then; `'self'` only when content shares the app origin (`contentOrigin` null).
 */
export function playerCsp(contentOrigin: string | null, runtimeSha256: string): string {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(runtimeSha256)) throw new TypeError("bad runtime hash");
  const frame = contentOrigin === null ? "'self'" : new URL(contentOrigin).origin;
  return appCsp([])
    .replace("frame-src 'self'", `frame-src ${frame}`)
    .replace("script-src 'self'", `script-src 'self' 'sha256-${runtimeSha256}'`)
    .replace("font-src 'self'", "font-src 'self' data:");
}

/** CSP of the service worker script: it may only fetch from its own origin. */
export const SERVICE_WORKER_CSP = "default-src 'none'; connect-src 'self'; frame-ancestors 'none'";

/** CSP for responses that are not documents (JSON, files). */
export const NON_DOCUMENT_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** Media-type check for JSON bodies. */
export function isJsonRequest(c: Context): boolean {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
}
