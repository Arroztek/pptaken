// SPDX-License-Identifier: AGPL-3.0-or-later
// OAuth endpoints of the built-in authorization server (ADR-0018) and the RFC 9728 resource metadata:
//   GET  /.well-known/oauth-protected-resource[/mcp]   resource metadata (always; authorization_servers when on)
//   GET  /.well-known/oauth-authorization-server       RFC 8414 metadata (only when OAuth is on)
//   POST /oauth/register                               RFC 7591 dynamic registration (JSON, public clients)
//   GET  /oauth/authorize                              validates, stores a pending request, sends to /connect/<id>
//   POST /oauth/token                                  authorization_code and refresh_token grants
//   POST /oauth/revoke                                 RFC 7009, always 200
// The consent itself is a panel page (apps/web) calling /api/v1/oauth/requests/:id with the owner session.
// CORS (`*`, never credentials) only on the two metadata documents, /oauth/token and /oauth/register: browser-based
// MCP clients call them cross-origin. /oauth/authorize is a top-level navigation and gets no CORS.
import { OAuthProtocolError } from "@pptaken/auth-local";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv, Services } from "./context.js";
import { publicOrigin } from "./http.js";
import { MCP_SCOPES } from "./routes-mcp.js";

/** Paths a sign-in window visits during an OAuth flow: they are served without COOP isolation (see app.ts). */
export function isOAuthPopupPath(path: string): boolean {
  return (
    path === "/oauth/authorize" || path === "/login" || /^\/connect\/[A-Za-z0-9_-]{32}$/.test(path)
  );
}

/** Largest body accepted by the OAuth POST endpoints. */
export const OAUTH_MAX_BODY_BYTES = 4 * 1024;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "600",
  // The default is same-origin (app.ts); these documents are meant to be read from other origins.
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function oauthJson(
  value: unknown,
  status = 200,
  options: { cors?: boolean; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...(options.cors === true ? CORS_HEADERS : {}),
      ...options.headers,
    },
  });
}

function oauthError(
  error: OAuthProtocolError | { code: string; description: string; status?: number },
  cors: boolean,
  headers: Record<string, string> = {},
): Response {
  return oauthJson(
    { error: error.code, error_description: error.description },
    error.status ?? 400,
    { cors, headers },
  );
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );

/** The page shown instead of redirecting when the client or its redirect URI cannot be trusted. */
function errorPage(error: string, description: string): Response {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Cannot connect · PPTaken</title><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">This connection request was refused.</h1><p>${escapeHtml(description)}.</p><p style="color:#666">Error: <code>${escapeHtml(error)}</code>. Nothing was shared. Go back to the application and try connecting again; if it keeps failing, the application is not set up correctly for this PPTaken.</p></body></html>`;
  return new Response(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** RFC 9728 metadata of the MCP resource. `issuer` adds `authorization_servers` (OAuth on). */
export function protectedResourceMetadata(base: string, issuer: string | null) {
  return {
    resource: `${base}/mcp`,
    ...(issuer === null ? {} : { authorization_servers: [issuer] }),
    bearer_methods_supported: ["header"],
    scopes_supported: MCP_SCOPES,
    resource_name: "PPTaken",
    resource_documentation: `${base}/welcome`,
  };
}

async function formOf(c: Context): Promise<URLSearchParams | null> {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  try {
    return new URLSearchParams(await c.req.text());
  } catch {
    return null;
  }
}

export function oauthRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const oauth = s.oauth;
  const retryAfter = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));

  const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });
  const prm = (c: Context) =>
    oauthJson(protectedResourceMetadata(publicOrigin(c, s.config), oauth.issuer), 200, {
      cors: true,
      headers: { "Cache-Control": "public, max-age=300" },
    });

  app.get("/.well-known/oauth-protected-resource", prm);
  app.get("/.well-known/oauth-protected-resource/mcp", prm);
  app.options("/.well-known/oauth-protected-resource", preflight);
  app.options("/.well-known/oauth-protected-resource/mcp", preflight);

  if (!oauth.enabled) {
    // No authorization server: the metadata and the endpoints do not exist (404 from the app's fallbacks).
    app.all("/oauth/*", (c) => c.text("Not found", 404));
    return app;
  }

  app.get("/.well-known/oauth-authorization-server", () =>
    oauthJson(oauth.metadata(), 200, {
      cors: true,
      headers: { "Cache-Control": "public, max-age=300" },
    }),
  );
  app.options("/.well-known/oauth-authorization-server", preflight);
  app.options("/oauth/token", preflight);
  app.options("/oauth/register", preflight);

  /** Shared per-IP guard of the OAuth endpoints (DoS). */
  const limited = (c: Context, cors: boolean): Response | null => {
    const rl = s.limits.oauthPerIp.take(c.get("ip"));
    if (rl.ok) return null;
    return oauthError(
      { code: "temporarily_unavailable", description: "Too many requests", status: 429 },
      cors,
      { "Retry-After": retryAfter(rl.retryAfterMs) },
    );
  };

  app.post("/oauth/register", async (c) => {
    const rl = s.limits.dcrPerIp.take(c.get("ip"));
    if (!rl.ok) {
      return oauthError(
        { code: "temporarily_unavailable", description: "Too many registrations", status: 429 },
        true,
        { "Retry-After": retryAfter(rl.retryAfterMs) },
      );
    }
    const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      return oauthError(
        { code: "invalid_client_metadata", description: "Send the metadata as application/json" },
        true,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return oauthError(
        { code: "invalid_client_metadata", description: "The body is not valid JSON" },
        true,
      );
    }
    try {
      const registered = await oauth.registerClient(body);
      s.logger.info("oauth client registered", {
        clientId: registered.client_id,
        requestId: c.get("requestId"),
      });
      return oauthJson(registered, 201, { cors: true });
    } catch (error) {
      if (error instanceof OAuthProtocolError) return oauthError(error, true);
      throw error;
    }
  });

  app.get("/oauth/authorize", async (c) => {
    const denied = limited(c, false);
    if (denied) return denied;
    const outcome = await oauth.authorize(new URL(c.req.url).searchParams);
    if (outcome.kind === "error_page") {
      s.logger.info("oauth authorize refused", {
        error: outcome.error,
        requestId: c.get("requestId"),
      });
      return errorPage(outcome.error, outcome.description);
    }
    return new Response(null, {
      status: 302,
      headers: { Location: outcome.location, "Cache-Control": "no-store" },
    });
  });

  app.post("/oauth/token", async (c) => {
    const denied = limited(c, true);
    if (denied) return denied;
    const form = await formOf(c);
    if (form === null) {
      return oauthError(
        {
          code: "invalid_request",
          description: "Send the parameters as application/x-www-form-urlencoded",
        },
        true,
      );
    }
    try {
      const tokens = await oauth.token(form);
      s.logger.info("oauth tokens issued", {
        grantType: form.get("grant_type"),
        requestId: c.get("requestId"),
      });
      return oauthJson(tokens, 200, { cors: true });
    } catch (error) {
      if (error instanceof OAuthProtocolError) {
        s.logger.info("oauth token refused", {
          error: error.code,
          grantType: form.get("grant_type")?.slice(0, 40),
          requestId: c.get("requestId"),
        });
        return oauthError(error, true);
      }
      throw error;
    }
  });

  app.post("/oauth/revoke", async (c) => {
    const denied = limited(c, false);
    if (denied) return denied;
    const form = await formOf(c);
    if (form !== null) await oauth.revokeToken(form);
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  });

  app.all("/oauth/*", (c) => c.text("Not found", 404));
  return app;
}
