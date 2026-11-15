// SPDX-License-Identifier: AGPL-3.0-or-later
// The `/ws` endpoint (phase F4, ADR-0017): the `ws` package in noServer mode on the Node server's `upgrade` event
// (@hono/node-server 2.1.8 has no upgrade hook). An upgrade bypasses every Hono middleware, so the controls are
// re-applied here by hand with the request-agnostic helpers of http.ts: allowed Host (DNS rebinding, T14), content
// origin separation, same-origin `Origin`, client IP, a connection cap per IP, path-only logging.
//
// Each socket: maxPayload 1 KB (larger frames close it with 1009), no compression, the first frame must be `auth`
// within 5 s (cookies are never used on the socket), strict validation of every frame per role, per-connection
// token buckets (excess dropped silently), an idle timeout, and the hub for everything else.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { DEFAULT_WORKSPACE_ID, ownerPrincipal } from "@pptaken/core";
import {
  ALLOWED,
  AUTH_TIMEOUT_MS,
  CLOSE,
  decodeFrame,
  MAX_FRAME_BYTES,
  PING_INTERVAL_MS,
  parseClientFrame,
  RATES,
  type Role,
  TokenBucket,
} from "@pptaken/realtime";
import { type WebSocket, WebSocketServer } from "ws";
import type { Services } from "./context.js";
import { clientIpFrom, isAllowedHost, isSameOrigin, protoFrom } from "./http.js";
import { deviceInfos, verifyScreenTicket } from "./routes-live.js";

/** Sockets per client IP (security §7). */
export const MAX_SOCKETS_PER_IP = 20;
/** Sockets in total (a single-presenter instance needs a handful). */
export const MAX_SOCKETS = 500;
/** Invalid frames tolerated on one socket before it is closed (1008). */
const MAX_INVALID = 20;
/** No frame at all for this long (clients ping every 10 s): the socket is dead. */
const IDLE_MS = PING_INTERVAL_MS * 3 + 5000;

export interface RealtimeOptions {
  /** Remote address of a raw request (the Node socket). */
  socketIp?: (req: IncomingMessage) => string | undefined;
}

export interface RealtimeServer {
  /** Handles `upgrade` events of a Node HTTP server. Returns a function that detaches it. */
  attach(server: Server): () => void;
  /** Closes every socket (1001 going away) and stops accepting new ones. */
  close(): void;
  readonly sockets: number;
}

function reject(socket: Duplex, status: number, text: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    // ignore
  }
  socket.destroy();
}

export function createRealtime(s: Services, options: RealtimeOptions = {}): RealtimeServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: true,
  });
  const perIp = new Map<string, number>();
  let closing = false;
  const contentHost =
    s.config.contentUrl === null ? null : new URL(s.config.contentUrl).host.toLowerCase();
  const owner = ownerPrincipal(DEFAULT_WORKSPACE_ID);

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const path = (req.url ?? "/").split("?")[0]?.slice(0, 200) ?? "/";
    const ip = clientIpFrom(header, s.config, options.socketIp?.(req) ?? req.socket.remoteAddress);
    const deny = (status: number, text: string, why: string): void => {
      s.logger.info("ws refused", { path, status, reason: why, ip });
      reject(socket, status, text);
    };
    if (closing) return deny(503, "Service Unavailable", "shutting down");
    if (path !== "/ws") return deny(404, "Not Found", "path");
    const host = (header("host") ?? "").toLowerCase();
    if (!isAllowedHost(host, s.config)) return deny(403, "Forbidden", "host");
    if (contentHost !== null && host === contentHost) return deny(404, "Not Found", "content host");
    const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
    const own = `${protoFrom(header, encrypted, s.config)}://${host}`;
    if (!isSameOrigin(header("origin"), own, s.config)) return deny(403, "Forbidden", "origin");
    const count = perIp.get(ip) ?? 0;
    if (count >= MAX_SOCKETS_PER_IP || wss.clients.size >= MAX_SOCKETS) {
      return deny(429, "Too Many Requests", "connection cap");
    }
    perIp.set(ip, count + 1);
    let counted = true;
    const release = (): void => {
      if (!counted) return;
      counted = false;
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    };
    socket.once("close", release);
    try {
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip, release));
    } catch {
      release();
      socket.destroy();
    }
  };

  function onConnection(ws: WebSocket, ip: string, release: () => void): void {
    const id = randomUUID();
    let role: Role | null = null;
    let authing = false;
    let invalid = 0;
    let room: string | null = null;
    const now = () => Date.now();
    const buckets = {
      nav: new TokenBucket(RATES.nav.capacity, RATES.nav.perSecond, now()),
      pointer: new TokenBucket(RATES.pointer.capacity, RATES.pointer.perSecond, now()),
      state: new TokenBucket(RATES.state.capacity, RATES.state.perSecond, now()),
      ping: new TokenBucket(RATES.ping.capacity, RATES.ping.perSecond, now()),
    };
    s.logger.info("ws open", { path: "/ws", ip });

    const close = (code: number, reason: string): void => {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    };
    const authTimer = setTimeout(() => {
      if (role === null) close(CLOSE.authTimeout, "auth timeout");
    }, AUTH_TIMEOUT_MS);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ws.terminate(), IDLE_MS);
    };
    touch();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;

    const sink = {
      send: (text: string, volatile: boolean) => {
        if (ws.readyState !== ws.OPEN) return;
        if (volatile && ws.bufferedAmount > 0) return; // never queue laser frames
        try {
          ws.send(text);
        } catch {
          // closed meanwhile
        }
      },
      close: (code: number, reason: string) => close(code, reason),
    };

    const bad = (): void => {
      invalid += 1;
      if (invalid > MAX_INVALID) close(CLOSE.policy, "invalid frames");
    };

    const authenticate = async (frameRole: Role, credential: string): Promise<void> => {
      if (frameRole === "screen") {
        const liveId = verifyScreenTicket(s, credential);
        const session = liveId === null ? null : await s.live.get(owner, liveId).catch(() => null);
        if (session === null || ws.readyState !== ws.OPEN) {
          close(CLOSE.unauthorized, "unauthorized");
          return;
        }
        role = "screen";
        room = session.id;
        s.hub.join(room, { id, role: "screen", deviceId: null, status: "approved" }, sink);
        s.hub.dispatch(room, { kind: "devices", devices: await deviceInfos(s, room) });
        expiryTimer = setTimeout(
          () => close(CLOSE.ended, "ended"),
          Math.min(Math.max(session.expiresAt - s.clock.now(), 0), 2 ** 31 - 1),
        );
        s.logger.info("ws auth", { role: "screen", liveId: room, ip });
        return;
      }
      const resolved = await s.live.resolveDevice(credential);
      if (resolved === null || ws.readyState !== ws.OPEN) {
        close(CLOSE.unauthorized, "unauthorized");
        return;
      }
      role = "remote";
      room = resolved.session.id;
      const devices = await deviceInfos(s, room);
      if (ws.readyState !== ws.OPEN) return;
      s.hub.join(
        room,
        { id, role: "remote", deviceId: resolved.device.id, status: resolved.device.status },
        sink,
      );
      s.hub.dispatch(room, { kind: "devices", devices });
      expiryTimer = setTimeout(
        () => close(CLOSE.ended, "ended"),
        Math.min(Math.max(resolved.device.expiresAt - s.clock.now(), 0), 2 ** 31 - 1),
      );
      s.logger.info("ws auth", { role: "remote", liveId: room, deviceId: resolved.device.id, ip });
    };

    ws.on("message", (data, isBinary) => {
      touch();
      if (isBinary) return bad();
      const frame = parseClientFrame(decodeFrame(data.toString("utf8")));
      if (frame === null) return bad();
      if (role === null) {
        if (frame.type !== "auth" || authing) {
          if (!authing) close(CLOSE.unauthorized, "auth first");
          return;
        }
        authing = true;
        clearTimeout(authTimer);
        authenticate(frame.role, frame.credential)
          .catch((error: unknown) => {
            s.logger.error("ws auth failed", { error: String(error) });
            close(CLOSE.unauthorized, "unauthorized");
          })
          .finally(() => {
            authing = false;
          });
        return;
      }
      if (frame.type === "auth" || !ALLOWED[role].has(frame.type) || room === null) return bad();
      const t = now();
      switch (frame.type) {
        case "ping":
          if (buckets.ping.take(t)) sink.send(JSON.stringify({ v: 1, type: "pong" }), false);
          return;
        case "state":
          if (buckets.state.take(t)) {
            const { v: _v, type: _t, ...state } = frame;
            s.hub.dispatch(room, { kind: "state", connectionId: id, state });
          }
          return;
        case "cmd":
          if (buckets.nav.take(t))
            s.hub.dispatch(room, {
              kind: "cmd",
              connectionId: id,
              n: frame.n,
              action: frame.action,
            });
          return;
        case "goto":
          if (buckets.nav.take(t))
            s.hub.dispatch(room, {
              kind: "goto",
              connectionId: id,
              n: frame.n,
              slide: frame.slide,
              step: frame.step,
            });
          return;
        case "pointer":
          if (buckets.pointer.take(t))
            s.hub.dispatch(room, { kind: "pointer", connectionId: id, x: frame.x, y: frame.y });
          return;
        case "pointer-off":
          if (buckets.pointer.take(t))
            s.hub.dispatch(room, { kind: "pointer-off", connectionId: id });
          return;
      }
    });

    ws.on("error", () => {
      // A close event follows.
    });

    ws.on("close", (code) => {
      clearTimeout(authTimer);
      clearTimeout(idleTimer);
      clearTimeout(expiryTimer);
      s.hub.leave(id);
      release();
      s.logger.info("ws close", { path: "/ws", role, code, ip });
    });
  }

  return {
    attach(server) {
      server.on("upgrade", onUpgrade);
      return () => server.off("upgrade", onUpgrade);
    },
    close() {
      closing = true;
      s.hub.closeAll(CLOSE.goingAway, "going away");
      for (const ws of wss.clients) {
        try {
          ws.close(CLOSE.goingAway, "going away");
        } catch {
          ws.terminate();
        }
      }
      setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
      }, 1000).unref();
      wss.close();
    },
    get sockets() {
      return wss.clients.size;
    },
  };
}
