// SPDX-License-Identifier: AGPL-3.0-or-later
// Secret formats: API tokens, session ids, the install code and short-lived signed tokens (content routes).
import { randomInt } from "node:crypto";
import { constantTimeEqual, hmacBase64Url, randomBase64Url, sha256Hex } from "./crypto.js";

// ---------------------------------------------------------------------------------------------------------------
// API tokens: `ppt_` + 43 base64url characters (256 random bits). The prefix lets secret scanners find leaks.

export const API_TOKEN_PREFIX = "ppt_";
export const API_TOKEN_PATTERN = /^ppt_[A-Za-z0-9_-]{43}$/;

export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBase64Url(32)}`;
}

export function isApiTokenFormat(value: string): boolean {
  return API_TOKEN_PATTERN.test(value);
}

/** SHA-256 hex of a high-entropy secret (API token, session id). Safe as a lookup key. */
export function hashSecret(secret: string): string {
  return sha256Hex(secret);
}

// ---------------------------------------------------------------------------------------------------------------
// Session ids: 256 random bits, base64url.

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateSessionId(): string {
  return randomBase64Url(32);
}

// ---------------------------------------------------------------------------------------------------------------
// Install code: 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L, U), shown as XXXX-XXXX.
// 30^8 ≈ 6.6 × 10^11 combinations; guessing is capped by the sign-in rate limits and the code changes on every
// boot until used.

export const INSTALL_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateInstallCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++)
    code += INSTALL_CODE_ALPHABET[randomInt(INSTALL_CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Uppercases and removes spaces and dashes; `null` when the result is not 8 alphabet characters. */
export function normalizeInstallCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== 8) return null;
  for (const ch of code) if (!INSTALL_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

// ---------------------------------------------------------------------------------------------------------------
// Signed tokens: `<payload base64url>.<HMAC-SHA256 base64url>`, payload `v1|<purpose>|<subject>|<exp ms>`.
// Used for the content routes (bound to deck id + revision, or to a deck for its assets).

export interface SignedTokenClaims {
  purpose: string;
  subject: string;
  /** Expiry, epoch ms. */
  exp: number;
}

const SAFE_PART = /^[A-Za-z0-9:._-]{1,200}$/;

export function signToken(key: Uint8Array, claims: SignedTokenClaims): string {
  if (!SAFE_PART.test(claims.purpose) || !SAFE_PART.test(claims.subject)) {
    throw new TypeError("purpose and subject must be short identifiers");
  }
  if (!Number.isSafeInteger(claims.exp)) throw new TypeError("exp must be an integer");
  const payload = Buffer.from(
    `v1|${claims.purpose}|${claims.subject}|${claims.exp}`,
    "utf8",
  ).toString("base64url");
  return `${payload}.${hmacBase64Url(key, payload)}`;
}

/**
 * Verifies a signed token for `purpose` and `subject` at time `now`. Returns false for anything malformed,
 * forged, expired or issued for another purpose or subject. The signature is checked in constant time before
 * the payload is trusted.
 */
export function verifyToken(
  key: Uint8Array,
  token: unknown,
  expected: { purpose: string; subject: string; now: number },
): boolean {
  if (typeof token !== "string" || token.length > 600) return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  if (!constantTimeEqual(signature, hmacBase64Url(key, payload))) return false;
  const parts = Buffer.from(payload, "base64url").toString("utf8").split("|");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const exp = Number(parts[3]);
  if (!Number.isSafeInteger(exp) || exp <= expected.now) return false;
  return parts[1] === expected.purpose && parts[2] === expected.subject;
}
