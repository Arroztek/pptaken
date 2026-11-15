// SPDX-License-Identifier: Apache-2.0
import {
  MAX_SLIDES as PLAYER_MAX_SLIDES,
  MAX_STEPS as PLAYER_MAX_STEPS,
} from "@pptaken/player/protocol";
import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  backoffDelay,
  decodeFrame,
  MAX_FRAME_BYTES,
  MAX_SLIDES,
  MAX_STEPS,
  parseClientFrame,
  parseToRemote,
  parseToScreen,
  TokenBucket,
  toCoord,
} from "../dist/index.js";

const state = { v: 1, type: "state", seq: 3, slide: 2, step: 1, black: false, slideCount: 20 };
const ulid = "01JD0000000000000000000000";

describe("client frames", () => {
  it("accepts every valid frame and returns a fresh copy", () => {
    const frames = [
      { v: 1, type: "auth", role: "remote", credential: "a".repeat(43) },
      { v: 1, type: "auth", role: "screen", credential: "abc.def_-" },
      { v: 1, type: "ping" },
      { v: 1, type: "cmd", n: 0, action: "next" },
      { v: 1, type: "cmd", n: 2_147_483_647, action: "black" },
      { v: 1, type: "goto", n: 1, slide: 199, step: 255 },
      { v: 1, type: "pointer", x: 0, y: 10_000 },
      { v: 1, type: "pointer-off" },
      state,
    ];
    for (const f of frames) {
      const parsed = parseClientFrame(f);
      expect(parsed).toEqual(f);
      expect(parsed).not.toBe(f);
    }
  });

  it("drops extra keys, missing keys, other versions and unknown types", () => {
    const bad: unknown[] = [
      { v: 1, type: "ping", extra: 1 },
      { v: 2, type: "ping" },
      { type: "ping" },
      { v: 1, type: "cmd", n: 1 },
      { v: 1, type: "cmd", n: 1, action: "next", id: "x" },
      { v: 1, type: "nav", n: 1, action: "next" },
      { v: 1, type: "state", seq: 1, slide: 0, step: 0, black: false },
      { ...state, notes: "secret" },
      null,
      [],
      "ping",
      Object.create({ v: 1, type: "ping" }),
      JSON.parse('{"v":1,"type":"ping","__proto__":{}}'),
    ];
    for (const f of bad) expect(parseClientFrame(f)).toBeNull();
  });

  it("enforces bounds and types", () => {
    const bad: unknown[] = [
      { v: 1, type: "cmd", n: -1, action: "next" },
      { v: 1, type: "cmd", n: 1.5, action: "next" },
      { v: 1, type: "cmd", n: 2_147_483_648, action: "next" },
      { v: 1, type: "cmd", n: 1, action: "goto" },
      { v: 1, type: "cmd", n: 1, action: "overview" },
      { v: 1, type: "goto", n: 1, slide: 200, step: 0 },
      { v: 1, type: "goto", n: 1, slide: 0, step: 256 },
      { v: 1, type: "goto", n: "1", slide: 0, step: 0 },
      { v: 1, type: "pointer", x: 10_001, y: 0 },
      { v: 1, type: "pointer", x: 0.5, y: 0 },
      { v: 1, type: "pointer", x: -1, y: 0 },
      { v: 1, type: "pointer", x: Number.NaN, y: 0 },
      { ...state, slide: 20 },
      { ...state, slideCount: 0, slide: 0 },
      { ...state, slideCount: 201 },
      { ...state, black: "no" },
      { v: 1, type: "auth", role: "owner", credential: "x" },
      { v: 1, type: "auth", role: "remote", credential: "" },
      { v: 1, type: "auth", role: "remote", credential: "a b" },
      { v: 1, type: "auth", role: "remote", credential: "a".repeat(601) },
    ];
    for (const f of bad) expect(parseClientFrame(f), JSON.stringify(f)).toBeNull();
  });

  it("only lets each role send its own frames", () => {
    expect(ALLOWED.remote.has("state")).toBe(false);
    expect(ALLOWED.screen.has("cmd")).toBe(false);
    expect(ALLOWED.screen.has("pointer")).toBe(false);
    expect(ALLOWED.remote.has("auth")).toBe(false);
    expect([...ALLOWED.remote].sort()).toEqual(["cmd", "goto", "ping", "pointer", "pointer-off"]);
    expect([...ALLOWED.screen].sort()).toEqual(["ping", "state"]);
  });

  it("decodes only small JSON text frames", () => {
    expect(decodeFrame('{"v":1,"type":"ping"}')).toEqual({ v: 1, type: "ping" });
    expect(decodeFrame("not json")).toBeUndefined();
    expect(decodeFrame(new Uint8Array(3))).toBeUndefined();
    expect(decodeFrame(`"${"x".repeat(MAX_FRAME_BYTES)}"`)).toBeUndefined();
    // Multi-byte characters count in bytes, not UTF-16 units.
    expect(decodeFrame(`"${"é".repeat(600)}"`)).toBeUndefined();
  });

  it("shares the slide and step limits with the player", () => {
    expect(MAX_SLIDES).toBe(PLAYER_MAX_SLIDES);
    expect(MAX_STEPS).toBe(PLAYER_MAX_STEPS);
  });
});

describe("server frames", () => {
  it("validates frames for remotes", () => {
    const ok = [
      { v: 1, type: "welcome", role: "remote", status: "pending" },
      { v: 1, type: "snapshot", state: null, screen: false },
      {
        v: 1,
        type: "snapshot",
        state: { seq: 0, slide: 0, step: 0, black: true, slideCount: 1 },
        screen: true,
      },
      state,
      { v: 1, type: "ack", n: 4 },
      { v: 1, type: "nack", n: 4, reason: "no-screen" },
      { v: 1, type: "presence", screen: true, status: "approved" },
      { v: 1, type: "revoked" },
      { v: 1, type: "pong" },
    ];
    for (const f of ok) expect(parseToRemote(f)).toEqual(f);
    for (const f of [
      { v: 1, type: "welcome", role: "screen", status: "approved" },
      { v: 1, type: "nack", n: 4, reason: "other" },
      { v: 1, type: "snapshot", state: { ...state }, screen: true },
      { v: 1, type: "presence", remotes: [] },
      { v: 1, type: "cmd", action: "next" },
    ])
      expect(parseToRemote(f)).toBeNull();
  });

  it("validates frames for screens, including the device list", () => {
    const device = {
      id: ulid,
      label: "Android · Chrome",
      code: "42",
      status: "pending",
      online: true,
    };
    const ok = [
      { v: 1, type: "welcome", role: "screen", status: "approved" },
      { v: 1, type: "presence", remotes: [device] },
      { v: 1, type: "replaced" },
      { v: 1, type: "cmd", action: "first" },
      { v: 1, type: "goto", slide: 3, step: 0 },
      { v: 1, type: "pointer", x: 5000, y: 5000 },
      { v: 1, type: "pointer-off" },
    ];
    for (const f of ok) expect(parseToScreen(f)).toEqual(f);
    for (const f of [
      { v: 1, type: "presence", remotes: [{ ...device, label: "<b>x</b>" }] },
      { v: 1, type: "presence", remotes: [{ ...device, code: "123" }] },
      { v: 1, type: "presence", remotes: [{ ...device, id: "x" }] },
      { v: 1, type: "presence", remotes: [{ ...device, extra: 1 }] },
      { v: 1, type: "presence", remotes: Array(9).fill(device) },
      { v: 1, type: "cmd", n: 1, action: "next" },
      { v: 1, type: "goto", n: 1, slide: 3, step: 0 },
      state,
    ])
      expect(parseToScreen(f)).toBeNull();
  });
});

describe("limits", () => {
  it("token bucket: burst, then refill over time", () => {
    const b = new TokenBucket(10, 10, 0);
    let ok = 0;
    for (let i = 0; i < 25; i++) if (b.take(0)) ok++;
    expect(ok).toBe(10);
    expect(b.take(50)).toBe(false);
    expect(b.take(100)).toBe(true);
    expect(b.take(100)).toBe(false);
  });

  it("backoff grows from 250 ms to 5 s with jitter", () => {
    expect(backoffDelay(0, 0)).toBe(250);
    expect(backoffDelay(0, 0.999)).toBeLessThanOrEqual(250);
    expect(backoffDelay(1, 0.999)).toBeLessThanOrEqual(500);
    expect(backoffDelay(3, 0)).toBe(1000);
    for (let i = 0; i < 30; i++) {
      const d = backoffDelay(i, Math.random());
      expect(d).toBeGreaterThanOrEqual(250);
      expect(d).toBeLessThanOrEqual(5000);
    }
    expect(backoffDelay(20, 0.999)).toBeGreaterThan(4900);
  });

  it("maps pad offsets to canvas coordinates", () => {
    expect(toCoord(0, 200)).toBe(0);
    expect(toCoord(100, 200)).toBe(5000);
    expect(toCoord(250, 200)).toBe(10_000);
    expect(toCoord(-5, 200)).toBe(0);
    expect(toCoord(10, 0)).toBe(0);
  });
});
