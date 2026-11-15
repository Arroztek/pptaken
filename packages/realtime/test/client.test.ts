// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSocketClient, type SocketLike } from "../dist/client.js";
import { CLOSE, parseToRemote, type ToRemote } from "../dist/index.js";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed: number | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code ?? 1000;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

function makeWin() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    addEventListener: (n: string, f: () => void) => {
      if (!listeners.has(n)) listeners.set(n, new Set());
      listeners.get(n)?.add(f);
    },
    removeEventListener: (n: string, f: () => void) => listeners.get(n)?.delete(f),
    setTimeout: ((f: () => void, ms: number) =>
      setTimeout(f, ms)) as unknown as Window["setTimeout"],
    clearTimeout: ((id: number) => clearTimeout(id)) as unknown as Window["clearTimeout"],
    fire(n: string) {
      for (const f of listeners.get(n) ?? []) f();
    },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("socket client", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  function start(credential = async () => "a".repeat(43) as string | null) {
    const frames: ToRemote[] = [];
    const statuses: string[] = [];
    const win = makeWin();
    const client = createSocketClient<ToRemote>({
      url: "ws://x/ws",
      role: "remote",
      credential,
      parse: parseToRemote,
      onFrame: (f) => frames.push(f),
      onStatus: (s, r) => statuses.push(r ? `${s}:${r}` : s),
      WebSocketImpl: FakeSocket,
      win: win as never,
      random: () => 0,
    });
    return { client, frames, statuses, win };
  }

  it("sends auth first, opens on welcome, never queues while disconnected", async () => {
    const { client, frames, statuses } = start();
    expect(client.send({ v: 1, type: "cmd", n: 1, action: "next" })).toBe(false);
    await flush();
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.open();
    expect(ws.sent).toEqual([{ v: 1, type: "auth", role: "remote", credential: "a".repeat(43) }]);
    expect(client.send({ v: 1, type: "cmd", n: 1, action: "next" })).toBe(false); // not authenticated yet
    ws.receive({ v: 1, type: "welcome", role: "remote", status: "approved" });
    expect(statuses).toContain("open");
    expect(client.send({ v: 1, type: "cmd", n: 2, action: "next" })).toBe(true);
    ws.receive({ v: 1, type: "bogus" });
    ws.receive({ v: 1, type: "ack", n: 2, extra: true });
    expect(frames.map((f) => f.type)).toEqual(["welcome"]);
    // Nothing sent while down is replayed after a reconnect.
    ws.drop();
    expect(client.send({ v: 1, type: "cmd", n: 3, action: "next" })).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    const ws2 = FakeSocket.all[1] as FakeSocket;
    ws2.open();
    ws2.receive({ v: 1, type: "welcome", role: "remote", status: "approved" });
    expect(ws2.sent).toEqual([{ v: 1, type: "auth", role: "remote", credential: "a".repeat(43) }]);
  });

  it("volatile frames are skipped while data is buffered", async () => {
    const { client } = start();
    await flush();
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.open();
    ws.receive({ v: 1, type: "welcome", role: "remote", status: "approved" });
    ws.bufferedAmount = 10;
    expect(client.sendVolatile({ v: 1, type: "pointer", x: 1, y: 1 })).toBe(false);
    ws.bufferedAmount = 0;
    expect(client.sendVolatile({ v: 1, type: "pointer", x: 1, y: 1 })).toBe(true);
  });

  it("pings every 10 s and drops a connection after two missed pongs", async () => {
    start();
    await flush();
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.open();
    ws.receive({ v: 1, type: "welcome", role: "remote", status: "approved" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.sent.at(-1)).toEqual({ v: 1, type: "ping" });
    ws.receive({ v: 1, type: "pong" });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000); // second miss: dead
    expect(ws.closed).not.toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.all.length).toBe(2);
  });

  it("backs off up to 5 s, and reconnects at once on online / pageshow / visibility", async () => {
    const { win } = start();
    await flush();
    for (let i = 0; i < 6; i++) {
      (FakeSocket.all.at(-1) as FakeSocket).drop();
      await vi.advanceTimersByTimeAsync(5000);
    }
    const count = FakeSocket.all.length;
    (FakeSocket.all.at(-1) as FakeSocket).drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeSocket.all.length).toBe(count);
    win.fire("online");
    await flush();
    expect(FakeSocket.all.length).toBe(count + 1);
  });

  it("stops for good when revoked, and never throws when the credential cannot be fetched", async () => {
    let calls = 0;
    const { statuses } = start(async () => {
      calls += 1;
      if (calls === 1) throw new Error("server down");
      return "a".repeat(43);
    });
    await flush();
    expect(FakeSocket.all.length).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.open();
    ws.receive({ v: 1, type: "welcome", role: "remote", status: "approved" });
    ws.receive({ v: 1, type: "revoked" });
    ws.drop(CLOSE.revoked);
    expect(statuses.at(-1)).toBe("closed:revoked");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all.length).toBe(1);
  });

  it("stops without a credential", async () => {
    const { statuses } = start(async () => null);
    await flush();
    expect(statuses.at(-1)).toBe("closed:unauthorized");
    expect(FakeSocket.all.length).toBe(0);
  });
});
