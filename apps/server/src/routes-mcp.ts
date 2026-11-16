// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /mcp: Streamable HTTP, stateless (one McpServer per request). Credentials only in `Authorization: Bearer`:
// API tokens (`ppt_`) or, when the built-in authorization server is on, OAuth access tokens (`ppto_`, ADR-0018)
// issued for exactly this resource.
// The SDK's createMcpHandler serves the 2026-07-28 per-request protocol and falls back to stateless 2025-era
// serving for older clients.
import { type AuthInfo, createMcpHandler } from "@modelcontextprotocol/server";
import type { Principal } from "@pptaken/core";
import { createMcpServer } from "@pptaken/mcp";
import { Hono } from "hono";
import type { AppEnv, Services } from "./context.js";
import { apiError, ownOrigin, publicOrigin } from "./http.js";

interface Extra extends Record<string, unknown> {
  principal: Principal;
  ip: string;
  requestId: string;
  baseUrl: string;
}

export const MCP_SCOPES = ["decks:read", "decks:write", "quiz:draft"];

export function mcpRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const handler = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as Extra | undefined;
      if (extra === undefined) throw new Error("unauthenticated MCP request reached the handler");
      return createMcpServer({
        core: s.core,
        principal: extra.principal,
        call: { ip: extra.ip, requestId: extra.requestId },
        config: {
          version: s.config.version,
          baseUrl: extra.baseUrl,
          rateLimit: ({ principal, write }) => {
            const key = principal.tokenId ?? "owner";
            const calls = s.limits.mcpCallsPerToken.take(key);
            if (!calls.ok)
              return { ok: false, retryAfterSec: Math.ceil(calls.retryAfterMs / 1000) };
            if (write) {
              const writes = s.limits.mcpWritesPerToken.take(key);
              if (!writes.ok)
                return { ok: false, retryAfterSec: Math.ceil(writes.retryAfterMs / 1000) };
            }
            return { ok: true, retryAfterSec: 0 };
          },
          onActivity: async ({ principal, tool, clientName }) => {
            await s.auth.recordMcpCall({
              tool,
              clientName,
              tokenId: principal.tokenId ?? null,
            });
          },
        },
      });
    },
    {
      maxRequestBodySize: s.config.maxMcpBodyBytes,
      onerror: (error) => s.logger.debug("mcp request rejected", { error: error.message }),
    },
  );

  // RFC 6750 §3: no error code when the request carried no credentials; invalid_token when it did.
  const unauthenticated = (resourceMetadata: string, tokenPresented: boolean) =>
    new Response(
      JSON.stringify({
        error: {
          code: "UNAUTHENTICATED",
          message: "A valid access token is required",
          hint: s.oauth.enabled
            ? "Connect through your MCP client's sign-in (OAuth), or send Authorization: Bearer ppt_… with a token created in the PPTaken panel."
            : "Send Authorization: Bearer ppt_… with a token created in the PPTaken panel.",
        },
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "WWW-Authenticate": `Bearer realm="pptaken", resource_metadata="${resourceMetadata}", scope="${MCP_SCOPES.join(" ")}"${tokenPresented ? ', error="invalid_token"' : ""}`,
        },
      },
    );

  app.all("/", async (c) => {
    const base = publicOrigin(c, s.config);
    const ip = c.get("ip");
    // Browsers send Origin: refuse cross-origin pages (DNS rebinding and drive-by requests). No CORS is granted.
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== base && origin !== ownOrigin(c, s.config)) {
      return apiError(c, "FORBIDDEN", "Cross-origin MCP requests are not allowed");
    }
    const authorization = c.req.header("authorization");
    const auth =
      authorization === undefined
        ? null
        : await s.auth.authenticateBearer(
            authorization,
            s.oauth.resource === null ? {} : { resource: s.oauth.resource },
          );
    if (auth === null || auth.kind !== "token") {
      const rl = s.limits.mcpAuthFailuresPerIp.take(ip);
      if (!rl.ok) {
        return apiError(c, "RATE_LIMITED", "Too many unauthenticated requests", {
          retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
        });
      }
      return unauthenticated(
        `${base}/.well-known/oauth-protected-resource/mcp`,
        authorization !== undefined,
      );
    }
    const tokenId = auth.token.id;
    const rl = s.limits.mcpRequestsPerToken.take(tokenId);
    if (!rl.ok) {
      return apiError(c, "RATE_LIMITED", "Too many MCP requests with this token", {
        retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
      });
    }
    const length = Number(c.req.header("content-length") ?? "0");
    if (length > s.config.maxMcpBodyBytes) {
      return apiError(c, "VALIDATION_ERROR", "Request body too large", { status: 413 });
    }
    const extra: Extra = {
      principal: auth.principal,
      ip,
      requestId: c.get("requestId"),
      baseUrl: base,
    };
    const authInfo: AuthInfo = {
      token: tokenId,
      clientId: tokenId,
      scopes: [...auth.principal.scopes],
      extra,
    };
    const initializeClient = await clientInfoOfInitialize(c.req.raw, length);
    const response = await handler.fetch(c.req.raw, { authInfo });
    if (response.status < 400) {
      try {
        // Any authenticated MCP request counts as "agent connected"; a tool call also records its name (in the
        // tool handler). The client name comes from `initialize` (or the per-request envelope of newer
        // clients); the User-Agent is only a last resort.
        const previous = await s.auth.mcpStatus();
        await s.auth.recordMcpCall({
          tool: null,
          clientName:
            initializeClient ??
            (previous?.clientName == null
              ? (c.req.header("user-agent")?.slice(0, 120) ?? null)
              : null),
          tokenId,
        });
      } catch (error) {
        s.logger.warn("could not record MCP activity", { error: String(error) });
      }
    }
    return response;
  });

  return app;
}

/** `clientInfo` of a small JSON-RPC `initialize` request (read from a clone; the original stays unread). */
async function clientInfoOfInitialize(request: Request, length: number): Promise<string | null> {
  if (request.method !== "POST" || length <= 0 || length > 64 * 1024) return null;
  try {
    const body = (await request.clone().json()) as {
      method?: unknown;
      params?: { clientInfo?: { name?: unknown; version?: unknown } };
    };
    const info = body?.method === "initialize" ? body.params?.clientInfo : undefined;
    if (info === undefined || typeof info.name !== "string") return null;
    return `${info.name}${typeof info.version === "string" ? ` ${info.version}` : ""}`.slice(
      0,
      120,
    );
  } catch {
    return null;
  }
}
