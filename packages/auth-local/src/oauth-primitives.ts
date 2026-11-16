// SPDX-License-Identifier: AGPL-3.0-or-later
// Building blocks of the OAuth 2.1 authorization server (ADR-0018): token formats, PKCE S256, redirect URI rules,
// scopes, resource indicators and the display of client-supplied names. Pure functions, no I/O.
import { createHash } from "node:crypto";
import { constantTimeEqual, randomBase64Url } from "./crypto.js";

// ---------------------------------------------------------------------------------------------------------------
// Token formats. Access `ppto_` and refresh `pptr_` + 43 base64url characters (256 bits): the prefixes let the
// bearer middleware dispatch without a database read and let secret scanners recognise leaks. Authorization codes
// are 256-bit base64url strings with no prefix. Only SHA-256 hashes are stored.

export const OAUTH_ACCESS_PREFIX = "ppto_";
export const OAUTH_REFRESH_PREFIX = "pptr_";
export const OAUTH_ACCESS_PATTERN = /^ppto_[A-Za-z0-9_-]{43}$/;
export const OAUTH_REFRESH_PATTERN = /^pptr_[A-Za-z0-9_-]{43}$/;
export const OAUTH_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Ids of DCR clients: `pptc_` + 22 base64url characters (128 bits; an identifier, not a secret). */
export const OAUTH_DCR_CLIENT_PATTERN = /^pptc_[A-Za-z0-9_-]{22}$/;
/** Ids of pending authorization requests (the `/connect/<id>` panel page). */
export const OAUTH_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function generateAccessToken(): string {
  return `${OAUTH_ACCESS_PREFIX}${randomBase64Url(32)}`;
}
export function generateRefreshToken(): string {
  return `${OAUTH_REFRESH_PREFIX}${randomBase64Url(32)}`;
}
export function generateAuthorizationCode(): string {
  return randomBase64Url(32);
}
export function generateDcrClientId(): string {
  return `pptc_${randomBase64Url(16)}`;
}
export function generateRequestId(): string {
  return randomBase64Url(24);
}

// ---------------------------------------------------------------------------------------------------------------
// PKCE (RFC 7636), S256 only.

/** RFC 7636 §4.1: 43 to 128 characters of [A-Z a-z 0-9 - . _ ~]. */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
/** A S256 challenge is the base64url SHA-256 of the verifier: always 43 characters. */
export const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function pkceChallengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Whether `verifier` is well formed and its S256 challenge equals `challenge` (constant-time comparison). */
export function verifyPkceS256(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !PKCE_VERIFIER_PATTERN.test(verifier)) return false;
  return constantTimeEqual(pkceChallengeOf(verifier), challenge);
}

// ---------------------------------------------------------------------------------------------------------------
// Redirect URIs. Accepted at registration: `https` without fragment or userinfo, or `http` to a loopback host
// (localhost, 127.0.0.1, [::1]) where the port is ignored when matching (RFC 8252 §7.3, Claude Code). No custom
// schemes. Matching is otherwise exact (string equality).

export const MAX_REDIRECT_URI_LENGTH = 255;
export const MAX_REDIRECT_URIS = 5;
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type RedirectKind = "claude" | "loopback" | "web";

/** `null` when the URI is acceptable as a registered redirect URI, otherwise the reason. */
export function redirectUriProblem(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return "must be a non-empty string";
  if (value.length > MAX_REDIRECT_URI_LENGTH)
    return `must be at most ${MAX_REDIRECT_URI_LENGTH} characters`;
  if (/[\u0000- \u007f]/.test(value)) return "must not contain spaces or control characters";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URL";
  }
  if (url.hash !== "" || value.includes("#")) return "must not contain a fragment";
  if (url.username !== "" || url.password !== "") return "must not contain credentials";
  if (url.protocol === "https:") return url.hostname === "" ? "must name a host" : null;
  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
      ? null
      : "http is only allowed for localhost, 127.0.0.1 and [::1]";
  }
  return "must use https (or http to a loopback address)";
}

function isLoopbackUrl(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/** Whether a requested redirect URI matches a registered one (exact; for loopback http, any port). */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackUrl(a) || !isLoopbackUrl(b) || requested.includes("#")) return false;
  if (b.username !== "" || b.password !== "") return false;
  return (
    a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
    a.pathname === b.pathname &&
    a.search === b.search
  );
}

export function redirectKind(uri: string): RedirectKind {
  if (uri === CLAUDE_CALLBACK) return "claude";
  try {
    return isLoopbackUrl(new URL(uri)) ? "loopback" : "web";
  } catch {
    return "web";
  }
}

/** Host (with port) of a URL, for display; empty string for anything unparsable. */
export function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}

/** Appends query parameters to a redirect URI, keeping its own query. */
export function withQuery(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.append(k, v);
  return url.toString();
}

// ---------------------------------------------------------------------------------------------------------------
// Scopes. OAuth grants map 1:1 to the MCP scopes; `offline_access` is accepted and ignored (refresh tokens are
// always issued); unknown scopes are dropped; `share:write` and the other non-agent scopes are never granted.

export const OAUTH_SCOPES = ["decks:read", "decks:write", "quiz:draft"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export type ScopeRequest =
  | { ok: true; scopes: OAuthScope[] }
  | { ok: false; reason: "too_long" | "nothing_grantable" };

/** Parses a space-separated `scope` parameter. Absent or only `offline_access` means every OAuth scope. */
export function parseScopeRequest(value: unknown): ScopeRequest {
  if (value === undefined || value === null || value === "")
    return { ok: true, scopes: [...OAUTH_SCOPES] };
  if (typeof value !== "string" || value.length > 1000) return { ok: false, reason: "too_long" };
  const asked = value.split(" ").filter((s) => s !== "");
  const known = new Set(asked.filter((s) => (OAUTH_SCOPES as readonly string[]).includes(s)));
  if (known.size === 0) {
    return asked.every((s) => s === "offline_access")
      ? { ok: true, scopes: [...OAUTH_SCOPES] }
      : { ok: false, reason: "nothing_grantable" };
  }
  return { ok: true, scopes: OAUTH_SCOPES.filter((s) => known.has(s)) };
}

/** Keeps the OAuth scopes of `list`, in canonical order. */
export function onlyOAuthScopes(list: readonly unknown[]): OAuthScope[] {
  const set = new Set(list);
  return OAUTH_SCOPES.filter((s) => set.has(s));
}

// ---------------------------------------------------------------------------------------------------------------
// Resource indicators (RFC 8707).

/** Canonical form of a resource URI (lowercase scheme and host, no default port, no trailing slash); `null` if invalid. */
export function canonicalResource(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hash !== "" || value.includes("#")) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Display of client-supplied names: control and bidirectional-override characters stripped, capped at 60.
const UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

export const MAX_CLIENT_NAME_DISPLAY = 60;

export function displayClientName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(UNSAFE_TEXT, "").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  const chars = [...clean];
  return chars.length > MAX_CLIENT_NAME_DISPLAY
    ? `${chars.slice(0, MAX_CLIENT_NAME_DISPLAY - 1).join("")}…`
    : clean;
}

// ---------------------------------------------------------------------------------------------------------------
// Client ID Metadata Documents (CIMD): the client_id is an https URL with a path.

export function isCimdClientId(value: string): boolean {
  if (!value.startsWith("https://") || value.length > MAX_REDIRECT_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.href !== value) return false; // only the canonical spelling (no dot segments, lowercase host�€�)
  if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
  return url.pathname !== "/" && url.pathname !== "";
}
