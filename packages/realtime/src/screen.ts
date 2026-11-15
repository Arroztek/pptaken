// SPDX-License-Identifier: Apache-2.0
// The screen side of the remote control, in the player page (the window the audience sees).
//
// The shell stays the single source of truth for {slide, step, black}: remote commands are applied as LOCAL input
// (`player.next()`, `player.goto()`, `player.black()`), exactly as if a key were pressed, so the presenter window
// keeps following over its BroadcastChannel, and every change the shell reports (`onChange`) is published to the
// server as `state`. The socket never touches the shell's navigation code, and socket failures never reach it:
// with the server down the presentation goes on.
//
// The socket is opened on demand: when the live session of the deck already has paired devices (a reload during a
// talk), or once the presenter opens the pairing panel. A presentation nobody pairs a phone with opens no socket.

import { createSocketClient, type SocketClient, type SocketStatus, socketUrl } from "./client.js";
import { apiJson } from "./dom.js";
import type { Locale } from "./i18n.js";
import { createPanel, type LiveInfo, type Panel, type QrEncoder } from "./panel.js";
import { type DeviceView, parseToScreen, type ToScreen } from "./protocol.js";

/** What the screen needs from the player shell (`createPlayer`). */
export interface ScreenPlayer {
  next(): void;
  prev(): void;
  first(): void;
  last(): void;
  goto(slide: number, step?: number): void;
  black(on?: boolean): void;
  pointer(point: { x: number; y: number } | null): void;
  getState(): { slide: number; step: number; black: boolean; slideCount: number } | null;
}

export interface RemoteScreenOptions {
  deckId: string;
  player: ScreenPlayer;
  /** Where the panel and the prompt are mounted (the player host, visible in full screen). */
  mount: HTMLElement;
  qr: QrEncoder;
  locale?: Locale;
  fetch?: typeof fetch;
  /** Status changes (tests and the page's `data-remote` attribute). */
  onStatus?(status: SocketStatus | "off", devices: readonly DeviceView[]): void;
}

export interface RemoteScreen {
  /** Forward every `onChange` of the player here. */
  onChange(state: { slide: number; step: number; black: boolean; slideCount: number }): void;
  /**
   * Forward the player's `onKey` here: R toggles the panel, K disconnects every remote, Enter / Escape answer the
   * approval prompt. Keys forwarded by the content iframe count only during a real user gesture.
   */
  onKey(code: string, source: "page" | "frame"): boolean;
  panel: Panel;
  destroy(): void;
}

interface LiveResponse {
  live: { id: string; devices: number };
  screenTicket: string;
  publicUrl: string | null;
}

/** A user gesture is in progress in this page (a real key press inside the iframe propagates it here). */
function activated(win: Window): boolean {
  return (
    (win.navigator as { userActivation?: { isActive?: boolean } }).userActivation?.isActive === true
  );
}

export function startRemoteScreen(options: RemoteScreenOptions): RemoteScreen {
  const doc = options.mount.ownerDocument;
  const win = doc.defaultView as Window;
  const fetchImpl = options.fetch ?? win.fetch.bind(win);
  const { player } = options;
  let client: SocketClient | null = null;
  let liveInfo: LiveInfo | null = null;
  let seq = 0;
  let last = "";
  let devices: DeviceView[] = [];
  let status: SocketStatus | "off" = "off";

  const report = (): void => {
    try {
      options.onStatus?.(status, devices);
    } catch {
      // ignore
    }
  };

  /** Creates or reuses the deck's live session; returns a fresh screen ticket. */
  const ensureLive = async (): Promise<{ info: LiveInfo; ticket: string }> => {
    const r = await apiJson<LiveResponse>(fetchImpl, "POST", "/api/v1/live", {
      deckId: options.deckId,
    });
    liveInfo = { liveId: r.live.id, publicUrl: r.publicUrl };
    return { info: liveInfo, ticket: r.screenTicket };
  };

  const publish = (force: boolean): void => {
    const s = player.getState();
    if (!s || !client) return;
    const key = `${s.slide}/${s.step}/${s.black}/${s.slideCount}`;
    if (!force && key === last) return;
    const sent = client.send({
      v: 1,
      type: "state",
      seq: seq % 2_147_483_647,
      slide: s.slide,
      step: s.step,
      black: s.black,
      slideCount: s.slideCount,
    });
    if (sent) {
      last = key;
      seq += 1;
    }
  };

  const apply = (frame: ToScreen): void => {
    switch (frame.type) {
      case "welcome":
        publish(true); // re-announce: the server rebuilds its snapshot from this
        return;
      case "cmd":
        if (frame.action === "next") player.next();
        else if (frame.action === "prev") player.prev();
        else if (frame.action === "first") player.first();
        else if (frame.action === "last") player.last();
        else player.black();
        return;
      case "goto":
        player.goto(frame.slide, frame.step);
        return;
      case "pointer":
        player.pointer({ x: frame.x, y: frame.y });
        return;
      case "pointer-off":
        player.pointer(null);
        return;
      case "presence":
        devices = frame.remotes;
        panel.setDevices(frame.remotes);
        report();
        return;
      case "replaced":
      case "pong":
        return;
    }
  };

  const connect = (): void => {
    if (client) {
      client.poke();
      return;
    }
    client = createSocketClient<ToScreen>({
      url: socketUrl(win.location),
      role: "screen",
      credential: async () => (await ensureLive()).ticket,
      parse: parseToScreen,
      onFrame: apply,
      onStatus: (s) => {
        status = s;
        if (s !== "open") player.pointer(null);
        if (s === "closed") client = null;
        report();
      },
    });
  };

  const panel = createPanel({
    doc,
    mount: options.mount,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    qr: options.qr,
    fetch: fetchImpl,
    live: async () => {
      if (liveInfo) return liveInfo;
      return (await ensureLive()).info;
    },
    onOpenChange: (open) => {
      if (open) connect();
    },
  });

  // On load: reconnect at once if this deck's live session already has paired devices (a reload mid-talk).
  void (async () => {
    try {
      const r = await apiJson<{ live: { id: string; devices: number } | null }>(
        fetchImpl,
        "GET",
        `/api/v1/live?deck=${encodeURIComponent(options.deckId)}`,
      );
      if (r.live !== null && r.live.devices > 0) connect();
    } catch {
      // Offline or signed out: the presentation does not need the remote.
    }
  })();
  report();

  return {
    onChange: () => publish(false),
    onKey: (code, source) => {
      const gated = source === "frame" && !activated(win);
      if (panel.promptVisible() && (code === "Enter" || code === "Escape")) {
        if (gated) return true; // swallow a forged key, never act on it
        void (code === "Enter" ? panel.approvePrompt() : panel.denyPrompt());
        return true;
      }
      if (code === "KeyR") {
        if (!gated) panel.toggle();
        return true;
      }
      if (code === "KeyK") {
        if (!gated) void panel.kick();
        return true;
      }
      if (code === "Escape" && panel.isOpen()) {
        panel.close();
        return true;
      }
      return false;
    },
    panel,
    destroy: () => {
      client?.stop();
      panel.destroy();
    },
  };
}
