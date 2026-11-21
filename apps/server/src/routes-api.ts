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
  type ScriptErrorView,
  type ScriptsStatus,
  type ShareLinkView,
  scriptsDigest,
  scriptsStateOf,
  scriptWarnings,
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
} from "./presenter-unlock.js";
import { publicLinksOn, verifyGuestGrant } from "./public-links.js";
import { presenterData } from "./routes-present.js";
import { clearSessionCookie, ownerSession, readSessionId, setSessionCookie } from "./session.js";

/** Lifetime of the signed URL of a deck document (the shell loads it right away). */
export const CONTENT_DOC_TTL_MS = 5 * 60 * 1000;

/** Lifetime of the signed URL of a cover (the grid view loads them as the cards come into view). */
export const COVER_URL_TTL_MS = 30 * 60 * 1000;
/** Most decks one covers request may ask for (a page of the list is 20). */
const MAX_COVER_IDS = 24;

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
/** Script error reports (ADR-023): entries are validated one by one by the core (bad ones are dropped). */
const scriptErrorsBody = z
  .object({ digest: z.string().regex(/^[0-9a-f]{64}$/), errors: z.array(z.unknown()).max(50) })
  .strict();
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
      // ADR-023: distinct errors reported for the current code (the list shows an amber badge).
      scriptErrors:
        digest === null
          ? 0
          : (await s.storage.scriptErrors.list(DEFAULT_WORKSPACE_ID, id)).filter(
              (e) => e.digest === digest,
            ).length,
      // ADR-026: how many public links are active (the list shows one quiet "Shared" chip).
      sharedLinks: await s.storage.shareLinks.countActive(DEFAULT_WORKSPACE_ID, s.clock.now(), id),
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
    const trashed = c.req.query("trash") === "1";
    try {
      const page = await s.core.listPresentations(
        owner,
        {
          limit: 20,
          ...(cursor === undefined ? {} : { cursor }),
          ...(q === undefined ? {} : { query: q }),
          ...(trashed ? { trashed: true } : {}),
        },
        { ip: c.get("ip"), requestId: c.get("requestId") },
      );
      if (trashed) {
        // The trash (owner only): what is there, when it went and until when it can come back.
        const retention = s.core.config.trashRetentionMs;
        const decks = [];
        for (const item of page.items) {
          // ADR-026: links the trash turned off, which the owner may turn back on when restoring.
          const links = await s.core.countShareLinks(owner, {
            presentationId: item.presentationId,
          });
          decks.push({
            id: item.presentationId,
            title: item.title,
            lang: item.lang,
            slideCount: item.slideCount,
            revision: item.revision,
            updatedAt: iso(item.updatedAt),
            deletedAt: iso(item.deletedAt),
            restorableUntil: iso((item.deletedAt ?? item.updatedAt) + retention),
            linksOff: links.turnedOffByTrash,
          });
        }
        return c.json(
          {
            decks,
            nextCursor: page.nextCursor,
          },
          200,
          { "Cache-Control": "no-store" },
        );
      }
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

  // The cover URLs of a page of decks in one call (the panel's grid view): the first slide of the current revision as
  // a static, script-free thumbnail document on the content origin (docs/spec/player.md, cover mode). Owner session
  // only (never an API or OAuth token, never a view grant). Side-effect free: it only signs. Decks that are not
  // there (trashed, unknown) or have no slide are left out; the panel then shows its fallback cover. The URL carries
  // a "cover" token bound to this revision: it opens that first slide and nothing else.
  api.get("/decks/covers", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const ids = [
      ...new Set(
        (c.req.query("ids") ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x !== ""),
      ),
    ];
    if (ids.length === 0 || ids.length > MAX_COVER_IDS || !ids.every((id) => ULID.test(id))) {
      return apiError(c, "VALIDATION_ERROR", `ids: 1 to ${MAX_COVER_IDS} presentation ids`);
    }
    const now = s.clock.now();
    const exp = now + COVER_URL_TTL_MS;
    const origin = contentOrigin(c, s.config);
    const covers = [];
    for (const id of ids) {
      const deck = await s.storage.decks.get(DEFAULT_WORKSPACE_ID, id);
      if (deck === null || deck.deletedAt !== null) continue;
      const revision = await s.storage.revisions.get(
        DEFAULT_WORKSPACE_ID,
        id,
        deck.currentRevision,
      );
      if (revision === null || revision.document.slides.length === 0) continue;
      const token = signToken(s.contentKey, {
        purpose: "cover",
        subject: `${id}:${deck.currentRevision}`,
        exp,
      });
      covers.push({
        id,
        revision: deck.currentRevision,
        url: `${origin}/c/${id}/${deck.currentRevision}/cover?ct=${token}`,
        ...canvasSize(revision.document.aspectRatio),
        expiresAt: iso(exp),
      });
    }
    return c.json({ covers }, 200, { "Cache-Control": "no-store" });
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

  // ---------------------------------------------------------------------------------------------------------------
  // Trash (ADR-014): the owner moves a presentation to the trash, restores it within the retention, or deletes it
  // for good. Panel session + CSRF only; every step is audited by the core use cases.

  api.delete("/decks/:id", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    try {
      const r = await s.core.trashPresentation(owner, { presentationId: id }, callOf(c));
      return c.json({
        id: r.presentationId,
        trashed: true,
        restorableUntil: iso(r.restorableUntil),
        linksTurnedOff: r.linksTurnedOff,
      });
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  api.post("/decks/:id/restore", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    // ADR-026: the deck's links stay off unless the owner confirmed turning them back on.
    const input = await body(c, z.object({ restoreLinks: z.boolean().optional() }).strict());
    if (input instanceof Response) return input;
    try {
      await s.core.restorePresentation(
        owner,
        { presentationId: id, restoreLinks: input.restoreLinks === true },
        callOf(c),
      );
      const sum = await summary(id);
      if (sum === null) return apiError(c, "NOT_FOUND", "Presentation not found");
      return c.json(sum);
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  api.delete("/trash/:id", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    try {
      await s.core.purgePresentation(owner, { presentationId: id }, callOf(c));
      return c.body(null, 204);
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Owner settings (ADR-024). Only the panel session reaches this router; agents have no way to read or change it.

  const settingsBody = z
    .object({ autoApproveUpdates: z.boolean().optional(), publicLinks: z.boolean().optional() })
    .strict();

  const settingsJson = async () => ({
    autoApproveUpdates: await s.auth.autoApproveUpdates(),
    scripts: s.config.scripts,
    // ADR-026: the owner's switch, and the operator's (which wins: when it is off, links never work).
    publicLinks: await s.auth.publicLinksAllowed(),
    publicLinksInstance: s.config.publicLinks ? "on" : "off",
  });

  api.get("/settings", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    return c.json(await settingsJson(), 200, { "Cache-Control": "no-store" });
  });

  api.put("/settings", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const input = await body(c, settingsBody);
    if (input instanceof Response) return input;
    if (input.autoApproveUpdates !== undefined) {
      await s.auth.setAutoApproveUpdates(input.autoApproveUpdates);
      await auditEntry(
        c,
        "settings.auto_approve_updates",
        null,
        "ok",
        { on: input.autoApproveUpdates },
        "owner",
      );
    }
    if (input.publicLinks !== undefined) {
      await s.auth.setPublicLinksAllowed(input.publicLinks);
      await auditEntry(c, "settings.public_links", null, "ok", { on: input.publicLinks }, "owner");
    }
    return c.json(await settingsJson(), 200, { "Cache-Control": "no-store" });
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
    // ADR-026: a guest grant whose link still works now. When a page sends one, it is a link page and gets the
    // link's semantics even if the browser also holds the owner's session (the owner opening their own view link
    // sees what viewers see: static, the frozen revision, no notes).
    const viewHeader = c.req.header(VIEW_HEADER);
    const guest =
      viewHeader === undefined || viewHeader === ""
        ? null
        : await verifyGuestGrant(s, viewHeader, id);
    const owned = guest === null && (await ownerSession(c, s)) !== null;
    if (!owned && guest === null) {
      const denied = await requireOwner(c);
      if (denied) return denied;
    }
    if (guest?.linkId) {
      const rl = s.limits.sharePerLink.take(guest.linkId);
      if (!rl.ok) {
        return apiError(c, "RATE_LIMITED", "Too many requests", {
          retryAfterSec: retryAfter(rl.retryAfterMs),
        });
      }
    }
    const sum = ULID.test(id) ? await summary(id) : null;
    if (sum === null) return apiError(c, "NOT_FOUND", "Presentation not found");
    // A link frozen on a revision shows that revision; everyone else the current one.
    const revisionNumber = guest?.revision ?? sum.revision;
    const safe = c.req.query("safe") === "1";
    let document: Deck;
    try {
      ({ document } = await s.core.getRevision(owner, {
        presentationId: id,
        revision: revisionNumber,
      }));
    } catch (error) {
      return domainErrorResponse(c, error);
    }
    const digest = scriptsDigest(document);
    let scripts: "running" | "none" | "off" | "pending" | "safe" | "locked" = "none";
    const unlock = owned ? undefined : c.req.header(UNLOCK_HEADER);
    let unlockRejected = false;
    if (digest !== null && guest?.kind === "view") {
      // A view link never runs author scripts and never offers an unlock: it just shows the simple version.
      scripts = "none";
    } else if (digest !== null) {
      const approval = await s.storage.scriptApprovals.get(DEFAULT_WORKSPACE_ID, id);
      if (s.config.scripts !== "owner") scripts = "off";
      else if (approval?.digest !== digest) scripts = "pending";
      else if (safe) scripts = "safe";
      else if (owned) scripts = "running";
      // ADR-024: automatic approvals never reach guest contexts; a guest only runs code the owner clicked for.
      else if (approval.ownerDigest !== digest) scripts = "pending";
      else if (await verifyUnlockToken(s, unlock, id, digest, guest?.linkId ?? "test")) {
        scripts = "running";
      } else scripts = "locked";
    }
    // A guest's unlock token that no longer works (edited deck, revoked, password changed, expired): say so, so
    // the page forgets it and can offer the unlock again.
    if (
      guest?.kind === "presenter" &&
      unlock !== undefined &&
      unlock !== "" &&
      scripts !== "running" &&
      !safe
    ) {
      unlockRejected = true;
    }
    const extra = unlockRejected ? { unlockRejected: true } : {};
    const exp = s.clock.now() + CONTENT_DOC_TTL_MS;
    // Public links get link-bound document tokens: the content route re-checks the link on every request.
    const linkId = guest?.linkId ?? null;
    const token =
      scripts === "running"
        ? signToken(s.contentKey, {
            purpose: linkId === null ? "sdoc" : "lsdoc",
            subject: `${id}:${revisionNumber}:${digest}${linkId === null ? "" : `:${linkId}`}`,
            exp,
          })
        : signToken(s.contentKey, {
            purpose: linkId === null ? "doc" : "ldoc",
            subject: `${id}:${revisionNumber}${linkId === null ? "" : `:${linkId}`}`,
            exp,
          });
    const url = `${contentOrigin(c, s.config)}/c/${id}/${revisionNumber}?ct=${token}`;
    if (scripts !== "running")
      return c.json({ url, scripts, ...extra }, 200, { "Cache-Control": "no-store" });
    const canvas = canvasSize(document.aspectRatio);
    return c.json(
      {
        url,
        scripts,
        expect: { slides: document.slides.map((x) => x.id), ...canvas },
        // ADR-023: the owner's page reports script errors against this digest (guests never report).
        ...(owned ? { digest } : {}),
      },
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
    // ADR-024: how the approval was given, what needs a click, and what an automatic approval replaced.
    approvalMode: st.approvalMode,
    ownerApproved: st.ownerApproved,
    newLibs: st.newLibs,
    previousRevision: st.previousRevision,
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
      let checks: {
        code: string;
        message: string;
        path: string | null;
        slideId: string | null;
      }[] = [];
      if (review.digest !== null) {
        const { document } = await s.core.getRevision(owner, {
          presentationId: id,
          revision: review.revision,
        });
        // ADR-023: the static check of the scripts (syntax errors, a bare `root`, blocked APIs).
        checks = scriptWarnings(document)
          .slice(0, MAX_REVIEW_WARNINGS)
          .map((w) => ({
            code: w.code,
            message: w.message,
            path: w.path ?? null,
            slideId: w.slideId ?? null,
          }));
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
          previous: review.previous,
          warnings,
          checks,
          presenterPassword: { set: await s.auth.hasPresenterPassword() },
          autoApproveUpdates: await s.auth.autoApproveUpdates(),
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
  // Script error visibility (ADR-023). The owner's player page reports author-script failures; the panel reads and
  // clears them. Panel session only (this router never accepts API or OAuth tokens), CSRF + same-origin on POST and
  // DELETE, a small body limit (app.ts), rate limits per IP and per deck, and the core ignores reports unless the
  // deck's current digest is approved and equals the digest the page was served with.

  const errorJson = (e: ScriptErrorView) => ({
    kind: e.kind,
    slideId: e.slideId,
    slideTitle: e.slideTitle,
    slideIndex: e.slideIndex,
    name: e.name,
    message: e.message,
    stack: e.stack,
    count: e.count,
    firstSeen: iso(e.firstSeen),
    lastSeen: iso(e.lastSeen),
    hint: e.hint,
  });

  /** Browsers say where a request came from; anything but our own page is refused (defense in depth). */
  const crossSite = (c: Context) => {
    const site = c.req.header("sec-fetch-site");
    return site !== undefined && site !== "same-origin";
  };

  api.post("/decks/:id/script-errors", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    if (crossSite(c)) return apiError(c, "FORBIDDEN", "Cross-site request refused");
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    for (const [limiter, key] of [
      [s.limits.scriptErrorsPerIp, c.get("ip")],
      [s.limits.scriptErrorsPerDeck, id],
    ] as const) {
      const rl = limiter.take(key);
      if (!rl.ok) {
        return apiError(c, "RATE_LIMITED", "Too many script error reports", {
          retryAfterSec: retryAfter(rl.retryAfterMs),
        });
      }
    }
    const input = await body(c, scriptErrorsBody);
    if (input instanceof Response) return input;
    try {
      const result = await s.core.reportScriptErrors(
        owner,
        { presentationId: id, digest: input.digest, errors: input.errors },
        callOf(c),
      );
      return c.json(result, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  api.get("/decks/:id/script-errors", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    try {
      const r = await s.core.getScriptErrors(owner, { presentationId: id }, callOf(c));
      const approval = await s.storage.scriptApprovals.get(DEFAULT_WORKSPACE_ID, id);
      return c.json(
        {
          presentationId: r.presentationId,
          revision: r.revision,
          digest: r.digest,
          state: r.state,
          status: r.status,
          approvedAt: r.state === "approved" ? iso(approval?.approvedAt ?? null) : null,
          current: r.current.map(errorJson),
          previous: r.previous.map(errorJson),
          previousDigest: r.previousDigest,
        },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  api.delete("/decks/:id/script-errors", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    if (crossSite(c)) return apiError(c, "FORBIDDEN", "Cross-site request refused");
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    try {
      await s.core.clearScriptErrors(owner, { presentationId: id }, callOf(c));
      return c.body(null, 204);
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
    // ADR-026: only a PRESENTER link's page can unlock (its grant travels in X-PPTaken-View); a view link, a dead
    // link or no grant at all fails like a wrong password, after the same work.
    const [epoch, grant] = await Promise.all([
      s.auth.verifyPresenterPassword(input.password),
      verifyGuestGrant(s, c.req.header(VIEW_HEADER), input.deckId),
    ]);
    const presenter = grant?.kind === "presenter" ? grant : null;
    const digest = await unlockableDigest(s, input.deckId, {
      guest: true,
      revision: presenter?.revision ?? null,
    });
    if (epoch === null || digest === null || presenter === null) {
      s.limits.presenterUnlock.fail(ip);
      s.limits.presenterUnlockPerDeck.take(deckKey);
      await auditEntry(
        c,
        "presenter.unlock",
        ULID.test(input.deckId) ? `deck:${input.deckId}` : null,
        "denied",
        {
          reason:
            presenter === null
              ? "no_presenter_link"
              : epoch === null
                ? "password"
                : "not_unlockable",
          ...(presenter?.linkId ? { link: presenter.linkId } : {}),
        },
        "system",
      );
      s.logger.warn("presenter unlock failed", { ip, requestId: c.get("requestId") });
      return apiError(c, "UNAUTHENTICATED", "Unlock failed", {
        hint: "Check the presenter password. Only presentations whose scripts the owner approved can be unlocked.",
      });
    }
    s.limits.presenterUnlock.succeed(ip);
    const linkId = presenter.linkId ?? "test";
    const { token, exp } = signUnlockToken(s, { deckId: input.deckId, digest, epoch, linkId });
    await auditEntry(
      c,
      "presenter.unlock",
      `deck:${input.deckId}`,
      "ok",
      { digest, expiresAt: exp, ...(presenter.linkId ? { link: presenter.linkId } : {}) },
      "system",
    );
    return c.json({ token, deckId: input.deckId, expiresAt: iso(exp) }, 200, {
      "Cache-Control": "no-store",
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Public links (ADR-026). Management: owner session + CSRF only (this router never accepts API or OAuth tokens, and
  // the core refuses any actor but the owner). Every change is audited by link id; answers carry the link URL (the
  // secret) only to the owner, never IPs or user agents.

  const linkBody = z
    .object({
      kind: z.enum(["view", "presenter"]),
      label: z.string().max(400).optional(),
      expires: z.string().max(40).nullable().optional(),
      pinRevision: z.boolean().optional(),
    })
    .strict();
  const linkPatchBody = z
    .object({
      label: z.string().max(400).optional(),
      expires: z.string().max(40).nullable().optional(),
      pinned: z.boolean().optional(),
    })
    .strict();

  /** `null` (never), `1d`/`7d`/`30d`, or an ISO date-time; `undefined` when absent; a Response when invalid. */
  const expiryOf = (
    c: Context,
    value: string | null | undefined,
  ): number | null | undefined | Response => {
    if (value === undefined) return undefined;
    if (value === null || value === "never") return null;
    const preset = /^(1|7|30)d$/.exec(value);
    if (preset !== null) return s.clock.now() + Number(preset[1]) * 24 * 60 * 60 * 1000;
    const at = Date.parse(value);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(at)) {
      return apiError(
        c,
        "VALIDATION_ERROR",
        'expires: null, "1d", "7d", "30d" or an ISO date-time',
      );
    }
    return at;
  };

  const linkJson = (c: Context, l: ShareLinkView) => ({
    id: l.id,
    kind: l.kind,
    label: l.label,
    url: l.secret === null ? null : `${publicOrigin(c, s.config)}/s/${l.secret}`,
    state: l.state,
    createdAt: iso(l.createdAt),
    expiresAt: iso(l.expiresAt),
    pinnedRevision: l.pinnedRevision,
    lastOpenedAt: iso(l.lastOpenedAt),
    openCount: l.openCount,
  });

  /** What the Share panel needs to explain itself: whether links work and whether a presenter password exists. */
  const sharingState = async () => ({
    enabled: await publicLinksOn(s),
    instance: s.config.publicLinks ? ("on" as const) : ("off" as const),
    owner: (await s.auth.publicLinksAllowed()) ? ("on" as const) : ("off" as const),
    presenterPassword: await s.auth.hasPresenterPassword(),
    scripts: s.config.scripts,
  });

  api.get("/decks/:id/links", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    try {
      const links = await s.core.listShareLinks(owner, { presentationId: id }, callOf(c));
      return c.json(
        { links: links.map((l) => linkJson(c, l)), sharing: await sharingState() },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (error) {
      return domainErrorResponse(c, error);
    }
  });

  api.post("/decks/:id/links", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    if (!(await publicLinksOn(s))) {
      return apiError(c, "FORBIDDEN", "Public links are turned off", {
        hint: s.config.publicLinks
          ? "Turn on public links in Settings."
          : "Whoever runs this server must set PPTAKEN_PUBLIC_LINKS=on.",
      });
    }
    const input = await body(c, linkBody);
    if (input instanceof Response) return input;
    const expiresAt = expiryOf(c, input.expires);
    if (expiresAt instanceof Response) return expiresAt;
    try {
      const link = await s.core.createShareLink(
        owner,
        {
          presentationId: id,
          kind: input.kind,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(input.pinRevision === undefined ? {} : { pinRevision: input.pinRevision }),
        },
        callOf(c),
      );
      s.logger.info("public link created", { linkId: link.id, requestId: c.get("requestId") });
      return c.json({ link: linkJson(c, link) }, 201, { "Cache-Control": "no-store" });
    } catch (error) {
      return linkErrorResponse(c, error);
    }
  });

  api.patch("/decks/:id/links/:linkId", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const linkId = c.req.param("linkId");
    if (!ULID.test(id) || !ULID.test(linkId)) return apiError(c, "NOT_FOUND", "Link not found");
    const input = await body(c, linkPatchBody);
    if (input instanceof Response) return input;
    const expiresAt = expiryOf(c, input.expires);
    if (expiresAt instanceof Response) return expiresAt;
    try {
      const link = await s.core.updateShareLink(
        owner,
        {
          presentationId: id,
          linkId,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(input.pinned === undefined
            ? {}
            : { pinnedRevision: input.pinned ? ("current" as const) : null }),
        },
        callOf(c),
      );
      return c.json({ link: linkJson(c, link) }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      return linkErrorResponse(c, error);
    }
  });

  api.delete("/decks/:id/links/:linkId", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const linkId = c.req.param("linkId");
    if (!ULID.test(id) || !ULID.test(linkId)) return apiError(c, "NOT_FOUND", "Link not found");
    try {
      await s.core.revokeShareLink(owner, { presentationId: id, linkId }, callOf(c));
      s.logger.info("public link turned off", { linkId, requestId: c.get("requestId") });
      return c.body(null, 204);
    } catch (error) {
      return linkErrorResponse(c, error);
    }
  });

  api.delete("/decks/:id/links", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!ULID.test(id)) return apiError(c, "NOT_FOUND", "Presentation not found");
    try {
      const r = await s.core.revokeAllShareLinks(owner, { presentationId: id }, callOf(c));
      return c.json(r, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      return linkErrorResponse(c, error);
    }
  });

  function linkErrorResponse(c: Context, error: unknown): Response {
    if (isDomainError(error) && error.code === "LIMIT_EXCEEDED") {
      return apiError(c, "VALIDATION_ERROR", error.message, { hint: error.hint, status: 409 });
    }
    if (isDomainError(error) && error.code === "NOT_FOUND") {
      return apiError(c, "NOT_FOUND", error.message, { hint: error.hint });
    }
    return domainErrorResponse(c, error);
  }

  // Guest side (no session): the page of a public link counts one opening, and a presenter link's presenter window
  // reads the notes. Both need the link grant (X-PPTaken-View) of a link that works NOW; anything else is one
  // generic 404. CSRF: the same-origin check above applies (the guest page sends the header; no cookie is used).
  const guestGone = (c: Context) => apiError(c, "NOT_FOUND", "This link is not available");

  api.post("/share/:deckId/opened", async (c) => {
    const deckId = c.req.param("deckId");
    const grant = await verifyGuestGrant(s, c.req.header(VIEW_HEADER), deckId);
    if (grant === null || grant.linkId === null) return guestGone(c);
    const rl = s.limits.sharePerLink.take(grant.linkId);
    if (!rl.ok) {
      return apiError(c, "RATE_LIMITED", "Too many requests", {
        retryAfterSec: retryAfter(rl.retryAfterMs),
      });
    }
    await s.core.recordShareLinkOpen(DEFAULT_WORKSPACE_ID, grant.linkId);
    return c.body(null, 204);
  });

  api.get("/share/:deckId/presenter", async (c) => {
    const deckId = c.req.param("deckId");
    const grant = await verifyGuestGrant(s, c.req.header(VIEW_HEADER), deckId);
    // Speaker notes: presenter links only (a view link's grant gets the same 404 as a dead link).
    if (grant === null || grant.kind !== "presenter") return guestGone(c);
    if (grant.linkId !== null) {
      const rl = s.limits.sharePerLink.take(grant.linkId);
      if (!rl.ok) {
        return apiError(c, "RATE_LIMITED", "Too many requests", {
          retryAfterSec: retryAfter(rl.retryAfterMs),
        });
      }
    }
    const data = await presenterData(s, deckId, grant.revision ?? undefined);
    if (data === null) return guestGone(c);
    const interactive =
      (await unlockableDigest(s, deckId, { guest: true, revision: grant.revision })) !== null;
    return c.json({ ...data, ...(interactive ? { interactive } : {}) }, 200, {
      "Cache-Control": "no-store",
    });
  });

  api.all("*", (c) => apiError(c, "NOT_FOUND", "No such API route"));
  return api;
}
