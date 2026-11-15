// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  CLOSE,
  type Effect,
  emptyRoom,
  RealtimeHub,
  type RoomEvent,
  type RoomState,
  reduce,
} from "../dist/index.js";

const D1 = "01JD0000000000000000000001";
const D2 = "01JD0000000000000000000002";
const S = { seq: 1, slide: 4, step: 2, black: false, slideCount: 20 };

function run(events: RoomEvent[], start: RoomState = emptyRoom()) {
  let state = start;
  const effects: Effect[] = [];
  for (const e of events) {
    const r = reduce(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const sentTo = (effects: Effect[], id: string) =>
  effects
    .filter((e) => e.kind === "send" && e.connectionId === id)
    .map((e) => (e as { frame: unknown }).frame);

const joinScreen = (id: string): RoomEvent => ({
  kind: "join",
  connection: { id, role: "screen", deviceId: null, status: "approved" },
});
const joinRemote = (
  id: string,
  deviceId: string,
  status: "pending" | "approved" = "approved",
): RoomEvent => ({
  kind: "join",
  connection: { id, role: "remote", deviceId, status },
});

describe("room reducer", () => {
  it("greets a screen and caches the state it announces for late remotes", () => {
    const { state, effects } = run([
      joinScreen("s"),
      { kind: "state", connectionId: "s", state: S },
      joinRemote("r", D1),
    ]);
    expect(sentTo(effects, "s")[0]).toEqual({
      v: 1,
      type: "welcome",
      role: "screen",
      status: "approved",
    });
    expect(state.snapshot).toEqual(S);
    expect(sentTo(effects, "r")).toEqual([
      { v: 1, type: "welcome", role: "remote", status: "approved" },
      { v: 1, type: "presence", screen: true, status: "approved" },
      { v: 1, type: "snapshot", state: S, screen: true },
    ]);
  });

  it("the screen is authoritative: only the current screen's state is accepted and relayed", () => {
    const { state, effects } = run([
      joinScreen("s"),
      joinRemote("r", D1),
      { kind: "state", connectionId: "r", state: { ...S, slide: 9 } },
      { kind: "state", connectionId: "s", state: S },
    ]);
    expect(state.snapshot).toEqual(S);
    expect(sentTo(effects, "r").filter((f) => (f as { type: string }).type === "state")).toEqual([
      { v: 1, type: "state", ...S },
    ]);
  });

  it("relays commands to the screen once, acks them, and de-duplicates by n per connection", () => {
    const { effects } = run([
      joinScreen("s"),
      joinRemote("r", D1),
      joinRemote("r2", D1),
      { kind: "cmd", connectionId: "r", n: 1, action: "next" },
      { kind: "cmd", connectionId: "r", n: 1, action: "next" },
      { kind: "cmd", connectionId: "r", n: 0, action: "prev" },
      { kind: "goto", connectionId: "r", n: 2, slide: 5, step: 1 },
      // Another connection has its own numbering.
      { kind: "cmd", connectionId: "r2", n: 1, action: "black" },
    ]);
    const toScreen = sentTo(effects, "s").filter((f) =>
      ["cmd", "goto"].includes((f as { type: string }).type),
    );
    expect(toScreen).toEqual([
      { v: 1, type: "cmd", action: "next" },
      { v: 1, type: "goto", slide: 5, step: 1 },
      { v: 1, type: "cmd", action: "black" },
    ]);
    const acks = sentTo(effects, "r").filter((f) => (f as { type: string }).type === "ack");
    expect(acks).toEqual([
      { v: 1, type: "ack", n: 1 },
      { v: 1, type: "ack", n: 1 },
      { v: 1, type: "ack", n: 0 },
      { v: 1, type: "ack", n: 2 },
    ]);
  });

  it("refuses commands without a screen (nack no-screen) and never queues them", () => {
    const { effects, state } = run([
      joinRemote("r", D1),
      { kind: "cmd", connectionId: "r", n: 1, action: "next" },
    ]);
    expect(sentTo(effects, "r").at(-1)).toEqual({ v: 1, type: "nack", n: 1, reason: "no-screen" });
    const later = run([joinScreen("s")], state);
    expect(sentTo(later.effects, "s").some((f) => (f as { type: string }).type === "cmd")).toBe(
      false,
    );
  });

  it("a pending device can send and receive nothing until approved", () => {
    const { state, effects } = run([
      joinScreen("s"),
      { kind: "devices", devices: [{ id: D1, label: "Phone", code: "07", status: "pending" }] },
      joinRemote("r", D1, "pending"),
      { kind: "state", connectionId: "s", state: S },
      { kind: "cmd", connectionId: "r", n: 1, action: "next" },
      { kind: "pointer", connectionId: "r", x: 1, y: 1 },
    ]);
    expect(sentTo(effects, "r")).toEqual([
      { v: 1, type: "welcome", role: "remote", status: "pending" },
    ]);
    expect(
      sentTo(effects, "s").some((f) => ["cmd", "pointer"].includes((f as { type: string }).type)),
    ).toBe(false);
    // The screen sees the pending device (online) for its approval prompt.
    expect(sentTo(effects, "s").at(-1)).toEqual({
      v: 1,
      type: "presence",
      remotes: [{ id: D1, label: "Phone", code: "07", status: "pending", online: true }],
    });
    const approved = run(
      [
        { kind: "approve", deviceId: D1 },
        { kind: "cmd", connectionId: "r", n: 1, action: "next" },
      ],
      state,
    );
    expect(sentTo(approved.effects, "r").slice(0, 2)).toEqual([
      { v: 1, type: "presence", screen: true, status: "approved" },
      { v: 1, type: "snapshot", state: S, screen: true },
    ]);
    expect(sentTo(approved.effects, "s")).toContainEqual({ v: 1, type: "cmd", action: "next" });
  });

  it("a newer screen replaces the old one", () => {
    const { state, effects } = run([joinScreen("s1"), joinRemote("r", D1), joinScreen("s2")]);
    expect(state.screen).toBe("s2");
    expect(state.connections.map((c) => c.id).sort()).toEqual(["r", "s2"]);
    expect(sentTo(effects, "s1")).toContainEqual({ v: 1, type: "replaced" });
    expect(effects).toContainEqual({
      kind: "close",
      connectionId: "s1",
      code: CLOSE.replaced,
      reason: "replaced",
    });
  });

  it("kick revokes every remote and closes their sockets; revoke by id only that device", () => {
    const base = run([
      joinScreen("s"),
      {
        kind: "devices",
        devices: [
          { id: D1, label: "A", code: "11", status: "approved" },
          { id: D2, label: "B", code: "22", status: "approved" },
        ],
      },
      joinRemote("r1", D1),
      joinRemote("r2", D2),
    ]).state;
    const one = run([{ kind: "revoke", deviceIds: [D2] }], base);
    expect(one.state.connections.map((c) => c.id).sort()).toEqual(["r1", "s"]);
    expect(one.effects).toContainEqual({
      kind: "close",
      connectionId: "r2",
      code: CLOSE.revoked,
      reason: "revoked",
    });
    const all = run([{ kind: "revoke", deviceIds: "all" }], base);
    expect(all.state.connections.map((c) => c.id)).toEqual(["s"]);
    expect(all.state.devices).toEqual([]);
    for (const id of ["r1", "r2"]) {
      expect(sentTo(all.effects, id)).toEqual([{ v: 1, type: "revoked" }]);
    }
    expect(sentTo(all.effects, "s").at(-1)).toEqual({ v: 1, type: "presence", remotes: [] });
  });

  it("pointer frames are volatile and only reach the screen from approved remotes", () => {
    const { effects } = run([
      joinScreen("s"),
      joinRemote("r", D1),
      { kind: "pointer", connectionId: "r", x: 10, y: 20 },
      { kind: "pointer-off", connectionId: "r" },
    ]);
    expect(effects).toContainEqual({
      kind: "send",
      connectionId: "s",
      frame: { v: 1, type: "pointer", x: 10, y: 20 },
      volatile: true,
    });
    expect(effects).toContainEqual({
      kind: "send",
      connectionId: "s",
      frame: { v: 1, type: "pointer-off" },
    });
  });

  it("screen leaving tells remotes, keeps the snapshot; end closes everyone", () => {
    const a = run([
      joinScreen("s"),
      joinRemote("r", D1),
      { kind: "state", connectionId: "s", state: S },
      { kind: "leave", connectionId: "s" },
    ]);
    expect(a.state.screen).toBeNull();
    expect(a.state.snapshot).toEqual(S);
    expect(sentTo(a.effects, "r").at(-1)).toEqual({
      v: 1,
      type: "presence",
      screen: false,
      status: "approved",
    });
    const b = run([joinScreen("s2"), { kind: "end" }], a.state);
    expect(b.state).toEqual(emptyRoom());
    expect(b.effects).toContainEqual({
      kind: "close",
      connectionId: "r",
      code: CLOSE.ended,
      reason: "revoked",
    });
    expect(b.effects).toContainEqual({
      kind: "close",
      connectionId: "s2",
      code: CLOSE.ended,
      reason: "ended",
    });
  });
});

describe("hub", () => {
  it("executes effects on sinks, drops closed connections and closes everything on shutdown", () => {
    const hub = new RealtimeHub();
    const log: string[] = [];
    const sink = (id: string) => ({
      send: (text: string, volatile: boolean) =>
        log.push(`${id}<${volatile ? "~" : ""}${JSON.parse(text).type}`),
      close: (code: number) => log.push(`${id}x${code}`),
    });
    hub.join("L", { id: "s", role: "screen", deviceId: null, status: "approved" }, sink("s"));
    hub.join("L", { id: "r", role: "remote", deviceId: D1, status: "approved" }, sink("r"));
    hub.dispatch("L", { kind: "pointer", connectionId: "r", x: 1, y: 1 });
    expect(log).toContain("s<~pointer");
    expect(hub.hasScreen("L")).toBe(true);
    hub.join("L", { id: "s2", role: "screen", deviceId: null, status: "approved" }, sink("s2"));
    expect(log).toContain(`sx${CLOSE.replaced}`);
    hub.leave("s"); // its socket closes afterwards: ignored
    expect(hub.connectionCount).toBe(2);
    hub.closeAll(1001, "going away");
    expect(log).toContain("rx1001");
    expect(log).toContain("s2x1001");
    expect(hub.connectionCount).toBe(0);
    expect(hub.state("L")).toBeUndefined();
  });
});
