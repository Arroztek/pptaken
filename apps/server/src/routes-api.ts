// SPDX-License-Identifier: AGPL-3.0-or-later
// The panel API, phase F2 (docs/spec/http-api.md). JSON only; every state-changing request passes the CSRF check;
// every input goes through Zod before it reaches the auth layer or the core.
import {
  AuthError,
  type ConnectedApp,
  checkCsrf,
  OAuthProtocolError,
  signToken,
  type TokenView,
} from "@pptaken/auth-local";
import {
  DEFAULT_WORKSPACE_ID,
  isDomainError,
  ownerPrincipal,
  type ScriptsStatus,
  scriptsDigest,
  scriptsStateOf,
} from "@pptaken/core";
import { staticDeck } from "@pptaken/sanitizer";
import { canvasSize, type Deck } from "@pptaken/schema";
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
import {
  signUnlockToken,
  UNLOCK_HEADER,
  unlockableDigest,
  VIEW_HEADER,
  verifyUnlockToken,
  verifyViewGrant,
} from "./presenter-unlock.js";
import { clearSessionCookie, ownerSession, readSessionId, setSessionCookie } from "./session.js";

/** Lifetime of the signed URL of a deck document (the shell loads it right away). */
export const CONTENT_DOC_TTL_MS = 5 * 60 * 1000;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

const setupBody = z.object({ installCode: z.string().max(64), password: z.string().max(4096) });
const loginBody = z.object({ password: z.string().max(4096) });
const passwordBody = z.object({
  currentPassword: z.string().max(4096),
  newPassword: z.string().max(4096),
  disconnectApps: z.boolean().optional(),
});
const decisionBody = z.object({
  decision: z.enum(["approve", "deny"]),
  scopes: z.array(z.string().max(40)).max(10).optional(),
});
const approveBody = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const presenterPasswordBody = z.object({ password: z.string().max(4096) }).strict();
const unlockBody = z
  .object({ deckId: z.string().max(64), password: z.string().max(4096) })
  .strict();
/** Sanitizer warnings shown on the approval screen (the rest are summarized by count). */
const MAX_REVIEW_WARNINGS = 50;
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

function appJson(a: ConnectedApp) {
  return {
    id: a.id,
    clientId: a.clientId,
    clientKind: a.clientKind,
    clientName: a.clientName,
    redirectHost: a.redirectHost,
    scopes: a.scopes,
    createdAt: iso(a.createdAt),
    lastUsedAt: iso(a.lastUsedAt),
    expiresAt: iso(a.expiresAt),
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

  api.post("/auth/password", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const ip = c.get("ip");
    const gate = s.limits.signIn.check(ip);
    if (!gate.ok) {
      return apiError(c, "RATE_LIMITED", "Too many attempts", {
        retryAfterSec: retryAfter(gate.retryAfterMs),
      });
    }
    const input = await body(c, passwordBody);
    if (input instanceof Response) return input;
    try {
      const { sessionId, disconnected } = await s.auth.changePassword({
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        disconnectApps: input.disconnectApps === true,
      });
      s.limits.signIn.succeed(ip);
      setSessionCookie(c, s, sessionId);
      s.logger.info("owner password changed", { disconnected, requestId: c.get("requestId") });
      return c.json({ disconnectedApps: disconnected });
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.code === "UNAUTHENTICATED") s.limits.signIn.fail(ip);
        return authErrorResponse(c, error);
      }
      throw error;
    }
  });

  // -------------------------------------------------------------------------------------------------------------
  // OAuth consent and connected applications (ADR-0018). Consent needs a live owner session and the CSRF check
  // above; it is never automatic.

  api.get("/oauth/requests/:id", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const view = s.oauth.enabled ? s.oauth.pendingRequest(c.req.param("id")) : null;
    if (view === null)
      return apiError(c, "NOT_FOUND", "This connection request expired or was already answered");
    c.header("Cache-Control", "no-store");
    return c.json({ ...view, expiresAt: iso(view.expiresAt) });
  });

  api.post("/oauth/requests/:id", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const input = await body(c, decisionBody);
    if (input instanceof Response) return input;
    if (!s.oauth.enabled) return apiError(c, "NOT_FOUND", "OAuth is not enabled");
    try {
      const { redirectUrl } = await s.oauth.decide(c.req.param("id"), {
        approve: input.decision === "approve",
        scopes: input.scopes,
      });
      s.logger.info("oauth request answered", {
        decision: input.decision,
        requestId: c.get("requestId"),
      });
      c.header("Cache-Control", "no-store");
      return c.json({ redirectUrl });
    } catch (error) {
      if (error instanceof OAuthProtocolError) {
        return error.code === "not_found"
          ? apiError(c, "NOT_FOUND", error.description)
          : apiError(c, "VALIDATION_ERROR", error.description);
      }
      throw error;
    }
  });

  api.get("/oauth/apps", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    return c.json({ apps: (await s.oauth.connectedApps()).map(appJson) });
  });

  api.delete("/oauth/apps/:id", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    if (!(await s.oauth.revokeGrant(c.req.param("id")))) {
      return apiError(c, "NOT_FOUND", "No connected application has this id");
    }
    s.logger.info("oauth grant revoked", {
      grantId: c.req.param("id"),
      requestId: c.get("requestId"),
    });
    return c.body(null, 204);
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
    // Interactive mode (ADR-020/021): the trust state of the current revision's scripts, for the list badge.
    const revision = await s.storage.revisions.get(DEFAULT_WORKSPACE_ID, id, deck.currentRevision);
    const digest = revision === null ? null : scriptsDigest(revision.document);
    const approval =
      digest === null ? null : await s.storage.scriptApprovals.get(DEFAULT_WORKSPACE_ID, id);
    return {
      id: deck.id,
      title: deck.title,
      lang: deck.lang,
      slideCount: deck.slideCount,
      revision: deck.currentRevision,
      updatedAt: iso(deck.updatedAt),
      createdBy: deck.createdBy.actor === "agent" ? "agent" : "owner",
      scripts: scriptsStateOf(digest, approval?.digest ?? null),
    };
  }

  const callOf = (c: Context<AppEnv>) => ({ ip: c.get("ip"), requestId: c.get("requestId") });

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
    const base = publicOrigin(c, s.config);
    // Ingest-time vendoring (ADR-022): the provenance of the current revision's external resources and the
    // operator switch, for the panel's "Vendored resources" section.
    const revision = await s.storage.revisions.get(DEFAULT_WORKSPACE_ID, id, sum.revision);
    return c.json({
      ...sum,
      urls: { present: `${base}/p/${id}`, manage: `${base}/decks/${id}` },
      vendorFetch: s.config.vendorFetch ? "on" : "off",
      vendored: revision?.document.vendored ?? [],
    });
  });

  // The signed content URL of the current revision for the owner's player page. Side-effect free (it only signs).
  // Interactive mode (ADR-020): an "sdoc" token (scripted document) only when the instance switch is on, the deck's
  // current scripts digest is the approved one and the page did not ask for the static version (`?safe=1`);
  // otherwise a "doc" token (static fallback). Never an API or OAuth token.
  //
  // Without an owner session (ADR-021) the request must carry a view grant for this deck (`X-PPTaken-View`, minted
  // by a guest page: today the test route, later phase F5's links); it gets the static version, reported as
  // `locked` when the deck's approved scripts could run after a presenter-password unlock. With a valid unlock token
  // (`X-PPTaken-Unlock`, bound to this deck, its current approved digest and the presenter password epoch) it gets
  // the scripted document under the same rules as the owner (switch on, approved digest, not `?safe=1`).
  api.get("/decks/:id/content-url", async (c) => {
    const id = c.req.param("id");
    const owned = (await ownerSession(c, s)) !== null;
    if (!owned && !(ULID.test(id) && verifyViewGrant(s, c.req.header(VIEW_HEADER), id))) {
      const denied = await requireOwner(c);
      if (denied) return denied;
    }
    const sum = ULID.test(id) ? await summary(id) : null;
    if (sum === null) return apiError(c, "NOT_FOUND", "Presentation not found");
    const safe = c.req.query("safe") === "1";
    let document: Deck;
    try {
      ({ document } = await s.core.getRevision(owner, {
        presentationId: id,
        revision: sum.revision,
      }));
    } catch (error) {
      return domainErrorResponse(c, error);
    }
    const digest = scriptsDigest(document);
    let scripts: "running" | "none" | "off" | "pending" | "safe" | "locked" = "none";
    const unlock = owned ? undefined : c.req.header(UNLOCK_HEADER);
    let unlockRejected = false;
    if (digest !== null) {
      const approval = await s.storage.scriptApprovals.get(DEFAULT_WORKSPACE_ID, id);
      if (s.config.scripts !== "owner") scripts = "off";
      else if (approval?.digest !== digest) scripts = "pending";
      else if (safe) scripts = "safe";
      else if (owned) scripts = "running";
      else if (await verifyUnlockToken(s, unlock, id, digest)) scripts = "running";
      else scripts = "locked";
    }
    // A guest's unlock token that no longer works (edited deck, revoked, password changed, expired): say so, so
    // the page forgets it and can offer the unlock again.
    if (!owned && unlock !== undefined && unlock !== "" && scripts !== "running" && !safe) {
      unlockRejected = true;
    }
    const extra = unlockRejected ? { unlockRejected: true } : {};
    const exp = s.clock.now() + CONTENT_DOC_TTL_MS;
    const token =
      scripts === "running"
        ? signToken(s.contentKey, {
            purpose: "sdoc",
            subject: `${id}:${sum.revision}:${digest}`,
            exp,
          })
        : signToken(s.contentKey, { purpose: "doc", subject: `${id}:${sum.revision}`, exp });
    const url = `${contentOrigin(c, s.config)}/c/${id}/${sum.revision}?ct=${token}`;
    if (scripts !== "running")
      return c.json({ url, scripts, ...extra }, 200, { "Cache-Control": "no-store" });
    const canvas = canvasSize(document.aspectRatio);
    return c.json(
      { url, scripts, expect: { slides: document.slides.map((x) => x.id), ...canvas } },
      200,
      { "Cache-Control": "no-store" },
    );
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Interactive mode (ADR-020): the owner reviews and approves a deck's author scripts. Panel session only (this
  // router never accepts API or OAuth tokens), CSRF on POST, and the core refuses any actor but the owner.

  /** The scripts status of a deck, with the instance capability the approval screen must show. */
  const scriptsJson = (st: ScriptsStatus) => ({
    presentationId: st.presentationId,
    revision: st.revision,
    enabled: st.enabled,
    state: st.state,
    digest: st.digest,
    approvedDigest: st.approvedDigest,
    approvedAt: iso(st.approvedAt),
    slides: st.slides,
    libs: st.libs,
    deckScript: st.deckScript,
    chars: st.chars,
    capability: {
      contentOrigin: s.config.contentOrigin,
      separateSiteContent: s.config.contentOrigin === "separate-site",
      // Shown before approval when false: a runaway script can freeze the presenter tab in Firefox and Safari.
      freezeWarning: s.config.contentOrigin !== "separate-site",
    },
  });

  // The approval screen (ADR-021): the status plus every script's exact source, hash and size, and what the static
  // fallback loses (sanitizer warnings of the safe re-sanitization), so the owner reads exactly what the digest binds.
  api.get("/decks/:id/scripts", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    try {
      const review = await s.core.getScriptsReview(owner, { presentationId: id }, callOf(c));
      let warnings: { code: string; message: string; path: string | null; name: string | null }[] =
        [];
      if (review.digest !== null) {
        const { document } = await s.core.getRevision(owner, {
          presentationId: id,
          revision: review.revision,
        });
        warnings = staticDeck(document)
          .warnings.slice(0, MAX_REVIEW_WARNINGS)
          .map((w) => ({
            code: w.code,
            message: w.message,
            path: w.path ?? null,
            name: w.name ?? null,
          }));
      }
      return c.json(
        {
          ...scriptsJson(review),
          sources: review.sources,
          deckSource: review.deckSource,
          warnings,
          presenterPassword: { set: await s.auth.hasPresenterPassword() },
        },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  api.post("/decks/:id/scripts/approve", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    const input = await body(c, approveBody);
    if (input instanceof Response) return input;
    try {
      const st = await s.core.approveScripts(
        owner,
        { presentationId: id, digest: input.digest },
        callOf(c),
      );
      return c.json(scriptsJson(st));
    } catch (error) {
      if (isDomainError(error) && error.code === "REVISION_CONFLICT") {
        return apiError(c, "VALIDATION_ERROR", error.message, { hint: error.hint, status: 409 });
      }
      return domainErrorResponse(c, error);
    }
  });

  api.post("/decks/:id/scripts/revoke", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    try {
      const st = await s.core.revokeScripts(owner, { presentationId: id }, callOf(c));
      return c.json(scriptsJson(st));
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Presenter password (ADR-021). Managed from the owner's panel (session + CSRF). It is a separate secret from the
  // owner password: it unlocks approved scripts where no owner session exists and can never sign in.

  /** Audit entries written by the HTTP layer (never the password, never the token). */
  const auditEntry = async (
    c: Context<AppEnv>,
    action: string,
    target: string | null,
    result: "ok" | "denied",
    detail: Record<string, unknown> | null,
    actor: "owner" | "system",
  ) => {
    try {
      await s.storage.audit.append({
        workspaceId: DEFAULT_WORKSPACE_ID,
        id: s.ids.ulid(),
        at: s.clock.now(),
        actor,
        tokenId: null,
        action,
        target,
        ip: c.get("ip"),
        result,
        detail,
      });
    } catch (error) {
      s.logger.warn("audit write failed", { action, error: String(error) });
    }
  };

  api.get("/presenter/password", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    return c.json({ set: await s.auth.hasPresenterPassword() }, 200, {
      "Cache-Control": "no-store",
    });
  });

  api.post("/presenter/password", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const input = await body(c, presenterPasswordBody);
    if (input instanceof Response) return input;
    try {
      const change = await s.auth.setPresenterPassword(input.password);
      await auditEntry(
        c,
        change === "set" ? "presenter_password.set" : "presenter_password.change",
        null,
        "ok",
        null,
        "owner",
      );
      s.logger.info("presenter password updated", { change, requestId: c.get("requestId") });
      return c.json({ set: true, change }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof AuthError) return authErrorResponse(c, error);
      throw error;
    }
  });

  api.delete("/presenter/password", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    if (await s.auth.clearPresenterPassword()) {
      await auditEntry(c, "presenter_password.remove", null, "ok", { via: "panel" }, "owner");
      s.logger.info("presenter password removed", { requestId: c.get("requestId") });
    }
    return c.body(null, 204);
  });

  // The unlock (ADR-021): no owner session needed (this is what future presenter/public links call). Strict rate
  // limits (per IP with backoff, global and per deck), one scrypt verification and one deck read on every attempt
  // whatever the input (no timing oracle), and one generic failure for every reason. The token only upgrades a view
  // grant of this deck to its approved scripted document.
  api.post("/presenter/unlock", async (c) => {
    const ip = c.get("ip");
    const gate = s.limits.presenterUnlock.check(ip);
    if (!gate.ok) {
      return apiError(c, "RATE_LIMITED", "Too many unlock attempts", {
        retryAfterSec: retryAfter(gate.retryAfterMs),
      });
    }
    const input = await body(c, unlockBody);
    if (input instanceof Response) return input;
    const deckKey = ULID.test(input.deckId) ? input.deckId : "invalid";
    const deckGate = s.limits.presenterUnlockPerDeck.peek(deckKey);
    if (!deckGate.ok) {
      return apiError(c, "RATE_LIMITED", "Too many unlock attempts", {
        retryAfterSec: retryAfter(deckGate.retryAfterMs),
      });
    }
    const [epoch, digest] = await Promise.all([
      s.auth.verifyPresenterPassword(input.password),
      unlockableDigest(s, input.deckId),
    ]);
    if (epoch === null || digest === null) {
      s.limits.presenterUnlock.fail(ip);
      s.limits.presenterUnlockPerDeck.take(deckKey);
      await auditEntry(
        c,
        "presenter.unlock",
        ULID.test(input.deckId) ? `deck:${input.deckId}` : null,
        "denied",
        { reason: epoch === null ? "password" : "not_unlockable" },
        "system",
      );
      s.logger.warn("presenter unlock failed", { ip, requestId: c.get("requestId") });
      return apiError(c, "UNAUTHENTICATED", "Unlock failed", {
        hint: "Check the presenter password. Only presentations whose scripts the owner approved can be unlocked.",
      });
    }
    s.limits.presenterUnlock.succeed(ip);
    const { token, exp } = signUnlockToken(s, { deckId: input.deckId, digest, epoch });
    await auditEntry(
      c,
      "presenter.unlock",
      `deck:${input.deckId}`,
      "ok",
      { digest, expiresAt: exp },
      "system",
    );
    return c.json({ token, deckId: input.deckId, expiresAt: iso(exp) }, 200, {
      "Cache-Control": "no-store",
    });
  });

  api.all("*", (c) => apiError(c, "NOT_FOUND", "No such API route"));
  return api;
}
