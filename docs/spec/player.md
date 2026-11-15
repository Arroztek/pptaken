# Player engine (`@pptaken/player`), phases F1 and F3

The player shows a sanitized `pptaken.deck` in the browser: one slide at a time, revealable steps, scaling with a
black letterbox, keyboard navigation and the position in the URL (F1); an overview grid, printing to PDF (one page
per slide), a key help overlay and a presenter view with notes, next slide, clock and pace per section, kept in
sync with the main window (F3). License: Apache-2.0. Design background:
[ADR-001](../adr/0001-content-format.md) and [architecture §6](../foundation/02-architecture.md).

It has these parts with clear trust boundaries:

| Part | Runs | Trust |
|---|---|---|
| **Builder** (`buildDeckDocument`, `contentHeaders`) | server, pure function | input must come from `sanitizeDeck` (barrier 1) |
| **Runtime** (`RUNTIME_SOURCE`, about 8.2 KB) | inside the sandboxed iframe, the only script there | runs next to untrusted content |
| **Shell** (`createPlayer`) | the app page | trusted; owns the state and the mode |
| **Presenter view** (`createPresenter`, `@pptaken/player/presenter`) | a second app window | trusted; the only place with notes |
| **Notes renderer** (`renderNotes`) | server, pure function | turns untrusted Markdown into allowlisted HTML |

The shell and the runtime talk only through a small, versioned `postMessage` protocol validated on both ends. The
main window and the presenter window talk through a same-origin `BroadcastChannel`, also validated. Offline
preload, the service worker and HTML export are other F3 work, outside this document's scope for now.

## Serving requirements

1. **Sanitize on ingest.** The builder does not sanitize; it inserts slide HTML and CSS as they are.
2. **Separate, cookie-less content origin.** Serve deck documents and assets from an origin that holds no
   session (for example `https://usercontent.example`, or a second host name or port for self-hosted instances,
   such as `content.pptaken.local`). A navigation started by content cannot be stopped by any CSP directive; on
   the app origin it would carry the session cookie in WebKit (ADR-001, second verification). The shell only
   takes a `contentUrl`.
3. **Headers of the deck document** (`contentHeaders({ nonce, assetBaseUrl, frameAncestors })`):

   ```
   Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'nonce-<nonce>';
     style-src 'unsafe-inline'; img-src <assetBaseUrl>; font-src <assetBaseUrl>; connect-src 'none';
     form-action 'none'; base-uri 'none'; frame-src 'none'[; frame-ancestors <app origin>]
   Content-Type: text/html; charset=utf-8
   X-Content-Type-Options: nosniff
   Referrer-Policy: no-referrer
   Permissions-Policy: camera=(), microphone=(), geolocation=(), fullscreen=(), ... (all off)
   Cache-Control: no-store
   ```

   `img-src` and `font-src` name the **asset path only** (`https://usercontent.example/c/asset/`), never
   `'self'`. CSP source expressions need a host, so `assetBaseUrl` must be an absolute `http(s)` URL ending in
   `/`; without it images and fonts are `'none'`. The nonce is new for every response (at least 128 random bits),
   so the document is not cacheable in F1.
4. **Headers of assets** (`assetHeaders()` plus `Content-Type`): `nosniff`, `Referrer-Policy: no-referrer`,
   `Access-Control-Allow-Origin: *` (fonts are fetched by an opaque origin, spike S1), immutable caching. Never
   send permissive CORS on API routes. Do not redirect asset requests (CSP path matching is relaxed after a
   redirect). Keep API `GET`s free of side effects.

## Deck document

```html
<!doctype html>
<html lang="…">
<head>
  <meta charset="utf-8"><title>…</title>
  <style>theme CSS</style>
  <style>slide CSS (each scoped by the sanitizer to [data-slide="<id>"])</style>
  <style>stage CSS (last, !important where the theme must not break the player)</style>
  <script nonce="…">runtime</script>
</head>
<body>
  <div id="pptaken-stage" data-width="1920" data-height="1080">
    <section data-slide="<id>" role="group" aria-roledescription="slide" aria-label="<title>" hidden>slide HTML</section>
    …
  </div>
</body>
</html>
```

- Everything the builder interpolates is validated and escaped: title, `lang` (BCP-47 shape), slide ids (schema
  alphabet, unique), nonce (base64 shape). CSS containing `</` or `<!` is refused (sanitized CSS never has it).
- **Assets**: `asset:<hex>` is replaced by `<assetBaseUrl><hex>` only as an exact token in the two places
  sanitized content holds it: a whole `src="…"`/`href="…"` attribute value, and a whole `url(…)` argument (quoted
  or not). The base URL is validated (no quotes, parentheses, spaces, `&`, `$`, dot segments), so the replacement
  cannot change the surrounding syntax. The same text elsewhere (for example in a paragraph) is left alone.
- The runtime is in `<head>`, before any content element exists, so it captures `window`, `document` and
  `parent` before content could define named properties.

## Canvas, scaling and letterbox

The stage is the logical canvas (1920×1080 for 16:9, 1440×1080 for 4:3). The runtime scales it with
`transform: translate(x, y) scale(s)`, `s = min(viewport width / W, viewport height / H)`, centered, on every
resize. `html` and `body` are black (`#000`, `!important`): that is the letterbox. The stage and each section
clip their overflow, so nothing paints outside the canvas. Each section is absolutely positioned at the canvas
size; its default background is white and its default text black (zero-specificity defaults the slide CSS can
override, for example with `body { background: … }`, which the sanitizer maps to the slide). No chrome is drawn
inside the iframe.

## Steps

`data-step="n"` (n = 1..99) and `data-step=""` (no number) mark revealable elements. Elements without the
attribute are always visible. The spec says unnumbered steps appear "in document order"; the player decides how
they combine with numbered ones:

1. Numbered steps come first, in ascending number. Gaps collapse (`1, 3` is two steps) and equal numbers reveal
   together.
2. Unnumbered steps follow, one step each, in document order.
3. A slide has at most 255 steps; extra ones are merged into the last step (no real slide gets close).

Example: `B(2) U1 A(1) U2 B2(2)` gives four steps: `A`, then `B` and `B2`, then `U1`, then `U2`.

**Hidden steps keep their layout** (`visibility: hidden`), so a slide does not jump when a step appears and the
layout is final from the first frame. Hidden steps are also hidden from assistive technology. A revealed step gets
the class `pptaken-revealed` (the sanitizer drops `pptaken*` classes and selectors from content, so content
cannot fake or target it). Consequence: an author cannot animate the reveal in F1 (see open questions). A child
of a hidden step that sets `visibility: visible` itself would show early; that is the author's own content.

Navigation: *next* reveals the next step, then moves to the next slide with no step revealed; *previous* hides
the last step, then moves to the previous slide **with all its steps revealed**; *first* is slide 1 with no step;
*last* is the last slide with all its steps (the end of the talk). Next at the end and previous at the start stay.

## Keys

The shell handles keys on the parent document, and the runtime forwards keys pressed inside the iframe as `key`
messages, so keys work whichever side has focus. Clicking the player gives the iframe focus.

| Keys | Action |
|---|---|
| ArrowRight, ArrowDown, Space, PageDown, Enter | next |
| ArrowLeft, ArrowUp, PageUp, Backspace, Shift+Space | previous |
| Home / End | first / last |
| `b`, `.` | black screen on/off (HID clickers) |
| `f` | full screen on/off (on the host element) |
| `o` | overview on/off |
| `s` | open (or focus) the presenter window (when the page passes `presenterUrl`) |
| `p` | print / PDF |
| `?` | key help on/off |
| `Escape` | close the overview or the help |
| `t`, `Shift+R` | presenter view only: start/pause the clock, reset it |

In the overview: arrows move the highlight (left/right one slide, up/down one row), Home/End go to the ends,
Enter (or a click) goes to the highlighted slide, `Escape` or `o` close it where the talk was; `b`, `.` and `f`
still work.

Keys are matched on `KeyboardEvent.key` (layout aware). Keys with Ctrl, Alt or Meta are ignored, Shift too except
Shift+Space, Shift+R and `?` (which needs Shift on most layouts), as are keys typed in inputs, text areas, selects
and `contenteditable` elements of the parent page.

**Gated keys.** `o`, `s`, `p` and `?` change the mode or open windows. When they arrive from the iframe (a `key`
message), the shell acts only if `navigator.userActivation.isActive` is true in its own page: a real key press in
the iframe propagates the user gesture to its ancestors, a message posted by a script does not. Without the API
the shell fails closed (the keys then work only with focus on the parent page).

**Help overlay.** `?` shows the key list in `#8B8FA0` JetBrains Mono over translucent black, centered; `?` or
`Escape` fade it out (no transition under `prefers-reduced-motion`). Nothing is shown otherwise: no persistent
chrome. Texts come from `i18n.ts` (English, Spanish; option `locale`).

## URL state

`#/<slide>/<step>`: slide 1-based, step 0-based (`#/5/1` is slide 5 with one step revealed). Read at start,
clamped to the deck (`#/99/42` opens the last slide), followed on `hashchange`; an invalid hash is replaced by the
current position. The hash is written with `history.replaceState` once navigation pauses for 400 ms (browsers
rate-limit `replaceState`; WebKit throws after 100 calls in 30 s) and on `pagehide`.

## Black screen, full screen and HUD

The black screen is a `#000` layer in the shell above the iframe (the content is untouched). Full screen is
requested on the host element. With `showHud: true` the shell shows `n / N` in `#8B8FA0` JetBrains Mono over
translucent black after each move and fades it after 2 s (no transition under `prefers-reduced-motion`). The
player animates nothing of its own.

## Protocol (version 1)

All messages are plain objects with exactly the listed keys plus `v: 1` and `type`. Slides are 0-based indexes,
`step` is the number of revealed steps. Validators are hand-written (`parseShellMessage`,
`parseContentMessage`): unknown types, extra or missing keys, other versions, non-integers and out-of-range
numbers are dropped.

| Direction | Message | Fields |
|---|---|---|
| shell → iframe | `goto` | `slide` 0..199, `step` 0..255 (in the overview: the highlighted slide) |
| shell → iframe | `mode` | `mode`: `"present"`, `"overview"` or `"print"` |
| iframe → shell | `ready` | `slides: [{ id, steps }]`, 1..200 entries, ids in the schema alphabet and unique; `width`, `height`: the canvas, integers 1..4096 |
| iframe → shell | `key` | `code`, one of the closed set of key codes (`KEY_CODES`, 22 codes) |
| iframe → shell | `state` | `slide`, `step`: what the iframe shows after a `goto`; also sent as the acknowledgement of a `mode` |
| iframe → shell | `select` | `slide` 0..199: a thumbnail clicked in the overview |

Only the shell sends `mode`. The shell honours `select` only while it has the overview open (otherwise it is
dropped), and checks the slide against the deck. The runtime never changes the mode by itself.

The shell accepts messages only when `event.source` is its iframe's window and `event.origin` is `"null"` (the
content always has an opaque origin). The runtime accepts messages only from `window.parent`. Both post with
target `"*"`: the content origin is opaque, and messages carry no secrets. The shell is the single source of
truth for `{ slide, step }`; the runtime only applies `goto` and reports.

**Faults.** A deck document loads exactly once. A second `load` event of the iframe means the content navigated
it (for example a `<meta http-equiv="refresh">` that slipped past the sanitizer): the shell blanks the iframe,
stops and calls `onFault("unexpected-navigation")`.

## Overview (`mode: "overview"`)

Implemented inside the content runtime, in the same document (no extra iframes): the stage becomes a scrollable
grid and the runtime positions every `<section>` with an inline `transform: translate() scale()` (set with
`!important`, so slide CSS cannot move a thumbnail). Columns depend on the slide count only
(`overviewColumns(n) = clamp(ceil(sqrt(1.2 n)), 1, 6)`), so the shell knows how far ArrowUp/ArrowDown move without
asking the content. Under each thumbnail a caption shows `n  title` (gray mono); where a `section` starts, its
name is shown above the thumbnail (the builder puts it on the section element as `data-section`, escaped). The
highlight is a 3 px ring in the focus-ring color `#A99BFF` (the one brand color the neutral-player rule allows);
the runtime scrolls it into view inside the iframe only. Content inside thumbnails takes no pointer events, so a
click always lands on a slide, and the runtime reports it with `select`.

**Steps in the overview: every slide is shown fully revealed, by design.** The overview is a map of the talk; a
thumbnail with half its content hidden is misleading. Consequence: whoever sees the screen while the overview is
open sees upcoming steps. Present mode is untouched: closing the overview restores the exact slide and step.

Performance: no virtualization. Sections get `content-visibility: auto` in the overview, so off-screen thumbnails
skip rendering. Measured with a synthetic 200-slide deck (text, list, SVG and a step per slide), see Tests.

## Print (`mode: "print"`) and PDF

Print mode is pure CSS from the builder: every slide stacked at canvas size, every step visible, `break-after:
page`, backgrounds kept (`print-color-adjust: exact`), and `@page { size: <W>px <H>px; margin: 0 }`. The same rules
also apply under `@media print`, so printing the content document from any path shows all steps.

`player.print()` (key `p`): the shell (1) closes the overview/help, (2) adds a print stylesheet to the page and
marks the host (`data-pptaken-printing`): the host and the iframe grow to `W × (N·H)` CSS pixels, everything else
in `<body>` is hidden in print media, and the page's `@page` is the canvas size, (3) sends `mode: "print"` and waits
for the acknowledgement (`state`, or 1.5 s), (4) waits two frames and calls `window.print()` on the **app page**.
On `afterprint` (or any key, as a fail-safe) it returns to present mode at the same position. `Ctrl+P` from the
browser menu triggers the same layout through `beforeprint` (best effort: the content's `@media print` rules do the
rest).

Why not print the content frame: the content is a sandboxed iframe with an opaque origin; the shell cannot call
`print()` on it (cross-origin), and the content's CSP sandbox has no `allow-modals`, so it cannot print itself.
Chromium slices a tall cross-origin iframe into pages when it prints the parent, which gives exactly one page per
slide (verified with `page.pdf()`). The host must be a descendant of `<body>` whose ancestors do not clip it.

Verified: Chromium, a real PDF of the 20-slide example has 20 pages and each page has text (`pdftotext`), with the
revealable steps printed. Firefox and WebKit: the print layout (mode, frame size, slides stacked at canvas size,
all steps visible, return on `afterprint`) is verified; their PDF output is not (Playwright exposes PDF only for
Chromium, and their handling of a tall cross-origin iframe when printing was not verified).

## Presenter view

`createPresenter(root, { contentUrl, data, sync?, locale?, now?, tickMs?, keyboard?, onChange? })`, module
`@pptaken/player/presenter`, framework-free, served by the server like the shell modules. Page
`GET /p/:deckId/presenter` (owner session), data from `GET /api/v1/decks/:id/presenter` (see the HTTP API spec).

- **Layout** (dark, neutral, `@pptaken/ui` tokens: ink/paper/slate colors, Inter for text, JetBrains Mono for the
  clock and numbers): a top bar with slide `n / N` and step, the clock (elapsed vs target) with the pace status,
  and buttons (previous, next, start/pause, reset); on the left the current slide and the pace per section; on
  the right the next slide (or "End of the presentation") and the notes (scrollable, 1.5rem type).
- **Previews** are two ordinary players (`createPlayer` with `hash: false`, `keyboard: false`, `help: false` and
  an `onKey` hook): the same sandboxed iframe, CSP and runtime as the main window, each scaled by the runtime with a
  CSS transform. The next preview sits at `next(position)`: the next step, or the next slide with no step.
- **Keys**: navigation keys, `b`/`.` (black screen of the main window), `f` (full screen of the presenter), `t`
  start/pause, `Shift+R` reset. Keys pressed inside a preview come back through `onKey`.
- **Clock and pace** (`pace.ts`, pure, tested with a fake clock): the clock counts only while running (manual
  start, decision below); time is attributed to the slide shown while it runs. Plan per slide: `durationHintSec`,
  and slides without a hint share what is left of `targetMinutes`. Pace is **on time** while the elapsed time is
  inside the planned window of the current slide, **behind** after it, **ahead** before it (shown as `+m:ss
  behind` / `-m:ss ahead`). Sections are runs of consecutive slides with the same `section`; the table shows
  planned vs actual per section, the current one highlighted, finished ones over plan in orange and under plan in
  green. Without hints and target only the clock is shown.
- **Notes** arrive as HTML from `renderNotes` and are rebuilt node by node against the same allowlist
  (`setNotesHtml`, no `innerHTML`), defense in depth.

### Window sync (`sync.ts`)

A `BroadcastChannel` named `pptaken:<deckId>` (`syncChannelName`), same origin, no network. Messages, all `v: 1`,
exact keys, validated on receipt and before sending, unknown ones ignored:

| Message | Fields | Meaning |
|---|---|---|
| `hello` | none | a window joined; the others answer with `nav` and `black` |
| `nav` | `slide` 0..199, `step` 0..255 | this window moved by its own input |
| `black` | `on` boolean | black screen on/off |

Either window can navigate and both follow. A change applied because of a message is not sent back (no echo,
hence no ping-pong); a burst of keys converges. When the presenter opens, it says `hello` and takes the main
window's position. Only positions travel on the channel: never notes or other presenter data.

## Speaker notes policy

Notes are Markdown in the deck (`slides[].notes`, at most 16 KB). They reach the browser **only** through
`GET /api/v1/decks/:id/presenter` (owner session) and are shown **only** in the presenter view. They are stripped
before building the content document (`/c/*`), are not in the content iframe, not on the sync channel, and the
public link (F5) and the remote (F4) must not get them (threat T7).

`renderNotes(markdown)` is a small hand-written renderer (no dependency): paragraphs (every line break kept as
`<br>`), `**bold**`, `*italic*`, `` `code` ``, fenced code blocks, `-`/`*`/`+` and `1.`/`1)` lists nested one
level, `#` → `h3` and `##`+ → `h4`, one level of `>` blockquote, backslash escapes. Output allowlist: `p br
strong em code pre ul ol li h3 h4 blockquote`, no attributes except a numeric `ol start`, no inline styles, no
URLs. Links, images, autolinks, raw HTML and entities are shown as text (escaped, never decoded). Inline formatting
does not span lines. Input over 64 KB is cut. Linear time: emphasis uses a delimiter stack with per-kind opener
lists and depth 4, code spans pair backtick runs by precomputed "next run of the same length".

## API

```ts
// server
buildDeckDocument(deck, { nonce, assetBaseUrl?, lang?, frameAncestors? }): { html, csp }
contentHeaders({ nonce, assetBaseUrl?, frameAncestors? }): Record<string, string>
contentSecurityPolicy({ nonce, assetBaseUrl?, frameAncestors? }): string
assetHeaders(): Record<string, string>

renderNotes(markdown): string                      // speaker notes -> allowlisted HTML
parsePresenterData(json): PresenterData | null     // presenter API shape, validated

// browser (import "@pptaken/player/shell": no builder, no schema, no zod)
createPlayer(host, { contentUrl, initial?, hash?, keyboard?, showHud?, title?, help?, locale?, presenterUrl?,
  sync?, onKey?, onReady?, onChange?, onRender?, onFault?, onLoadTimeout?, loadTimeoutMs? })
  -> { goto(slide, step?), next, prev, first, last, black(on?), toggleFullscreen, overview(on?), print(),
       openPresenter(), help(on?), getState, getCanvas, iframe, ready, destroy }
// state: { slide, step, slideId, slideCount, stepCount, black, mode, highlight }

// browser (import "@pptaken/player/presenter")
createPresenter(root, { contentUrl, data, sync?, locale?, now?, tickMs?, keyboard?, onChange? })
  -> { goto, next, prev, toggleClock, resetClock, getState, current, upcoming, ready, destroy }

// shared, pure
navigation: clamp, next, prev, first, last, samePosition, parseHash, formatHash, overviewMove, KEY_ACTIONS
protocol: parseShellMessage, parseContentMessage, overviewColumns, PROTOCOL_VERSION, MODES, MAX_SLIDES,
  MAX_STEPS, MAX_CANVAS, KEY_CODES, message types
sync ("@pptaken/player/sync"): openSync, parseSyncMessage, syncChannelName
pace ("@pptaken/player/pace"): clock*, slideTimes, attribute, buildPlan, paceAt, sectionReport, formatClock
keys: keyCodeOf     i18n: LABELS, labelsFor, pickLocale
```

## Build

`tsc` only. The library is compiled as usual; the runtime (`runtime.ts` with `keys.ts` and `messages.ts`) is
compiled by a second `tsconfig.runtime.json` without comments, and `scripts/build-runtime.mjs` concatenates the
three modules in an IIFE (removing their relative `import` lines and `export` keywords), drops indentation, checks
that the result cannot close a `<script>` element, and writes `dist/runtime-source.js` (`RUNTIME_SOURCE`). No
bundler.

## Tests

- `pnpm --filter @pptaken/player test` (Vitest, against `dist`; build first): navigation over every deck shape
  with up to 4 slides of up to 3 steps plus large shapes, hash parsing, protocol validators, key mapping, builder
  escaping, nonce, asset rewriting, CSP and headers, and the example decks (sanitized) build with section ids equal
  to slide ids.
- `pnpm --filter @pptaken/player test:browser` (Playwright, Chromium, Firefox, WebKit): a shell origin
  (`localhost`) and a separate content origin (`127.0.0.1`), real headers. Every step and slide of the 20-slide
  example (plus an image asset) forward with focus in the iframe and back with focus on the parent, checking state,
  the visible slide and the revealed steps after every key; step semantics; URL hash; black screen and full
  screen; HUD; scaling of 16:9 and 4:3 decks at six viewport sizes; frame times; and raw hostile content injected
  into the built document (scripts, handlers, `@import`, `@font-face`, images and backgrounds to `/api`, frames,
  media, forms, `fetch`, XHR, cookies, storage, parent access, top navigation, popups, `eval`) with zero requests
  reaching any server, plus the navigation fault. Results in `packages/player/browser/last-run.json`.
- F3 unit tests: notes renderer (features, hostile corpus, 2000 random inputs, output re-parsed with a strict
  grammar and with the sanitizer's HTML parser, linear time on 14 adversarial shapes, 64 KB under 250 ms), new
  protocol messages and bounds, key mapping, overview navigation, sync messages over a real `BroadcastChannel`
  (Node), presenter data validation, and clock/pace with a fake clock.
- F3 browser tests (same harness, all three engines): overview with keys (from the page and from inside the
  iframe), mouse, sections, all steps shown, `select` validated and ignored outside the overview; key help; print
  layout and, in Chromium, a real PDF via `page.pdf()` (20 pages for the 20-slide example, text on every page via
  `pdftotext`, steps printed); presenter window opened with `s`, sync in both directions (keys, button, a burst of
  12 keys converges), previews at the current and next position, notes shown and absent from every content
  document and from the `/c/` response, black screen both ways, clock start/pause/reset (real time), pace ahead,
  and behind after 20 minutes with Playwright's fake clock; the hostile document cannot select, change the mode,
  print, open help or open windows. Last run: Chromium 407, Firefox 401, WebKit 401 checks, all passing.
- Overview with 200 slides (synthetic deck: heading, list, SVG and a step per slide; 1280×720): open to ready
  55-135 ms, first two frames 17-24 ms, scroll through the whole grid p95 about 16.7 ms cold and warm in all three
  engines, 30 ArrowDown presses 38-173 ms. No virtualization needed at this size.
- `apps/server`: Vitest for the presenter API and page (owner only, notes rendered, never on the content origin,
  rate limit, fonts) and the browser smoke test extended with the real presenter window (sync both ways, notes
  shown there and absent from content documents) in all three engines.

## Decisions and open questions (F3)

Decisions (the safer or simpler option where the brief left room):

- **Overview steps fully revealed**, on the audience screen too (see Overview). Alternative considered: thumbnails
  at the current reveal state, which hides content the presenter wants to find.
- **Overview grid is continuous** (sections are labels, not row breaks), so ArrowUp/ArrowDown are exactly ±columns
  and the column count is a pure function of the slide count shared by shell and runtime. No extra message.
- **Overview highlight owned by the shell**; `goto` moves it in the content. `select` is honoured only while the
  overview is open.
- **Mode keys from the iframe need a user gesture** (`navigator.userActivation`), fail closed without the API.
- **Print through the app page**, the iframe grown to N canvases (see Print). Any key during print mode ends it.
- **`ready` carries the canvas size** (`width`, `height`): the shell needs it for the print page size and the
  presenter for its preview boxes. Same protocol version (shell and runtime always ship together).
- **`KEY_CODES` moved to `protocol.ts`** (keys.ts keeps the `KeyCode` type) so the runtime does not carry the list.
- **Clock starts manually** (`t` or the button), never on the first move: rehearsals and a late start would
  otherwise count. Reset (`Shift+R`) also clears the time per slide.
- **Pace windows**: on time while inside the planned window of the current slide; slides without a hint share the
  remaining target time evenly.
- **No echo on the sync channel**; last writer wins if both windows move at the very same moment (the next key
  resyncs). The channel carries positions and the black screen only.
- **Previews are full players at preview size** (the runtime scales the canvas with a transform inside each
  iframe), not 1920×1080 iframes scaled from outside: same visual result, less rendering work.
- **UI fonts on the app origin** (`/_player/fonts/`), because the app CSP allows `font-src 'self'` only and the
  presenter must not depend on the content origin.

Open questions:

- **Printing in Firefox and WebKit**: the layout is verified, but whether they paginate a tall cross-origin iframe
  when printing the parent was not (no PDF API in Playwright). If not, the fallback is to open the content
  document top-level for printing (its `@media print` rules already lay it out), which needs a print-only content
  URL and `allow-modals` thinking.
- **Overview on the audience screen** shows upcoming steps; a presenter-only overview (in the presenter window)
  may be preferable for some talks.
- **Presenter on a public/delegated link** (backlog): the data API is owner-only today.
- **BroadcastChannel needs both windows on the same origin and profile**: a presenter on another device is F4
  (remote, through the server).

## Open questions (F1)

- **Reveal animations.** Authors cannot select `pptaken-revealed`. Expose a stable, content-visible hook for
  CSS transitions (for example a state attribute the sanitizer allows in selectors only), or keep reveals instant.
- **Fonts.** The deck's catalog fonts need `@font-face` rules pointing at the asset path; the builder does not
  emit them yet (it should take the catalog file URLs from the server).
- **Document-wide names** (`@keyframes`, SVG ids) are shared by all slides in one document (sanitizer README).
- **Many slides in one document**: up to 200 slides of 256 KB each. If memory becomes a problem, F3 can keep only
  neighbouring slides in the DOM.
- **Unexpected navigation** is detected after the fact; the separate cookie-less origin is what makes it harmless.
- **Click to advance** and pointer/touch input are not handled in F1.
