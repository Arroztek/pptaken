// SPDX-License-Identifier: AGPL-3.0-or-later
// Remote control over HTTP (phase F4, ADR-0017). Owner routes (session + CSRF) create the live session of a deck
// and its short-lived screen ticket, pairing codes, and approve / remove / kick devices; the phone redeems a pairing
// code for a device credential and, once approved, reads the deck data (notes, titles, plan and a signed content
// URL for the slide previews) with that credential. Notes never travel on the socket, and never to a pending device.
//
// Mounted at `/` before the panel API router, whose catch-all would otherwise answer these paths.
import { networkInterfaces } from "node:os";
import { checkCsrf, signToken, verifyToken } from "@pptaken/auth-local";
import {
  DEFAULT_WORKSPACE_ID,
  type DeviceRecord,
  isDomainError,
  ownerPrincipal,
} from "@pptaken/core";
import { type DeviceInfo, presenceOf } from "@pptaken/realtime";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "./context.js";
import {
  apiError,
  contentOrigin,
  isJsonRequest,
  ownOrigin,
  publicOrigin,
  requestHost,
} from "./http.js";
import { CONTENT_DOC_TTL_MS } from "./routes-api.js";
import { presenterData } from "./routes-present.js";
import { ownerSession } from "./session.js";

/** Lifetime of a screen ticket: the player page fetches a fresh one before every socket connection. */
export const SCREEN_TICKET_TTL_MS = 60_000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const iso = (ms: number) => new Date(ms).toISOString();

const startBody = z.object({ deckId: z.string().max(40) }).strict();
const pairBody = z.object({ secret: z.string().max(64) }).strict();

/** Signs a screen ticket for a live session. */
export function screenTicket(s: Services, liveId: string): string {
  return signToken(s.liveKey, {
    purpose: "screen",
    subject: liveId,
    exp: s.clock.now() + SCREEN_TICKET_TTL_MS,
  });
}

/** The live session id named by a valid, unexpired screen ticket, or `null`. */
export function verifyScreenTicket(s: Services, ticket: string): string | null {
  const payload = ticket.split(".")[0];
  if (payload === undefined || !/^[A-Za-z0-9_-]{1,400}$/.test(payload)) return null;
  const parts = Buffer.from(payload, "base64url").toString("utf8").split("|");
  const liveId = parts.length === 4 ? parts[2] : undefined;
  if (liveId === undefined || !ULID.test(liveId)) return null;
  return verifyToken(s.liveKey, ticket, { purpose: "screen", subject: liveId, now: s.clock.now() })
    ? liveId
    : null;
}

/** A short, safe label for the device from its User-Agent ("Android · Chrome"). Never the raw header. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = (userAgent ?? "").slice(0, 512);
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "Device";
  const browser = /EdgA?\/|EdgiOS/.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /CriOS|Chrome\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "Browser";
  return `${os} · ${browser}`;
}

const toInfo = (d: DeviceRecord): DeviceInfo => ({
  id: d.id,
  label: d.label,
  code: d.code,
  status: d.status,
});

/** The stored, unrevoked devices of an active session, as the hub keeps them (empty when it ended). */
export async function deviceInfos(s: Services, liveId: string): Promise<DeviceInfo[]> {
  try {
    return (await s.live.devices(ownerPrincipal(DEFAULT_WORKSPACE_ID), liveId)).map(toInfo);
  } catch {
    return [];
  }
}

/** IPv4 LAN addresses of this machine, as origins with the port the request used. */
export function lanOrigins(proto: "http" | "https", port: string): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || a.family !== "IPv4") continue;
      if (a.address.startsWith("169.254.")) continue; // link-local: not reachable from a phone in practice
      out.push(`${proto}://${a.address}${port === "" ? "" : `:${port}`}`);
    }
  }
  return [...new Set(out)];
}

export function liveRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const owner = ownerPrincipal(DEFAULT_WORKSPACE_ID);

  /** Pushes the stored device list of a session to its room (the screen's presence). */
  const syncDevices = async (liveId: string): Promise<void> => {
    s.hub.dispatch(liveId, { kind: "devices", devices: await deviceInfos(s, liveId) });
  };

  // Rate limit, CSRF on state-changing methods, JSON bodies only.
  app.use("/api/v1/live/*", guard);
  app.use("/api/v1/live", guard);
  app.use("/api/v1/remote/*", guard);
  async function guard(
    c: Context<AppEnv>,
    next: () => Promise<void>,
  ): Promise<Response | undefined> {
    const rl = s.limits.apiPerIp.take(c.get("ip"));
    if (!rl.ok) {
      return apiError(c, "RATE_LIMITED", "Too many requests", {
        retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
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
    if (c.req.method === "POST" && c.req.header("content-length") !== "0") {
      const hasBody =
        c.req.header("content-length") !== undefined ||
        c.req.header("transfer-encoding") !== undefined;
      if (hasBody && !isJsonRequest(c)) {
        return apiError(c, "VALIDATION_ERROR", "The request body must be JSON", {
          hint: "Send Content-Type: application/json.",
        });
      }
    }
    c.header("Cache-Control", "no-store");
    await next();
    return undefined;
  }

  async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | Response> {
    let raw: unknown;
    try {
      const text = await c.req.text();
      raw = text === "" ? {} : JSON.parse(text);
    } catch {
      return apiError(c, "VALIDATION_ERROR", "The request body is not valid JSON");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return apiError(c, "VALIDATION_ERROR", "Invalid request body");
    return parsed.data;
  }

  async function requireOwner(c: Context): Promise<Response | null> {
    if (await ownerSession(c, s)) return null;
    if (!(await s.auth.isInstalled())) {
      return apiError(c, "SETUP_REQUIRED", "Nobody has set up this instance yet", {
        hint: "Open /welcome to set it up.",
      });
    }
    return apiError(c, "UNAUTHENTICATED", "Sign in first");
  }

  function domainError(c: Context, error: unknown): Response {
    if (isDomainError(error)) {
      if (error.code === "NOT_FOUND") return apiError(c, "NOT_FOUND", error.message);
      if (error.code === "VALIDATION_ERROR") return apiError(c, "VALIDATION_ERROR", error.message);
      if (error.code === "FORBIDDEN_ACTOR" || error.code === "FORBIDDEN_SCOPE")
        return apiError(c, "FORBIDDEN", error.message);
    }
    throw error;
  }

  const liveId = (c: Context): string | null => {
    const id = c.req.param("id");
    return id !== undefined && ULID.test(id) ? id : null;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Owner

  app.get("/api/v1/live", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const deckId = c.req.query("deck") ?? "";
    if (!ULID.test(deckId))
      return apiError(c, "VALIDATION_ERROR", "deck must be a presentation id");
    const session = await s.live.active(owner, deckId);
    if (session === null) return c.json({ live: null });
    const devices = await s.live.devices(owner, session.id);
    return c.json({
      live: {
        id: session.id,
        deckId: session.deckId,
        revision: session.revision,
        expiresAt: iso(session.expiresAt),
        devices: devices.length,
      },
    });
  });

  app.post("/api/v1/live", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const input = await body(c, startBody);
    if (input instanceof Response) return input;
    const deck = ULID.test(input.deckId)
      ? await s.storage.decks.get(DEFAULT_WORKSPACE_ID, input.deckId)
      : null;
    if (deck === null || deck.deletedAt !== null) {
      return apiError(c, "NOT_FOUND", "Presentation not found");
    }
    try {
      const { session, created } = await s.live.start(
        owner,
        { deckId: deck.id, revision: deck.currentRevision },
        { ip: c.get("ip"), requestId: c.get("requestId") },
      );
      const devices = await s.live.devices(owner, session.id);
      return c.json(
        {
          live: {
            id: session.id,
            deckId: session.deckId,
            revision: session.revision,
            expiresAt: iso(session.expiresAt),
            devices: devices.length,
          },
          screenTicket: screenTicket(s, session.id),
          publicUrl: s.config.publicUrl,
        },
        created ? 201 : 200,
      );
    } catch (error) {
      return domainError(c, error);
    }
  });

  app.get("/api/v1/live/lan", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const host = requestHost(c);
    const m = /:(\d{1,5})$/.exec(host.startsWith("[") ? host.slice(host.indexOf("]")) : host);
    const proto = ownOrigin(c, s.config).startsWith("https:") ? "https" : "http";
    return c.json({ addresses: lanOrigins(proto, m?.[1] ?? "") });
  });

  app.post("/api/v1/live/:id/pairing", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = liveId(c);
    if (id === null) return apiError(c, "NOT_FOUND", "Live session not found");
    try {
      const r = await s.live.createPairing(owner, id);
      return c.json({ secret: r.secret, expiresAt: iso(r.expiresAt), path: "/r" }, 201);
    } catch (error) {
      return domainError(c, error);
    }
  });

  app.get("/api/v1/live/:id/devices", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = liveId(c);
    if (id === null) return apiError(c, "NOT_FOUND", "Live session not found");
    try {
      const list = (await s.live.devices(owner, id)).map(toInfo);
      const room = s.hub.state(id);
      const devices = presenceOf({
        screen: room?.screen ?? null,
        connections: room?.connections ?? [],
        snapshot: null,
        devices: list,
      });
      return c.json({ devices });
    } catch (error) {
      return domainError(c, error);
    }
  });

  app.post("/api/v1/live/:id/devices/:device/approve", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = liveId(c);
    const device = c.req.param("device");
    if (id === null || !ULID.test(device)) return apiError(c, "NOT_FOUND", "Device not found");
    try {
      await s.live.approve(owner, id, device, { ip: c.get("ip"), requestId: c.get("requestId") });
      s.hub.dispatch(id, { kind: "approve", deviceId: device });
      return c.body(null, 204);
    } catch (error) {
      return domainError(c, error);
    }
  });

  app.delete("/api/v1/live/:id/devices/:device", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = liveId(c);
    const device = c.req.param("device");
    if (id === null || !ULID.test(device)) return apiError(c, "NOT_FOUND", "Device not found");
    try {
      const revoked = await s.live.revoke(owner, id, [device], {
        ip: c.get("ip"),
        requestId: c.get("requestId"),
      });
      if (revoked.length === 0) return apiError(c, "NOT_FOUND", "Device not found");
      s.hub.dispatch(id, { kind: "revoke", deviceIds: revoked });
      return c.body(null, 204);
    } catch (error) {
      return domainError(c, error);
    }
  });

  app.post("/api/v1/live/:id/kick", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = liveId(c);
    if (id === null) return apiError(c, "NOT_FOUND", "Live session not found");
    try {
      const revoked = await s.live.revoke(owner, id, "all", {
        ip: c.get("ip"),
        requestId: c.get("requestId"),
      });
      s.hub.dispatch(id, { kind: "revoke", deviceIds: "all" });
      s.logger.info("remotes kicked", { liveId: id, devices: revoked.length });
      return c.json({ revoked: revoked.length });
    } catch (error) {
      return domainError(c, error);
    }
  });

  app.delete("/api/v1/live/:id", async (c) => {
    const denied = await requireOwner(c);
    if (denied) return denied;
    const id = liveId(c);
    if (id === null) return apiError(c, "NOT_FOUND", "Live session not found");
    try {
      await s.live.end(owner, id, { ip: c.get("ip"), requestId: c.get("requestId") });
      s.hub.dispatch(id, { kind: "end" });
      return c.body(null, 204);
    } catch (error) {
      return domainError(c, error);
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Phone

  app.post("/api/v1/remote/pair", async (c) => {
    const ip = c.get("ip");
    const perIp = s.limits.pairPerIp.take(ip);
    const global = s.limits.pairFailures.peek("all");
    if (!perIp.ok || !global.ok) {
      return apiError(c, "RATE_LIMITED", "Too many pairing attempts", {
        retryAfterSec: Math.ceil(Math.max(perIp.retryAfterMs, global.retryAfterMs) / 1000),
      });
    }
    const input = await body(c, pairBody);
    if (input instanceof Response) return input;
    try {
      const r = await s.live.redeem(
        { secret: input.secret, label: deviceLabel(c.req.header("user-agent")) },
        { ip, requestId: c.get("requestId") },
      );
      await syncDevices(r.session.id);
      s.logger.info("remote paired", { liveId: r.session.id, deviceId: r.device.id });
      return c.json(
        {
          credential: r.credential,
          deviceId: r.device.id,
          liveId: r.session.id,
          code: r.device.code,
          label: r.device.label,
          expiresAt: iso(r.device.expiresAt),
        },
        201,
      );
    } catch (error) {
      if (isDomainError(error) && error.code === "NOT_FOUND") {
        s.limits.pairFailures.take("all");
        s.logger.warn("pairing refused", { ip, requestId: c.get("requestId") });
        return apiError(c, "UNAUTHENTICATED", "This pairing code expired or was already used", {
          hint: "Press R on the presenter's laptop for a new code.",
        });
      }
      if (isDomainError(error) && error.code === "LIMIT_EXCEEDED") {
        return apiError(c, "FORBIDDEN", "Two remotes are already paired with this presentation", {
          hint: "Remove a paired remote on the laptop first.",
        });
      }
      throw error;
    }
  });

  // Deck data for an APPROVED device: titles, plan, notes (rendered by renderNotes) and a signed content URL of
  // the session's revision for the slide previews. Credential in the Authorization header, never in the URL.
  app.get("/api/v1/remote/deck", async (c) => {
    const m = /^Device ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
    const resolved = m ? await s.live.resolveDevice(m[1]) : null;
    if (resolved === null) return apiError(c, "UNAUTHENTICATED", "Unknown or revoked device");
    if (resolved.device.status !== "approved") {
      return apiError(c, "FORBIDDEN", "This device is waiting for approval on the laptop");
    }
    const { session } = resolved;
    const data = await presenterData(s, session.deckId, session.revision);
    if (data === null) return apiError(c, "NOT_FOUND", "Presentation not found");
    const token = signToken(s.contentKey, {
      purpose: "doc",
      subject: `${session.deckId}:${session.revision}`,
      exp: s.clock.now() + CONTENT_DOC_TTL_MS,
    });
    return c.json({
      liveId: session.id,
      ...data,
      contentUrl: `${contentOrigin(c, s.config)}/c/${session.deckId}/${session.revision}?ct=${token}`,
    });
  });

  return app;
}
