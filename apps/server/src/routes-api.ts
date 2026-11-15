// SPDX-License-Identifier: AGPL-3.0-or-later
// The panel API, phase F2 (docs/spec/http-api.md). JSON only; every state-changing request passes the CSRF check;
// every input goes through Zod before it reaches the auth layer or the core.
import { AuthError, checkCsrf, signToken, type TokenView } from "@pptaken/auth-local";
import { DEFAULT_WORKSPACE_ID, isDomainError, ownerPrincipal } from "@pptaken/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "./context.js";
import {
  apiError,
  contentOrigin,
  isHttps,
  isJsonRequest,
  ownOrigin,
  publicOrigin,
} from "./http.js";
import { clearSessionCookie, ownerSession, readSessionId, setSessionCookie } from "./session.js";

/** Lifetime of the signed URL of a deck document (the shell loads it right away). */
export const CONTENT_DOC_TTL_MS = 5 * 60 * 1000;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

const setupBody = z.object({ installCode: z.string().max(64), password: z.string().max(4096) });
const loginBody = z.object({ password: z.string().max(4096) });
const tokenBody = z.object({
  name: z.string().max(200),
  scopes: z.array(z.string().max(40)).max(10).optional(),
  expiresInDays: z.number().optional().nullable(),
});

function tokenJson(t: TokenView) {
  return {
    id: t.id,
    name: t.name,
    scopes: t.scopes,
    createdAt: iso(t.createdAt),
    expiresAt: iso(t.expiresAt),
    lastUsedAt: iso(t.lastUsedAt),
    revokedAt: iso(t.revokedAt),
  };
}

function authErrorResponse(c: Context, error: AuthError): Response {
  return apiError(c, error.code, error.message, { hint: error.hint });
}

export function apiRoutes(s: Services): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  const owner = ownerPrincipal(DEFAULT_WORKSPACE_ID);

  const retryAfter = (ms: number) => Math.ceil(ms / 1000);

  // DoS guard per IP, then CSRF on every state-changing method, then JSON-only bodies.
  api.use("*", async (c, next) => {
    const rl = s.limits.apiPerIp.take(c.get("ip"));
    if (!rl.ok) {
      return apiError(c, "RATE_LIMITED", "Too many requests", {
        retryAfterSec: retryAfter(rl.retryAfterMs),
      });
    }
    const csrf = checkCsrf({
      method: c.req.method,
      header: (n) => c.req.header(n),
      allowedOrigins: [publicOrigin(c, s.config), ownOrigin(c, s.config)],
    });
    if (!csrf.ok) {
      return apiError(c, "FORBIDDEN", "Cross-site request refused", {
        hint: "Send the X-PPTaken-CSRF: 1 header from the PPTaken web app's own origin.",
      });
    }
    if (["POST", "PUT", "PATCH"].includes(c.req.method) && c.req.header("content-length") !== "0") {
      const hasBody =
        c.req.header("content-length") !== undefined ||
        c.req.header("transfer-encoding") !== undefined;
      if (hasBody && !isJsonRequest(c)) {
        return apiError(c, "VALIDATION_ERROR", "The request body must be JSON", {
          hint: "Send Content-Type: application/json.",
        });
      }
    }
    await next();
  });

  async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | Response> {
    let raw: unknown;
    try {
      const text = await c.req.text();
      raw = text === "" ? {} : JSON.parse(text);
    } catch {
      return apiError(c, "VALIDATION_ERROR", "The request body is not valid JSON");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") ?? "";
      return apiError(
        c,
        "VALIDATION_ERROR",
        `${path === "" ? "body" : path}: ${issue?.message ?? "invalid"}`,
      );
    }
    return parsed.data;
  }

  /** Owner session required (409 before setup, 401 without a valid session). */
  async function requireOwner(c: Context): Promise<Response | null> {
    if (await ownerSession(c, s)) return null;
    if (!(await s.auth.isInstalled())) {
      return apiError(c, "SETUP_REQUIRED", "Nobody has set up this instance yet", {
        hint: "Open /welcome to set it up.",
      });
    }
    return apiError(c, "UNAUTHENTICATED", "Sign in first");
  }

  // -------------------------------------------------------------------------------------------------------------
  // Setup and session

  api.get("/setup/status", async (c) =>
    c.json({
      installed: await s.auth.isInstalled(),
      publicUrl: publicOrigin(c, s.config),
      https: isHttps(c, s.config),
      version: s.config.version,
    }),
  );

  api.post("/setup", async (c) => {
    if (await s.auth.isInstalled())
      return apiError(c, "ALREADY_SETUP", "This instance is already set up");
    const ip = c.get("ip");
    const gate = s.limits.signIn.check(ip);
    if (!gate.ok) {
      return apiError(c, "RATE_LIMITED", "Too many attempts", {
        retryAfterSec: retryAfter(gate.retryAfterMs),
      });
    }
    const input = await body(c, setupBody);
    if (input instanceof Response) return input;
    try {
      const { ownerId, sessionId } = await s.auth.setup(input);
      s.limits.signIn.succeed(ip);
      setSessionCookie(c, s, sessionId);
      s.logger.info("owner created", { requestId: c.get("requestId") });
      return c.json({ owner: { id: ownerId } }, 201);
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.code === "FORBIDDEN") s.limits.signIn.fail(ip);
        return authErrorResponse(c, error);
      }
      throw error;
    }
  });

  api.post("/auth/login", async (c) => {
    if (!(await s.auth.isInstalled())) {
      return apiError(c, "SETUP_REQUIRED", "Nobody has set up this instance yet");
    }
    const ip = c.get("ip");
    const gate = s.limits.signIn.check(ip);
    if (!gate.ok) {
      return apiError(c, "RATE_LIMITED", "Too many sign-in attempts", {
        retryAfterSec: retryAfter(gate.retryAfterMs),
      });
    }
    const input = await body(c, loginBody);
    if (input instanceof Response) return input;
    try {
      const old = readSessionId(c, s);
      const { ownerId, sessionId } = await s.auth.login(input);
      if (old !== undefined) await s.auth.logout(old); // rotation: the previous session id dies
      s.limits.signIn.succeed(ip);
      setSessionCookie(c, s, sessionId);
      return c.json({ owner: { id: ownerId } }, 200);
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.code === "UNAUTHENTICATED") {
          s.limits.signIn.fail(ip);
          s.logger.warn("sign-in failed", { ip, requestId: c.get("requestId") });
        }
        return authErrorResponse(c, error);
      }
      throw error;
    }
  });

  api.post("/auth/logout", async (c) => {
    await s.auth.logout(readSessionId(c, s));
    clearSessionCookie(c, s);
    return c.body(null, 204);
  });

  api.get("/auth/me", async (c) => {
    if (!(await s.auth.isInstalled())) {
      return apiError(c, "SETUP_REQUIRED", "Nobody has set up this instance yet");
    }
    const session = await ownerSession(c, s);
    if (session === null) return apiError(c, "UNAUTHENTICATED", "Sign in first");
    return c.json({ owner: { id: session.ownerId }, csrf: "1" });
  });

  // -------------------------------------------------------------------------------------------------------------
  // API tokens

  api.post("/tokens", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const input = await body(c, tokenBody);
    if (input instanceof Response) return input;
    try {
      const { token, secret } = await s.auth.createToken({
        name: input.name,
        ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
        ...(input.expiresInDays === undefined || input.expiresInDays === null
          ? {}
          : { expiresInDays: input.expiresInDays }),
      });
      s.logger.info("api token created", { tokenId: token.id, requestId: c.get("requestId") });
      const view = tokenJson(token);
      return c.json(
        {
          token: {
            id: view.id,
            name: view.name,
            scopes: view.scopes,
            createdAt: view.createdAt,
            expiresAt: view.expiresAt,
          },
          secret,
        },
        201,
      );
    } catch (error) {
      if (error instanceof AuthError) return authErrorResponse(c, error);
      throw error;
    }
  });

  api.get("/tokens", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    return c.json({ tokens: (await s.auth.listTokens()).map(tokenJson) });
  });

  api.delete("/tokens/:id", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    try {
      await s.auth.revokeToken(c.req.param("id"));
      s.logger.info("api token revoked", {
        tokenId: c.req.param("id"),
        requestId: c.get("requestId"),
      });
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof AuthError) return authErrorResponse(c, error);
      throw error;
    }
  });

  // -------------------------------------------------------------------------------------------------------------
  // Agent connection

  api.get("/connect/status", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const status = await s.auth.mcpStatus();
    return c.json({
      mcpUrl: `${publicOrigin(c, s.config)}/mcp`,
      agentConnected: status !== null,
      lastCallAt: status === null ? null : iso(status.lastCallAt),
      lastTool: status?.lastTool ?? null,
      clientName: status?.clientName ?? null,
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  // Presentations (read-only in F2)

  async function summary(id: string) {
    const deck = await s.storage.decks.get(DEFAULT_WORKSPACE_ID, id);
    if (deck === null || deck.deletedAt !== null) return null;
    return {
      id: deck.id,
      title: deck.title,
      lang: deck.lang,
      slideCount: deck.slideCount,
      revision: deck.currentRevision,
      updatedAt: iso(deck.updatedAt),
      createdBy: deck.createdBy.actor === "agent" ? "agent" : "owner",
    };
  }

  function domainErrorResponse(c: Context, error: unknown): Response {
    if (isDomainError(error)) {
      if (error.code === "VALIDATION_ERROR")
        return apiError(c, "VALIDATION_ERROR", error.message, { hint: error.hint });
      if (error.code === "NOT_FOUND") return apiError(c, "NOT_FOUND", "Presentation not found");
      if (error.code === "FORBIDDEN_SCOPE" || error.code === "FORBIDDEN_ACTOR") {
        return apiError(c, "FORBIDDEN", error.message);
      }
    }
    throw error;
  }

  api.get("/decks", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const cursor = c.req.query("cursor") || undefined;
    const q = c.req.query("q") || undefined;
    if ((cursor?.length ?? 0) > 200 || (q?.length ?? 0) > 200) {
      return apiError(c, "VALIDATION_ERROR", "cursor and q must be at most 200 characters");
    }
    try {
      const page = await s.core.listPresentations(
        owner,
        {
          limit: 20,
          ...(cursor === undefined ? {} : { cursor }),
          ...(q === undefined ? {} : { query: q }),
        },
        { ip: c.get("ip"), requestId: c.get("requestId") },
      );
      const decks = [];
      for (const item of page.items) {
        const sum = await summary(item.presentationId);
        if (sum !== null) decks.push(sum);
      }
      return c.json({ decks, nextCursor: page.nextCursor });
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  api.get("/decks/:id", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const sum = ULID.test(id) ? await summary(id) : null;
    if (sum === null) return apiError(c, "NOT_FOUND", "Presentation not found");
    return c.json({ ...sum, urls: { present: `${publicOrigin(c, s.config)}/p/${id}` } });
  });

  api.get("/decks/:id/content-url", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const sum = ULID.test(id) ? await summary(id) : null;
    if (sum === null) return apiError(c, "NOT_FOUND", "Presentation not found");
    const token = signToken(s.contentKey, {
      purpose: "doc",
      subject: `${id}:${sum.revision}`,
      exp: s.clock.now() + CONTENT_DOC_TTL_MS,
    });
    return c.json({ url: `${contentOrigin(c, s.config)}/c/${id}/${sum.revision}?ct=${token}` });
  });

  api.all("*", (c) => apiError(c, "NOT_FOUND", "No such API route"));
  return api;
}
