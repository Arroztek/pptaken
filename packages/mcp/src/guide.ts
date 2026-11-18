// SPDX-License-Identifier: AGPL-3.0-or-later
// The authoring guide returned by `get_authoring_guide`: everything an agent needs to write a deck that renders
// well on the first try. Kept under 2,500 tokens (checked by a test). Facts come from @pptaken/schema (limits,
// font catalog) and the sanitizer policy (packages/sanitizer/README.md); keep them in sync when either changes.
import { policy } from "@pptaken/sanitizer";
import { FONT_CATALOG, LIB_CATALOG, LIMITS } from "@pptaken/schema";

/** Version of the guide, bumped with the deck format or the sanitizer policy. */
export const AUTHORING_GUIDE_VERSION = "2";

/** Maximum decoded bytes of one `add_asset` call with base64 content (phase F2). */
export const MAX_ASSET_BASE64_BYTES = 1024 * 1024;

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

const EXAMPLE_SLIDE = {
  id: "agenda",
  title: "Agenda",
  section: "Intro",
  html: "<div class='frame'><h2 class='title'>Agenda</h2><ol class='list'><li data-step='1'>Why it matters</li><li data-step='2'>How it works</li><li data-step='3'>What to do next</li></ol></div>",
  css: ".list li{margin-bottom:28px}",
  notes: "Reveal each item with a click, then ask which part matters most to the room.",
  duration_hint_sec: 45,
};

const EXAMPLE_THEME_CSS =
  ".frame{position:absolute;left:0;top:0;width:1920px;height:1080px;box-sizing:border-box;padding:120px;background:#FAF7F2;color:#16181D;font:44px/1.4 'Inter',sans-serif}.title{font:700 96px/1.05 'Bricolage Grotesque',sans-serif;margin:0 0 56px;color:#5746AF}";

/** The example used in the guide, as `create_presentation` input (tests check it renders without warnings). */
export const GUIDE_EXAMPLE = {
  title: "Example",
  theme: { css: EXAMPLE_THEME_CSS, fonts: ["Inter", "Bricolage Grotesque"] },
  slides: [EXAMPLE_SLIDE],
};

export const AUTHORING_GUIDE = `# PPTaken authoring guide (deck format v1, guide v${AUTHORING_GUIDE_VERSION})

A presentation is a list of slides. Each slide is an HTML fragment drawn on a fixed canvas and shown one at a time in a sandboxed player. Design it like a poster, not like a web page.

## Canvas
- 16:9 (default): 1920×1080 px. 4:3: 1440×1080 px. The player scales the whole canvas to the screen.
- Use absolute pixel sizes for that canvas: body text 36–48px, titles 72–140px, padding 80–160px. Nothing below 28px.
- A slide starts empty (white background, black text). Good pattern: one root \`<div>\` with \`position:absolute;left:0;top:0;width:1920px;height:1080px;box-sizing:border-box;padding:120px\`.
- Content outside the canvas is clipped and nothing scrolls: split long content into more slides.

## HTML
- Allowed: div span p br hr h1-h6 ul ol li dl dt dd blockquote pre code kbd mark small strong em b i u s sub sup abbr cite q time figure figcaption section article aside header footer main nav address del ins; tables (table thead tbody tfoot tr th td caption colgroup col); \`<img src="asset:<id>" alt="…">\`; inline \`<svg>\` (shapes, path, text, gradients, clipPath, mask, pattern, marker, use, filters such as feGaussianBlur/feOffset/feMerge).
- Attributes: class, id, style, lang, dir, title, role (static roles like img, list, figure), aria-*, data-step, hidden; img src/alt/width/height; td/th colspan/rowspan; ol start/type/reversed.
- Removed with a warning (the call still succeeds): script, style elements, iframe, object, embed, video, audio, canvas, form controls, link, meta, on* handlers, links (\`<a>\` is unwrapped), data-* other than data-step, tabindex, contenteditable, SMIL animation, foreignObject.

## CSS
- Put CSS in the slide \`css\` (scoped to that slide; \`html\`, \`body\` and \`:root\` mean the slide), in \`theme.css\` (shared by all slides) or in \`style\` attributes.
- Allowed: flex, grid, positioning, box model, typography, colors, gradients, borders, shadows, transforms, transitions, @keyframes animations, filters, masks, custom properties, @media, @supports.
- Removed: @container, @layer, @page; \`url()\` other than \`asset:\` (after vendoring) in backgrounds; \`content:url()\`; attr(), env(), image-set(); selectors with escapes or classes/ids starting with \`pptaken\`. z-index within ±9999.
- \`@import url(https://…)\`, \`@font-face\` with an https \`src\` and \`url(https://…)\` images are vendored (see External resources). No \`data:\` URIs.

## Fonts
Bundled (no download): ${FONT_CATALOG.join(", ")}; list those in \`theme.fonts\` (max ${LIMITS.maxThemeFonts}). Any other family works once vendored: \`theme.google_fonts: [{"family":"Lora","weights":[400,700]}]\`, a Google Fonts \`@import url(https://fonts.googleapis.com/css2?…)\`, or an \`@font-face\` with an https \`src\`. Names neither bundled nor vendored are removed. End with a generic fallback: \`font-family:'Inter',sans-serif\`.

## Steps (reveal on click)
- \`data-step="1"\`, \`data-step="2"\`… reveal elements one click at a time; equal numbers appear together; \`data-step=""\` reveals in document order after the numbered ones.
- Hidden steps keep their space, so the layout never jumps. Elements without data-step are always visible.

## Images
1. Create the presentation, then call \`add_asset\` with \`presentation_id\`, \`filename\` and \`source: { base64, media_type }\` (PNG, JPEG, WebP, AVIF or GIF; at most 1 MB decoded per call; prefer WebP or AVIF).
2. Use the returned \`ref\` (\`asset:<sha256>\`) in \`<img src="asset:…">\` or \`background-image:url(asset:…)\` and save it with \`update_slides\`.
- Or put an https image URL directly in \`<img src>\`/\`url()\`, or call \`add_asset\` with \`source: { url }\`: the server downloads it once. SVG files are not vendored: write the SVG inline.

## Notes, sections, timing
- \`notes\`: Markdown, never shown to the audience. Write what the speaker says, not the slide text again.
- \`section\` groups slides in the overview; \`duration_hint_sec\` and \`target_minutes\` drive the speaker clock.

## Limits
${LIMITS.maxSlides} slides; slide html ${kb(LIMITS.maxSlideHtml)}; slide css ${kb(LIMITS.maxSlideCss)}; theme css ${kb(LIMITS.maxThemeCss)}; notes ${kb(LIMITS.maxNotes)}; titles ${LIMITS.maxTitleLength} characters; slide ids \`[a-z0-9-]{1,40}\`, unique and stable across edits. One request is at most 4 MB: for a very large deck, create it with part of the slides and add the rest with \`update_slides\`.

## Write slides like this
- One idea per slide, at most 6 short bullets, large text, strong contrast (4.5:1 or more).
- Shared classes in \`theme.css\`, small per-slide \`css\`.
- A meaningful \`title\` and a stable \`id\` on every slide (you edit slides by id).
- Diagrams as inline SVG with a \`viewBox\` and explicit pixel width/height.

## Not like that
- No \`<script>\`, event handlers or links in slide html: they are removed (code goes in \`script\`, see below).
- No iframes, embeds, video or audio, no \`data:\` URLs: removed with a warning.
- No vw/vh or % font sizes, no responsive breakpoints, no scrolling boxes.
- No full documents (\`<html>\`, \`<head>\`, \`<body>\`) in slide html: send only the slide content, or import a whole document with \`import_html_deck\`.

## Example
Slide:
${JSON.stringify(EXAMPLE_SLIDE)}
With \`theme\`: ${JSON.stringify(GUIDE_EXAMPLE.theme)}

## Flow
\`create_presentation\` with all slides in one call → give \`urls.present\` to the user. To edit: \`get_presentation\` (outline by default) shows slide ids and \`revision\`; pass it as \`expected_revision\` to \`update_slides\` or \`update_presentation\`. On REVISION_CONFLICT, read again and reapply. Successful writes may return \`warnings\` listing what the sanitizer removed: fix those slides if the removal matters.
`;

// ---------------------------------------------------------------------------------------------------------------
// Interactive scripts (ADR-020). The allowed and removed lists are generated from the sanitizer's policy constants;
// a contract test sanitizes every listed item (allowed: no warning; removed: a warning).

/** Status of author scripts on an instance, as `whoami` and the guide report it. */
export type ScriptsStatusLabel = "off" | "needs_owner_approval";

/** One allowed element of the interactive profile, as the guide shows it and the contract test builds it. */
export interface InteractiveExample {
  tag: string;
  /** Allowed attributes (the global ones such as class, id, style, aria-*, data-* are not repeated). */
  attributes: string[];
  /** A minimal valid instance, sanitized without warnings by the interactive profile. */
  html: string;
}

/** The elements the interactive profile adds, from the sanitizer policy. */
export function interactiveExamples(): InteractiveExample[] {
  return Object.entries(policy.INTERACTIVE_ELEMENT_ATTRIBUTES).map(([tag, attrs]) => {
    const attributes = Object.keys(attrs);
    const html =
      tag === "input"
        ? `<input type="${[...policy.INTERACTIVE_INPUT_TYPES][0]}">`
        : tag === "option"
          ? '<select><option value="a">A</option></select>'
          : `<${tag}></${tag}>`;
    return { tag, attributes, html };
  });
}

/** The library catalog as the guide and `whoami` show it. */
export function libraryCatalog(): {
  id: string;
  name: string;
  version: string;
  global: string;
  license: string;
  sha256: string;
  source: string;
}[] {
  return Object.entries(LIB_CATALOG).map(([id, lib]) => ({
    id,
    name: lib.name,
    version: lib.version,
    global: lib.global,
    license: lib.license,
    sha256: lib.sha256,
    source: lib.source,
  }));
}

/**
 * The guide's section on external resources (ADR-022): what ingest-time vendoring accepts on this instance and
 * what still cannot work.
 */
export function vendoringGuide(enabled: boolean): string {
  if (!enabled) {
    return "\n## External resources\nOff on this instance: a write that references external https resources (fonts, stylesheets, scripts, images) is refused with FETCH_BLOCKED. Use the bundled fonts and libraries and add_asset with base64.\n";
  }
  return `
## External resources (vendored)
- Write content as you would for a browser: \`<img src="https://…">\`, CSS \`url(https://…)\`, \`@import url(https://…)\` (Google Fonts included), \`@font-face\` with an https \`src\`, \`<link rel="stylesheet">\`/\`<script src>\` (classic builds from jsDelivr, unpkg, cdnjs…) and \`libs\` entries that are https URLs.
- On write, the server downloads each resource ONCE (https only, public hosts, at most 3 redirects), checks it by content and stores it; the deck is rewritten to the stored copy, so viewers never contact those hosts. Same URL again: no new download.
- Limits per write: 100 URLs, 40 MB; per file: script 2 MB, stylesheet 512 KB, font 2 MB, image 8 MB (PNG, JPEG, GIF, WebP, AVIF; SVG must be inline).
- Results list each URL in \`vendored\` (status vendored/reused/failed). A failed resource is dropped with a VENDOR_FAILED warning: tell the user, or use another URL.
- Cannot work: network at runtime (fetch, XHR, WebSocket, live APIs: put the data in the deck), iframes, embeds, video/audio, ES modules (\`type="module"\`, \`import … from "https://…"\`: use the UMD/IIFE build and its global), JSX/React that needs a transpiler.
- A whole HTML artifact (inline styles and scripts, CDN links): \`import_html_deck\` turns it into slides (elements with class "slide", sibling \`<section>\`s, or h1/h2 boundaries).
`;
}

/** The guide's script section for an instance; short when scripts are off. */
export function scriptsGuide(status: ScriptsStatusLabel): string {
  if (status === "off") {
    return "\n## Interactive scripts\nOff on this instance: `script` and `libs` are stored but never run, so every slide shows its static HTML/CSS. Do not rely on them.\n";
  }
  const elements = interactiveExamples()
    .map((e) => (e.attributes.length > 0 ? `${e.tag} (${e.attributes.join(" ")})` : e.tag))
    .join("; ");
  const types = [...policy.INTERACTIVE_INPUT_TYPES].join("/");
  const libs = libraryCatalog()
    .map((l) => `\`${l.id}\` (${l.name} ${l.version}, global \`${l.global}\`, ${l.license})`)
    .join(", ");
  return `
## Interactive scripts (status: needs_owner_approval)
- A slide's code goes in its \`script\` field: an inline classic script, at most ${kb(LIMITS.maxSlideScript)} per slide and ${kb(LIMITS.maxDeckScripts)} per deck, without "<script", "</script" or "<!--". \`<script>\` in \`html\` is removed.
- It runs once as \`function (slide) { … }\` with \`slide = { root, onEnter(fn(step)), onLeave(fn), onStep(fn(step)), setSteps(n) }\`; \`root\` is the slide's \`<section>\`. Call \`setSteps\` during setup only. Use \`addEventListener\`, never on* attributes.
- No network at runtime: fetch, XHR, WebSocket, WebRTC, workers, eval/new Function, iframes, \`<script>\`/\`<link>\` elements and \`document.write\` are blocked. Libraries go in \`libs\`, in load order: an https CDN URL of a classic UMD/IIFE build (vendored on write, then part of what the owner approves) or a bundled id: ${libs}.
- Shared code (helpers, global functions) can go in the deck-level \`script\`: it runs once in the global scope after \`libs\` and before the slide scripts.
- Extra HTML in decks with scripts: ${elements}; input type ${types}; data-* attributes. Still removed: ${policy.INTERACTIVE_REMOVED_EXAMPLES.join(" ")}.
- Mandatory static fallback: the slide's html/css must make sense without the script. Exports, phones, the presenter preview and any deck the owner has not approved show only that.
- Scripts run only after the owner approves them in the panel; any change to a script or to \`libs\` needs approval again. Tool results report \`interactive.status\`; you cannot approve. Keys typed in inputs stay there; arrows and space still move the slides.
- When a result says \`pending_owner_approval\`, tell the user to open \`interactive.approve_url\` (the presentation's page in the panel), read every script there and approve it if they agree. Never say the code already runs, and never ask for or handle the owner or presenter password.
- Without the owner signed in (presenter links, when they exist), approved scripts run only after someone types the instance's presenter password on that screen; offline copies and exports are always static.
`;
}
