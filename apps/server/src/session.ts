// SPDX-License-Identifier: AGPL-3.0-or-later
// The panel session cookie: `__Host-pptaken_session` over HTTPS (the prefix requires Secure), `pptaken_session`
// over plain HTTP. HttpOnly, SameSite=Lax, Path=/, 30-day Max-Age refreshed while the session slides.
import { SESSION_TTL_MS } from "@pptaken/auth-local";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Services } from "./context.js";
import { isHttps } from "./http.js";

export function sessionCookieName(https: boolean): string {
  return https ? "__Host-pptaken_session" : "pptaken_session";
}

export function readSessionId(c: Context, s: Services): string | undefined {
  return getCookie(c, sessionCookieName(isHttps(c, s.config)));
}

export function setSessionCookie(c: Context, s: Services, sessionId: string): void {
  const https = isHttps(c, s.config);
  const parts = [
    `${sessionCookieName(https)}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (https) parts.push("Secure");
  c.header("Set-Cookie", parts.join("; "), { append: true });
}

export function clearSessionCookie(c: Context, s: Services): void {
  const https = isHttps(c, s.config);
  const parts = [`${sessionCookieName(https)}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (https) parts.push("Secure");
  c.header("Set-Cookie", parts.join("; "), { append: true });
}

/** Resolves the owner session of the request (sliding expiry: re-sends the cookie when it was extended). */
export async function ownerSession(
  c: Context,
  s: Services,
): Promise<{ ownerId: string; sessionId: string } | null> {
  const sessionId = readSessionId(c, s);
  if (sessionId === undefined) return null;
  const session = await s.auth.resolveSession(sessionId);
  if (session === null) return null;
  if (session.refreshed) setSessionCookie(c, s, sessionId);
  return { ownerId: session.ownerId, sessionId };
}
