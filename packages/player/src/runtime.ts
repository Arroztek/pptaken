// SPDX-License-Identifier: Apache-2.0
// The PPTaken runtime: the only script inside the sandboxed content iframe (authorized by the CSP nonce).
// It shows one slide at a time, reveals steps, scales the logical canvas to the iframe with a black letterbox,
// lays out the overview grid, forwards keys to the shell and talks to it only through the validated postMessage
// protocol. Print mode is pure CSS (from the builder); the runtime only switches the mode attribute. After `ready`
// it preloads every image and font of the deck (offline layer 1) and reports the result once (`preload`).
//
// Built by `scripts/build-runtime.mjs` into a single IIFE together with `keys.ts` and `messages.ts`, and
// embedded in the deck document by the builder. Rules: no eval, no innerHTML, no inline handlers, and no reads of
// globals that content could define (named elements): everything is captured before the content is parsed,
// because the builder puts this script in the document head.

//
// Script mode (ADR-020, `<html data-pptaken-scripts>`): before anything else the runtime captures the intrinsics
// it needs, runs the lockdown (lockdown.ts), opens a private MessageChannel to the shell (the very first message,
// posted from <head> before any author script exists) and defines `pptaken.register`, the only way author scripts
// (the last elements of <body>, each wrapped by the builder) receive their slide API. It then sends a heartbeat
// every second and reports author errors per slide. The shell trusts none of it beyond its own validation.

import { keyCodeOf } from "./keys.js";
import { lockdown } from "./lockdown.js";
import {
  type ContentMessage,
  cleanErrorText,
  type ErrorKind,
  MAX_ERROR_COUNT,
  MAX_ERROR_MESSAGE,
  MAX_ERROR_NAME,
  MAX_ERROR_STACK,
  MAX_PRELOAD_FAILED,
  MAX_STEPS,
  type Mode,
  overviewColumns,
  PROTOCOL_VERSION,
  type PreloadFailure,
  parseShellMessage,
} from "./messages.js";

/** Class put on revealed step elements. Content cannot use it: the sanitizer drops `pptaken*` classes. */
const REVEALED = "pptaken-revealed";
const STAGE_ID = "pptaken-stage";
/** Overview geometry in CSS pixels: outer padding, gap between cells, section label and caption heights. */
const PAD = 24;
const GAP = 16;
const LABEL = 22;
const CAPTION = 28;

const win = window;
const doc = document;
const root = doc.documentElement;
const shell = win.parent;
const fontSet = doc.fonts;
const sheets = doc.styleSheets;
/** Preload budget: whatever has not loaded by then is reported as a timeout (presenting never waits for it). */
const PRELOAD_MS = 30_000;
/** Decoded images, kept referenced so the browser keeps them in its memory cache for the whole talk. */
const kept: HTMLImageElement[] = [];

interface SlideView {
  section: HTMLElement;
  id: string;
  /** Elements revealed at each step: `stages[0]` appears on the first advance. */
  stages: Element[][];
}

let slides: SlideView[] = [];
let stage: HTMLElement | null = null;
let width = 1920;
let height = 1080;
let current = -1;
let shownStep = 0;
let mode: Mode = "present";
/** Overview layer (captions, section labels, highlight), created on first use. */
let layer: HTMLElement | null = null;
let mark: HTMLElement | null = null;
const captionOf = new WeakMap<Element, number>();
/** Overview cell geometry of the last layout: columns, cell width, row height, thumbnail height. */
let grid = { cols: 1, cell: 0, row: 0, thumb: 0 };

// ---------------------------------------------------------------------------------------------------------------
// Script mode setup. Runs while <head> is parsed: no author code exists yet, so everything captured is pristine.

const scriptMode = root.hasAttribute("data-pptaken-scripts");
const apply = Reflect.apply;
const portPost = MessagePort.prototype.postMessage;
const startTimer = win.setInterval.bind(win);
const activeElementOf = Object.getOwnPropertyDescriptor(Document.prototype, "activeElement")?.get;
const closest = Element.prototype.closest;
/** Steps declared by author scripts with `setSteps`, by slide index. */
const declaredSteps = new Map<number, number>();
let port: MessagePort | null = null;

interface AuthorHooks {
  enter: ((step: number) => void)[];
  leave: (() => void)[];
  step: ((step: number) => void)[];
}
type AuthorSetup = (slide: unknown) => void;
const registered = new Map<string, AuthorSetup>();
const hooks = new Map<number, AuthorHooks>();
let setupDone = false;
/** The slide whose author code is running (setup or callback), for error attribution. */
let runningSlide = -1;
let entered = -1;

// Error capture (ADR-023). Captured before any author code exists; author code shares this realm, so everything
// here is best effort and the shell validates and cleans every field again.
const currentScriptOf = Object.getOwnPropertyDescriptor(Document.prototype, "currentScript")?.get;
const getAttribute = Element.prototype.getAttribute;
const docUrl = String(doc.URL);
/** Distinct errors kept by the runtime, messages sent at most. */
const MAX_DISTINCT_ERRORS = 20;
const MAX_ERROR_POSTS = 200;
interface CapturedError {
  /** Slide id, `deck`, or null when it is not known (resolved to -1). */
  slideId: string | null;
  kind: ErrorKind;
  name: string;
  message: string;
  stack: string;
  count: number;
  /** Count at the last post (0: never sent). */
  sent: number;
}
const captured = new Map<string, CapturedError>();
let errorPosts = 0;
/** Slides (by id) whose script failed while loading: reported by the error event, not again at init. */
const loadFailed = new Set<string>();
/** Where each author script starts in the document: `[line, slide id or "deck"]`, ascending. */
let scriptStarts: [number, string][] = [];

if (scriptMode) {
  lockdown(win, doc);
  const channel = new MessageChannel();
  port = channel.port1;
  shell.postMessage({ v: PROTOCOL_VERSION, type: "hello" }, "*", [channel.port2]);
  const register = (id: unknown, setup: unknown): void => {
    if (setupDone || typeof id !== "string" || typeof setup !== "function") return;
    if (!registered.has(id)) registered.set(id, setup as AuthorSetup);
  };
  Object.defineProperty(win, "pptaken", {
    value: Object.freeze({ register }),
    writable: false,
    enumerable: false,
    configurable: false,
  });
  // Heartbeat for the shell's watchdog (a busy author script stops it); repeated errors are flushed with it.
  startTimer(() => {
    post({ v: PROTOCOL_VERSION, type: "beat" });
    flushErrors();
  }, 1000);
  // Only real (isTrusted) events: author code can dispatch synthetic ones. Registered first, so they run first.
  win.addEventListener("error", (event) => {
    if (!event.isTrusted) return;
    const script = currentScriptOf ? apply(currentScriptOf, doc, []) : null;
    const owner =
      script instanceof Element
        ? (apply(getAttribute, script, ["data-pptaken-for"]) as string | null)
        : null;
    if (owner !== null && !setupDone) {
      // A script that did not parse or threw at its top level (the deck script included).
      loadFailed.add(owner);
      capture(owner, "script-load", event.error, event);
      return;
    }
    const slide = runningSlide >= 0 ? runningSlide : current;
    capture(
      slides[slide]?.id ?? null,
      setupDone ? "handler" : "script-load",
      event.error,
      event,
      runningSlide < 0,
    );
  });
  // No isTrusted check here: WebKit dispatches real rejection events as untrusted. A synthetic one only lets author
  // code report an error it could also throw for real (the same caps apply).
  win.addEventListener("unhandledrejection", (event) => {
    capture(slides[current]?.id ?? null, "rejection", event.reason, undefined, true);
  });
  // An inline handler (`el.setAttribute("onclick", …)`), a <script> or a worker the policy refused: no exception
  // reaches author code, so this is the only trace. String evaluation is left out (its keyword is the blocked URI):
  // it also throws, and that error is reported.
  win.addEventListener("securitypolicyviolation", (event) => {
    if (!event.isTrusted) return;
    const directive = String(event.effectiveDirective || event.violatedDirective || "");
    const blocked = String(event.blockedURI || "");
    if (!/^(script-src|worker-src)/.test(directive)) return;
    if (blocked !== "inline" && !blocked.includes(":")) return;
    const inline = blocked === "inline";
    capture(slides[runningSlide >= 0 ? runningSlide : current]?.id ?? null, "handler", {
      name: "SecurityPolicyViolation",
      message: inline
        ? `Blocked by the content security policy (${directive}): inline code or an on* attribute. Use addEventListener.`
        : `Blocked by the content security policy (${directive}): a script or worker that is not part of the approved code.`,
    });
  });
}

/** `name`, `message` and the first stack lines of anything thrown (never throws itself). */
function describeError(
  value: unknown,
  event?: ErrorEvent,
): { name: string; message: string; stack: string } {
  let name = "";
  let message = "";
  let stack = "";
  try {
    if (typeof value === "object" && value !== null) {
      const e = value as { name?: unknown; message?: unknown; stack?: unknown };
      if (typeof e.name === "string") name = e.name;
      if (typeof e.message === "string") message = e.message;
      if (typeof e.stack === "string") stack = e.stack;
    } else if (value !== undefined && value !== null) {
      message = typeof value === "string" ? value : String(value);
    }
  } catch {
    // A hostile getter or toString: keep what we have.
  }
  try {
    if (message === "" && event && typeof event.message === "string") {
      message = event.message.replace(/^Uncaught (?:exception: )?/, "");
      const m = /^([A-Za-z]*Error): (.*)$/.exec(message);
      if (m && name === "") [, name, message] = m as unknown as [string, string, string];
    }
    // V8 stacks start with "Name: message" (possibly several lines): keep only the frames when there are any.
    let lines = stack.split("\n").filter((l) => l.trim() !== "");
    const frames = lines.filter((l) => /^\s*at |@/.test(l));
    if (frames.length > 0) lines = frames;
    stack = lines.slice(0, 3).map(authorLines).join("\n");
    if (stack === "" && event && event.lineno > 0) {
      stack = authorLines(`at ${docUrl}:${event.lineno}:${event.colno}`);
    }
  } catch {
    stack = "";
  }
  return { name, message, stack };
}

/**
 * This document in stack frames: its URL without query or fragment (engines differ in whether frames keep the
 * query), then anything up to `:line:column`. Query strings never contain a colon (signed tokens are base64url).
 */
const docFrame = new RegExp(
  `${(docUrl.split(/[?#]/)[0] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s:)]*:(\\d+):(\\d+)`,
  "g",
);

/** Rewrites `<document URL>:line:column` into the author's own position (`slide intro, line 3:14`). */
function authorLines(line: string): string {
  return line.replace(docFrame, (whole: string, l: string, c: string) => {
    const docLine = Number(l);
    let at: [number, string] | undefined;
    for (const s of scriptStarts) if (s[0] <= docLine) at = s;
    if (at === undefined) return whole;
    // Slide scripts: the wrapper line is the <script> line, so the author's line 1 is the next one.
    const own = at[1] === "deck" ? docLine - at[0] + 1 : docLine - at[0];
    const where = at[1] === "deck" ? "deck script" : `slide ${at[1]}`;
    return `${where}, line ${Math.max(own, 1)}:${c}`;
  });
}

/**
 * Records an author error and sends it (new) or its count (repeat, at the next beat). `fromStack`: errors that
 * reach a window event (handlers, timers, rejections) are attributed to the slide their first author frame names,
 * when there is one, rather than to the slide on screen.
 */
function capture(
  slideId: string | null,
  kind: ErrorKind,
  value: unknown,
  event?: ErrorEvent,
  fromStack = false,
): void {
  try {
    const d = describeError(value, event);
    if (fromStack) {
      const named = /(?:^|\s|@)slide ([a-z0-9-]{1,40}), line /.exec(d.stack);
      if (named?.[1] && slides.some((s) => s.id === named[1])) slideId = named[1];
      else if (/(?:^|\s|@)deck script, line /.test(d.stack)) slideId = "deck";
    }
    const name = cleanErrorText(d.name, MAX_ERROR_NAME);
    const message = cleanErrorText(d.message, MAX_ERROR_MESSAGE);
    const key = `${kind}\u0000${slideId ?? ""}\u0000${name}\u0000${message}`;
    const prior = captured.get(key);
    if (prior) {
      if (prior.count < MAX_ERROR_COUNT) prior.count++;
      return;
    }
    if (captured.size >= MAX_DISTINCT_ERRORS) return;
    captured.set(key, {
      slideId,
      kind,
      name,
      message,
      stack: cleanErrorText(d.stack, MAX_ERROR_STACK, true),
      count: 1,
      sent: 0,
    });
    flushErrors();
  } catch {
    // Reporting must never break the deck.
  }
}

/** Sends every error whose count changed since it was last sent (only after `ready`: the shell needs the deck). */
function flushErrors(): void {
  if (!readySent) return;
  for (const e of captured.values()) {
    if (e.count === e.sent || errorPosts >= MAX_ERROR_POSTS) continue;
    errorPosts++;
    e.sent = e.count;
    const index = e.slideId === null ? -1 : slides.findIndex((s) => s.id === e.slideId);
    post({
      v: PROTOCOL_VERSION,
      type: "error",
      slide: index,
      kind: e.kind,
      name: e.name,
      message: e.message,
      stack: e.stack,
      count: e.count,
    });
  }
}

function post(message: ContentMessage): void {
  if (port !== null) {
    // Captured method and an array literal: author code cannot intercept or rewrite the message path.
    apply(portPost, port, [message]);
    return;
  }
  shell.postMessage(message, "*");
}

let readySent = false;

/** Runs author code for `slide`, catching and reporting anything it throws (`setup` or `handler`). */
function guarded(slide: number, run: () => void, kind: ErrorKind = "handler"): void {
  const previous = runningSlide;
  runningSlide = slide;
  try {
    run();
  } catch (error) {
    capture(slides[slide]?.id ?? null, kind, error);
  } finally {
    runningSlide = previous;
  }
}

/** Calls each registered setup with its slide API (once, at init, before `ready`). */
function runAuthorSetups(): void {
  slides.forEach((view, index) => {
    const setup = registered.get(view.id);
    if (setup === undefined) return;
    const h: AuthorHooks = { enter: [], leave: [], step: [] };
    hooks.set(index, h);
    const fn = (list: unknown[]) => (cb: unknown) => {
      if (typeof cb === "function") list.push(cb);
    };
    const api = Object.freeze({
      root: view.section,
      onEnter: fn(h.enter),
      onLeave: fn(h.leave),
      onStep: fn(h.step),
      setSteps: (n: unknown) => {
        if (!setupDone && typeof n === "number" && Number.isInteger(n) && n >= 0) {
          declaredSteps.set(index, Math.min(n, MAX_STEPS));
        }
      },
    });
    guarded(index, () => setup(api), "setup");
  });
  setupDone = true;
}

/** Steps of a slide: its `data-step` groups, or more when its script declared them. */
function stepsOf(index: number): number {
  return Math.max(slides[index]?.stages.length ?? 0, declaredSteps.get(index) ?? 0);
}

/** Author callbacks after a change of the shown slide or step (present mode only). */
function notifyAuthor(slide: number, step: number, slideChanged: boolean): void {
  if (!scriptMode || mode !== "present") return;
  if (slideChanged && entered >= 0) {
    const left = entered;
    for (const cb of hooks.get(left)?.leave ?? []) guarded(left, () => cb());
    entered = -1;
  }
  const h = hooks.get(slide);
  if (slideChanged) {
    entered = slide;
    for (const cb of h?.enter ?? []) guarded(slide, () => cb(step));
  } else {
    for (const cb of h?.step ?? []) guarded(slide, () => cb(step));
  }
}

/**
 * Groups the `data-step` elements of a slide into steps. Numbered steps (`data-step="1"` to `"99"`) come first,
 * in ascending number (gaps collapse, equal numbers reveal together); unnumbered ones (`data-step=""`) follow, one
 * step each, in document order.
 */
function stagesOf(section: HTMLElement): Element[][] {
  const numbered = new Map<number, Element[]>();
  const unnumbered: Element[][] = [];
  for (const el of section.querySelectorAll("[data-step]")) {
    const value = el.getAttribute("data-step") ?? "";
    if (/^[1-9][0-9]?$/.test(value)) {
      const n = Number(value);
      const group = numbered.get(n);
      if (group) group.push(el);
      else numbered.set(n, [el]);
    } else {
      unnumbered.push([el]);
    }
  }
  const stages: Element[][] = [];
  for (const n of [...numbered.keys()].sort((a, b) => a - b)) stages.push(numbered.get(n) ?? []);
  stages.push(...unnumbered);
  if (stages.length > MAX_STEPS) stages.push(stages.splice(MAX_STEPS - 1).flat());
  return stages;
}

/** Scales the canvas to fit the viewport and centers it; the black body is the letterbox. */
function fit(): void {
  if (!stage) return;
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const scale = Math.min(vw / width, vh / height);
  const x = (vw - width * scale) / 2;
  const y = (vh - height * scale) / 2;
  stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}

function el(className: string, text: string, index: number): HTMLElement {
  const e = doc.createElement("div");
  e.className = className;
  e.textContent = text;
  captionOf.set(e, index);
  layer?.append(e);
  return e;
}

/** Creates the overview layer once: a caption per slide and a label where a section starts. */
function buildLayer(): void {
  if (layer || !stage) return;
  layer = doc.createElement("div");
  layer.id = "pptaken-overlay";
  mark = doc.createElement("div");
  mark.id = "pptaken-mark";
  layer.append(mark);
  let group: string | null = null;
  slides.forEach((v, i) => {
    const name = v.section.getAttribute("data-section");
    if (name && name !== group) el("pptaken-sec", name, i);
    group = name;
    el("pptaken-cap", `${i + 1}  ${v.section.getAttribute("aria-label") ?? ""}`, i);
  });
  stage.append(layer);
}

const place = (e: HTMLElement, x: number, y: number, w: number, h?: number): void => {
  e.style.setProperty("left", `${x}px`, "important");
  e.style.setProperty("top", `${y}px`, "important");
  e.style.setProperty("width", `${w}px`, "important");
  if (h !== undefined) e.style.setProperty("height", `${h}px`, "important");
};

/** Position of slide `i` in the overview grid (top-left corner of its thumbnail). */
const cellAt = (i: number): [number, number] => [
  PAD + (i % grid.cols) * (grid.cell + GAP),
  PAD + Math.floor(i / grid.cols) * grid.row + LABEL,
];

/** Overview: every slide as a scaled thumbnail in one scrollable grid, in the same document. */
function layoutGrid(): void {
  if (!stage || !layer) return;
  const cols = overviewColumns(slides.length);
  const cell = Math.max((stage.clientWidth - PAD * 2 - GAP * (cols - 1)) / cols, 40);
  const thumb = (height * cell) / width;
  grid = { cols, cell, row: LABEL + thumb + CAPTION + GAP, thumb };
  for (const e of layer.children as HTMLCollectionOf<HTMLElement>) {
    const i = captionOf.get(e);
    if (i === undefined) continue;
    const [x, y] = cellAt(i);
    if (e.className === "pptaken-sec") place(e, x, y - LABEL, cell);
    else place(e, x, y + thumb + 4, cell);
  }
  slides.forEach((v, i) => {
    const [x, y] = cellAt(i);
    v.section.style.setProperty(
      "transform",
      `translate(${x}px, ${y}px) scale(${cell / width})`,
      "important",
    );
  });
  const rows = Math.ceil(slides.length / cols);
  layer.style.setProperty("height", `${PAD * 2 + rows * grid.row}px`, "important");
  highlight();
}

/** Moves the overview highlight to the current slide and scrolls it into view (inside the iframe only). */
function highlight(): void {
  if (!stage || !mark || current < 0) return;
  const [x, y] = cellAt(current);
  place(mark, x - 4, y - 4, grid.cell + 8, grid.thumb + 8);
  const top = y - LABEL - PAD;
  const bottom = y + grid.thumb + CAPTION + PAD;
  if (top < stage.scrollTop) stage.scrollTop = top;
  else if (bottom > stage.scrollTop + stage.clientHeight)
    stage.scrollTop = bottom - stage.clientHeight;
}

function layout(): void {
  if (mode === "overview") layoutGrid();
  else fit();
}

function setMode(next: Mode): void {
  if (next !== "overview" && mode === "overview") {
    for (const v of slides) v.section.style.removeProperty("transform");
  }
  mode = next;
  root.setAttribute("data-pptaken-mode", next);
  if (next === "overview") buildLayer();
  layout();
}

function show(slide: number, step: number, report: boolean): void {
  const view = slides[slide];
  if (!view) return;
  const slideChanged = slide !== current;
  if (slideChanged) {
    slides[current]?.section.setAttribute("hidden", "");
    view.section.removeAttribute("hidden");
    current = slide;
  }
  const before = shownStep;
  const revealed = Math.min(step, stepsOf(slide));
  view.stages.forEach((group, index) => {
    for (const e of group) e.classList.toggle(REVEALED, index < revealed);
  });
  shownStep = revealed;
  if (mode === "overview") highlight();
  if (slideChanged || revealed !== before || entered !== slide) {
    notifyAuthor(slide, revealed, slideChanged || entered !== slide);
  }
  if (report) post({ v: PROTOCOL_VERSION, type: "state", slide, step: revealed });
}

/** Adds every `url(...)` of a CSS text to `into`, except same-document references (`url(#id)`). */
function urlsOf(text: string | null, into: Set<string>): void {
  for (const m of (text ?? "").matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g)) {
    if (m[2] && m[2][0] !== "#") into.add(m[2]);
  }
}

/**
 * Layer 1 of offline presenting: decodes every image of every slide (hidden ones too, and CSS backgrounds) and
 * loads every declared font face, then reports once with `preload`. Never blocks presenting.
 */
async function preload(): Promise<void> {
  const urls = new Set<string>();
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) if (!(rule instanceof CSSFontFaceRule)) urlsOf(rule.cssText, urls);
  }
  for (const e of stage?.querySelectorAll("img,image,[style]") ?? []) {
    if (e instanceof HTMLImageElement) {
      if (e.src) urls.add(e.src);
    } else if (e.localName === "image") {
      const href = e.getAttribute("href") ?? e.getAttribute("xlink:href");
      if (href) urls.add(href);
    }
    urlsOf(e.getAttribute("style"), urls);
  }
  const failed: PreloadFailure[] = [];
  const pending = { image: 0, font: 0 };
  const done = { image: 0, font: 0 };
  let over = false;
  const track = (job: Promise<unknown>, kind: "image" | "font"): Promise<void> => {
    pending[kind]++;
    const settle = (ok: boolean) => () => {
      if (over) return;
      pending[kind]--;
      if (ok) done[kind]++;
      else failed.push(`${kind}-error`);
    };
    return job.then(settle(true), settle(false));
  };
  const jobs: Promise<void>[] = [];
  for (const url of urls) {
    const img = new Image();
    kept.push(img);
    img.src = url;
    jobs.push(track(img.decode(), "image"));
  }
  for (const face of fontSet) jobs.push(track(face.load(), "font"));
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, PRELOAD_MS))]);
  over = true;
  for (const kind of ["image", "font"] as const) {
    for (let i = 0; i < pending[kind]; i++) failed.push(`${kind}-timeout`);
  }
  post({
    v: PROTOCOL_VERSION,
    type: "preload",
    ok: failed.length === 0,
    images: done.image,
    fonts: done.font,
    failed: failed.slice(0, MAX_PRELOAD_FAILED),
  });
}

function init(): void {
  stage = doc.getElementById(STAGE_ID);
  if (!stage) return;
  width = Number(stage.getAttribute("data-width")) || width;
  height = Number(stage.getAttribute("data-height")) || height;
  slides = [];
  for (const section of stage.children) {
    const id = section.getAttribute("data-slide");
    if (section instanceof HTMLElement && section.tagName === "SECTION" && id !== null) {
      slides.push({ section, id, stages: stagesOf(section) });
    }
  }
  if (scriptMode) {
    try {
      for (const s of doc.querySelectorAll("script[data-pptaken-for][data-pptaken-line]")) {
        const line = Number(s.getAttribute("data-pptaken-line"));
        const owner = s.getAttribute("data-pptaken-for");
        if (owner !== null && Number.isInteger(line) && line > 0) scriptStarts.push([line, owner]);
      }
      scriptStarts = scriptStarts.sort((a, b) => a[0] - b[0]);
    } catch {
      // Line mapping is a convenience; tampered DOM APIs only cost it.
    }
    runAuthorSetups();
    // A slide whose script never registered failed to parse or threw at the top level; when the error event did
    // not already say why (blocked by the policy, or an engine without currentScript), say that it did not run.
    for (const view of slides) {
      if (
        view.section.hasAttribute("data-pptaken-script") &&
        !registered.has(view.id) &&
        !loadFailed.has(view.id)
      ) {
        capture(view.id, "script-load", {
          name: "ScriptNotRun",
          message:
            "The slide script did not run: it has a syntax error, threw before it started, or was blocked.",
        });
      }
    }
  }
  fit();
  show(0, 0, false);
  post({
    v: PROTOCOL_VERSION,
    type: "ready",
    slides: slides.map((s, index) => ({ id: s.id, steps: stepsOf(index) })),
    width,
    height,
  });
  readySent = true;
  // Errors of the load and setup phase waited for `ready` (the shell only knows the deck after it).
  if (scriptMode) flushErrors();
  void preload();
}

win.addEventListener("message", (event) => {
  if (event.source !== shell) return;
  const message = parseShellMessage(event.data);
  if (!message) return;
  if (message.type === "goto") return show(message.slide, message.step, true);
  setMode(message.mode);
  if (scriptMode && message.mode !== "present" && entered >= 0) {
    const left = entered;
    for (const cb of hooks.get(left)?.leave ?? []) guarded(left, () => cb());
    entered = -1;
  }
  // Acknowledge: the shell waits for this before printing.
  post({ v: PROTOCOL_VERSION, type: "state", slide: current, step: shownStep });
});

// Keys pressed while the iframe has focus go to the shell, which owns navigation.
win.addEventListener(
  "keydown",
  (event) => {
    // Script mode: synthetic events (dispatched by author code) are never forwarded; keys typed into a form
    // control stay there, except Escape, b and f.
    if (scriptMode && !event.isTrusted) return;
    const code = keyCodeOf(event);
    if (!code) return;
    if (scriptMode && code !== "Escape" && code !== "KeyB" && code !== "KeyF" && inControl())
      return;
    event.preventDefault();
    post({ v: PROTOCOL_VERSION, type: "key", code });
  },
  true,
);

/** Focus is in a form control of the content (script mode: inputs, selects, buttons...). */
function inControl(): boolean {
  const active = activeElementOf ? apply(activeElementOf, doc, []) : null;
  if (!(active instanceof Element)) return false;
  return apply(closest, active, [CONTROLS]) !== null;
}

const CONTROLS = "input,select,textarea,button,[contenteditable]";

// In the overview, a click on a thumbnail (content inside it does not take pointer events) or on its caption
// reports the slide; the shell decides what to do with it.
doc.addEventListener(
  "click",
  (event) => {
    // Script mode: a click dispatched by author code (isTrusted false) never selects a slide.
    if (mode !== "overview" || (scriptMode && !event.isTrusted)) return;
    const t = event.target;
    if (!(t instanceof Element)) return;
    const section = t.closest("section[data-slide]");
    const i = captionOf.get(t) ?? slides.findIndex((v) => v.section === section);
    if (i >= 0) post({ v: PROTOCOL_VERSION, type: "select", slide: i });
  },
  true,
);

win.addEventListener("resize", layout);

if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
else init();
