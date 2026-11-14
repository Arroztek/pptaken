// SPDX-License-Identifier: Apache-2.0
// The PPTaken runtime: the only script inside the sandboxed content iframe (authorized by the CSP nonce).
// It shows one slide at a time, reveals steps, scales the logical canvas to the iframe with a black letterbox,
// forwards keys to the shell and talks to it only through the validated postMessage protocol.
//
// Built by `scripts/build-runtime.mjs` into a single IIFE together with `keys.ts` and `messages.ts`, and
// embedded in the deck document by the builder. Rules: no eval, no innerHTML, no inline handlers, and no reads of
// globals that content could define (named elements): everything is captured before the content is parsed,
// because the builder puts this script in the document head.

import { keyCodeOf } from "./keys.js";
import { type ContentMessage, MAX_STEPS, PROTOCOL_VERSION, parseShellMessage } from "./messages.js";

/** Class put on revealed step elements. Content cannot use it: the sanitizer drops `pptaken*` classes. */
const REVEALED = "pptaken-revealed";
const STAGE_ID = "pptaken-stage";

const win = window;
const doc = document;
const root = doc.documentElement;
const shell = win.parent;

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

function post(message: ContentMessage): void {
  shell.postMessage(message, "*");
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

function show(slide: number, step: number, report: boolean): void {
  const view = slides[slide];
  if (!view) return;
  if (slide !== current) {
    slides[current]?.section.setAttribute("hidden", "");
    view.section.removeAttribute("hidden");
    current = slide;
  }
  const revealed = Math.min(step, view.stages.length);
  view.stages.forEach((group, index) => {
    for (const el of group) el.classList.toggle(REVEALED, index < revealed);
  });
  if (report) post({ v: PROTOCOL_VERSION, type: "state", slide, step: revealed });
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
  fit();
  show(0, 0, false);
  post({
    v: PROTOCOL_VERSION,
    type: "ready",
    slides: slides.map((s) => ({ id: s.id, steps: s.stages.length })),
  });
}

win.addEventListener("message", (event) => {
  if (event.source !== shell) return;
  const message = parseShellMessage(event.data);
  if (!message) return;
  if (message.type === "goto") show(message.slide, message.step, true);
  else root.setAttribute("data-pptaken-mode", message.mode);
});

// Keys pressed while the iframe has focus go to the shell, which owns navigation.
win.addEventListener(
  "keydown",
  (event) => {
    const code = keyCodeOf(event);
    if (!code) return;
    event.preventDefault();
    post({ v: PROTOCOL_VERSION, type: "key", code });
  },
  true,
);

win.addEventListener("resize", fit);

if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
else init();
