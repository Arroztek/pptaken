// SPDX-License-Identifier: Apache-2.0
// The shell: the trusted side of the player, running in the app page. It owns the navigation state, mounts the
// deck document in a sandboxed iframe (opaque origin) and drives it through the validated postMessage protocol.
// No persistent chrome: a black host, the content, and an optional on-demand slide counter.

import { type KeyCode, keyCodeOf } from "./keys.js";
import * as nav from "./navigation.js";
import { KEY_ACTIONS, type KeyAction } from "./navigation.js";
import {
  type ContentMessage,
  PROTOCOL_VERSION,
  parseContentMessage,
  type ShellMessage,
  type SlideInfo,
} from "./protocol.js";

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
}

export type PlayerFault = "unexpected-navigation";

export interface PlayerOptions {
  /** URL of the deck document (the content route, ideally on a separate cookie-less origin). http(s) only. */
  contentUrl: string;
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
  onReady?(slides: readonly SlideInfo[]): void;
  /** Called after every change of position or black screen. */
  onChange?(state: PlayerState): void;
  /** Called when the iframe confirms what it shows (a `state` message). */
  onRender?(position: nav.Position): void;
  /** Called when the content misbehaves; the player blanks the iframe and stops. */
  onFault?(fault: PlayerFault): void;
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
  /** Current state, or `null` until the deck is ready. */
  getState(): PlayerState | null;
  /** The iframe element (for focus management and tests). */
  readonly iframe: HTMLIFrameElement;
  /** Resolves when the deck document has reported its slides. */
  readonly ready: Promise<readonly SlideInfo[]>;
  destroy(): void;
}

const HUD_MS = 2000;
const HASH_MS = 400;
const TYPING = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

function checkedContentUrl(url: string, base: string): string {
  const parsed = new URL(url, base);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("contentUrl must be an http(s) URL");
  }
  return parsed.href;
}

function isTyping(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const el = target as HTMLElement;
  return el.isContentEditable || el.closest(TYPING) !== null;
}

export function createPlayer(host: HTMLElement, options: PlayerOptions): Player {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new TypeError("host must be attached to a window");
  const src = checkedContentUrl(options.contentUrl, doc.baseURI);
  const useHash = options.hash !== false;
  const useKeyboard = options.keyboard !== false;

  let slides: SlideInfo[] | null = null;
  let position: nav.Position = options.initial ?? { slide: 0, step: 0 };
  if (useHash) position = nav.parseHash(win.location.hash) ?? position;
  let blackOn = false;
  let faulted = false;
  let loads = 0;
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

  const iframe = doc.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("allow", "");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.title = options.title ?? "Presentation";
  iframe.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#000";

  const curtain = doc.createElement("div");
  curtain.setAttribute("aria-hidden", "true");
  curtain.style.cssText = "position:absolute;inset:0;background:#000;display:none";

  let hud: HTMLDivElement | null = null;
  if (options.showHud) {
    const reduced = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    hud = doc.createElement("div");
    hud.setAttribute("aria-hidden", "true");
    hud.style.cssText =
      "position:absolute;right:16px;bottom:16px;padding:6px 10px;border-radius:4px;" +
      "background:rgba(0,0,0,.6);color:#8B8FA0;font:14px/1 'JetBrains Mono',ui-monospace,monospace;" +
      `pointer-events:none;opacity:0;transition:${reduced ? "none" : "opacity 200ms cubic-bezier(.2,0,0,1)"}`;
  }

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
    };
  };

  const flashHud = (): void => {
    if (!hud || !slides) return;
    hud.textContent = `${position.slide + 1} / ${slides.length}`;
    hud.style.opacity = "1";
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      if (hud) hud.style.opacity = "0";
    }, HUD_MS);
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

  const apply = (target: nav.Position, force = false): void => {
    if (!slides || faulted) return;
    const shape = { slides };
    const p = nav.clamp(shape, target);
    if (!force && nav.samePosition(p, position)) return;
    position = p;
    send({ v: PROTOCOL_VERSION, type: "goto", slide: p.slide, step: p.step });
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
    }
  };

  const handleKey = (code: KeyCode): void => {
    act(KEY_ACTIONS[code]);
  };

  const fault = (reason: PlayerFault): void => {
    if (faulted) return;
    faulted = true;
    iframe.src = "about:blank";
    options.onFault?.(reason);
  };

  const onMessage = (event: MessageEvent): void => {
    // Only our iframe, which always has an opaque origin ("null"), and only well-formed messages.
    if (faulted || event.source !== iframe.contentWindow || event.origin !== "null") return;
    const message: ContentMessage | null = parseContentMessage(event.data);
    if (!message) return;
    switch (message.type) {
      case "ready": {
        const first = slides === null;
        slides = message.slides;
        send({ v: PROTOCOL_VERSION, type: "mode", mode: "present" });
        apply(position, true);
        if (first) {
          options.onReady?.(slides);
          resolveReady(slides);
        }
        return;
      }
      case "key":
        return handleKey(message.code);
      case "state":
        options.onRender?.({ slide: message.slide, step: message.step });
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
    handleKey(code);
  };

  // A hash edited by hand: go there (clamped); an invalid one is replaced by the current position.
  const onHashChange = (): void => {
    const p = nav.parseHash(win.location.hash);
    if (p) apply(p);
    writeHash();
  };

  win.addEventListener("message", onMessage);
  doc.addEventListener("keydown", onKeyDown);
  if (useHash) {
    win.addEventListener("hashchange", onHashChange);
    win.addEventListener("pagehide", writeHash);
  }
  iframe.addEventListener("load", onLoad);
  iframe.src = src;
  host.append(iframe, curtain);
  if (hud) host.append(hud);

  return {
    goto: (slide, step = 0) => apply({ slide, step }),
    next: () => move(nav.next),
    prev: () => move(nav.prev),
    first: () => move(nav.first),
    last: () => move(nav.last),
    black: setBlack,
    toggleFullscreen,
    getState: state,
    iframe,
    ready,
    destroy: () => {
      writeHash();
      win.removeEventListener("message", onMessage);
      doc.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("hashchange", onHashChange);
      win.removeEventListener("pagehide", writeHash);
      iframe.removeEventListener("load", onLoad);
      clearTimeout(hudTimer);
      if (doc.fullscreenElement === host) void doc.exitFullscreen().catch(() => {});
      iframe.remove();
      curtain.remove();
      hud?.remove();
      slides = null;
    },
  };
}
