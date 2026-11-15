// SPDX-License-Identifier: Apache-2.0
// The phone page (`/r`): pairing, navigation, black screen, laser, and (once approved) notes, the next slide and a
// local clock. Framework-free; the page script injects the player modules it needs (served from /_player/).
//
// Pairing: the QR opens `/r#<secret>`. The fragment is stripped at once (`history.replaceState`) and the secret is
// redeemed over HTTP (`POST /api/v1/remote/pair`) for a device credential, kept in localStorage and sent as the
// first socket frame. The device stays PENDING (inert) until the presenter approves it on the laptop, where the
// same two-digit code shows.
//
// State: the phone shows only what the server confirmed (`snapshot`, `state`), never its own guess; commands are
// numbered and never replayed after a reconnect. Notes and slide previews come over HTTP with the device credential
// (`GET /api/v1/remote/deck`), never over the socket.

import { createSocketClient, type SocketClient, type SocketStatus, socketUrl } from "./client.js";
import { HttpError, h, isLoopbackHost } from "./dom.js";
import { type Locale, type RemoteLabels, remoteLabels } from "./i18n.js";
import {
  type Action,
  COORD_MAX,
  parseToRemote,
  type ScreenState,
  type ToRemote,
} from "./protocol.js";

export const STORAGE_KEY = "pptaken.remote";
/** The pairing secret in the fragment: 128 bits, base64url. */
export const PAIRING_SECRET = /^[A-Za-z0-9_-]{22}$/;
/** At most one laser frame per animation frame and per this interval (30/s). */
export const LASER_INTERVAL_MS = 34;

interface Stored {
  credential: string;
  liveId: string;
  code: string;
  expiresAt: number;
}

export interface PreviewPlayer {
  goto(slide: number, step?: number): void;
  readonly ready: Promise<readonly { id: string; steps: number }[]>;
  destroy(): void;
}

export interface PhoneDeps {
  createPlayer(
    host: HTMLElement,
    options: {
      contentUrl: string;
      hash: boolean;
      keyboard: boolean;
      help: boolean;
      title: string;
      initial: { slide: number; step: number };
    },
  ): PreviewPlayer;
  next(
    shape: { slides: readonly { id: string; steps: number }[] },
    p: { slide: number; step: number },
  ): { slide: number; step: number };
  setNotesHtml(target: HTMLElement, html: string): void;
  pace: {
    clockIdle(): { running: boolean; startedAt: number; accumulated: number };
    clockElapsed(
      c: { running: boolean; startedAt: number; accumulated: number },
      now: number,
    ): number;
    clockToggle(
      c: { running: boolean; startedAt: number; accumulated: number },
      now: number,
    ): { running: boolean; startedAt: number; accumulated: number };
    buildPlan(
      slides: readonly { section?: string | undefined; durationHintSec?: number | undefined }[],
      targetMinutes?: number,
    ): unknown;
    paceAt(
      plan: never,
      slide: number,
      elapsedSec: number,
    ): { status: "ahead" | "behind" | "on-time"; deltaSec: number } | null;
    formatClock(seconds: number): string;
  };
}

export interface PhoneOptions {
  root: HTMLElement;
  deps: PhoneDeps;
  locale?: Locale;
  fetch?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
}

interface DeckData {
  liveId: string;
  title: string;
  revision: number;
  aspectRatio: "16:9" | "4:3";
  targetMinutes?: number;
  slides: {
    id: string;
    title: string;
    section?: string;
    durationHintSec?: number;
    notesHtml: string;
  }[];
  contentUrl: string;
}

/** Maps a point inside a box to integer canvas coordinates 0..10000 (clamped). */
export function toCoord(offset: number, size: number): number {
  if (!(size > 0) || !Number.isFinite(offset)) return 0;
  return Math.round(Math.min(Math.max(offset / size, 0), 1) * COORD_MAX);
}

function readStored(storage: PhoneOptions["storage"], now: number): Stored | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored>;
    if (
      typeof v.credential !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(v.credential) ||
      typeof v.liveId !== "string" ||
      typeof v.code !== "string" ||
      typeof v.expiresAt !== "number" ||
      v.expiresAt <= now
    ) {
      storage?.removeItem(STORAGE_KEY);
      return null;
    }
    return v as Stored;
  } catch {
    return null;
  }
}

const CSS_BUTTON = "pr-button";

/** The phone page stylesheet (served as /_rt/phone.css). */
export const PHONE_CSS = `
[hidden]{display:none!important}
html,body{margin:0;min-height:100%;background:#0F1115;color:#F2EFE9;font:16px/1.4 Inter,system-ui,sans-serif;-webkit-text-size-adjust:100%}
#app{box-sizing:border-box;max-width:720px;margin:0 auto;padding:12px 12px calc(12px + env(safe-area-inset-bottom))}
.pr-top{display:flex;align-items:center;gap:8px;font:14px/1.3 'JetBrains Mono',ui-monospace,monospace;color:#8B8FA0;margin-bottom:8px}
.pr-dot{width:10px;height:10px;border-radius:50%;background:#8B8FA0;flex:none}
.pr-dot[data-on="true"]{background:#3DD68C}
.pr-top .pr-pos{margin-left:auto;color:#F2EFE9}
.pr-msg{margin:12px 0;padding:12px;border-radius:8px;background:#16181D}
.pr-code{font:700 40px/1.1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.1em;margin:8px 0}
.pr-stage{position:relative;width:100%;background:#000;border-radius:6px;overflow:hidden}
.pr-stage>.pr-preview{position:absolute;inset:0}
.pr-pad{position:absolute;inset:0;z-index:2;touch-action:none;cursor:crosshair;outline:2px solid #FF3B30;outline-offset:-2px}
.pr-black{position:absolute;inset:0;z-index:1;background:rgba(0,0,0,.8);color:#8B8FA0;display:flex;align-items:center;justify-content:center;font-size:14px;text-align:center;padding:8px}
.pr-row{display:flex;gap:8px;margin-top:8px}
.pr-row>button{flex:1}
.pr-button{font:inherit;min-height:48px;padding:8px;border-radius:8px;border:1px solid #3A3F4B;background:#22252D;color:#F2EFE9;touch-action:manipulation}
.pr-button[aria-pressed="true"]{background:#3A1C1A;border-color:#FF3B30}
.pr-big{min-height:88px;font-size:20px;font-weight:600}
.pr-button:disabled{opacity:.4}
.pr-section{margin-top:12px}
.pr-section h2{margin:0 0 4px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#8B8FA0}
.pr-notes{font-size:18px;line-height:1.5;overflow-wrap:anywhere}
.pr-next{position:relative;width:50%;background:#000;border-radius:4px;overflow:hidden}
.pr-next>.pr-preview{position:absolute;inset:0}
.pr-clock{display:flex;align-items:center;gap:8px;font:20px 'JetBrains Mono',ui-monospace,monospace}
.pr-clock .pr-button{min-height:40px;font:14px Inter,system-ui,sans-serif}
.pr-note{font-size:13px;color:#FF9F43;margin:8px 0 0}
.pr-flash{color:#FF9F43}
`;

export interface Phone {
  destroy(): void;
}

export function startPhone(options: PhoneOptions): Phone {
  const { root, deps } = options;
  const doc = root.ownerDocument;
  const win = doc.defaultView as Window;
  const body = doc.body;
  const t: RemoteLabels = remoteLabels(options.locale);
  const fetchImpl = options.fetch ?? win.fetch.bind(win);
  const storage =
    options.storage === undefined
      ? (() => {
          try {
            return win.localStorage;
          } catch {
            return null;
          }
        })()
      : options.storage;
  const now = options.now ?? (() => Date.now());

  let stored: Stored | null = readStored(storage, now());
  let client: SocketClient | null = null;
  let approved = false;
  let screenOn = false;
  let state: ScreenState | null = null;
  let data: DeckData | null = null;
  let loading = false;
  let n = 0;
  let laserOn = false;
  let current: PreviewPlayer | null = null;
  let upcoming: PreviewPlayer | null = null;
  let shape: { slides: readonly { id: string; steps: number }[] } | null = null;
  let clock = deps.pace.clockIdle();
  let plan: unknown = null;
  let tick: ReturnType<typeof setInterval> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const set = (key: string, value: string): void => {
    body.dataset[key] = value;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Layout

  const dot = h(doc, "span", { class: "pr-dot", "aria-hidden": "true" });
  const statusText = h(doc, "span", { role: "status" });
  const pos = h(doc, "span", { class: "pr-pos" });
  const top = h(doc, "div", { class: "pr-top" }, dot, statusText, pos);
  const message = h(doc, "div", { class: "pr-msg" });
  const codeBox = h(doc, "div", { class: "pr-code", "data-pptaken-code": "" });
  message.hidden = true;
  codeBox.hidden = true;

  const stage = h(doc, "div", { class: "pr-stage", "data-pptaken-stage": "" });
  const stagePreview = h(doc, "div", { class: "pr-preview" });
  const blackCover = h(doc, "div", { class: "pr-black" }, t.phoneIsBlack);
  blackCover.hidden = true;
  const pad = h(doc, "div", {
    class: "pr-pad",
    "data-pptaken-pad": "",
    "aria-label": t.phoneLaser,
  });
  pad.hidden = true;
  stage.append(stagePreview, blackCover, pad);

  const button = (label: string, cls = "", attrs: Record<string, string> = {}) =>
    h(doc, "button", { type: "button", class: `${CSS_BUTTON} ${cls}`.trim(), ...attrs }, label);
  const prevButton = button(t.phonePrev, "pr-big", { "data-action": "prev" });
  const nextButton = button(t.phoneNext, "pr-big", { "data-action": "next" });
  const firstButton = button(t.phoneFirst, "", { "data-action": "first" });
  const lastButton = button(t.phoneLast, "", { "data-action": "last" });
  const blackButton = button(t.phoneBlack, "", { "data-action": "black", "aria-pressed": "false" });
  const laserButton = button(t.phoneLaser, "", { "data-action": "laser", "aria-pressed": "false" });
  const controls = h(
    doc,
    "div",
    {},
    h(doc, "div", { class: "pr-row" }, prevButton, nextButton),
    h(doc, "div", { class: "pr-row" }, firstButton, blackButton, laserButton, lastButton),
  );

  const notes = h(doc, "div", { class: "pr-notes", "data-pptaken-notes": "" });
  const notesSection = h(
    doc,
    "section",
    { class: "pr-section" },
    h(doc, "h2", {}, t.phoneNotes),
    notes,
  );
  const nextBox = h(doc, "div", { class: "pr-next" });
  const nextPreview = h(doc, "div", { class: "pr-preview" });
  const endText = h(doc, "p", {}, t.phoneEnd);
  endText.hidden = true;
  nextBox.append(nextPreview);
  const nextSection = h(
    doc,
    "section",
    { class: "pr-section" },
    h(doc, "h2", {}, t.phoneNextSlide),
    nextBox,
    endText,
  );
  const elapsed = h(doc, "span", { "data-pptaken-elapsed": "" }, "0:00");
  const paceText = h(doc, "span", { style: "font-size:14px;color:#8B8FA0" });
  const clockButton = button(t.phoneStart);
  const resetButton = button(t.phoneReset);
  const clockSection = h(
    doc,
    "section",
    { class: "pr-section" },
    h(doc, "h2", {}, t.phoneClock),
    h(doc, "div", { class: "pr-clock" }, elapsed, clockButton, resetButton, paceText),
  );
  notesSection.hidden = true;
  nextSection.hidden = true;
  clockSection.hidden = true;

  const notesBox = h(doc, "div", {});
  const sleepNote = h(doc, "p", { class: "pr-note" }, t.phoneSleep);
  const httpNote = h(doc, "p", { class: "pr-note" }, t.phoneHttp);
  httpNote.hidden = !(win.location.protocol === "http:" && !isLoopbackHost(win.location.hostname));
  notesBox.append(sleepNote, httpNote);

  const main = h(
    doc,
    "div",
    {},
    stage,
    controls,
    clockSection,
    notesSection,
    nextSection,
    notesBox,
  );
  main.hidden = true;
  root.replaceChildren(top, message, codeBox, main);

  // ---------------------------------------------------------------------------------------------------------------
  // Rendering

  const say = (text: string, kind: string): void => {
    message.hidden = false;
    message.textContent = text;
    set("state", kind);
  };

  const setAspect = (ratio: "16:9" | "4:3"): void => {
    const css = ratio === "4:3" ? "4 / 3" : "16 / 9";
    stage.style.aspectRatio = css;
    nextBox.style.aspectRatio = css;
    set("aspect", ratio);
  };
  setAspect("16:9");

  const renderStatus = (socket: SocketStatus | "idle"): void => {
    set("socket", socket);
    set("screen", String(screenOn));
    const live = socket === "open" && approved;
    dot.dataset.on = String(live && screenOn);
    statusText.textContent =
      socket !== "open"
        ? t.phoneConnecting
        : !approved
          ? (t.phonePending.split(".")[0] ?? "")
          : screenOn
            ? t.phoneReady
            : t.phoneScreenOff;
    const enabled = live && screenOn;
    for (const b of [prevButton, nextButton, firstButton, lastButton, blackButton, laserButton]) {
      b.disabled = !enabled;
    }
    if (!enabled && laserOn) setLaser(false);
  };

  const renderClock = (): void => {
    const ms = deps.pace.clockElapsed(clock, now());
    elapsed.textContent = deps.pace.formatClock(ms / 1000);
    clockButton.textContent = clock.running ? t.phonePause : t.phoneStart;
    paceText.textContent = "";
    if (plan !== null && state) {
      const p = deps.pace.paceAt(plan as never, state.slide, ms / 1000);
      if (p) {
        paceText.textContent =
          p.status === "on-time"
            ? t.phoneOnTime
            : `${deps.pace.formatClock(Math.abs(p.deltaSec))} ${p.status === "ahead" ? t.phoneAhead : t.phoneBehind}`;
      }
    }
  };

  const renderState = (): void => {
    if (!state) {
      pos.textContent = "";
      return;
    }
    set("slide", String(state.slide));
    set("step", String(state.step));
    set("black", String(state.black));
    pos.textContent = `${state.slide + 1} / ${state.slideCount}`;
    blackButton.setAttribute("aria-pressed", String(state.black));
    blackCover.hidden = !state.black;
    if (data && state.slideCount !== data.slides.length && !loading) {
      void loadData(); // stale: the deck changed (new revision)
      return;
    }
    current?.goto(state.slide, state.step);
    if (data) {
      const slide = data.slides[state.slide];
      if (slide && slide.notesHtml !== "") deps.setNotesHtml(notes, slide.notesHtml);
      else notes.textContent = t.phoneNoNotes;
    }
    if (shape && upcoming) {
      const nx = deps.next(shape, { slide: state.slide, step: state.step });
      const atEnd = nx.slide === state.slide && nx.step === state.step;
      endText.hidden = !atEnd;
      nextBox.hidden = atEnd;
      if (!atEnd) upcoming.goto(nx.slide, nx.step);
    }
    renderClock();
  };

  const flash = (text: string): void => {
    statusText.textContent = text;
    statusText.classList.add("pr-flash");
    win.clearTimeout(flashTimer);
    flashTimer = win.setTimeout(() => {
      statusText.classList.remove("pr-flash");
      renderStatus(client?.status() ?? "idle");
    }, 2000);
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Data (HTTP, device credential)

  const dropPreviews = (): void => {
    current?.destroy();
    upcoming?.destroy();
    current = null;
    upcoming = null;
    shape = null;
    stagePreview.replaceChildren();
    nextPreview.replaceChildren();
  };

  const loadData = async (): Promise<void> => {
    if (!stored || loading) return;
    loading = true;
    try {
      const res = await fetchImpl("/api/v1/remote/deck", {
        headers: { Authorization: `Device ${stored.credential}` },
        credentials: "omit",
        cache: "no-store",
      });
      if (!res.ok) throw new HttpError(res.status, "");
      data = (await res.json()) as DeckData;
      setAspect(data.aspectRatio === "4:3" ? "4:3" : "16:9");
      plan = deps.pace.buildPlan(data.slides, data.targetMinutes);
      dropPreviews();
      const at = state ?? { slide: 0, step: 0 };
      current = deps.createPlayer(stagePreview, {
        contentUrl: data.contentUrl,
        hash: false,
        keyboard: false,
        help: false,
        title: data.title,
        initial: { slide: at.slide, step: at.step },
      });
      upcoming = deps.createPlayer(nextPreview, {
        contentUrl: data.contentUrl,
        hash: false,
        keyboard: false,
        help: false,
        title: t.phoneNextSlide,
        initial: { slide: at.slide, step: at.step },
      });
      const mine = current;
      void current.ready.then((slides) => {
        if (current !== mine) return;
        shape = { slides };
        set("previews", "ready");
        renderState();
      });
      notesSection.hidden = false;
      nextSection.hidden = false;
      clockSection.hidden = false;
      set("data", "loaded");
      renderState();
    } catch {
      set("data", "error");
    } finally {
      loading = false;
    }
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Socket

  const forget = (text: string, kind: string): void => {
    try {
      storage?.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    stored = null;
    approved = false;
    client?.stop();
    client = null;
    dropPreviews();
    main.hidden = true;
    codeBox.hidden = true;
    say(text, kind);
  };

  const onFrame = (frame: ToRemote): void => {
    switch (frame.type) {
      case "welcome":
        approved = frame.status === "approved";
        if (!approved) {
          say(t.phonePending, "pending");
          codeBox.hidden = false;
          codeBox.textContent = stored?.code ?? "";
          main.hidden = true;
        }
        break;
      case "presence":
        screenOn = frame.screen;
        if (frame.status === "approved" && !approved) approved = true;
        break;
      case "snapshot":
        screenOn = frame.screen;
        approved = true;
        state = frame.state;
        message.hidden = true;
        codeBox.hidden = true;
        main.hidden = false;
        set("state", "ready");
        if (!data && !loading) void loadData();
        renderState();
        break;
      case "state":
        state = {
          seq: frame.seq,
          slide: frame.slide,
          step: frame.step,
          black: frame.black,
          slideCount: frame.slideCount,
        };
        screenOn = true;
        renderState();
        break;
      case "nack":
        if (frame.reason === "no-screen") {
          screenOn = false;
          flash(t.phoneScreenOff);
        }
        break;
      case "revoked":
        forget(t.phoneRevoked, "revoked");
        return;
      case "ack":
      case "pong":
        return;
    }
    renderStatus(client?.status() ?? "idle");
  };

  const connect = (): void => {
    if (!stored || client) return;
    set("state", "connecting");
    client = createSocketClient<ToRemote>({
      url: socketUrl(win.location),
      role: "remote",
      credential: async () => stored?.credential ?? null,
      parse: parseToRemote,
      onFrame,
      onStatus: (s, reason) => {
        if (s === "closed") {
          if (reason === "revoked") forget(t.phoneRevoked, "revoked");
          else if (reason === "ended") forget(t.phoneEnded, "ended");
          else if (reason === "unauthorized") forget(t.phoneRevoked, "revoked");
          return;
        }
        if (s !== "open") setLaser(false);
        renderStatus(s);
      },
    });
  };

  const send = (action: Action): void => {
    if (!client || !approved) return;
    n += 1;
    client.send({ v: 1, type: "cmd", n, action });
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Laser: absolute mapping over the deck-shaped pad, coalesced per animation frame, at most 30/s, never queued.

  let pendingPoint: { x: number; y: number } | null = null;
  let lastSent = 0;
  let raf = 0;
  let pressed = false;

  const flush = (): void => {
    raf = 0;
    if (!pendingPoint || !client) return;
    const at = now();
    if (at - lastSent < LASER_INTERVAL_MS) {
      raf = win.requestAnimationFrame(flush);
      return;
    }
    if (client.sendVolatile({ v: 1, type: "pointer", ...pendingPoint })) {
      lastSent = at;
      pendingPoint = null;
    } else {
      raf = win.requestAnimationFrame(flush); // socket busy: keep only the newest point
    }
  };

  const point = (ev: PointerEvent): void => {
    const r = pad.getBoundingClientRect();
    pendingPoint = {
      x: toCoord(ev.clientX - r.left, r.width),
      y: toCoord(ev.clientY - r.top, r.height),
    };
    if (!raf) raf = win.requestAnimationFrame(flush);
  };

  const release = (): void => {
    if (!pressed) return;
    pressed = false;
    pendingPoint = null;
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    client?.send({ v: 1, type: "pointer-off" });
  };

  pad.addEventListener("pointerdown", (ev) => {
    pressed = true;
    try {
      pad.setPointerCapture(ev.pointerId);
    } catch {
      // ignore
    }
    ev.preventDefault();
    point(ev);
  });
  pad.addEventListener("pointermove", (ev) => {
    if (pressed) point(ev);
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    pad.addEventListener(name, release);
  }

  function setLaser(on: boolean): void {
    laserOn = on;
    pad.hidden = !on;
    laserButton.setAttribute("aria-pressed", String(on));
    if (!on) release();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Controls

  prevButton.addEventListener("click", () => send("prev"));
  nextButton.addEventListener("click", () => send("next"));
  firstButton.addEventListener("click", () => send("first"));
  lastButton.addEventListener("click", () => send("last"));
  blackButton.addEventListener("click", () => send("black"));
  laserButton.addEventListener("click", () => setLaser(!laserOn));
  clockButton.addEventListener("click", () => {
    clock = deps.pace.clockToggle(clock, now());
    renderClock();
  });
  resetButton.addEventListener("click", () => {
    clock = deps.pace.clockIdle();
    renderClock();
  });
  tick = win.setInterval(renderClock, 1000);

  // Screen wake lock where available (secure contexts only); otherwise the note above stays.
  const wake = (win.navigator as { wakeLock?: { request(type: "screen"): Promise<unknown> } })
    .wakeLock;
  if (wake && win.isSecureContext) {
    const request = () => {
      if (doc.visibilityState === "visible") wake.request("screen").catch(() => {});
    };
    request();
    doc.addEventListener("visibilitychange", request);
    sleepNote.hidden = true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Start: strip the fragment first, then redeem it (or reuse the stored credential).

  /** Reads the fragment and strips it from the URL (and from the history entry) at once. */
  const takeFragment = (): string => {
    const value = win.location.hash.slice(1);
    if (win.location.hash !== "") {
      try {
        win.history.replaceState(null, "", win.location.pathname + win.location.search);
      } catch {
        // ignore
      }
    }
    return value;
  };
  const fragment = takeFragment();
  renderStatus("idle");

  /** Drops the current connection and everything shown for it (a new QR code scanned in this tab). */
  const reset = (): void => {
    client?.stop();
    client = null;
    approved = false;
    screenOn = false;
    state = null;
    data = null;
    setLaser(false);
    dropPreviews();
    main.hidden = true;
    delete body.dataset.data;
    delete body.dataset.previews;
  };

  const pair = async (secret: string): Promise<void> => {
    reset();
    say(t.phonePairing, "pairing");
    try {
      const res = await fetchImpl("/api/v1/remote/pair", {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-PPTaken-CSRF": "1" },
        body: JSON.stringify({ secret }),
      });
      if (!res.ok) {
        if (stored) {
          // A stale QR (already used) on a phone that is still paired: keep the pairing.
          connect();
          return;
        }
        say(
          res.status === 401
            ? t.phoneExpired
            : res.status === 403
              ? t.phoneLimit
              : res.status === 429
                ? t.phoneRateLimited
                : t.phoneError,
          "error",
        );
        return;
      }
      const r = (await res.json()) as {
        credential: string;
        liveId: string;
        code: string;
        expiresAt: string;
      };
      stored = {
        credential: r.credential,
        liveId: r.liveId,
        code: r.code,
        expiresAt: Date.parse(r.expiresAt),
      };
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(stored));
      } catch {
        // Private mode: the pairing lasts as long as the page.
      }
      say(t.phonePending, "pending");
      codeBox.hidden = false;
      codeBox.textContent = r.code;
      connect();
    } catch {
      say(t.phoneError, "error");
    }
  };

  if (PAIRING_SECRET.test(fragment)) void pair(fragment);
  else if (stored) connect();
  else say(t.phoneScan, "unpaired");

  // A QR code scanned while this page is open may reuse the tab: a same-document navigation to /r#<secret>.
  const onHash = (): void => {
    const next = takeFragment();
    if (PAIRING_SECRET.test(next)) void pair(next);
  };
  win.addEventListener("hashchange", onHash);

  return {
    destroy: () => {
      client?.stop();
      win.removeEventListener("hashchange", onHash);
      win.clearInterval(tick);
      dropPreviews();
    },
  };
}
