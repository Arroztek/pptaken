// SPDX-License-Identifier: Apache-2.0
// Browser side of the socket: one reconnecting WebSocket to `/ws` for a screen (player page) or a remote (phone).
//
// - The credential is fetched right before every connection attempt (a screen ticket is short-lived), then sent as
//   the first frame (`auth`). Cookies are never used on the socket.
// - Reconnects with backoff 250 ms .. 5 s plus jitter, and at once on `visibilitychange` (visible), `online` and
//   `pageshow`. App-level ping every 10 s; two missed pongs mean the connection is dead (half-open sockets on
//   phones are common).
// - Terminal closes (revoked, replaced, ended, and for remotes an unknown credential) stop reconnecting.
// - Nothing here ever throws to the caller: a dead server is reported through `onStatus` only, so the player page
//   keeps presenting whatever happens to the socket.
// - Queued commands are never replayed after a reconnect: `send` refuses while not connected, and the caller
//   shows only state the server confirmed.

import { BACKOFF_MAX_MS, backoffDelay, PING_INTERVAL_MS, PING_MISSES } from "./limits.js";
import { CLOSE, type ClientFrame, decodeFrame, encodeFrame, type Role } from "./protocol.js";

export type SocketStatus =
  /** Connecting or waiting to reconnect. */
  | "connecting"
  /** Authenticated (the server sent `welcome`). */
  | "open"
  /** Stopped for good: see the reason. */
  | "closed";

export type TerminalReason = "revoked" | "replaced" | "ended" | "unauthorized" | "stopped";

/** The subset of `WebSocket` the client uses (tests pass a fake). */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SocketClientOptions<F> {
  /** Absolute `ws:`/`wss:` URL of `/ws`. */
  url: string;
  role: Role;
  /** Returns the credential for the next attempt, or `null` to stop (no credential any more). May reject. */
  credential(): Promise<string | null>;
  /** Validator of incoming frames for this role (`parseToRemote` / `parseToScreen`). */
  parse(data: unknown): F | null;
  onFrame(frame: F): void;
  onStatus?(status: SocketStatus, reason?: TerminalReason): void;
  /** Close codes after which the client stops. Default: revoked, replaced, ended (+ unauthorized for remotes). */
  terminalCodes?: readonly number[];
  WebSocketImpl?: new (url: string) => SocketLike;
  /** Window for the reconnect triggers and timers (default `globalThis`). */
  win?: Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"> & {
    document?: { visibilityState?: string };
  };
  random?: () => number;
  pingIntervalMs?: number;
}

export interface SocketClient {
  /** Sends a frame if authenticated; `false` otherwise (never queued). */
  send(frame: ClientFrame): boolean;
  /** Sends a frame only when nothing is queued on the socket (laser): never piles up. */
  sendVolatile(frame: ClientFrame): boolean;
  /** Connects now if not connected (also resets the backoff). */
  poke(): void;
  status(): SocketStatus;
  stop(): void;
}

const OPEN = 1;

const REASONS: Record<number, TerminalReason> = {
  [CLOSE.revoked]: "revoked",
  [CLOSE.replaced]: "replaced",
  [CLOSE.ended]: "ended",
  [CLOSE.unauthorized]: "unauthorized",
};

export function createSocketClient<F extends { type: string }>(
  options: SocketClientOptions<F>,
): SocketClient {
  const win = options.win ?? (globalThis as unknown as NonNullable<typeof options.win>);
  const Impl =
    options.WebSocketImpl ??
    (globalThis as unknown as { WebSocket: new (url: string) => SocketLike }).WebSocket;
  const random = options.random ?? Math.random;
  const pingEvery = options.pingIntervalMs ?? PING_INTERVAL_MS;
  const terminal = new Set(
    options.terminalCodes ??
      (options.role === "remote"
        ? [CLOSE.revoked, CLOSE.replaced, CLOSE.ended, CLOSE.unauthorized]
        : [CLOSE.revoked, CLOSE.replaced, CLOSE.ended]),
  );

  let ws: SocketLike | null = null;
  let status: SocketStatus = "connecting";
  let authed = false;
  let stopped = false;
  let attempt = 0;
  let connecting = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let missed = 0;

  const setStatus = (next: SocketStatus, reason?: TerminalReason): void => {
    if (next === status && next !== "closed") return;
    status = next;
    try {
      options.onStatus?.(next, reason);
    } catch {
      // A UI callback must not break the socket.
    }
  };

  const clearTimers = (): void => {
    win.clearTimeout(retryTimer);
    win.clearTimeout(pingTimer);
    retryTimer = undefined;
    pingTimer = undefined;
  };

  const finish = (reason: TerminalReason): void => {
    stopped = true;
    clearTimers();
    const old = ws;
    ws = null;
    authed = false;
    if (old) {
      old.onclose = null;
      try {
        old.close(1000, "bye");
      } catch {
        // already closed
      }
    }
    setStatus("closed", reason);
    detach();
  };

  const schedule = (delay?: number): void => {
    if (stopped) return;
    win.clearTimeout(retryTimer);
    const wait = delay ?? backoffDelay(attempt, random());
    attempt += 1;
    retryTimer = win.setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, wait);
  };

  const ping = (): void => {
    win.clearTimeout(pingTimer);
    pingTimer = win.setTimeout(() => {
      if (!ws || !authed) return;
      if (missed >= PING_MISSES) {
        // Dead connection (no pong twice): drop it and reconnect.
        drop();
        return;
      }
      missed += 1;
      try {
        ws.send(encodeFrame({ v: 1, type: "ping" }));
      } catch {
        drop();
        return;
      }
      ping();
    }, pingEvery);
  };

  /** Abandons the current socket (no close event will be handled) and schedules a reconnect. */
  const drop = (): void => {
    const old = ws;
    ws = null;
    authed = false;
    win.clearTimeout(pingTimer);
    if (old) {
      old.onclose = null;
      old.onmessage = null;
      old.onerror = null;
      try {
        old.close(4000, "dead");
      } catch {
        // ignore
      }
    }
    setStatus("connecting");
    schedule();
  };

  const connect = async (): Promise<void> => {
    if (stopped || connecting || ws) return;
    connecting = true;
    setStatus("connecting");
    let credential: string | null;
    try {
      credential = await options.credential();
    } catch {
      connecting = false;
      schedule(); // the server (or the network) is down: try again later
      return;
    }
    connecting = false;
    if (stopped) return;
    if (credential === null) {
      finish("unauthorized");
      return;
    }
    let socket: SocketLike;
    try {
      socket = new Impl(options.url);
    } catch {
      schedule();
      return;
    }
    ws = socket;
    missed = 0;
    socket.onopen = () => {
      try {
        socket.send(encodeFrame({ v: 1, type: "auth", role: options.role, credential }));
      } catch {
        // onclose follows
      }
    };
    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      const frame = options.parse(decodeFrame(ev.data));
      if (!frame) return;
      if (frame.type === "pong") {
        missed = 0;
        return;
      }
      if (frame.type === "welcome") {
        authed = true;
        attempt = 0;
        missed = 0;
        setStatus("open");
        ping();
      }
      try {
        options.onFrame(frame);
      } catch {
        // A UI callback must not break the socket.
      }
    };
    socket.onerror = () => {
      // Always followed by onclose.
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return;
      ws = null;
      authed = false;
      win.clearTimeout(pingTimer);
      const reason = REASONS[ev.code];
      if (terminal.has(ev.code) && reason) {
        finish(reason);
        return;
      }
      setStatus("connecting");
      schedule();
    };
  };

  const poke = (): void => {
    if (stopped) return;
    if (ws || connecting) return;
    attempt = 0;
    win.clearTimeout(retryTimer);
    retryTimer = undefined;
    void connect();
  };

  const onVisible = (): void => {
    if (win.document?.visibilityState !== "hidden") poke();
  };
  type Target = {
    addEventListener(n: string, f: () => void): void;
    removeEventListener(n: string, f: () => void): void;
  };
  const doc = win.document as unknown as Partial<Target> | undefined;
  const docTarget: Target =
    typeof doc?.addEventListener === "function" ? (doc as Target) : (win as unknown as Target);
  const triggers: [Target, string, () => void][] = [
    [docTarget, "visibilitychange", onVisible],
    [win as unknown as Target, "online", poke],
    [win as unknown as Target, "pageshow", poke],
  ];
  const detach = (): void => {
    for (const [target, name, fn] of triggers) target.removeEventListener(name, fn);
  };
  for (const [target, name, fn] of triggers) target.addEventListener(name, fn);

  void connect();

  const trySend = (frame: ClientFrame, volatile: boolean): boolean => {
    if (!ws || !authed || ws.readyState !== OPEN) return false;
    if (volatile && ws.bufferedAmount > 0) return false;
    try {
      ws.send(encodeFrame(frame));
      return true;
    } catch {
      return false;
    }
  };

  return {
    send: (frame) => trySend(frame, false),
    sendVolatile: (frame) => trySend(frame, true),
    poke,
    status: () => status,
    stop: () => {
      if (!stopped) finish("stopped");
    },
  };
}

/** `ws:`/`wss:` URL of `/ws` on the page's own origin. */
export function socketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export { BACKOFF_MAX_MS };
