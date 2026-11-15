// SPDX-License-Identifier: AGPL-3.0-or-later
// Remote control (F4) against a real listening server and a real WebSocket client: the upgrade controls (Host,
// Origin, connection cap), first-frame auth and its timeout, oversize frames, pairing (one-time, rate limited,
// pending devices inert until approved), relaying, kick and revocation, newest-screen-wins, shutdown, persistence of
// credentials across a restart, and notes never on the socket nor on /c/.
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { ownerPrincipal } from "@pptaken/core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createServer, type PPTakenServer } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { deviceLabel } from "../src/routes-live.js";
import { type Harness, makeHarness, setupOwner } from "./helpers.js";

const NOTE = "TOP-SECRET-SPEAKER-NOTE";

interface Listening {
  base: string;
  port: number;
  close(): Promise<void>;
}

async function listen(server: PPTakenServer): Promise<Listening> {
  return new Promise((resolve) => {
    const s = serve(
      { fetch: server.fetch, port: 0, hostname: "127.0.0.1" },
      (info: AddressInfo) => {
        const detach = server.attach(s as unknown as import("node:http").Server);
        resolve({
          base: `http://127.0.0.1:${info.port}`,
          port: info.port,
          close: () =>
            new Promise<void>((done) => {
              detach();
              (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
              s.close(() => done());
            }),
        });
      },
    );
  });
}

interface Client {
  ws: WebSocket;
  frames: Record<string, unknown>[];
  raw: string[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  refused: Promise<number>;
  send(frame: unknown): void;
  waitFor(
    pred: (f: Record<string, unknown>) => boolean,
    ms?: number,
  ): Promise<Record<string, unknown>>;
}

function connect(port: number, options: { origin?: string | null; host?: string } = {}): Client {
  const origin = options.origin === undefined ? `http://127.0.0.1:${port}` : options.origin;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    ...(origin === null ? {} : { origin }),
    ...(options.host ? { headers: { Host: options.host } } : {}),
  });
  const frames: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const waiters: {
    pred: (f: Record<string, unknown>) => boolean;
    resolve: (f: Record<string, unknown>) => void;
  }[] = [];
  ws.on("message", (data) => {
    const text = data.toString();
    raw.push(text);
    const f = JSON.parse(text) as Record<string, unknown>;
    frames.push(f);
    for (const w of [...waiters]) {
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  opened.catch(() => {});
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const refused = new Promise<number>((resolve) =>
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    }),
  );
  return {
    ws,
    frames,
    raw,
    opened,
    closed,
    refused,
    send: (frame) => ws.send(typeof frame === "string" ? frame : JSON.stringify(frame)),
    waitFor: (pred, ms = 5000) => {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout; got ${JSON.stringify(frames)}`)),
          ms,
        );
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      });
    },
  };
}

const type = (t: string) => (f: Record<string, unknown>) => f.type === t;

describe("remote control over /ws", () => {
  let h: Harness | undefined;
  let net: Listening | undefined;
  const clients: Client[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.terminate();
    await net?.close();
    net = undefined;
    await h?.cleanup();
    h = undefined;
  });

  async function start() {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const created = await h.server.services.core.createPresentation(ownerPrincipal(), {
      title: "Remote test",
      slides: [
        { id: "one", html: "<h1>One</h1>", notes: NOTE },
        { id: "two", html: "<h1>Two</h1><p data-step>s</p>" },
        { id: "three", html: "<h1>Three</h1>" },
      ],
    });
    net = await listen(h.server);
    const origin = net.base;
    const api = async (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${net?.base}${path}`, {
        method,
        headers: {
          Origin: origin,
          "X-PPTaken-CSRF": "1",
          Cookie: cookie,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const live = (await (
      await api("POST", "/api/v1/live", { deckId: created.presentationId })
    ).json()) as {
      live: { id: string };
      screenTicket: string;
    };
    const open = (opts?: Parameters<typeof connect>[1]) => {
      const c = connect(net?.port as number, opts);
      clients.push(c);
      return c;
    };
    const screen = async () => {
      const r = (await (
        await api("POST", "/api/v1/live", { deckId: created.presentationId })
      ).json()) as {
        screenTicket: string;
      };
      const c = open();
      await c.opened;
      c.send({ v: 1, type: "auth", role: "screen", credential: r.screenTicket });
      await c.waitFor(type("welcome"));
      return c;
    };
    const pair = async (
      ua = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
    ) => {
      const p = (await (await api("POST", `/api/v1/live/${live.live.id}/pairing`, {})).json()) as {
        secret: string;
      };
      const res = await fetch(`${net?.base}/api/v1/remote/pair`, {
        method: "POST",
        headers: {
          Origin: origin,
          "X-PPTaken-CSRF": "1",
          "Content-Type": "application/json",
          "User-Agent": ua,
        },
        body: JSON.stringify({ secret: p.secret }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as {
        credential: string;
        deviceId: string;
        code: string;
        label: string;
      };
    };
    const remote = async (credential: string) => {
      const c = open();
      await c.opened;
      c.send({ v: 1, type: "auth", role: "remote", credential });
      await c.waitFor(type("welcome"));
      return c;
    };
    return { api, live, deckId: created.presentationId, screen, pair, remote, open, origin };
  }

  it("refuses foreign Host and Origin headers, and unknown paths", async () => {
    const t = await start();
    expect(await t.open({ host: "evil.example" }).refused).toBe(403);
    expect(await t.open({ origin: "http://evil.example" }).refused).toBe(403);
    expect(await t.open({ origin: null }).refused).toBe(403);
    expect(await t.open({ origin: "null" }).refused).toBe(403);
    const bad = new WebSocket(`ws://127.0.0.1:${net?.port}/ws/other`, { origin: t.origin });
    const status = await new Promise<number>((resolve) => {
      bad.once("unexpected-response", (_q, r) => resolve(r.statusCode ?? 0));
      bad.once("error", () => resolve(-1));
    });
    expect(status).toBe(404);
    bad.terminate();
  });

  it("needs auth as the first frame, within 5 s, and refuses oversize frames", async () => {
    const t = await start();
    const silent = t.open();
    await silent.opened;
    expect((await silent.closed).code).toBe(4408);
    const rude = t.open();
    await rude.opened;
    rude.send({ v: 1, type: "ping" });
    expect((await rude.closed).code).toBe(4401);
    const forged = t.open();
    await forged.opened;
    forged.send({ v: 1, type: "auth", role: "screen", credential: "x.y" });
    expect((await forged.closed).code).toBe(4401);
    const big = t.open();
    await big.opened;
    big.send(JSON.stringify({ v: 1, type: "auth", role: "remote", credential: "a".repeat(2000) }));
    expect((await big.closed).code).toBe(1009);
  }, 20_000);

  it("caps sockets per IP", async () => {
    const t = await start();
    const open: Client[] = [];
    for (let i = 0; i < 20; i++) open.push(t.open());
    await Promise.all(open.map((c) => c.opened));
    expect(await t.open().refused).toBe(429);
  });

  it("pairs a pending device that is inert until approved, then relays both ways", async () => {
    const t = await start();
    const screen = await t.screen();
    expect(screen.frames[0]).toEqual({ v: 1, type: "welcome", role: "screen", status: "approved" });
    const paired = await t.pair();
    expect(paired.label).toBe("Android · Chrome");
    expect(paired.code).toMatch(/^\d{2}$/);
    const prompt = await screen.waitFor(
      (f) => f.type === "presence" && JSON.stringify(f).includes('"pending"'),
    );
    expect(prompt).toMatchObject({
      remotes: [{ id: paired.deviceId, code: paired.code, status: "pending" }],
    });

    // Pending: no data over HTTP, nothing relayed, nothing received.
    const pending = await t.remote(paired.credential);
    expect(pending.frames).toEqual([{ v: 1, type: "welcome", role: "remote", status: "pending" }]);
    const deck = await fetch(`${net?.base}/api/v1/remote/deck`, {
      headers: { Authorization: `Device ${paired.credential}` },
    });
    expect(deck.status).toBe(403);
    pending.send({ v: 1, type: "cmd", n: 1, action: "next" });
    screen.send({ v: 1, type: "state", seq: 1, slide: 0, step: 0, black: false, slideCount: 3 });
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.frames.some((f) => f.type === "cmd")).toBe(false);
    expect(pending.frames.length).toBe(1);

    // Approve: snapshot, then commands flow and are acknowledged once.
    expect(
      (await t.api("POST", `/api/v1/live/${t.live.live.id}/devices/${paired.deviceId}/approve`, {}))
        .status,
    ).toBe(204);
    const snap = await pending.waitFor(type("snapshot"));
    expect(snap).toEqual({
      v: 1,
      type: "snapshot",
      state: { seq: 1, slide: 0, step: 0, black: false, slideCount: 3 },
      screen: true,
    });
    pending.send({ v: 1, type: "cmd", n: 2, action: "next" });
    pending.send({ v: 1, type: "cmd", n: 2, action: "next" });
    pending.send({ v: 1, type: "goto", n: 3, slide: 2, step: 0 });
    await pending.waitFor((f) => f.type === "ack" && f.n === 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.frames.filter((f) => f.type === "cmd" || f.type === "goto")).toEqual([
      { v: 1, type: "cmd", action: "next" },
      { v: 1, type: "goto", slide: 2, step: 0 },
    ]);
    screen.send({ v: 1, type: "state", seq: 2, slide: 2, step: 0, black: true, slideCount: 3 });
    expect(await pending.waitFor((f) => f.type === "state" && f.seq === 2)).toMatchObject({
      slide: 2,
      black: true,
    });
    // A screen-only frame from a remote is ignored; a remote-only frame from the screen too.
    pending.send({ v: 1, type: "state", seq: 9, slide: 1, step: 0, black: false, slideCount: 3 });
    screen.send({ v: 1, type: "cmd", n: 1, action: "prev" });
    await new Promise((r) => setTimeout(r, 100));
    expect(pending.frames.some((f) => f.type === "state" && f.seq === 9)).toBe(false);

    // Laser.
    pending.send({ v: 1, type: "pointer", x: 5000, y: 2500 });
    expect(await screen.waitFor(type("pointer"))).toEqual({
      v: 1,
      type: "pointer",
      x: 5000,
      y: 2500,
    });

    // Approved: the deck data with notes over HTTP.
    const data = await fetch(`${net?.base}/api/v1/remote/deck`, {
      headers: { Authorization: `Device ${paired.credential}` },
    });
    expect(data.status).toBe(200);
    const body = (await data.json()) as { slides: { notesHtml: string }[]; contentUrl: string };
    expect(body.slides[0]?.notesHtml).toContain(NOTE);
    // Notes never on the socket, never in the content document.
    for (const text of [...screen.raw, ...pending.raw]) expect(text).not.toContain(NOTE);
    const doc = await (await fetch(body.contentUrl)).text();
    expect(doc).toContain("<h1>One</h1>");
    expect(doc).not.toContain(NOTE);
    // Pong.
    pending.send({ v: 1, type: "ping" });
    await pending.waitFor(type("pong"));
  });

  it("pairing codes are one-time and rate limited; bad credentials are refused", async () => {
    const t = await start();
    const p = (await (
      await t.api("POST", `/api/v1/live/${t.live.live.id}/pairing`, {})
    ).json()) as { secret: string };
    const redeem = (secret: string, headers: Record<string, string> = {}) =>
      fetch(`${net?.base}/api/v1/remote/pair`, {
        method: "POST",
        headers: {
          Origin: t.origin,
          "X-PPTaken-CSRF": "1",
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ secret }),
      });
    // CSRF: no header, or another origin.
    expect((await redeem(p.secret, { "X-PPTaken-CSRF": "" })).status).toBe(403);
    expect((await redeem(p.secret, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await redeem(p.secret)).status).toBe(201);
    expect((await redeem(p.secret)).status).toBe(401);
    let limited = false;
    for (let i = 0; i < 12; i++) if ((await redeem("A".repeat(22))).status === 429) limited = true;
    expect(limited).toBe(true);
    const unknown = t.open();
    await unknown.opened;
    unknown.send({ v: 1, type: "auth", role: "remote", credential: "B".repeat(43) });
    expect((await unknown.closed).code).toBe(4401);
    // Owner routes need the session.
    const anon = await fetch(`${net?.base}/api/v1/live/${t.live.live.id}/pairing`, {
      method: "POST",
      headers: { Origin: t.origin, "X-PPTaken-CSRF": "1" },
    });
    expect(anon.status).toBe(401);
    // LAN addresses for the QR when the page is on localhost: IPv4 origins with the request's port.
    const lan = (await (await t.api("GET", "/api/v1/live/lan")).json()) as { addresses: string[] };
    for (const a of lan.addresses)
      expect(a).toMatch(new RegExp(`^http://\\d+\\.\\d+\\.\\d+\\.\\d+:${net?.port}$`));
    // Devices list and ending the session.
    const list = (await (await t.api("GET", `/api/v1/live/${t.live.live.id}/devices`)).json()) as {
      devices: { status: string; online: boolean }[];
    };
    expect(list.devices).toEqual([expect.objectContaining({ status: "pending", online: false })]);
    expect((await t.api("DELETE", `/api/v1/live/${t.live.live.id}`)).status).toBe(204);
    expect((await t.api("GET", `/api/v1/live/${t.live.live.id}/devices`)).status).toBe(404);
  });

  it("kick revokes every remote and closes their sockets; the newest screen wins", async () => {
    const t = await start();
    const screen = await t.screen();
    const a = await t.pair();
    const b = await t.pair(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Version/18.0 Mobile Safari/604.1",
    );
    expect(b.label).toBe("iPhone · Safari");
    // At most two remotes.
    const p3 = (await (
      await t.api("POST", `/api/v1/live/${t.live.live.id}/pairing`, {})
    ).json()) as {
      secret: string;
    };
    const third = await fetch(`${net?.base}/api/v1/remote/pair`, {
      method: "POST",
      headers: { Origin: t.origin, "X-PPTaken-CSRF": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ secret: p3.secret }),
    });
    expect(third.status).toBe(403);
    for (const d of [a, b])
      await t.api("POST", `/api/v1/live/${t.live.live.id}/devices/${d.deviceId}/approve`, {});
    const ra = await t.remote(a.credential);
    const rb = await t.remote(b.credential);
    await ra.waitFor(type("snapshot"));
    const kicked = await t.api("POST", `/api/v1/live/${t.live.live.id}/kick`, {});
    expect(await kicked.json()).toEqual({ revoked: 2 });
    for (const r of [ra, rb]) {
      await r.waitFor(type("revoked"));
      expect((await r.closed).code).toBe(4003);
    }
    const again = t.open();
    await again.opened;
    again.send({ v: 1, type: "auth", role: "remote", credential: a.credential });
    expect((await again.closed).code).toBe(4401);
    // A second screen replaces the first.
    const screen2 = await t.screen();
    await screen.waitFor(type("replaced"));
    expect((await screen.closed).code).toBe(4001);
    expect(screen2.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("relays nothing without a screen (nack no-screen) and closes sockets with 1001 on shutdown", async () => {
    const t = await start();
    const d = await t.pair();
    await t.api("POST", `/api/v1/live/${t.live.live.id}/devices/${d.deviceId}/approve`, {});
    const r = await t.remote(d.credential);
    expect(await r.waitFor(type("snapshot"))).toEqual({
      v: 1,
      type: "snapshot",
      state: null,
      screen: false,
    });
    r.send({ v: 1, type: "cmd", n: 1, action: "next" });
    expect(await r.waitFor(type("nack"))).toEqual({
      v: 1,
      type: "nack",
      n: 1,
      reason: "no-screen",
    });
    h?.server.realtime.close();
    expect((await r.closed).code).toBe(1001);
  });

  it("device credentials survive a server restart", async () => {
    const t = await start();
    const d = await t.pair();
    await t.api("POST", `/api/v1/live/${t.live.live.id}/devices/${d.deviceId}/approve`, {});
    const dataDir = h?.dataDir as string;
    await net?.close();
    net = undefined;
    await h?.server.close();
    const again = await createServer(
      loadConfig({ PPTAKEN_DATA_DIR: dataDir, PPTAKEN_WEB_DIR: `${dataDir}/no-web` }),
      { logSink: () => {}, scrypt: { ln: 10, r: 8, p: 1 }, clock: (h as Harness).clock },
    );
    net = await listen(again);
    const c = connect(net.port, { origin: net.base });
    clients.push(c);
    await c.opened;
    c.send({ v: 1, type: "auth", role: "remote", credential: d.credential });
    expect(await c.waitFor(type("welcome"))).toEqual({
      v: 1,
      type: "welcome",
      role: "remote",
      status: "approved",
    });
    expect(await c.waitFor(type("snapshot"))).toMatchObject({ state: null, screen: false });
    c.ws.terminate();
    await net.close();
    net = undefined;
    await again.close();
    h = {
      ...(h as Harness),
      cleanup: async () => {
        const { rmSync } = await import("node:fs");
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      },
    };
  });
});

describe("device labels", () => {
  it("are short and safe whatever the User-Agent says", () => {
    expect(deviceLabel(undefined)).toBe("Device · Browser");
    expect(deviceLabel("<script>alert(1)</script>")).toBe("Device · Browser");
    expect(
      deviceLabel("Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0"),
    ).toBe("Android · Firefox");
  });
});
