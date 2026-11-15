// SPDX-License-Identifier: AGPL-3.0-or-later
// The authoring guide returned by `get_authoring_guide`: everything an agent needs to write a deck that renders
// well on the first try. Kept under 2,500 tokens (checked by a test). Facts come from @pptaken/schema (limits,
// font catalog) and the sanitizer policy (packages/sanitizer/README.md); keep them in sync when either changes.
import { FONT_CATALOG, LIMITS } from "@pptaken/schema";

/** Version of the guide, bumped with the deck format or the sanitizer policy. */
export const AUTHORING_GUIDE_VERSION = "1";

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
- Removed: @import, @font-face, @container, @layer, @page; \`url()\` except \`url(asset:<id>)\` in backgrounds; \`content:url()\`; attr(), env(), image-set(); selectors with escapes or classes/ids starting with \`pptaken\`. z-index within ±9999.
- No external URLs anywhere: no http(s), no \`data:\` URIs, no web fonts or CDNs. They are removed and could not load anyway.

## Fonts
Use only these families (plus generic ones such as sans-serif, serif, monospace): ${FONT_CATALOG.join(", ")}. Other names are removed. List the ones you use in \`theme.fonts\` (max ${LIMITS.maxThemeFonts}) and always end with a generic fallback: \`font-family:'Inter',sans-serif\`.

## Steps (reveal on click)
- \`data-step="1"\`, \`data-step="2"\`… reveal elements one click at a time; equal numbers appear together; \`data-step=""\` reveals in document order after the numbered ones.
- Hidden steps keep their space, so the layout never jumps. Elements without data-step are always visible.

## Images
1. Create the presentation, then call \`add_asset\` with \`presentation_id\`, \`filename\` and \`source: { base64, media_type }\` (PNG, JPEG, WebP, AVIF or GIF; at most 1 MB decoded per call; prefer WebP or AVIF).
2. Use the returned \`ref\` (\`asset:<sha256>\`) in \`<img src="asset:…">\` or \`background-image:url(asset:…)\` and save it with \`update_slides\`.
- SVG files cannot be uploaded: write the SVG inline in the slide HTML. Downloading images from a URL is not available yet.

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
- No \`<script>\`, event handlers or links: they are removed.
- No external images, fonts or stylesheets, no \`data:\` URLs.
- No vw/vh or % font sizes, no responsive breakpoints, no scrolling boxes.
- No full documents (\`<html>\`, \`<head>\`, \`<body>\`): send only the slide content.

## Example
Slide:
${JSON.stringify(EXAMPLE_SLIDE)}
With \`theme\`: ${JSON.stringify(GUIDE_EXAMPLE.theme)}

## Flow
\`create_presentation\` with all slides in one call → give \`urls.present\` to the user. To edit: \`get_presentation\` (outline by default) shows slide ids and \`revision\`; pass it as \`expected_revision\` to \`update_slides\` or \`update_presentation\`. On REVISION_CONFLICT, read again and reapply. Successful writes may return \`warnings\` listing what the sanitizer removed: fix those slides if the removal matters.
`;
