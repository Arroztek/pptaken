// SPDX-License-Identifier: Apache-2.0
// The presentation loader: what the player, presenter and public-link pages show while a deck loads, before the
// content frame reports `ready`. Server-rendered markup plus one stylesheet fragment, so it is on screen before any
// script runs (the shell modules, the content URL request and the frame all happen under it).
//
// Concept, "the follow spot finds the screen": a dark stage with a floor line and two tape marks. A follow spot
// enters from the wings, its beam travels to the empty screen, and the screen lights up as a slide (title and two
// lines, the brand's amber). The light holds, cuts, and the spot travels on and irises out; then again. Lights snap
// (opacity in about 150 ms), objects travel (the spot, about 1 s on the stage easing). One loop every 4.8 s.
//
// Rules it keeps: pure CSS animation on inline SVG (no script, no request, no data: URL; it works under the
// pages' strict CSP and inside the offline copy); it fades in only after LOADER_DELAY_MS, so a fast load never
// flashes it; it is a fixed overlay that never takes pointer events or space, so nothing moves when the deck
// replaces it; under prefers-reduced-motion nothing travels (the spot rests on the lit screen, which breathes
// slowly); a polite live region with a visually hidden "Loading…" in the page's language.
// Never loaded inside the content frame: the deck document stays free of player styles.

/** The element id of the loader in the player, presenter and public-link pages. */
export const LOADER_ID = "pptaken-loader";

/** Milliseconds the loader stays invisible before it fades in (avoids a flash on fast loads). */
export const LOADER_DELAY_MS = 180;

/** Length of one loop of the animation, in milliseconds. */
export const LOADER_LOOP_MS = 4800;

const escape = (text: string): string => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * The loader's markup. `label` is the spoken text (for example `labelsFor(locale).loading`); the page script may
 * replace it once it knows the reader's language (`[data-loader-label]`). Starts visible: hide it with the
 * `hidden` attribute when the deck is ready or when the page shows an error instead.
 */
export function loaderHtml(label: string): string {
  return (
    `<div id="${LOADER_ID}" class="pptaken-loader" role="status" aria-live="polite">` +
    '<svg class="pptaken-loader__art" viewBox="0 0 240 150" aria-hidden="true" focusable="false">' +
    `<defs><clipPath id="${LOADER_ID}-stage"><rect width="240" height="128.5"/></clipPath></defs>` +
    // The pool of light travels on the floor under the spot; then the floor and its tape marks.
    '<ellipse class="pptaken-loader__pool" cx="120" cy="128.5" rx="44" ry="5.5"/>' +
    '<path class="pptaken-loader__ink" d="M16 128.5H224M35 139H45M40 134V144M195 139H205M200 134V144"/>' +
    // The follow spot: housing and beam, turning around the lamp, cut at the floor.
    `<g clip-path="url(#${LOADER_ID}-stage)"><g class="pptaken-loader__spot">` +
    '<path class="pptaken-loader__beam" d="M112 15H128L170 150H70Z"/>' +
    '<path class="pptaken-loader__lamp" d="M107 4.5C107 3.67 107.67 3 108.5 3H131.5C132.33 3 133 3.67 133 4.5V9L129 15H111L107 9Z"/>' +
    "</g></g>" +
    // The screen: dark until the light finds it, then a lit slide.
    '<rect class="pptaken-loader__screen" x="78" y="52" width="84" height="47.25" rx="3"/>' +
    '<g class="pptaken-loader__slide">' +
    '<rect class="pptaken-loader__lit" x="78" y="52" width="84" height="47.25" rx="3"/>' +
    '<rect class="pptaken-loader__text" x="89" y="62" width="38" height="5.5" rx="1.5"/>' +
    '<rect class="pptaken-loader__text pptaken-loader__text--soft" x="89" y="75" width="58" height="3" rx="1.5"/>' +
    '<rect class="pptaken-loader__text pptaken-loader__text--soft" x="89" y="82" width="44" height="3" rx="1.5"/>' +
    "</g>" +
    '<rect class="pptaken-loader__frame" x="78" y="52" width="84" height="47.25" rx="3"/>' +
    "</svg>" +
    `<span class="pptaken-loader__label" data-loader-label>${escape(label)}</span>` +
    "</div>"
  );
}

const STAGE_EASE = "cubic-bezier(.22,.8,.2,1)";

/**
 * The loader's styles, appended to the page stylesheets (`/_player/page.css`, `/_player/presenter.css`). Colours
 * are the stage tokens (chrome #8B8FA0, Spotlight #FFB224, Ink #16181D) behind custom properties, so a page can
 * restyle it; `--pptaken-loader-bg` must match the page background (the unlit screen hides the beam behind it).
 */
export const LOADER_CSS =
  ".pptaken-loader{--pptaken-loader-ink:#8B8FA0;--pptaken-loader-light:#FFB224;--pptaken-loader-on-light:#16181D;--pptaken-loader-bg:#000;" +
  `position:fixed;inset:0;z-index:1;display:grid;place-items:center;pointer-events:none;animation:pptaken-loader-in 200ms ease-out ${LOADER_DELAY_MS}ms both}` +
  ".pptaken-loader[hidden]{display:none}" +
  ".pptaken-loader__art{display:block;width:clamp(168px,32vmin,288px);height:auto;overflow:visible;fill:none}" +
  ".pptaken-loader__label{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}" +
  ".pptaken-loader__ink{stroke:var(--pptaken-loader-ink);stroke-width:1.5;stroke-linecap:round;opacity:.55}" +
  ".pptaken-loader__frame{stroke:var(--pptaken-loader-ink);stroke-width:2}" +
  ".pptaken-loader__screen{fill:var(--pptaken-loader-bg)}" +
  ".pptaken-loader__lit{fill:var(--pptaken-loader-light)}" +
  ".pptaken-loader__text{fill:var(--pptaken-loader-on-light);opacity:.78}" +
  ".pptaken-loader__text--soft{opacity:.4}" +
  ".pptaken-loader__lamp{fill:var(--pptaken-loader-ink)}" +
  ".pptaken-loader__beam{fill:var(--pptaken-loader-light);opacity:.2}" +
  ".pptaken-loader__pool{fill:var(--pptaken-loader-light);opacity:.85}" +
  // The spot turns around the lamp (120, 9); the pool follows it on the floor: 119.5 · tan(22°) ≈ 48.
  `.pptaken-loader__spot{transform-box:view-box;transform-origin:120px 9px;animation:pptaken-loader-spot ${LOADER_LOOP_MS}ms linear infinite both}` +
  `.pptaken-loader__pool{transform-box:view-box;animation:pptaken-loader-pool ${LOADER_LOOP_MS}ms linear infinite both}` +
  `.pptaken-loader__slide{animation:pptaken-loader-lit ${LOADER_LOOP_MS}ms linear infinite both}` +
  "@keyframes pptaken-loader-in{from{opacity:0}to{opacity:1}}" +
  `@keyframes pptaken-loader-spot{0%{transform:rotate(22deg);opacity:0;animation-timing-function:${STAGE_EASE}}` +
  "4%{opacity:1}22%{transform:rotate(0deg)}" +
  `66%{transform:rotate(0deg);animation-timing-function:${STAGE_EASE}}` +
  "86%{opacity:1}90%{transform:rotate(-22deg)}96%,100%{transform:rotate(-22deg);opacity:0}}" +
  `@keyframes pptaken-loader-pool{0%{transform:translateX(-48px);opacity:0;animation-timing-function:${STAGE_EASE}}` +
  "4%{opacity:.85}22%{transform:translateX(0)}" +
  `66%{transform:translateX(0);animation-timing-function:${STAGE_EASE}}` +
  "86%{opacity:.85}90%{transform:translateX(48px)}96%,100%{transform:translateX(48px);opacity:0}}" +
  "@keyframes pptaken-loader-lit{0%,23%{opacity:0}26%,62%{opacity:1}65%,100%{opacity:0}}" +
  "@keyframes pptaken-loader-rest{0%,100%{opacity:1}50%{opacity:.7}}" +
  "@media (prefers-reduced-motion:reduce){" +
  ".pptaken-loader__spot,.pptaken-loader__pool{animation:none;transform:none;opacity:1}" +
  ".pptaken-loader__pool{opacity:.85}" +
  ".pptaken-loader__slide{animation:pptaken-loader-rest 3.2s ease-in-out infinite}}";
