// SPDX-License-Identifier: Apache-2.0
// The shell: the trusted side of the player, running in the app page. It owns the navigation state and the mode,
// mounts the deck document in a sandboxed iframe (opaque origin) and drives it through the validated postMessage
// protocol. No persistent chrome: a black host, the content, and on-demand layers (slide counter, key help).
// Optional: a presenter window kept in sync over a BroadcastChannel, and printing (one page per slide).
// Offline: the content reports its in-memory preload (`preload`); the shell keeps the indicator state (an 8 px
// dot when `indicator` is on, the text on demand) and can mount an offline deck document through `srcdoc`.

import { type Labels, type Locale, labelsFor } from "./i18n.js";
import { type KeyCode, keyCodeOf } from "./keys.js";
import { LASER_TIMEOUT_MS, laserGeometry } from "./laser.js";
import * as nav from "./navigation.js";
import { KEY_ACTIONS, type KeyAction } from "./navigation.js";
import {
  isOfflineDocument,
  OFFLINE_DOT,
  OFFLINE_LABEL,
  type OfflineStatus,
  offlineStatus,
} from "./offline.js";
import {
  type ContentMessage,
  isHelloMessage,
  type Mode,
  overviewColumns,
  PROTOCOL_VERSION,
  type PreloadMessage,
  parseContentMessage,
  type ShellMessage,
  type SlideInfo,
} from "./protocol.js";
import { openSync, type Sync } from "./sync.js";

export type { OfflineState, OfflineStatus } from "./offline.js";

export interface PlayerState {
  /** 0-based slide index. */
  slide: number;
  /** Revealed steps of the slide. */
  step: number;
  slideId: string;
  slideCount: number;
  /** Number of steps of the current slide. */
  stepCount: number;
  black: boolean;
  mode: Mode;
  /** The slide highlighted in the overview (equals `slide` outside it). */
  highlight: number;
}

/**
 * `unexpected-navigation`: the content loaded a second document. Script mode only: `protocol` (the content broke
 * the handshake or announced a deck the server did not) and `unresponsive` (no heartbeat for 3.5 s: the frame was
 * removed and, with `fallbackUrl`, replaced by the static version).
 */
export type PlayerFault = "unexpected-navigation" | "protocol" | "unresponsive";

/** Where a key came from: the app page, or forwarded by the content iframe. */
export type KeySource = "page" | "frame";

export interface PlayerOptions {
  /**
   * URL of the deck document (the content route, ideally on a separate cookie-less origin). http(s) only. Exactly
   * one of `contentUrl` and `contentHtml` is required.
   */
  contentUrl?: string | undefined;
  /**
   * An offline deck document (`buildOfflineDocument`), mounted with `srcdoc` in the same sandboxed iframe. It must
   * start with the no-network CSP `<meta>` (checked, fail closed). The page's own CSP also applies to it (a srcdoc
   * frame inherits it), so the page must allow the runtime's hash and `data:` fonts.
   */
  contentHtml?: string | undefined;
  /** Show the 8 px offline status dot in the top-right corner (outside the canvas). Default `false`. */
  indicator?: boolean;
  /** Called whenever the offline status changes (preload report, offline copy). */
  onOffline?(status: OfflineStatus): void;
  /** Initial position (0-based slide). The URL hash wins when `hash` is enabled and present. */
  initial?: nav.Position;
  /** Keep the state in the URL hash `#/<slide 1-based>/<step>`. Default `true`. */
  hash?: boolean;
  /** Handle keys on the parent document (keys in the iframe are always forwarded). Default `true`. */
  keyboard?: boolean;
  /** Show `n / N` in neutral gray for 2 s after each move. Default `false`. */
  showHud?: boolean;
  /** Accessible name of the iframe. Default `"Presentation"`. */
  title?: string;
  /** The key help overlay on `?`. Default: on when `keyboard` is on. */
  help?: boolean;
  /** Language of the player's own texts (key help). Default `"en"`. */
  locale?: Locale;
  /** Same-origin URL of the presenter view, opened in a second window with `s`. Without it, `s` does nothing. */
  presenterUrl?: string;
  /** BroadcastChannel name (see `syncChannelName`) shared with the presenter view. Without it, no sync. */
  sync?: string;
  /**
   * Called for every key before the shell acts on it. Return `true` to take it over (the shell then ignores it).
   * Used by the presenter view to drive its previews.
   */
  onKey?(code: KeyCode, source: KeySource): boolean;
  /**
   * Called once if the content has not reported ready after `loadTimeoutMs`. Nothing is blanked and a later `ready`
   * still works; use it to tell the user the presentation is slow or cannot load (for example in a preview pane
   * that does not run sandboxed iframes).
   */
  onLoadTimeout?(): void;
  /** Milliseconds to wait for the content before `onLoadTimeout`. Default 10000; `0` disables it. */
  loadTimeoutMs?: number;
  onReady?(slides: readonly SlideInfo[]): void;
  /** Called after every change of position, black screen or mode. */
  onChange?(state: PlayerState): void;
  /** Called when the iframe confirms what it shows (a `state` message) in present mode. */
  onRender?(position: nav.Position): void;
  /** Called when the content misbehaves; the player blanks the iframe and stops. */
  onFault?(fault: PlayerFault): void;
  /** Adds the remote-control keys (R: pair a phone, K: disconnect every remote) to the key help. */
  remoteKeys?: boolean;
  /**
   * Script mode (ADR-020): the document at `contentUrl` runs approved author scripts. The shell then treats the
   * frame as hostile: private port handshake, `ready` once and checked against `expect`, `preload` unverified,
   * `state` checked, every gated key, `Enter` and `f` from the frame dropped before `onKey`, navigation keys from
   * the frame rate-limited (10/s), and a watchdog on the runtime's heartbeat. Ignored with `contentHtml`.
   */
  scripts?: boolean;
  /** Script mode: the slide ids and canvas the server built the document from; `ready` must match them. */
  expect?: { slides: readonly string[]; width: number; height: number };
  /**
   * Script mode: the URL of the static version, asked for when the watchdog removes an unresponsive frame. Without
   * it the player stops after showing the notice.
   */
  fallbackUrl?: () => Promise<string | null>;
  /** Script mode: author code of a slide threw (reported by the runtime, no details). */
  onScriptError?(slide: number): void;
}

export interface Player {
  /** Goes to a 0-based slide and step (clamped). Ignored until the deck is ready. */
  goto(slide: number, step?: number): void;
  next(): void;
  prev(): void;
  first(): void;
  last(): void;
  /** Toggles the black screen, or sets it with `on`. */
  black(on?: boolean): void;
  /** Toggles full screen on the host element. */
  toggleFullscreen(): Promise<void>;
  /** Opens or closes the overview (toggles without `on`). */
  overview(on?: boolean): void;
  /**
   * Prints the deck (every step, one page per slide): switches the content to print mode, opens the browser's print
   * dialog and returns to present mode on `afterprint`. Resolves when printing is over.
   */
  print(): Promise<void>;
  /** Opens (or focuses) the presenter window, if `presenterUrl` is set. */
  openPresenter(): void;
  /** Shows or hides the key help overlay (toggles without `on`). */
  help(on?: boolean): void;
  /**
   * Shows the laser dot at a canvas point (integers 0..10000 along the canvas width and height), or hides it with
   * `null`. Drawn by the shell above the iframe; hidden after 1.5 s without a new point, under the black screen,
   * in the overview and in print.
   */
  pointer(point: { x: number; y: number } | null): void;
  /** Current state, or `null` until the deck is ready. */
  getState(): PlayerState | null;
  /** The logical canvas size, or `null` until the deck is ready. */
  getCanvas(): { width: number; height: number } | null;
  /** The offline status (indicator state, preload counts, failures, offline copy). */
  getOffline(): OfflineStatus;
  /** Tells the shell whether an offline copy of this deck is stored (layer 2); upgrades `ready`. */
  setOfflineCopy(on: boolean): void;
  /** The iframe element (for focus management and tests). Replaced when the watchdog loads the static version. */
  readonly iframe: HTMLIFrameElement;
  /** Script mode is active (the current frame runs author scripts). */
  readonly scripted: boolean;
  /** Resolves when the deck document has reported its slides. */
  readonly ready: Promise<readonly SlideInfo[]>;
  destroy(): void;
}

const HUD_MS = 2000;
const HASH_MS = 400;
const PRINT_ACK_MS = 1500;
const TYPING = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const CHROME = "#8B8FA0";
const CHROME_BG = "rgba(0,0,0,.86)";
const MONO = "'JetBrains Mono',ui-monospace,monospace";
/** Keys that change the mode or open windows: from the iframe they need a real user gesture (see `activated`). */
const GATED = new Set<KeyCode>(["KeyO", "KeyS", "KeyP", "Question", "KeyR", "KeyK"]);
/**
 * Script mode: the only keys accepted from the frame (navigation, black screen, Escape). Everything that opens
 * windows, changes the mode, prints, toggles full screen, or answers a remote-control prompt (`Enter`, `R`, `K`)
 * works only from the trusted page.
 */
export const FRAME_KEYS_IN_SCRIPT_MODE: ReadonlySet<KeyCode> = new Set<KeyCode>([
  "ArrowRight",
  "ArrowLeft",
  "ArrowUp",
  "ArrowDown",
  "PageDown",
  "PageUp",
  "Space",
  "ShiftSpace",
  "Backspace",
  "Home",
  "End",
  "KeyB",
  "Period",
  "Escape",
]);
/** Script mode: navigation keys accepted from the frame per second. */
export const FRAME_KEYS_PER_SECOND = 10;
/** Script mode: heartbeat interval of the runtime and missed beats before the watchdog fires. */
export const BEAT_MS = 1000;
export const WATCHDOG_MS = 3 * BEAT_MS + 500;
export const PRESENTER_WINDOW = "pptaken-presenter";

function checkedHttpUrl(url: string, base: string, what: string): URL {
  const parsed = new URL(url, base);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`${what} must be an http(s) URL`);
  }
  return parsed;
}

function isTyping(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const el = target as HTMLElement;
  return el.isContentEditable || el.closest(TYPING) !== null;
}

function nextFrame(win: Window): Promise<void> {
  return new Promise((resolve) => win.requestAnimationFrame(() => resolve()));
}

/**
 * Rows of the key help overlay: `[keys, what]`. With a presenter window, its own keys are listed too (clock,
 * reset, and Esc to finish at the end of the talk).
 */
export function keyHelpRows(t: Labels, presenter: boolean, remote: boolean): [string, string][] {
  const rows: [string, string][] = [
    ["→ Space PgDn Enter", t.helpNext],
    ["← Backspace PgUp", t.helpPrev],
    ["Home End", t.helpFirstLast],
    ["B .", t.helpBlack],
    ["F", t.helpFullscreen],
    ["O", t.helpOverview],
  ];
  if (presenter)
    rows.push(
      ["S", t.helpPresenter],
      ["T", t.helpClock],
      ["Shift+R", t.helpClockReset],
      ["Esc", t.helpFinish],
    );
  if (remote) rows.push(["R", t.helpRemote], ["K", t.helpKick]);
  rows.push(["P", t.helpPrint], ["?", t.helpHelp], ["Esc", t.helpClose]);
  return rows;
}

export function createPlayer(host: HTMLElement, options: PlayerOptions): Player {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new TypeError("host must be attached to a window");
  if ((options.contentUrl === undefined) === (options.contentHtml === undefined)) {
    throw new TypeError("pass exactly one of contentUrl and contentHtml");
  }
  let src: string | null = null;
  if (options.contentUrl !== undefined) {
    src = checkedHttpUrl(options.contentUrl, doc.baseURI, "contentUrl").href;
  } else if (!isOfflineDocument(options.contentHtml)) {
    throw new TypeError(
      "contentHtml is not an offline deck document (no-network CSP <meta> first)",
    );
  }
  let presenterUrl: string | null = null;
  if (options.presenterUrl !== undefined) {
    const p = checkedHttpUrl(options.presenterUrl, doc.baseURI, "presenterUrl");
    if (p.origin !== win.location.origin) throw new TypeError("presenterUrl must be same-origin");
    presenterUrl = p.href;
  }
  const useHash = options.hash !== false;
  const useKeyboard = options.keyboard !== false;
  const useHelp = options.help ?? useKeyboard;
  const labels = labelsFor(options.locale);
  const reduced = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const fade = reduced ? "none" : "opacity 200ms cubic-bezier(.2,0,0,1)";

  let slides: SlideInfo[] | null = null;
  let canvas: { width: number; height: number } | null = null;
  let position: nav.Position = options.initial ?? { slide: 0, step: 0 };
  if (useHash) position = nav.parseHash(win.location.hash) ?? position;
  let mode: Mode = "present";
  let cursor = 0;
  let blackOn = false;
  let faulted = false;
  let loads = 0;
  /** Set while applying a change that came from the other window, so it is not sent back. */
  let remote = false;
  let printing: Promise<void> | null = null;
  let endPrint: (() => void) | null = null;
  let ack: (() => void) | null = null;
  let presenterWindow: Window | null = null;
  let preload: PreloadMessage | null = null;
  let offlineCopy = false;
  let offline = offlineStatus(null, false);
  // Script mode (ADR-020): set from the options for the first frame only; the static fallback frame is plain.
  let scriptMode = options.scripts === true && src !== null;
  let port: MessagePort | null = null;
  let helloSeen = false;
  let readySeen = false;
  let lastBeat = 0;
  let destroyed = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const frameKeyTimes: number[] = [];
  let notice: HTMLDivElement | null = null;
  let hudTimer: ReturnType<typeof setTimeout> | undefined;
  let hashTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady: (slides: readonly SlideInfo[]) => void = () => {};
  const ready = new Promise<readonly SlideInfo[]>((resolve) => {
    resolveReady = resolve;
  });

  // Host: black, no chrome. Only positioned if the page left it static.
  if (win.getComputedStyle(host).position === "static") host.style.position = "relative";
  host.style.background = "#000";
  host.style.overflow = "hidden";

  const makeFrame = (): HTMLIFrameElement => {
    const frame = doc.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("allow", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = options.title ?? "Presentation";
    frame.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#000";
    return frame;
  };
  let iframe = makeFrame();
  // Script mode: the host can take focus back from the frame (Escape), so trusted keys work again.
  if (scriptMode && !host.hasAttribute("tabindex")) host.tabIndex = -1;

  const curtain = doc.createElement("div");
  curtain.setAttribute("aria-hidden", "true");
  curtain.style.cssText = "position:absolute;inset:0;background:#000;display:none";

  // Offline status dot: 8 px, top-right corner of the letterbox, hidden with the black screen. Text on demand.
  let dot: HTMLDivElement | null = null;
  if (options.indicator) {
    dot = doc.createElement("div");
    dot.setAttribute("role", "img");
    dot.style.cssText =
      "position:absolute;top:12px;right:12px;width:8px;height:8px;border-radius:50%;pointer-events:none";
  }

  let hud: HTMLDivElement | null = null;
  if (options.showHud) {
    hud = doc.createElement("div");
    hud.setAttribute("aria-hidden", "true");
    hud.style.cssText =
      "position:absolute;right:16px;bottom:16px;padding:6px 10px;border-radius:4px;" +
      `background:rgba(0,0,0,.6);color:${CHROME};font:14px/1 ${MONO};` +
      `pointer-events:none;opacity:0;transition:${fade}`;
  }

  // Key help: neutral gray mono over translucent black, only while asked for.
  let helpBox: HTMLDivElement | null = null;
  let helpStatus: HTMLDivElement | null = null;
  let helpOn = false;
  if (useHelp) {
    helpBox = doc.createElement("div");
    helpBox.setAttribute("role", "dialog");
    helpBox.setAttribute("aria-label", labels.helpTitle);
    helpBox.hidden = true;
    helpBox.style.cssText =
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:calc(100% - 32px);" +
      `max-height:calc(100% - 32px);overflow:auto;box-sizing:border-box;padding:20px 24px;border-radius:6px;background:${CHROME_BG};` +
      `color:${CHROME};font:14px/1.6 ${MONO};opacity:0;transition:${fade}`;
    const title = doc.createElement("div");
    title.textContent = labels.helpTitle;
    title.style.cssText = "margin-bottom:8px;letter-spacing:.08em;text-transform:uppercase";
    const table = doc.createElement("table");
    table.style.cssText = "border-collapse:collapse;font:inherit;color:inherit";
    for (const [keys, what] of keyHelpRows(
      labels,
      presenterUrl !== null,
      options.remoteKeys === true,
    )) {
      const row = table.insertRow();
      const k = row.insertCell();
      k.textContent = keys;
      k.style.cssText = "padding:2px 24px 2px 0;white-space:nowrap;color:#F2EFE9";
      row.insertCell().textContent = what;
    }
    helpStatus = doc.createElement("div");
    helpStatus.style.cssText = "margin-top:12px";
    helpBox.append(title, table, helpStatus);
  }

  // Laser: a trusted layer above the iframe (and above the black layer, which hides it explicitly).
  const laser = doc.createElement("div");
  laser.setAttribute("aria-hidden", "true");
  laser.setAttribute("data-pptaken-laser", "");
  laser.style.cssText =
    "position:absolute;left:0;top:0;border-radius:50%;pointer-events:none;display:none;will-change:transform;" +
    "background:#FF3B30;box-shadow:0 0 0 2px rgba(255,59,48,.35),0 0 12px 4px rgba(255,59,48,.55)";
  let laserTimer: ReturnType<typeof setTimeout> | undefined;
  const hideLaser = (): void => {
    clearTimeout(laserTimer);
    laserTimer = undefined;
    laser.style.display = "none";
  };
  const showLaser = (point: { x: number; y: number } | null): void => {
    if (point === null || !canvas || faulted || blackOn || mode !== "present" || printing) {
      hideLaser();
      return;
    }
    const g = laserGeometry(
      { width: host.clientWidth, height: host.clientHeight },
      canvas,
      point.x,
      point.y,
    );
    if (!g) return hideLaser();
    laser.style.width = `${g.size}px`;
    laser.style.height = `${g.size}px`;
    laser.style.transform = `translate3d(${g.x - g.size / 2}px,${g.y - g.size / 2}px,0)`;
    laser.style.display = "block";
    clearTimeout(laserTimer);
    laserTimer = setTimeout(hideLaser, LASER_TIMEOUT_MS);
  };

  const send = (message: ShellMessage): void => {
    // The content has an opaque origin, so "*" is the only possible target; messages carry no secrets.
    iframe.contentWindow?.postMessage(message, "*");
  };

  const state = (): PlayerState | null => {
    if (!slides) return null;
    const info = slides[position.slide];
    return {
      slide: position.slide,
      step: position.step,
      slideId: info?.id ?? "",
      slideCount: slides.length,
      stepCount: info?.steps ?? 0,
      black: blackOn,
      mode,
      highlight: mode === "overview" ? cursor : position.slide,
    };
  };

  const showHudText = (text: string): void => {
    if (!hud) return;
    hud.textContent = text;
    hud.style.opacity = "1";
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      if (hud) hud.style.opacity = "0";
    }, HUD_MS);
  };

  const flashHud = (): void => {
    if (!slides || mode !== "present") return;
    showHudText(`${position.slide + 1} / ${slides.length}`);
  };

  /** Recomputes the offline status; updates the dot and help text, and tells the page when the state changes. */
  const renderOffline = (): void => {
    const previous = offline;
    offline = offlineStatus(preload, offlineCopy, scriptMode);
    const text = labels[OFFLINE_LABEL[offline.state]];
    if (dot) {
      dot.style.background = OFFLINE_DOT[offline.state];
      dot.setAttribute("aria-label", text);
      dot.setAttribute("data-offline", offline.state);
    }
    if (helpStatus) helpStatus.textContent = `${labels.offlineTitle}: ${text}`;
    if (previous.state === offline.state && previous.copy === offline.copy) return;
    if (previous.state === "loading" && mode === "present" && !faulted) showHudText(text);
    options.onOffline?.(offline);
  };

  // Browsers rate-limit history.replaceState (WebKit throws after 100 calls in 30 s), and a presenter can press
  // next many times per second: the hash is written once navigation pauses for HASH_MS.
  const writeHash = (): void => {
    clearTimeout(hashTimer);
    hashTimer = undefined;
    if (!useHash || !slides || faulted) return;
    const hash = nav.formatHash(position);
    if (win.location.hash === hash) return;
    try {
      win.history.replaceState(win.history.state, "", hash);
    } catch {
      // Rate limited or not allowed: the hash is a convenience, the player keeps working.
    }
  };
  const scheduleHash = (): void => {
    if (!useHash) return;
    clearTimeout(hashTimer);
    hashTimer = setTimeout(writeHash, HASH_MS);
  };

  const notify = (): void => {
    const s = state();
    if (s) options.onChange?.(s);
  };

  let sync: Sync | null = null;

  /** Sets the position. The content shows it in present mode; other modes show it when they close. */
  const apply = (target: nav.Position, force = false): void => {
    if (!slides || faulted) return;
    const p = nav.clamp({ slides }, target);
    if (!force && nav.samePosition(p, position)) return;
    position = p;
    if (mode === "present")
      send({ v: PROTOCOL_VERSION, type: "goto", slide: p.slide, step: p.step });
    if (!remote) sync?.send({ v: PROTOCOL_VERSION, type: "nav", slide: p.slide, step: p.step });
    scheduleHash();
    flashHud();
    notify();
  };

  const move = (fn: (shape: nav.DeckShape, p: nav.Position) => nav.Position): void => {
    if (slides) apply(fn({ slides }, position));
  };

  const setBlack = (on?: boolean): void => {
    const value = on ?? !blackOn;
    if (value === blackOn) return;
    blackOn = value;
    curtain.style.display = blackOn ? "block" : "none";
    if (blackOn) hideLaser();
    if (dot) dot.style.visibility = blackOn ? "hidden" : "visible"; // a black screen is all black
    if (!remote) sync?.send({ v: PROTOCOL_VERSION, type: "black", on: blackOn });
    notify();
  };

  const toggleFullscreen = async (): Promise<void> => {
    try {
      if (doc.fullscreenElement === host) await doc.exitFullscreen();
      else await host.requestFullscreen();
    } catch {
      // Refused by the browser (no user activation, permissions policy...): nothing to do.
    }
  };

  const setMode = (next: Mode): void => {
    if (next === mode) return;
    mode = next;
    if (next !== "present") hideLaser();
    send({ v: PROTOCOL_VERSION, type: "mode", mode: next });
    if (next === "present") apply(position, true);
    else notify();
  };

  // Overview: the shell owns the highlight (`cursor`); `goto` moves it in the content.
  const overview = (on?: boolean): void => {
    if (!slides || faulted || printing) return;
    const open = on ?? mode !== "overview";
    if (open && mode === "present") {
      cursor = position.slide;
      setMode("overview");
    } else if (!open && mode === "overview") {
      setMode("present");
    }
  };

  const highlight = (index: number): void => {
    if (!slides || mode !== "overview" || index === cursor) return;
    cursor = index;
    send({ v: PROTOCOL_VERSION, type: "goto", slide: index, step: 0 });
    notify();
  };

  const choose = (slide: number): void => {
    if (!slides || mode !== "overview" || slide >= slides.length) return;
    position = { slide, step: 0 };
    mode = "present";
    send({ v: PROTOCOL_VERSION, type: "mode", mode: "present" });
    apply(position, true);
  };

  const showHelp = (on?: boolean): void => {
    if (!helpBox) return;
    const box = helpBox;
    helpOn = on ?? !helpOn;
    if (helpOn) {
      box.hidden = false;
      void box.offsetWidth; // start the fade from opacity 0
      box.style.opacity = "1";
    } else {
      box.style.opacity = "0";
      setTimeout(
        () => {
          if (!helpOn) box.hidden = true;
        },
        reduced ? 0 : 200,
      );
    }
  };

  // Printing: the content stacks every slide (all steps) at canvas size; the iframe grows to N canvases and the
  // page prints at the canvas size, so the browser slices it into one page per slide.
  const printStyle = doc.createElement("style");
  const layoutForPrint = (on: boolean): void => {
    if (!on || !slides || !canvas) {
      host.removeAttribute("data-pptaken-printing");
      printStyle.remove();
      return;
    }
    const w = canvas.width;
    const h = canvas.height * slides.length;
    printStyle.textContent =
      `@media print{@page{size:${w}px ${canvas.height}px;margin:0}` +
      "html,body{margin:0!important;padding:0!important;height:auto!important;min-height:0!important;overflow:visible!important;background:#000!important}" +
      "body>:not([data-pptaken-printing]):not(:has([data-pptaken-printing])){display:none!important}}" +
      `[data-pptaken-printing]{position:relative!important;inset:auto!important;left:0!important;top:0!important;width:${w}px!important;height:${h}px!important;overflow:visible!important;transform:none!important}` +
      `[data-pptaken-printing]>iframe{position:absolute!important;left:0!important;top:0!important;width:${w}px!important;height:${h}px!important}` +
      "[data-pptaken-printing]>:not(iframe){display:none!important}" +
      "*{print-color-adjust:exact!important;-webkit-print-color-adjust:exact!important}";
    doc.head.append(printStyle);
    host.setAttribute("data-pptaken-printing", "");
  };

  const finishPrint = (): void => {
    if (!endPrint) return;
    const end = endPrint;
    endPrint = null;
    layoutForPrint(false);
    setMode("present");
    end();
  };

  const startPrint = (): Promise<void> | null => {
    if (!slides || !canvas || faulted || printing) return null;
    if (mode === "overview") setMode("present");
    if (helpOn) showHelp(false);
    layoutForPrint(true);
    const done = new Promise<void>((resolve) => {
      endPrint = resolve;
    });
    printing = done.then(() => {
      printing = null;
    });
    setMode("print");
    return done;
  };

  const print = async (): Promise<void> => {
    const done = startPrint();
    if (!done) return printing ?? undefined;
    // Wait until the content confirms print mode (or a short timeout), then for layout.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PRINT_ACK_MS);
      ack = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    ack = null;
    await nextFrame(win);
    await nextFrame(win);
    if (endPrint) {
      try {
        win.print();
      } catch {
        finishPrint();
      }
    }
    return done;
  };

  // Printing from the browser menu (Ctrl+P): same layout, best effort (the content's print CSS does the rest).
  const onBeforePrint = (): void => {
    if (!printing) void startPrint();
  };
  const onAfterPrint = (): void => finishPrint();

  const openPresenter = (): void => {
    if (!presenterUrl) return;
    if (presenterWindow && !presenterWindow.closed) {
      presenterWindow.focus();
      return;
    }
    presenterWindow = win.open(presenterUrl, PRESENTER_WINDOW, "popup,width=1280,height=800");
  };

  /** A user gesture is in progress (keys pressed inside the iframe propagate it to this page). */
  const activated = (): boolean =>
    (win.navigator as { userActivation?: { isActive?: boolean } }).userActivation?.isActive ===
    true;

  const act = (action: KeyAction): void => {
    switch (action) {
      case "next":
        return move(nav.next);
      case "prev":
        return move(nav.prev);
      case "first":
        return move(nav.first);
      case "last":
        return move(nav.last);
      case "black":
        return setBlack();
      case "fullscreen":
        void toggleFullscreen();
        return;
      case "overview":
        return overview(true);
      case "presenter":
        return openPresenter();
      case "print":
        void print();
        return;
      case "help":
        return showHelp();
      case "close":
        if (helpOn) showHelp(false);
        return;
      case "clock":
      case "clockReset":
      case "remote":
      case "kick":
        return;
    }
  };

  /** Script mode: at most FRAME_KEYS_PER_SECOND keys from the frame in any second. */
  const frameKeyAllowed = (): boolean => {
    const now = Date.now();
    while (frameKeyTimes.length > 0 && now - (frameKeyTimes[0] ?? 0) >= 1000) frameKeyTimes.shift();
    if (frameKeyTimes.length >= FRAME_KEYS_PER_SECOND) return false;
    frameKeyTimes.push(now);
    return true;
  };

  const handleKey = (code: KeyCode, source: KeySource): void => {
    // The gate comes first: a key the frame may not send never reaches `onKey` (the remote control's prompt and
    // panel keys live there).
    if (source === "frame") {
      if (scriptMode) {
        if (!FRAME_KEYS_IN_SCRIPT_MODE.has(code) || !frameKeyAllowed()) return;
        // Escape gives the keyboard back to the trusted page; frame keys never reach `onKey` in script mode.
        if (code === "Escape") host.focus({ preventScroll: true });
      } else {
        if (GATED.has(code) && !activated()) return;
        if (options.onKey?.(code, source)) return;
      }
    } else if (options.onKey?.(code, source)) {
      return;
    }
    if (printing) {
      finishPrint();
      return;
    }
    if (mode === "overview" && slides) {
      const to = nav.overviewMove(slides.length, overviewColumns(slides.length), cursor, code);
      if (to !== null) return highlight(to);
      if (code === "Enter") return choose(cursor);
      if (code === "Escape" || code === "KeyO") return overview(false);
      if (code === "KeyB" || code === "Period" || code === "KeyF") act(KEY_ACTIONS[code]);
      return;
    }
    if (helpOn && code === "Escape") return showHelp(false);
    act(KEY_ACTIONS[code]);
  };

  const stopScripts = (): void => {
    clearInterval(watchdog);
    watchdog = undefined;
    if (port !== null) {
      port.onmessage = null;
      port.close();
      port = null;
    }
  };

  const fault = (reason: PlayerFault): void => {
    if (faulted) return;
    faulted = true;
    stopScripts();
    iframe.removeAttribute("srcdoc"); // srcdoc wins over src: drop it first
    iframe.src = "about:blank";
    options.onFault?.(reason);
  };

  /** A plain element over the stage (never an iframe: it could share the busy content process, spike S5). */
  const showNotice = (text: string | null): void => {
    if (text === null) {
      notice?.remove();
      notice = null;
      return;
    }
    if (!notice) {
      notice = doc.createElement("div");
      notice.setAttribute("role", "status");
      notice.setAttribute("data-pptaken-notice", "");
      notice.style.cssText =
        "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:32px;" +
        `box-sizing:border-box;background:#000;color:${CHROME};font:16px/1.5 ${MONO};text-align:center`;
      host.append(notice);
    }
    notice.textContent = text;
  };

  /** Watchdog: the runtime beats every second; 3 missed beats while the page is visible remove the frame. */
  const startWatchdog = (): void => {
    lastBeat = Date.now();
    watchdog = setInterval(() => {
      const now = Date.now();
      // Hidden pages throttle timers (and printing blocks them): only count time the page could hear beats.
      if (doc.visibilityState !== "visible" || printing) lastBeat = now;
      if (now - lastBeat > WATCHDOG_MS) unresponsive();
    }, BEAT_MS / 2);
  };

  const unresponsive = (): void => {
    if (faulted || !scriptMode) return;
    stopScripts();
    scriptMode = false;
    iframe.removeEventListener("load", onLoad);
    iframe.remove(); // detach the busy document first
    showNotice(labels.scriptsStopped);
    options.onFault?.("unresponsive");
    const fallback = options.fallbackUrl;
    if (!fallback) {
      faulted = true;
      return;
    }
    void fallback().then(
      (url) => {
        if (url === null || destroyed) {
          faulted = true;
          return;
        }
        const next = makeFrame();
        next.src = checkedHttpUrl(url, doc.baseURI, "fallbackUrl").href;
        loads = 0;
        helloSeen = false;
        readySeen = false;
        preload = null;
        renderOffline();
        next.addEventListener("load", onLoad);
        iframe = next;
        host.insertBefore(next, curtain);
      },
      () => {
        faulted = true;
      },
    );
  };

  /** Script mode: `ready` must name exactly the slides and canvas the server built the document from. */
  const matchesExpectation = (slideIds: readonly string[], w: number, h: number): boolean => {
    const e = options.expect;
    if (!e) return true;
    return (
      e.width === w &&
      e.height === h &&
      e.slides.length === slideIds.length &&
      e.slides.every((id, i) => slideIds[i] === id)
    );
  };

  const onPortMessage = (event: MessageEvent): void => {
    if (faulted || !scriptMode) return;
    const message = parseContentMessage(event.data);
    if (message) handleContent(message);
  };

  const onMessage = (event: MessageEvent): void => {
    // Only our iframe, which always has an opaque origin ("null"), and only well-formed messages.
    if (faulted || event.source !== iframe.contentWindow || event.origin !== "null") return;
    if (scriptMode) {
      // The runtime's first message transfers the private port; nothing else on `window` is ever accepted.
      if (helloSeen) return;
      helloSeen = true;
      const transferred = event.ports[0];
      if (!isHelloMessage(event.data, event.ports) || transferred === undefined) {
        fault("protocol");
        return;
      }
      port = transferred;
      port.onmessage = onPortMessage;
      startWatchdog();
      return;
    }
    const message: ContentMessage | null = parseContentMessage(event.data);
    if (message) handleContent(message);
  };

  const handleContent = (message: ContentMessage): void => {
    switch (message.type) {
      case "ready": {
        if (scriptMode) {
          if (readySeen) return;
          readySeen = true;
          const ids = message.slides.map((x) => x.id);
          if (!matchesExpectation(ids, message.width, message.height)) {
            fault("protocol");
            return;
          }
        } else if (notice !== null) {
          showNotice(null); // the static fallback is up
        }
        const first = slides === null;
        slides = message.slides;
        canvas = { width: message.width, height: message.height };
        mode = "present";
        send({ v: PROTOCOL_VERSION, type: "mode", mode: "present" });
        apply(position, true);
        if (first) {
          options.onReady?.(slides);
          resolveReady(slides);
          sync?.send({ v: PROTOCOL_VERSION, type: "hello" });
        }
        return;
      }
      case "key":
        return handleKey(message.code, "frame");
      case "state": {
        if (scriptMode) {
          // Only a state inside the deck, at the position the shell asked for, counts.
          const info = slides?.[message.slide];
          if (!info || message.step > info.steps) return;
          const asked = message.slide === position.slide && message.step === position.step;
          if (mode === "present" && !asked) return;
        }
        ack?.();
        if (mode === "present") options.onRender?.({ slide: message.slide, step: message.step });
        return;
      }
      case "select":
        // Only meaningful while the shell has the overview open; otherwise the content asked for it: ignore.
        return choose(message.slide);
      case "preload":
        // Once, after `ready`. It only drives the indicator: navigation never waits for it. In script mode the
        // report could come from author code: the indicator says "not verified", never "ready".
        if (!slides || preload) return;
        preload = message;
        return renderOffline();
      case "beat":
        if (scriptMode) lastBeat = Date.now();
        return;
      case "error":
        if (scriptMode && slides && message.slide < slides.length) {
          // A discreet notice in the presenter window only; nothing on the audience screen.
          sync?.send({ v: PROTOCOL_VERSION, type: "script-error", slide: message.slide });
          options.onScriptError?.(message.slide);
        }
        return;
    }
  };

  // A deck document loads exactly once. Another load means the content navigated the iframe (for example with a
  // <meta http-equiv="refresh"> that slipped past the sanitizer): treat it as a fault.
  const onLoad = (): void => {
    loads += 1;
    if (loads > 1) fault("unexpected-navigation");
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!useKeyboard || event.defaultPrevented || isTyping(event.target)) return;
    const code = keyCodeOf(event);
    if (!code) return;
    event.preventDefault();
    handleKey(code, "page");
  };

  // A hash edited by hand: go there (clamped); an invalid one is replaced by the current position.
  const onHashChange = (): void => {
    const p = nav.parseHash(win.location.hash);
    if (p) apply(p);
    writeHash();
  };

  if (options.sync !== undefined) {
    sync = openSync(options.sync, (message) => {
      if (!slides || faulted) return;
      remote = true;
      try {
        if (message.type === "hello") {
          remote = false;
          sync?.send({ v: PROTOCOL_VERSION, type: "nav", ...position });
          sync?.send({ v: PROTOCOL_VERSION, type: "black", on: blackOn });
        } else if (message.type === "nav") {
          apply({ slide: message.slide, step: message.step });
        } else if (message.type === "black") {
          setBlack(message.on);
        }
      } finally {
        remote = false;
      }
    });
  }

  win.addEventListener("message", onMessage);
  doc.addEventListener("keydown", onKeyDown);
  win.addEventListener("beforeprint", onBeforePrint);
  win.addEventListener("afterprint", onAfterPrint);
  if (useHash) {
    win.addEventListener("hashchange", onHashChange);
    win.addEventListener("pagehide", writeHash);
  }
  iframe.addEventListener("load", onLoad);
  if (src !== null) iframe.src = src;
  else iframe.srcdoc = options.contentHtml ?? "";
  host.append(iframe, curtain);
  if (hud) host.append(hud);
  if (helpBox) host.append(helpBox);
  if (dot) host.append(dot);
  host.append(laser); // last: above every other layer (it hides itself under the black screen)
  renderOffline();

  // The content should report ready quickly. If it does not, tell the page once; nothing is blanked.
  const loadTimeoutMs = options.loadTimeoutMs ?? 10_000;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  if (loadTimeoutMs > 0) {
    loadTimer = setTimeout(() => {
      if (slides === null && !faulted) options.onLoadTimeout?.();
    }, loadTimeoutMs);
  }
  void ready.then(() => clearTimeout(loadTimer));

  return {
    goto: (slide, step = 0) => apply({ slide, step }),
    next: () => move(nav.next),
    prev: () => move(nav.prev),
    first: () => move(nav.first),
    last: () => move(nav.last),
    black: setBlack,
    toggleFullscreen,
    overview,
    print,
    openPresenter,
    help: showHelp,
    pointer: showLaser,
    getState: state,
    getCanvas: () => (canvas ? { ...canvas } : null),
    getOffline: () => ({ ...offline, failed: [...offline.failed] }),
    setOfflineCopy: (on) => {
      if (on === offlineCopy || faulted) return;
      offlineCopy = on;
      renderOffline();
    },
    get iframe() {
      return iframe;
    },
    get scripted() {
      return scriptMode;
    },
    ready,
    destroy: () => {
      destroyed = true;
      stopScripts();
      showNotice(null);
      writeHash();
      finishPrint();
      sync?.close();
      win.removeEventListener("message", onMessage);
      doc.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("beforeprint", onBeforePrint);
      win.removeEventListener("afterprint", onAfterPrint);
      win.removeEventListener("hashchange", onHashChange);
      win.removeEventListener("pagehide", writeHash);
      iframe.removeEventListener("load", onLoad);
      clearTimeout(hudTimer);
      clearTimeout(loadTimer);
      clearTimeout(laserTimer);
      laser.remove();
      if (doc.fullscreenElement === host) void doc.exitFullscreen().catch(() => {});
      iframe.remove();
      curtain.remove();
      dot?.remove();
      hud?.remove();
      helpBox?.remove();
      slides = null;
    },
  };
}
