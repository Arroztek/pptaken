// SPDX-License-Identifier: AGPL-3.0-or-later
// The inline shell of the exported HTML file: the trusted outer page that owns navigation and drives the
// sandboxed deck iframe through the player's postMessage protocol (version 1).
//
// Why not the player's own shell: `@pptaken/player/shell` is built as ES modules and a page opened from `file://`
// cannot import modules or fetch anything. This is a compact, dependency-free re-implementation of the same
// behavior (keys, navigation, hash, black screen, full screen, counter, message validation), written as ONE
// self-contained function: `exportHtml` embeds `pptakenShell.toString()` in a classic `<script nonce>`. It must
// not reference anything outside its own body. The browser test checks it against the player's navigation module.

/** Configuration passed to the shell as a JSON literal. */
export interface ShellConfig {
  /** Speaker notes per slide (index order), or null when the file has no notes. */
  notes: string[] | null;
  /** Show `n / N` for 2 s after each move. */
  counter: boolean;
  /** Text shown when the deck does not start within 10 s. */
  slowText: string;
  /** Text of the notes panel heading. */
  notesLabel: string;
}

export function pptakenShell(config: ShellConfig): void {
  "use strict";
  const PROTOCOL_VERSION = 1;
  const MAX_SLIDES = 200;
  const MAX_STEPS = 255;
  const SLIDE_ID = /^[a-z0-9-]{1,40}$/;
  const HASH = /^#\/([0-9]{1,6})(?:\/([0-9]{1,6}))?\/?$/;
  const KEY_CODES = [
    "ArrowRight",
    "ArrowLeft",
    "ArrowUp",
    "ArrowDown",
    "PageDown",
    "PageUp",
    "Space",
    "ShiftSpace",
    "Enter",
    "Backspace",
    "Home",
    "End",
    "KeyB",
    "Period",
    "KeyF",
  ];
  const ACTIONS: Record<string, string> = {
    ArrowRight: "next",
    ArrowDown: "next",
    PageDown: "next",
    Space: "next",
    Enter: "next",
    ArrowLeft: "prev",
    ArrowUp: "prev",
    PageUp: "prev",
    Backspace: "prev",
    ShiftSpace: "prev",
    Home: "first",
    End: "last",
    KeyB: "black",
    Period: "black",
    KeyF: "fullscreen",
  };

  // The script runs in <head>, before the iframe exists, so that no message or load event can be missed:
  // elements are looked up when they are needed.
  const win = window;
  const doc = document;
  const el = (id: string) => doc.getElementById(`pptaken-${id}`) as HTMLElement;
  const frameWindow = () => (el("frame") as HTMLIFrameElement).contentWindow;
  const notesPanel = () => (config.notes ? el("notes") : null);

  type Position = { slide: number; step: number };
  let slides: { id: string; steps: number }[] | null = null;
  let position: Position = { slide: 0, step: 0 };
  let black = false;
  let faulted = false;
  let loads = 0;
  let hudTimer: ReturnType<typeof setTimeout> | undefined;
  let hashTimer: ReturnType<typeof setTimeout> | undefined;

  // --- keys (same mapping as @pptaken/player keys.ts)
  function keyCodeOf(e: KeyboardEvent): string | null {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return null;
    if (e.key === " " || e.key === "Spacebar") return e.shiftKey ? "ShiftSpace" : "Space";
    if (e.shiftKey) return null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowLeft":
      case "ArrowUp":
      case "ArrowDown":
      case "PageDown":
      case "PageUp":
      case "Enter":
      case "Backspace":
      case "Home":
      case "End":
        return e.key;
      case "b":
      case "B":
        return "KeyB";
      case ".":
        return "Period";
      case "f":
      case "F":
        return "KeyF";
      default:
        return null;
    }
  }

  // --- protocol validation (same rules as @pptaken/player protocol.ts)
  function exact(data: unknown, keys: string[]): Record<string, unknown> | null {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    if (Object.getPrototypeOf(data) !== Object.prototype) return null;
    const fields = data as Record<string, unknown>;
    if (Object.keys(fields).length !== keys.length) return null;
    for (const k of keys) if (!Object.hasOwn(fields, k)) return null;
    return fields;
  }
  function envelope(data: unknown, type: string, keys: string[]): Record<string, unknown> | null {
    const f = exact(data, ["v", "type", ...keys]);
    return f && f.v === PROTOCOL_VERSION && f.type === type ? f : null;
  }
  function bounded(value: unknown, max: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
  }
  function parseSlides(value: unknown): { id: string; steps: number }[] | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SLIDES) return null;
    const seen = new Set<string>();
    const out: { id: string; steps: number }[] = [];
    for (const item of value) {
      const s = exact(item, ["id", "steps"]);
      if (!s || typeof s.id !== "string" || !SLIDE_ID.test(s.id) || seen.has(s.id)) return null;
      if (!bounded(s.steps, MAX_STEPS)) return null;
      seen.add(s.id);
      out.push({ id: s.id, steps: s.steps });
    }
    return out;
  }

  // --- navigation (same semantics as @pptaken/player navigation.ts)
  function stepsOf(slide: number): number {
    const steps = slides?.[slide]?.steps ?? 0;
    return Number.isInteger(steps) && steps > 0 ? steps : 0;
  }
  function toInt(value: number): number {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  function clamp(p: Position): Position {
    const count = slides ? slides.length : 0;
    if (count === 0) return { slide: 0, step: 0 };
    const slide = Math.min(Math.max(toInt(p.slide), 0), count - 1);
    return { slide, step: Math.min(Math.max(toInt(p.step), 0), stepsOf(slide)) };
  }
  function nextOf(p0: Position): Position {
    const p = clamp(p0);
    if (p.step < stepsOf(p.slide)) return { slide: p.slide, step: p.step + 1 };
    if (slides && p.slide < slides.length - 1) return { slide: p.slide + 1, step: 0 };
    return p;
  }
  function prevOf(p0: Position): Position {
    const p = clamp(p0);
    if (p.step > 0) return { slide: p.slide, step: p.step - 1 };
    if (p.slide > 0) return { slide: p.slide - 1, step: stepsOf(p.slide - 1) };
    return p;
  }
  function lastOf(): Position {
    const slide = Math.max((slides ? slides.length : 1) - 1, 0);
    return { slide, step: stepsOf(slide) };
  }
  function parseHash(hash: string): Position | null {
    const m = HASH.exec(hash);
    if (!m) return null;
    return { slide: Number(m[1]) - 1, step: m[2] === undefined ? 0 : Number(m[2]) };
  }
  function formatHash(p: Position): string {
    return `#/${p.slide + 1}/${p.step}`;
  }

  // --- output
  function send(message: Record<string, unknown>): void {
    // The deck has an opaque origin, so "*" is the only possible target; messages carry no secrets.
    frameWindow()?.postMessage(message, "*");
  }
  function writeHash(): void {
    clearTimeout(hashTimer);
    hashTimer = undefined;
    if (!slides || faulted) return;
    const hash = formatHash(position);
    if (win.location.hash === hash) return;
    try {
      win.history.replaceState(win.history.state, "", hash);
    } catch {
      // Rate limited or not allowed on this URL: the hash is a convenience.
    }
  }
  function scheduleHash(): void {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(writeHash, 400);
  }
  function flashHud(): void {
    if (!config.counter || !slides) return;
    const hud = el("hud");
    hud.textContent = `${position.slide + 1} / ${slides.length}`;
    hud.classList.add("on");
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.classList.remove("on"), 2000);
  }
  function showNotes(): void {
    const panel = notesPanel();
    if (!panel || !config.notes || !slides) return;
    const body = panel.querySelector(".body") as HTMLElement;
    const head = panel.querySelector(".head") as HTMLElement;
    head.textContent = `${config.notesLabel} ${position.slide + 1} / ${slides.length}`;
    body.textContent = config.notes[position.slide] ?? "";
  }
  function apply(target: Position, force: boolean): void {
    if (!slides || faulted) return;
    const p = clamp(target);
    if (!force && p.slide === position.slide && p.step === position.step) return;
    position = p;
    send({ v: PROTOCOL_VERSION, type: "goto", slide: p.slide, step: p.step });
    doc.body.dataset.slide = String(p.slide);
    doc.body.dataset.step = String(p.step);
    scheduleHash();
    flashHud();
    showNotes();
  }
  function setBlack(): void {
    black = !black;
    el("curtain").hidden = !black;
    doc.body.dataset.black = String(black);
  }
  function toggleFullscreen(): void {
    const d = doc as Document & {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => void;
    };
    const host = el("host");
    const h = host as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      if ((doc.fullscreenElement ?? d.webkitFullscreenElement) === host) {
        if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => {});
        else d.webkitExitFullscreen?.();
      } else if (host.requestFullscreen) {
        void host.requestFullscreen().catch(() => {});
      } else {
        h.webkitRequestFullscreen?.();
      }
    } catch {
      // Refused by the browser: nothing to do.
    }
  }
  function act(code: string): void {
    const action = ACTIONS[code];
    if (!slides && action !== "black" && action !== "fullscreen") return;
    if (action === "next") apply(nextOf(position), false);
    else if (action === "prev") apply(prevOf(position), false);
    else if (action === "first") apply({ slide: 0, step: 0 }, false);
    else if (action === "last") apply(lastOf(), false);
    else if (action === "black") setBlack();
    else if (action === "fullscreen") toggleFullscreen();
  }
  function fault(): void {
    if (faulted) return;
    faulted = true;
    const frame = el("frame") as HTMLIFrameElement;
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";
    doc.body.dataset.state = "fault";
  }

  win.addEventListener("message", (event) => {
    // Only our iframe, which always has an opaque origin ("null"), and only well-formed messages.
    if (faulted || event.source === null || event.source !== frameWindow()) return;
    if (event.origin !== "null") return;
    const data: unknown = event.data;
    const type =
      typeof data === "object" && data !== null ? (data as { type?: unknown }).type : null;
    if (type === "ready") {
      // Protocol v1 `ready`: `{slides}` (F1 runtime) or `{slides, width, height}` (later runtimes report the
      // canvas size); both are exact shapes.
      const m =
        envelope(data, "ready", ["slides", "width", "height"]) ??
        envelope(data, "ready", ["slides"]);
      const parsed = m ? parseSlides(m.slides) : null;
      if (!m || !parsed) return;
      if ("width" in m && !(bounded(m.width, 4096) && m.width > 0)) return;
      if ("height" in m && !(bounded(m.height, 4096) && m.height > 0)) return;
      slides = parsed;
      send({ v: PROTOCOL_VERSION, type: "mode", mode: "present" });
      apply(position, true);
      el("status").hidden = true;
      doc.body.dataset.state = "ready";
      doc.body.dataset.slides = String(parsed.length);
    } else if (type === "key") {
      const m = envelope(data, "key", ["code"]);
      if (m && typeof m.code === "string" && KEY_CODES.includes(m.code)) act(m.code);
    } else if (type === "state") {
      const m = envelope(data, "state", ["slide", "step"]);
      if (m && bounded(m.slide, MAX_SLIDES - 1) && bounded(m.step, MAX_STEPS)) {
        doc.body.dataset.rendered = `${m.slide}/${m.step}`;
      }
    }
  });

  doc.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const panel = notesPanel();
    if (
      panel &&
      (event.key === "n" || event.key === "N") &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      panel.hidden = !panel.hidden;
      showNotes();
      return;
    }
    const code = keyCodeOf(event);
    if (!code) return;
    event.preventDefault();
    act(code);
  });

  win.addEventListener("hashchange", () => {
    const p = parseHash(win.location.hash);
    if (p) apply(p, false);
    writeHash();
  });
  win.addEventListener("pagehide", writeHash);

  // A deck document loads exactly once; another load means the content navigated the frame. `load` does not
  // bubble, but a capturing listener on the document sees it before the iframe is even parsed.
  doc.addEventListener(
    "load",
    (event) => {
      if (event.target !== el("frame")) return;
      loads += 1;
      if (loads > 1) fault();
    },
    true,
  );

  position = parseHash(win.location.hash) ?? position;
  setTimeout(() => {
    if (!slides && !faulted) {
      const status = el("status");
      status.textContent = config.slowText;
      status.hidden = false;
    }
  }, 10000);
  win.focus();
}
