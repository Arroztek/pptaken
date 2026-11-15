// SPDX-License-Identifier: Apache-2.0
// The remote-control WebSocket protocol, version 1 (ADR-0017, docs/spec/realtime.md). One socket per client on
// `/ws`; JSON text frames of at most 1 KB; every frame is a plain object with exactly the listed keys plus `v: 1`
// and `type`. Validators are hand-written (no zod: these modules also ship in the phone and player page bundles):
// unknown types, extra or missing keys, other versions, non-integers and out-of-range numbers are dropped.
//
// Client -> server (the first frame must be `auth`; the server checks which role may send what):
//   auth {role, credential}                       role "screen" (screen ticket) or "remote" (device credential)
//   ping {}                                       app-level keepalive, every 10 s
//   cmd {n, action}                               remote: next | prev | first | last | black (toggle)
//   goto {n, slide, step}                         remote: absolute position (0-based slide, revealed steps)
//   pointer {x, y}                                remote: laser at integer coords 0..10000 of the logical canvas
//   pointer-off {}                                remote: laser released
//   state {seq, slide, step, black, slideCount}   screen: what the audience sees (the screen is authoritative)
//
// Server -> client:
//   welcome {role, status}                        authenticated; status "approved" or "pending" (remotes only)
//   pong {}
//   snapshot {state, screen}                      remote: last known state (or null) and whether a screen is on
//   state {seq, slide, step, black, slideCount}   remote: the screen moved
//   ack {n} / nack {n, reason}                    remote: command relayed / refused ("no-screen")
//   presence {screen, status}                     remote: screen online, own approval status
//   presence {remotes: [...]}                     screen: the paired devices (id, label, code, status, online)
//   revoked {}                                    remote: credential revoked (the socket closes next)
//   replaced {}                                   screen: a newer screen took over (the socket closes next)
//   cmd {action} / goto {slide, step}             screen: a remote command to apply as local input
//   pointer {x, y} / pointer-off {}               screen: laser

export const REALTIME_VERSION = 1;
/** Largest accepted frame, in bytes (UTF-8). The server socket uses the same `maxPayload`. */
export const MAX_FRAME_BYTES = 1024;
/** Laser coordinates are integers in `[0, COORD_MAX]` along the logical canvas width and height. */
export const COORD_MAX = 10_000;
/** Same as `MAX_SLIDES` / `MAX_STEPS` of `@pptaken/player` (a unit test checks it). */
export const MAX_SLIDES = 200;
export const MAX_STEPS = 255;
/** Command numbers and state sequence numbers are integers in `[0, MAX_SEQ]`. */
export const MAX_SEQ = 2_147_483_647;
/** At most this many devices are listed in a screen's `presence` (2 remotes plus revoked-but-listed slack). */
export const MAX_PRESENCE = 8;
export const MAX_LABEL = 40;
export const MAX_CREDENTIAL = 600;

export const ROLES = ["screen", "remote"] as const;
export type Role = (typeof ROLES)[number];
export const ACTIONS = ["next", "prev", "first", "last", "black"] as const;
export type Action = (typeof ACTIONS)[number];
export const DEVICE_STATUSES = ["pending", "approved"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];
export const NACK_REASONS = ["no-screen"] as const;
export type NackReason = (typeof NACK_REASONS)[number];

/** Close codes used by the server (4xxx are application codes; see the realtime spec). */
export const CLOSE = {
  goingAway: 1001,
  policy: 1008,
  tooBig: 1009,
  replaced: 4001,
  revoked: 4003,
  ended: 4004,
  unauthorized: 4401,
  authTimeout: 4408,
} as const;

/** The screen's state: what the audience sees. */
export interface ScreenState {
  seq: number;
  slide: number;
  step: number;
  black: boolean;
  slideCount: number;
}

export interface DeviceView {
  /** Device id (ULID). */
  id: string;
  /** Short, human-readable label derived from the User-Agent ("Android · Chrome"). */
  label: string;
  /** Two digits shown on the phone and in the approval prompt. */
  code: string;
  status: DeviceStatus;
  online: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Frames

export type ClientFrame =
  | { v: 1; type: "auth"; role: Role; credential: string }
  | { v: 1; type: "ping" }
  | { v: 1; type: "cmd"; n: number; action: Action }
  | { v: 1; type: "goto"; n: number; slide: number; step: number }
  | { v: 1; type: "pointer"; x: number; y: number }
  | { v: 1; type: "pointer-off" }
  | ({ v: 1; type: "state" } & ScreenState);

export type ToRemote =
  | { v: 1; type: "welcome"; role: "remote"; status: DeviceStatus }
  | { v: 1; type: "pong" }
  | { v: 1; type: "snapshot"; state: ScreenState | null; screen: boolean }
  | ({ v: 1; type: "state" } & ScreenState)
  | { v: 1; type: "ack"; n: number }
  | { v: 1; type: "nack"; n: number; reason: NackReason }
  | { v: 1; type: "presence"; screen: boolean; status: DeviceStatus }
  | { v: 1; type: "revoked" };

export type ToScreen =
  | { v: 1; type: "welcome"; role: "screen"; status: "approved" }
  | { v: 1; type: "pong" }
  | { v: 1; type: "presence"; remotes: DeviceView[] }
  | { v: 1; type: "replaced" }
  | { v: 1; type: "cmd"; action: Action }
  | { v: 1; type: "goto"; slide: number; step: number }
  | { v: 1; type: "pointer"; x: number; y: number }
  | { v: 1; type: "pointer-off" };

export type ServerFrame = ToRemote | ToScreen;

/** Which client frames each role may send after `auth`. */
export const ALLOWED: Readonly<Record<Role, ReadonlySet<ClientFrame["type"]>>> = {
  screen: new Set(["ping", "state"]),
  remote: new Set(["ping", "cmd", "goto", "pointer", "pointer-off"]),
};

// ---------------------------------------------------------------------------------------------------------------
// Primitives (same rules as the player's postMessage validators)

type Fields = Record<string, unknown>;

/** A plain object (as produced by `JSON.parse` or structured clone) with exactly these own keys. */
export function exactObject(data: unknown, keys: readonly string[]): Fields | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  if (Object.getPrototypeOf(data) !== Object.prototype) return null;
  const fields = data as Fields;
  if (Object.keys(fields).length !== keys.length) return null;
  for (const key of keys) if (!Object.hasOwn(fields, key)) return null;
  return fields;
}

function envelope(data: unknown, type: string, keys: readonly string[]): Fields | null {
  const fields = exactObject(data, ["v", "type", ...keys]);
  return fields && fields.v === REALTIME_VERSION && fields.type === type ? fields : null;
}

function typeOf(data: unknown): unknown {
  return typeof data === "object" && data !== null ? (data as Fields).type : undefined;
}

/** Integer in `[0, max]`. */
export function isBoundedInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const CREDENTIAL = /^[A-Za-z0-9._-]{1,600}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CODE = /^[0-9]{2}$/;
/** Printable ASCII and Latin-1 letters, no angle brackets or quotes (it is shown as text anyway). */
const LABEL = /^[A-Za-z0-9 ·._()/+-]{1,40}$/;

function stateOf(m: Fields): ScreenState | null {
  if (
    !isBoundedInt(m.seq, MAX_SEQ) ||
    !isBoundedInt(m.slideCount, MAX_SLIDES) ||
    m.slideCount < 1 ||
    !isBoundedInt(m.slide, m.slideCount - 1) ||
    !isBoundedInt(m.step, MAX_STEPS) ||
    typeof m.black !== "boolean"
  ) {
    return null;
  }
  return { seq: m.seq, slide: m.slide, step: m.step, black: m.black, slideCount: m.slideCount };
}

const STATE_KEYS = ["seq", "slide", "step", "black", "slideCount"] as const;

/** UTF-8 byte length without allocating (surrogate pairs count 4). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Parses a text frame; `undefined` when it is too large or not JSON. */
export function decodeFrame(text: unknown): unknown {
  if (typeof text !== "string" || text.length > MAX_FRAME_BYTES) return undefined;
  if (utf8Length(text) > MAX_FRAME_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Serializes a frame (already valid by construction). */
export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame);
}

// ---------------------------------------------------------------------------------------------------------------
// Validators

/** Validates a frame sent by a client (any role). Returns a fresh copy, or `null` to drop it. */
export function parseClientFrame(data: unknown): ClientFrame | null {
  switch (typeOf(data)) {
    case "auth": {
      const m = envelope(data, "auth", ["role", "credential"]);
      if (!m || !isOneOf(ROLES, m.role) || typeof m.credential !== "string") return null;
      if (!CREDENTIAL.test(m.credential)) return null;
      return { v: 1, type: "auth", role: m.role, credential: m.credential };
    }
    case "ping":
      return envelope(data, "ping", []) ? { v: 1, type: "ping" } : null;
    case "cmd": {
      const m = envelope(data, "cmd", ["n", "action"]);
      if (!m || !isBoundedInt(m.n, MAX_SEQ) || !isOneOf(ACTIONS, m.action)) return null;
      return { v: 1, type: "cmd", n: m.n, action: m.action };
    }
    case "goto": {
      const m = envelope(data, "goto", ["n", "slide", "step"]);
      if (
        !m ||
        !isBoundedInt(m.n, MAX_SEQ) ||
        !isBoundedInt(m.slide, MAX_SLIDES - 1) ||
        !isBoundedInt(m.step, MAX_STEPS)
      )
        return null;
      return { v: 1, type: "goto", n: m.n, slide: m.slide, step: m.step };
    }
    case "pointer": {
      const m = envelope(data, "pointer", ["x", "y"]);
      if (!m || !isBoundedInt(m.x, COORD_MAX) || !isBoundedInt(m.y, COORD_MAX)) return null;
      return { v: 1, type: "pointer", x: m.x, y: m.y };
    }
    case "pointer-off":
      return envelope(data, "pointer-off", []) ? { v: 1, type: "pointer-off" } : null;
    case "state": {
      const m = envelope(data, "state", STATE_KEYS);
      const s = m && stateOf(m);
      return s ? { v: 1, type: "state", ...s } : null;
    }
    default:
      return null;
  }
}

function parseDevice(data: unknown): DeviceView | null {
  const m = exactObject(data, ["id", "label", "code", "status", "online"]);
  if (
    !m ||
    typeof m.id !== "string" ||
    !ULID.test(m.id) ||
    typeof m.label !== "string" ||
    !LABEL.test(m.label) ||
    typeof m.code !== "string" ||
    !CODE.test(m.code) ||
    !isOneOf(DEVICE_STATUSES, m.status) ||
    typeof m.online !== "boolean"
  ) {
    return null;
  }
  return { id: m.id, label: m.label, code: m.code, status: m.status, online: m.online };
}

/** Whether a device label fits the protocol (the server builds labels that always do). */
export const isDeviceLabel = (label: string): boolean => LABEL.test(label);

/** Validates a frame received by a remote (the phone). */
export function parseToRemote(data: unknown): ToRemote | null {
  switch (typeOf(data)) {
    case "welcome": {
      const m = envelope(data, "welcome", ["role", "status"]);
      if (!m || m.role !== "remote" || !isOneOf(DEVICE_STATUSES, m.status)) return null;
      return { v: 1, type: "welcome", role: "remote", status: m.status };
    }
    case "pong":
      return envelope(data, "pong", []) ? { v: 1, type: "pong" } : null;
    case "snapshot": {
      const m = envelope(data, "snapshot", ["state", "screen"]);
      if (!m || typeof m.screen !== "boolean") return null;
      if (m.state === null) return { v: 1, type: "snapshot", state: null, screen: m.screen };
      const inner = exactObject(m.state, STATE_KEYS);
      const s = inner && stateOf(inner);
      return s ? { v: 1, type: "snapshot", state: s, screen: m.screen } : null;
    }
    case "state": {
      const m = envelope(data, "state", STATE_KEYS);
      const s = m && stateOf(m);
      return s ? { v: 1, type: "state", ...s } : null;
    }
    case "ack": {
      const m = envelope(data, "ack", ["n"]);
      return m && isBoundedInt(m.n, MAX_SEQ) ? { v: 1, type: "ack", n: m.n } : null;
    }
    case "nack": {
      const m = envelope(data, "nack", ["n", "reason"]);
      if (!m || !isBoundedInt(m.n, MAX_SEQ) || !isOneOf(NACK_REASONS, m.reason)) return null;
      return { v: 1, type: "nack", n: m.n, reason: m.reason };
    }
    case "presence": {
      const m = envelope(data, "presence", ["screen", "status"]);
      if (!m || typeof m.screen !== "boolean" || !isOneOf(DEVICE_STATUSES, m.status)) return null;
      return { v: 1, type: "presence", screen: m.screen, status: m.status };
    }
    case "revoked":
      return envelope(data, "revoked", []) ? { v: 1, type: "revoked" } : null;
    default:
      return null;
  }
}

/** Validates a frame received by a screen (the player page). */
export function parseToScreen(data: unknown): ToScreen | null {
  switch (typeOf(data)) {
    case "welcome": {
      const m = envelope(data, "welcome", ["role", "status"]);
      if (!m || m.role !== "screen" || m.status !== "approved") return null;
      return { v: 1, type: "welcome", role: "screen", status: "approved" };
    }
    case "pong":
      return envelope(data, "pong", []) ? { v: 1, type: "pong" } : null;
    case "presence": {
      const m = envelope(data, "presence", ["remotes"]);
      if (!m || !Array.isArray(m.remotes) || m.remotes.length > MAX_PRESENCE) return null;
      const remotes: DeviceView[] = [];
      for (const r of m.remotes) {
        const d = parseDevice(r);
        if (!d) return null;
        remotes.push(d);
      }
      return { v: 1, type: "presence", remotes };
    }
    case "replaced":
      return envelope(data, "replaced", []) ? { v: 1, type: "replaced" } : null;
    case "cmd": {
      const m = envelope(data, "cmd", ["action"]);
      return m && isOneOf(ACTIONS, m.action) ? { v: 1, type: "cmd", action: m.action } : null;
    }
    case "goto": {
      const m = envelope(data, "goto", ["slide", "step"]);
      if (!m || !isBoundedInt(m.slide, MAX_SLIDES - 1) || !isBoundedInt(m.step, MAX_STEPS))
        return null;
      return { v: 1, type: "goto", slide: m.slide, step: m.step };
    }
    case "pointer": {
      const m = envelope(data, "pointer", ["x", "y"]);
      if (!m || !isBoundedInt(m.x, COORD_MAX) || !isBoundedInt(m.y, COORD_MAX)) return null;
      return { v: 1, type: "pointer", x: m.x, y: m.y };
    }
    case "pointer-off":
      return envelope(data, "pointer-off", []) ? { v: 1, type: "pointer-off" } : null;
    default:
      return null;
  }
}
