// SPDX-License-Identifier: Apache-2.0
// The presenter view (`@pptaken/player/presenter`): a trusted page in a second window with the current slide, the
// next slide, the speaker notes, the clock and the pace per section. Framework-free.
//
// - Both previews are ordinary players (`createPlayer`): sandboxed content iframes with the same CSP as the main
//   one; the runtime scales the canvas inside each iframe with a CSS transform. Keys pressed in them come back here.
// - The main window and this one stay in sync over a same-origin BroadcastChannel (`sync.ts`): either can move,
//   both follow. Only positions and the black screen travel on it.
// - Notes arrive as HTML from the server's renderer and are rebuilt here node by node against the same allowlist
//   (defense in depth); they are never sent anywhere else.

import { type Labels, type Locale, labelsFor } from "./i18n.js";
import type { KeyCode } from "./keys.js";
import { keyCodeOf } from "./keys.js";
import * as nav from "./navigation.js";
import { KEY_ACTIONS } from "./navigation.js";
import { OFFLINE_DOT, OFFLINE_LABEL, type OfflineStatus } from "./offline.js";
import {
  attribute,
  buildPlan,
  type ClockState,
  clockElapsed,
  clockIdle,
  clockToggle,
  formatClock,
  hasPace,
  type Pace,
  paceAt,
  type SectionReport,
  type SlideTimes,
  sectionReport,
  slideTimes,
} from "./pace.js";
import type { PresenterData } from "./presenter-data.js";
import { PROTOCOL_VERSION, type SlideInfo } from "./protocol.js";
import { createPlayer, type Player } from "./shell.js";
import { openSync, type Sync } from "./sync.js";

export type { PresenterData, PresenterSlide } from "./presenter-data.js";
export { parsePresenterData } from "./presenter-data.js";

export interface PresenterOptions {
  /** URL of the deck document (the same content route as the main player). One of this and `contentHtml`. */
  contentUrl?: string | undefined;
  /** The offline deck document instead of `contentUrl` (see `PlayerOptions.contentHtml`). */
  contentHtml?: string | undefined;
  /** Called when the offline status of the previews changes (the header shows it as text). */
  onOffline?(status: OfflineStatus): void;
  /** Presenter data, already validated with `parsePresenterData`. */
  data: PresenterData;
  /** BroadcastChannel name shared with the main player (`syncChannelName(deckId)`). */
  sync?: string;
  locale?: Locale;
  /** Clock source in milliseconds. Default `Date.now`. */
  now?: () => number;
  /** Clock refresh period. Default 250 ms. */
  tickMs?: number;
  /** Handle keys on the page. Default `true`. */
  keyboard?: boolean;
  onChange?(state: PresenterState): void;
}

export interface PresenterState {
  slide: number;
  step: number;
  slideCount: number;
  stepCount: number;
  black: boolean;
  running: boolean;
  elapsedMs: number;
  pace: Pace | null;
  sections: SectionReport[];
}

export interface Presenter {
  goto(slide: number, step?: number): void;
  next(): void;
  prev(): void;
  /** Start/pause the clock (`t`). */
  toggleClock(): void;
  /** Reset the clock and the time per slide (`Shift+R`). */
  resetClock(): void;
  getState(): PresenterState | null;
  /** Offline status of the current-slide preview, plus the offline-copy flag. */
  getOffline(): OfflineStatus;
  /** Tells the view whether an offline copy of the deck is stored (layer 2). */
  setOfflineCopy(on: boolean): void;
  readonly current: Player;
  readonly upcoming: Player;
  readonly ready: Promise<void>;
  destroy(): void;
}

/** Notes allowlist, the same as `renderNotes` (`ol` may keep a numeric `start`). */
const NOTE_TAGS = new Set([
  "P",
  "BR",
  "STRONG",
  "EM",
  "CODE",
  "PRE",
  "UL",
  "OL",
  "LI",
  "H3",
  "H4",
  "BLOCKQUOTE",
]);

/** Rebuilds notes HTML into `target` with fresh nodes: allowlisted tags only, no attributes but `ol[start]`. */
export function setNotesHtml(target: HTMLElement, html: string): void {
  const doc = target.ownerDocument;
  const parsed = new DOMParser().parseFromString(`<body>${html}`, "text/html");
  const copy = (from: Node, to: Node, depth: number): void => {
    for (const node of from.childNodes) {
      if (node.nodeType === 3) {
        to.appendChild(doc.createTextNode(node.textContent ?? ""));
      } else if (node.nodeType === 1 && depth < 32) {
        const el = node as Element;
        if (NOTE_TAGS.has(el.tagName)) {
          const clean = doc.createElement(el.tagName.toLowerCase());
          const start = el.getAttribute("start");
          if (el.tagName === "OL" && start !== null && /^[0-9]{1,9}$/.test(start))
            clean.setAttribute("start", start);
          copy(el, clean, depth + 1);
          to.appendChild(clean);
        } else if (el.tagName !== "SCRIPT" && el.tagName !== "STYLE") {
          copy(el, to, depth + 1);
        }
      }
    }
  };
  target.replaceChildren();
  copy(parsed.body, target, 0);
}

/** Styles of the presenter view: dark, neutral, PPTaken UI tokens (ink, paper, slate; Inter, JetBrains Mono). */
export const PRESENTER_CSS = `
.pptaken-presenter{position:fixed;inset:0;display:grid;grid-template-rows:auto minmax(0,1fr);background:#0F1115;color:#F2EFE9;font:16px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:dark}
.pptaken-presenter *{box-sizing:border-box}
.pptaken-presenter [hidden]{display:none!important}
.pp-bar{display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;padding:12px 24px;background:#181B22;border-bottom:1px solid #2A2F3A}
.pp-pos{font:500 1.125rem/1.3 "JetBrains Mono",ui-monospace,monospace;color:#A3A9B8;font-variant-numeric:tabular-nums}
.pp-pos b{color:#F2EFE9;font-weight:600}
.pp-clock{display:flex;align-items:baseline;gap:12px;margin-inline:auto;font-family:"JetBrains Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
.pp-elapsed{font-size:2.25rem;font-weight:600;line-height:1.1}
.pp-clock[data-running=false] .pp-elapsed{color:#A3A9B8}
.pp-target{color:#A3A9B8;font-size:1.125rem}
.pp-status{font-size:1.125rem;font-weight:600}
.pp-status[data-status=behind],.pp-sections [data-status=behind]{color:#FF9F43}
.pp-status[data-status=ahead],.pp-sections [data-status=ahead]{color:#3DD68C}
.pp-status[data-status=on-time]{color:#A3A9B8}
.pp-actions{display:flex;gap:8px}
.pp-actions button{min-height:44px;padding:0 16px;border-radius:6px;border:1px solid #2A2F3A;background:#20242D;color:#F2EFE9;font:500 .875rem/1 Inter,system-ui,sans-serif;cursor:pointer}
.pp-actions button:hover{border-color:#8B8FA0}
.pptaken-presenter :focus-visible{outline:2px solid #A99BFF;outline-offset:2px}
.pp-main{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:24px;padding:24px;min-height:0}
.pp-col{display:flex;flex-direction:column;gap:8px;min-height:0}
.pp-label{margin:8px 0 0;font:600 .75rem/1.3 Inter,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#A3A9B8}
.pp-frame{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:6px;overflow:hidden;flex:none}
.pp-end{display:flex;align-items:center;justify-content:center;color:#8B8FA0;font-family:"JetBrains Mono",ui-monospace,monospace}
.pp-notes{flex:1 1 0;min-height:6rem;overflow:auto;padding:16px 20px;border-radius:14px;background:#181B22;font-size:1.5rem;line-height:1.5}
.pp-notes>:first-child{margin-top:0}
.pp-notes h3,.pp-notes h4{font-size:1.25em;line-height:1.3;margin:.8em 0 .3em}
.pp-notes h4{font-size:1.1em}
.pp-notes code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.85em;background:#20242D;border-radius:4px;padding:0 .2em}
.pp-notes pre{overflow:auto;background:#20242D;border-radius:6px;padding:12px}
.pp-notes pre code{background:none;padding:0}
.pp-notes blockquote{margin:.5em 0;padding-left:16px;border-left:3px solid #565C6B;color:#A3A9B8}
.pp-empty{color:#8B8FA0}
.pp-sections{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.pp-sections th,.pp-sections td{padding:4px 8px;text-align:left;border-bottom:1px solid #2A2F3A}
.pp-sections th{font:600 .75rem/1.3 Inter,system-ui,sans-serif;color:#A3A9B8;text-transform:uppercase;letter-spacing:.08em}
.pp-sections td.n{font-family:"JetBrains Mono",ui-monospace,monospace;text-align:right}
.pp-sections tr[data-state=current]{background:rgba(169,155,255,.14)}
.pp-sections tr[data-state=upcoming]{color:#A3A9B8}
.pp-black{position:fixed;left:24px;bottom:24px;margin:0;padding:8px 12px;border-radius:6px;background:#000;color:#F2EFE9;border:1px solid #8B8FA0}
.pp-offline{display:flex;align-items:center;gap:8px;color:#A3A9B8;font-size:.875rem}
.pp-offline i{flex:none;width:8px;height:8px;border-radius:50%}
@media (max-width:800px){.pp-main{grid-template-columns:1fr;overflow:auto}}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function deltaText(pace: Pace, t: Labels): string {
  if (pace.status === "on-time") return t.onTime;
  const word = pace.status === "behind" ? t.behind : t.ahead;
  return `${pace.status === "behind" ? "+" : "-"}${formatClock(Math.abs(pace.deltaSec))} ${word}`;
}

export function createPresenter(root: HTMLElement, options: PresenterOptions): Presenter {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new TypeError("root must be attached to a window");
  const t = labelsFor(options.locale);
  const data = options.data;
  const now = options.now ?? (() => Date.now());
  const plan = buildPlan(data.slides, data.targetMinutes);
  const count = data.slides.length;

  if (!doc.getElementById("pptaken-presenter-css")) {
    const style = el(doc, "style");
    style.id = "pptaken-presenter-css";
    style.textContent = PRESENTER_CSS;
    doc.head.append(style);
  }

  // Layout.
  const shell = el(doc, "div", "pptaken-presenter");
  const bar = el(doc, "header", "pp-bar");
  const pos = el(doc, "div", "pp-pos");
  pos.setAttribute("aria-live", "polite");
  const clockBox = el(doc, "div", "pp-clock");
  const elapsedEl = el(doc, "span", "pp-elapsed", "0:00");
  elapsedEl.setAttribute("role", "timer");
  const targetEl = el(doc, "span", "pp-target");
  const statusEl = el(doc, "span", "pp-status");
  clockBox.append(elapsedEl, targetEl, statusEl);
  const offlineEl = el(doc, "div", "pp-offline");
  offlineEl.setAttribute("role", "status");
  const offlineDot = el(doc, "i");
  const offlineText = el(doc, "span");
  offlineEl.append(offlineDot, offlineText);
  const actions = el(doc, "div", "pp-actions");
  const button = (label: string, fn: () => void): HTMLButtonElement => {
    const b = el(doc, "button", "", label);
    b.type = "button";
    b.addEventListener("click", fn);
    actions.append(b);
    return b;
  };
  const main = el(doc, "main", "pp-main");
  const left = el(doc, "div", "pp-col");
  const right = el(doc, "div", "pp-col");
  const nowHost = el(doc, "div", "pp-frame");
  const nextHost = el(doc, "div", "pp-frame");
  const endEl = el(doc, "div", "pp-frame pp-end", t.end);
  endEl.hidden = true;
  const notesEl = el(doc, "div", "pp-notes");
  notesEl.tabIndex = 0;
  notesEl.setAttribute("aria-label", t.notes);
  const paceLabel = el(doc, "h2", "pp-label", t.pace);
  const table = el(doc, "table", "pp-sections");
  const blackEl = el(doc, "p", "pp-black", t.black);
  blackEl.hidden = true;
  blackEl.setAttribute("role", "status");
  const ratio = data.aspectRatio === "4:3" ? "4 / 3" : "16 / 9";
  for (const f of [nowHost, nextHost, endEl]) f.style.aspectRatio = ratio;
  left.append(el(doc, "h2", "pp-label", t.current), nowHost, paceLabel, table);
  right.append(
    el(doc, "h2", "pp-label", t.next),
    nextHost,
    endEl,
    el(doc, "h2", "pp-label", t.notes),
    notesEl,
  );
  main.append(left, right);
  bar.append(pos, clockBox, offlineEl, actions);
  shell.append(bar, main, blackEl);
  root.replaceChildren(shell);
  const showPace = hasPace(plan) || plan.sections.some((s) => s.name !== null);
  paceLabel.hidden = !showPace;
  table.hidden = !showPace;

  // State.
  let slides: SlideInfo[] | null = null;
  let position: nav.Position = { slide: 0, step: 0 };
  let clock: ClockState = clockIdle();
  let times: SlideTimes = slideTimes(count, 0);
  let black = false;
  let remote = false;
  let notesFor = -1;
  let sync: Sync | null = null;

  const onKey = (code: KeyCode): boolean => {
    handleKey(code);
    return true;
  };
  const renderOffline = (s: OfflineStatus): void => {
    offlineDot.style.background = OFFLINE_DOT[s.state];
    offlineText.textContent = t[OFFLINE_LABEL[s.state]];
    offlineEl.dataset.offline = s.state;
  };
  const common = {
    contentUrl: options.contentUrl,
    contentHtml: options.contentHtml,
    hash: false,
    keyboard: false,
    help: false,
    loadTimeoutMs: 0,
    onKey,
  };
  const current = createPlayer(nowHost, {
    ...common,
    title: `${t.current}: ${data.title}`,
    onOffline: (s) => {
      renderOffline(s);
      options.onOffline?.(s);
    },
  });
  const upcoming = createPlayer(nextHost, { ...common, title: `${t.next}: ${data.title}` });
  for (const p of [current, upcoming]) p.iframe.tabIndex = -1;
  renderOffline(current.getOffline());

  const elapsedMs = (): number => clockElapsed(clock, now());

  const snapshot = (): PresenterState | null => {
    if (!slides) return null;
    const ms = elapsedMs();
    const live = attribute(times, ms, position.slide);
    return {
      slide: position.slide,
      step: position.step,
      slideCount: slides.length,
      stepCount: slides[position.slide]?.steps ?? 0,
      black,
      running: clock.running,
      elapsedMs: ms,
      pace: paceAt(plan, position.slide, ms / 1000),
      sections: sectionReport(plan, live.perSlide, position.slide),
    };
  };

  const renderClock = (s: PresenterState): void => {
    elapsedEl.textContent = formatClock(s.elapsedMs / 1000);
    clockBox.dataset.running = String(s.running);
    targetEl.textContent = plan.totalSec === null ? "" : `/ ${formatClock(plan.totalSec)}`;
    if (s.pace) {
      statusEl.textContent = deltaText(s.pace, t);
      statusEl.dataset.status = s.pace.status;
    } else {
      statusEl.textContent = "";
      delete statusEl.dataset.status;
    }
    clockButton.textContent = s.running ? t.pause : t.start;
    if (!showPace) return;
    table.replaceChildren();
    const head = table.createTHead().insertRow();
    for (const h of ["", t.planned, t.actual, ""]) head.append(el(doc, "th", "", h));
    const body = table.createTBody();
    for (const sec of s.sections) {
      const row = body.insertRow();
      row.dataset.state = sec.state;
      row.insertCell().textContent = sec.name ?? t.noSection;
      const planned = row.insertCell();
      planned.className = "n";
      planned.textContent = sec.plannedSec === null ? "–" : formatClock(sec.plannedSec);
      const actual = row.insertCell();
      actual.className = "n";
      actual.textContent = formatClock(sec.actualSec);
      const status = row.insertCell();
      if (sec.status && sec.status !== "on-time" && sec.plannedSec !== null) {
        status.dataset.status = sec.status;
        const d = sec.actualSec - sec.plannedSec;
        status.textContent = `${d > 0 ? "+" : "-"}${formatClock(Math.abs(d))}`;
      }
    }
  };

  const render = (): void => {
    const s = snapshot();
    if (!s || !slides) return;
    pos.replaceChildren(
      `${t.slide} `,
      el(doc, "b", "", String(s.slide + 1)),
      ` / ${s.slideCount}`,
      s.stepCount > 0 ? `  ·  ${t.step} ${s.step} / ${s.stepCount}` : "",
    );
    if (notesFor !== s.slide) {
      notesFor = s.slide;
      const html = data.slides[s.slide]?.notesHtml ?? "";
      if (html === "") notesEl.replaceChildren(el(doc, "p", "pp-empty", t.noNotes));
      else setNotesHtml(notesEl, html);
      notesEl.scrollTop = 0;
    }
    blackEl.hidden = !black;
    renderClock(s);
    options.onChange?.(s);
  };

  const apply = (target: nav.Position, force = false): void => {
    if (!slides) return;
    const shape = { slides };
    const p = nav.clamp(shape, target);
    if (!force && nav.samePosition(p, position)) return;
    if (p.slide !== position.slide) times = attribute(times, elapsedMs(), p.slide);
    position = p;
    current.goto(p.slide, p.step);
    const n = nav.next(shape, p);
    const atEnd = nav.samePosition(n, p);
    nextHost.hidden = atEnd;
    endEl.hidden = !atEnd;
    if (!atEnd) upcoming.goto(n.slide, n.step);
    if (!remote) sync?.send({ v: PROTOCOL_VERSION, type: "nav", slide: p.slide, step: p.step });
    render();
  };

  const setBlack = (on: boolean): void => {
    if (on === black) return;
    black = on;
    if (!remote) sync?.send({ v: PROTOCOL_VERSION, type: "black", on });
    render();
  };

  const toggleClock = (): void => {
    times = attribute(times, elapsedMs(), position.slide);
    clock = clockToggle(clock, now());
    render();
  };
  const resetClock = (): void => {
    clock = clockIdle();
    times = slideTimes(count, position.slide);
    render();
  };

  const move = (fn: (shape: nav.DeckShape, p: nav.Position) => nav.Position): void => {
    if (slides) apply(fn({ slides }, position));
  };

  function handleKey(code: KeyCode): void {
    switch (KEY_ACTIONS[code]) {
      case "next":
        return move(nav.next);
      case "prev":
        return move(nav.prev);
      case "first":
        return move(nav.first);
      case "last":
        return move(nav.last);
      case "black":
        return setBlack(!black);
      case "clock":
        return toggleClock();
      case "clockReset":
        return resetClock();
      case "fullscreen":
        if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {});
        else void root.requestFullscreen().catch(() => {});
        return;
      default:
        return;
    }
  }

  button(t.prevButton, () => move(nav.prev));
  button(t.nextButton, () => move(nav.next));
  const clockButton = button(t.start, toggleClock);
  button(t.reset, resetClock);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable]")) return;
    const code = keyCodeOf(event);
    if (!code) return;
    // A focused button keeps Space and Enter for itself (they click it).
    if ((code === "Space" || code === "Enter") && target?.closest?.("button")) return;
    event.preventDefault();
    handleKey(code);
  };
  if (options.keyboard !== false) doc.addEventListener("keydown", onKeyDown);
  const timer = setInterval(() => {
    const s = snapshot();
    if (s) renderClock(s);
  }, options.tickMs ?? 250);

  if (options.sync !== undefined) {
    sync = openSync(options.sync, (message) => {
      if (!slides) return;
      if (message.type === "hello") {
        sync?.send({ v: PROTOCOL_VERSION, type: "nav", ...position });
        sync?.send({ v: PROTOCOL_VERSION, type: "black", on: black });
        return;
      }
      remote = true;
      try {
        if (message.type === "nav") apply({ slide: message.slide, step: message.step });
        else setBlack(message.on);
      } finally {
        remote = false;
      }
    });
  }

  const ready = Promise.all([current.ready, upcoming.ready]).then(([s]) => {
    slides = s.slice();
    const canvas = current.getCanvas();
    if (canvas) {
      for (const f of [nowHost, nextHost, endEl])
        f.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    }
    times = slideTimes(slides.length, 0);
    remote = true;
    try {
      apply(position, true);
    } finally {
      remote = false;
    }
    // Ask the main window where it is; it answers with `nav`, and this view follows.
    sync?.send({ v: PROTOCOL_VERSION, type: "hello" });
  });

  return {
    goto: (slide, step = 0) => apply({ slide, step }),
    next: () => move(nav.next),
    prev: () => move(nav.prev),
    toggleClock,
    resetClock,
    getState: snapshot,
    getOffline: () => current.getOffline(),
    setOfflineCopy: (on) => current.setOfflineCopy(on),
    current,
    upcoming,
    ready,
    destroy: () => {
      clearInterval(timer);
      sync?.close();
      doc.removeEventListener("keydown", onKeyDown);
      current.destroy();
      upcoming.destroy();
      shell.remove();
    },
  };
}
