// SPDX-License-Identifier: Apache-2.0
// The live-session reducer: `(state, event) -> { state, effects }`, pure (no I/O, no clock, no sockets). The hub
// keeps one `RoomState` per live session and executes the effects (send a frame to a connection, close it).
//
// Rules (ADR-0017):
// - The screen is AUTHORITATIVE for {slide, step, black}. The server only relays remote commands to it and caches
//   the last `state` it announced, to answer late or reconnecting remotes with a snapshot.
// - One screen per room: a new screen replaces the old one (`replaced`, then closed).
// - Remote commands are relayed only from APPROVED remotes. A pending remote can send and receive nothing (it only
//   gets its `welcome` and, when approved, `presence` and `snapshot`).
// - Relative commands are de-duplicated per connection by `n`: a number not above the connection's last one is
//   acknowledged again but never relayed twice. Without a screen, commands are refused (`nack no-screen`).
// - Revoking (kick, deny, end) sends `revoked` and closes the remote's connections.

import {
  type Action,
  CLOSE,
  type DeviceStatus,
  type DeviceView,
  type Role,
  type ScreenState,
  type ToRemote,
  type ToScreen,
} from "./protocol.js";

export interface Connection {
  id: string;
  role: Role;
  /** The device of a remote connection; `null` for the screen. */
  deviceId: string | null;
  status: DeviceStatus;
  /** Highest command number seen on this connection (-1 before the first). */
  lastN: number;
}

/** A paired device as known to the server (from storage). */
export interface DeviceInfo {
  id: string;
  label: string;
  code: string;
  status: DeviceStatus;
}

export interface RoomState {
  /** The screen connection, if any. */
  screen: string | null;
  connections: readonly Connection[];
  snapshot: ScreenState | null;
  devices: readonly DeviceInfo[];
}

export type RoomEvent =
  | { kind: "join"; connection: Omit<Connection, "lastN"> }
  | { kind: "leave"; connectionId: string }
  | { kind: "state"; connectionId: string; state: ScreenState }
  | { kind: "cmd"; connectionId: string; n: number; action: Action }
  | { kind: "goto"; connectionId: string; n: number; slide: number; step: number }
  | { kind: "pointer"; connectionId: string; x: number; y: number }
  | { kind: "pointer-off"; connectionId: string }
  | { kind: "devices"; devices: readonly DeviceInfo[] }
  | { kind: "approve"; deviceId: string }
  | { kind: "revoke"; deviceIds: readonly string[] | "all" }
  | { kind: "end" };

export type Effect =
  | {
      kind: "send";
      connectionId: string;
      frame: ToRemote | ToScreen;
      /** Laser frames: skipped when the socket still has data queued (never queue pointer frames). */
      volatile?: true;
    }
  | { kind: "close"; connectionId: string; code: number; reason: string };

export interface Reduction {
  state: RoomState;
  effects: Effect[];
}

export const emptyRoom = (): RoomState => ({
  screen: null,
  connections: [],
  snapshot: null,
  devices: [],
});

const send = (connectionId: string, frame: ToRemote | ToScreen): Effect => ({
  kind: "send",
  connectionId,
  frame,
});

const find = (s: RoomState, id: string): Connection | undefined =>
  s.connections.find((c) => c.id === id);

/** The screen's view of the paired devices, with whether each is connected now. */
export function presenceOf(s: RoomState): DeviceView[] {
  return s.devices.map((d) => ({
    id: d.id,
    label: d.label,
    code: d.code,
    status: d.status,
    online: s.connections.some((c) => c.role === "remote" && c.deviceId === d.id),
  }));
}

function screenPresence(s: RoomState): Effect[] {
  return s.screen === null
    ? []
    : [send(s.screen, { v: 1, type: "presence", remotes: presenceOf(s) })];
}

function approvedRemotes(s: RoomState): Connection[] {
  return s.connections.filter((c) => c.role === "remote" && c.status === "approved");
}

/** What an approved remote receives when it joins or is approved. */
function remoteHello(s: RoomState, c: Connection): Effect[] {
  return [
    send(c.id, { v: 1, type: "presence", screen: s.screen !== null, status: "approved" }),
    send(c.id, { v: 1, type: "snapshot", state: s.snapshot, screen: s.screen !== null }),
  ];
}

function removeRemotes(s: RoomState, ids: ReadonlySet<string>, code: number): Reduction {
  const effects: Effect[] = [];
  for (const c of s.connections) {
    if (!ids.has(c.id)) continue;
    effects.push(send(c.id, { v: 1, type: "revoked" }));
    effects.push({ kind: "close", connectionId: c.id, code, reason: "revoked" });
  }
  return {
    state: { ...s, connections: s.connections.filter((c) => !ids.has(c.id)) },
    effects,
  };
}

export function reduce(s: RoomState, event: RoomEvent): Reduction {
  switch (event.kind) {
    case "join": {
      const c: Connection = { ...event.connection, lastN: -1 };
      if (find(s, c.id)) return { state: s, effects: [] };
      if (c.role === "screen") {
        const effects: Effect[] = [];
        let connections = s.connections;
        if (s.screen !== null) {
          effects.push(send(s.screen, { v: 1, type: "replaced" }));
          effects.push({
            kind: "close",
            connectionId: s.screen,
            code: CLOSE.replaced,
            reason: "replaced",
          });
          const old = s.screen;
          connections = connections.filter((x) => x.id !== old);
        }
        const state: RoomState = {
          ...s,
          screen: c.id,
          connections: [...connections, { ...c, status: "approved" }],
        };
        effects.push(send(c.id, { v: 1, type: "welcome", role: "screen", status: "approved" }));
        effects.push(...screenPresence(state));
        for (const r of approvedRemotes(state)) {
          effects.push(send(r.id, { v: 1, type: "presence", screen: true, status: "approved" }));
        }
        return { state, effects };
      }
      const state: RoomState = { ...s, connections: [...s.connections, c] };
      const effects: Effect[] = [
        send(c.id, { v: 1, type: "welcome", role: "remote", status: c.status }),
      ];
      if (c.status === "approved") effects.push(...remoteHello(state, c));
      effects.push(...screenPresence(state));
      return { state, effects };
    }

    case "leave": {
      const c = find(s, event.connectionId);
      if (!c) return { state: s, effects: [] };
      const state: RoomState = {
        ...s,
        screen: s.screen === c.id ? null : s.screen,
        connections: s.connections.filter((x) => x.id !== c.id),
      };
      const effects: Effect[] = [];
      if (c.role === "screen" && s.screen === c.id) {
        for (const r of approvedRemotes(state)) {
          effects.push(send(r.id, { v: 1, type: "presence", screen: false, status: "approved" }));
        }
      } else if (c.role === "remote") {
        effects.push(...screenPresence(state));
      }
      return { state, effects };
    }

    case "state": {
      if (s.screen !== event.connectionId) return { state: s, effects: [] };
      const state: RoomState = { ...s, snapshot: { ...event.state } };
      const effects = approvedRemotes(state).map((r) =>
        send(r.id, { v: 1, type: "state", ...event.state }),
      );
      return { state, effects };
    }

    case "cmd":
    case "goto": {
      const c = find(s, event.connectionId);
      if (!c || c.role !== "remote" || c.status !== "approved") return { state: s, effects: [] };
      if (event.n <= c.lastN) {
        // Duplicate (or out of order): acknowledged again, never applied twice.
        return { state: s, effects: [send(c.id, { v: 1, type: "ack", n: event.n })] };
      }
      const state: RoomState = {
        ...s,
        connections: s.connections.map((x) => (x.id === c.id ? { ...x, lastN: event.n } : x)),
      };
      if (s.screen === null) {
        return {
          state,
          effects: [send(c.id, { v: 1, type: "nack", n: event.n, reason: "no-screen" })],
        };
      }
      const relay: ToScreen =
        event.kind === "cmd"
          ? { v: 1, type: "cmd", action: event.action }
          : { v: 1, type: "goto", slide: event.slide, step: event.step };
      return {
        state,
        effects: [send(s.screen, relay), send(c.id, { v: 1, type: "ack", n: event.n })],
      };
    }

    case "pointer":
    case "pointer-off": {
      const c = find(s, event.connectionId);
      if (!c || c.role !== "remote" || c.status !== "approved" || s.screen === null)
        return { state: s, effects: [] };
      const frame: ToScreen =
        event.kind === "pointer"
          ? { v: 1, type: "pointer", x: event.x, y: event.y }
          : { v: 1, type: "pointer-off" };
      // pointer-off is not volatile: a lost release would leave the dot until its timeout.
      return {
        state: s,
        effects: [
          event.kind === "pointer"
            ? { kind: "send", connectionId: s.screen, frame, volatile: true }
            : send(s.screen, frame),
        ],
      };
    }

    case "devices": {
      const state: RoomState = { ...s, devices: event.devices.map((d) => ({ ...d })) };
      return { state, effects: screenPresence(state) };
    }

    case "approve": {
      const effects: Effect[] = [];
      let state: RoomState = {
        ...s,
        devices: s.devices.map((d) =>
          d.id === event.deviceId ? { ...d, status: "approved" as const } : d,
        ),
      };
      const promoted: Connection[] = [];
      state = {
        ...state,
        connections: state.connections.map((c) => {
          if (c.role !== "remote" || c.deviceId !== event.deviceId || c.status === "approved")
            return c;
          const next = { ...c, status: "approved" as const };
          promoted.push(next);
          return next;
        }),
      };
      for (const c of promoted) effects.push(...remoteHello(state, c));
      effects.push(...screenPresence(state));
      return { state, effects };
    }

    case "revoke": {
      const all = event.deviceIds === "all";
      const ids = new Set(all ? [] : event.deviceIds);
      const targets = new Set(
        s.connections
          .filter(
            (c) => c.role === "remote" && (all || (c.deviceId !== null && ids.has(c.deviceId))),
          )
          .map((c) => c.id),
      );
      const removed = removeRemotes(s, targets, CLOSE.revoked);
      const state: RoomState = {
        ...removed.state,
        devices: all ? [] : removed.state.devices.filter((d) => !ids.has(d.id)),
      };
      return { state, effects: [...removed.effects, ...screenPresence(state)] };
    }

    case "end": {
      const remotes = new Set(s.connections.filter((c) => c.role === "remote").map((c) => c.id));
      const removed = removeRemotes(s, remotes, CLOSE.ended);
      const effects = [...removed.effects];
      if (s.screen !== null)
        effects.push({ kind: "close", connectionId: s.screen, code: CLOSE.ended, reason: "ended" });
      return { state: emptyRoom(), effects };
    }
  }
}
