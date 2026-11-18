# Player engine (`@pptaken/player`), phases F1, F3 and F4

The player shows a sanitized `pptaken.deck` in the browser: one slide at a time, revealable steps, scaling with a
black letterbox, keyboard navigation and the position in the URL (F1); an overview grid, printing to PDF (one page
per slide), a key help overlay and a presenter view with notes, next slide, clock and pace per section, kept in
sync with the main window (F3). License: Apache-2.0. Design background:
[ADR-001](../adr/0001-content-format.md) and [architecture §6](../foundation/02-architecture.md).

It has these parts with clear trust boundaries:

| Part | Runs | Trust |
|---|---|---|
| **Builder** (`buildDeckDocument`, `contentHeaders`) | server, pure function | input must come from `sanitizeDeck` (barrier 1) |
| **Runtime** (`RUNTIME_SOURCE`, about 10.0 KB) | inside the sandboxed iframe, the only script there | runs next to untrusted content |
| **Offline document builder** (`buildOfflineDocument`) | server, pure function | same input rule as the builder |
| **Service worker** (`dist/sw.js`, served at `/p/sw.js`) | the browser, scope `/p/` | trusted; never touches content routes |
| **Shell** (`createPlayer`) | the app page | trusted; owns the state and the mode |
| **Presenter view** (`createPresenter`, `@pptaken/player/presenter`) | a second app window | trusted; the only place with notes |
| **Notes renderer** (`renderNotes`) | server, pure function | turns untrusted Markdown into allowlisted HTML |

The shell and the runtime talk only through a small, versioned `postMessage` protocol validated on both ends. The
main window and the presenter window talk through a same-origin `BroadcastChannel`, also validated. Offline
presenting (in-memory preload and service worker) is specified below; HTML export lives in `@pptaken/export`.

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
| `Escape` | close the overview or the help; in the presenter view, at the last slide and step only: finish |
| `t`, `Shift+R` | presenter view only: start/pause the clock, reset it |
| `r` | remote control: open/close the pairing panel (F4; handled by the page through `onKey`) |
| `k` | remote control: disconnect every paired phone (F4; handled by the page through `onKey`) |

In the overview: arrows move the highlight (left/right one slide, up/down one row), Home/End go to the ends,
Enter (or a click) goes to the highlighted slide, `Escape` or `o` close it where the talk was; `b`, `.` and `f`
still work.

Keys are matched on `KeyboardEvent.key` (layout aware). Keys with Ctrl, Alt or Meta are ignored, Shift too except
Shift+Space, Shift+R and `?` (which needs Shift on most layouts), as are keys typed in inputs, text areas, selects
and `contenteditable` elements of the parent page.

**Gated keys.** `o`, `s`, `p`, `?`, `r` and `k` change the mode, open windows or act on remotes. When they arrive from the iframe (a `key`
message), the shell acts only if `navigator.userActivation.isActive` is true in its own page: a real key press in
the iframe propagates the user gesture to its ancestors, a message posted by a script does not. Without the API
the shell fails closed (the keys then work only with focus on the parent page).

**Help overlay.** `?` shows the key list in `#8B8FA0` JetBrains Mono over translucent black, centered; `?` or
`Escape` fade it out (no transition under `prefers-reduced-motion`). Nothing is shown otherwise: no persistent
chrome. Texts come from `i18n.ts` (English, Spanish; option `locale`). The rows are `keyHelpRows(labels,
presenter, remote)`; with a presenter window (`presenterUrl`) they also list its keys: `T` (clock), `Shift+R`
(reset) and `Esc` (finish, on the last slide).

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
| iframe → shell | `key` | `code`, one of the closed set of key codes (`KEY_CODES`, 24 codes since F4) |
| iframe → shell | `state` | `slide`, `step`: what the iframe shows after a `goto`; also sent as the acknowledgement of a `mode` |
| iframe → shell | `select` | `slide` 0..199: a thumbnail clicked in the overview |
| iframe → shell | `preload` | once, after `ready`: `ok` boolean, `images` and `fonts` 0..10000 (resources now in memory), `failed`: at most 16 of `"image-error"`, `"image-timeout"`, `"font-error"`, `"font-timeout"`; `ok` must equal `failed.length === 0` |

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

`createPresenter(root, { contentUrl, data, sync?, locale?, now?, tickMs?, keyboard?, panelUrl?, onFinish?,
onChange? })`, module `@pptaken/player/presenter`, framework-free, served by the server like the shell modules.
Page `GET /p/:deckId/presenter` (owner session), data from `GET /api/v1/decks/:id/presenter` (see the HTTP API
spec).

- **Layout** (dark, neutral, `@pptaken/ui` tokens: ink/paper/slate colors, Inter for text, JetBrains Mono for the
  clock and numbers): a top bar with slide `n / N` and step, the clock (elapsed vs target) with the pace status,
  buttons (previous, next, start/pause, reset, finish) and, for the owner, a "Back to panel" link; on the left the current slide and the pace per section; on
  the right the next slide (or "End of the presentation") and the notes (scrollable, 1.5rem type).
- **Previews** are two ordinary players (`createPlayer` with `hash: false`, `keyboard: false`, `help: false` and
  an `onKey` hook): the same sandboxed iframe, CSP and runtime as the main window, each scaled by the runtime with a
  CSS transform. The next preview sits at `next(position)`: the next step, or the next slide with no step.
- **Keys**: navigation keys, `b`/`.` (black screen of the main window), `f` (full screen of the presenter), `t`
  start/pause, `Shift+R` reset, `Escape` finish (only at the end, see below). Keys pressed inside a preview come
  back through `onKey`.
- **End of the talk** (presenter view only). At the last slide with every step revealed (`navigation.isEnd`;
  advancing further does nothing), the bar shows a discreet cue, "End of presentation · Esc to exit"
  (`[data-pptaken-end-cue]`, a status line, not a blocking screen; hidden in print). The audience window never
  shows it: the main player has no end cue, no end screen and no new chrome. `presenter.finish()` (the **Finish**
  button, always available, or `Escape` at the end) turns the audience screen black over the sync channel (the
  existing `black` message), calls `onFinish`, then closes the presenter window after 150 ms (so the message
  leaves first). A window the browser does not let a script close (one the user opened by hand) stays open and
  shows "Presentation finished: the audience screen is black. You can close this window." `Escape` elsewhere in
  the talk does nothing, so a stray key cannot end it. `getState()` reports `atEnd` and `finished`.
- **Back to panel**: with `panelUrl` (same-origin, checked) the bar has a "Back to panel" link that opens it in a
  new tab with `rel="noopener noreferrer"`. The server's presenter page passes `/decks` only when the deck came
  from the network with the owner session (the page and its data API are owner-only); an offline copy proves no
  session, so the link is left out there.
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
public link (F5) must not get them (threat T7). **Amended by ADR-017 (F4):** an **approved** remote phone gets them
over HTTP (`GET /api/v1/remote/deck`, device credential), never on the real-time socket; a pending device gets
nothing.

`renderNotes(markdown)` is a small hand-written renderer (no dependency): paragraphs (every line break kept as
`<br>`), `**bold**`, `*italic*`, `` `code` ``, fenced code blocks, `-`/`*`/`+` and `1.`/`1)` lists nested one
level, `#` → `h3` and `##`+ → `h4`, one level of `>` blockquote, backslash escapes. Output allowlist: `p br
strong em code pre ul ol li h3 h4 blockquote`, no attributes except a numeric `ol start`, no inline styles, no
URLs. Links, images, autolinks, raw HTML and entities are shown as text (escaped, never decoded). Inline formatting
does not span lines. Input over 64 KB is cut. Linear time: emphasis uses a delimiter stack with per-kind opener
lists and depth 4, code spans pair backtick runs by precomputed "next run of the same length".

## Offline presenting (F3)

Goal: once a presentation has loaded, presenting never fails because the network drops; with a service worker
(secure contexts) it also survives a reload or a closed tab. Three layers (architecture §6); the third, the
single-file HTML export, is `@pptaken/export`. Empirical background: [spike S4](../spikes/S4-offline.md).

### Layer 1: in-memory preload (every browser, any `http://` host)

After `ready`, the runtime collects every image URL of the document (`<img>`, SVG `<image>`, `url()` in every
stylesheet rule except `@font-face`, and in `style` attributes; `url(#id)` skipped), decodes each with
`new Image().decode()` and keeps the images referenced for the whole talk (so the browser keeps them in its memory
cache; hidden sections and CSS backgrounds included). It also calls `load()` on **every declared font face**
(`document.fonts`). Then it sends `preload` once. Budget: 30 s; whatever is still pending counts as a timeout.
Nothing waits for the preload: navigation works from `ready`.

**Font policy: all declared faces**, not only the families a slide names. Reason: the bundled catalog is small (6
WOFF2 subsets, about 300 KB), a used family needs every `unicode-range` subset anyway (a later slide may contain
`ñ`), and detecting "used" reliably (CSS shorthands, SVG presentation attributes, the overview's own font) costs
runtime code. Revisit if the catalog grows.

### Indicator

States (pure state machine, `offline.ts`): `loading` → `ready` (preload ok) or `partial` (some failure); `ready`
becomes `service-worker` when an offline copy is stored (layer 2) or the page runs from it. `partial` stays partial.

- Neutral player: **no banner**. With `indicator: true` the shell shows an **8 px dot** at 12 px from the top-right
  corner of the host (the letterbox corner, outside the canvas), hidden under the black screen and in print. Colors
  (brand decision 10, semantic colors are allowed there): chrome gray `#8B8FA0` while loading, Success `#3DD68C` for
  ready and service-worker, Warning `#FF9F43` for partial. Not color alone: the dot has `role="img"` and an
  `aria-label` with the text.
- Text on demand (en/es, `i18n.ts`): "Ready to present offline." / "Some resources could not be loaded." / "Ready
  to present offline. A copy is saved on this device." — in the `?` help overlay (last line), in the presenter view
  header (dot and text), and for 2 s as HUD text when the state leaves `loading` (with `showHud`).
- API: `onOffline(status)` option, `player.getOffline()`, `player.setOfflineCopy(on)`; the presenter view has the
  same `getOffline`/`setOfflineCopy`. The server's player page mirrors it as `body[data-offline]`
  (`loading|ready|partial|service-worker`), plus `data-offline-images`, `data-offline-fonts`, `data-offline-copy`
  and `data-source` (`network|copy`), for tests.

With the network cut after `ready`, everything keeps working from memory: navigation, steps, overview, black
screen, print layout, and a presenter window that was already open (its data is loaded once and kept in memory,
its previews preload too; the windows sync over `BroadcastChannel`, which needs no network).

### Layer 2: service worker (secure contexts only)

Registered by the player page (`offline-client.ts`) only when `isSecureContext` and `navigator.serviceWorker`
exist; without it nothing changes. Script `/p/sw.js`, **scope `/p/`**: the narrowest scope that controls the
player (`/p/:id`) and presenter (`/p/:id/presenter`) pages; a controlled page's requests to `/_player/*` and
`/api/*` reach the worker regardless of scope. Served with `Content-Type: text/javascript`, `Cache-Control:
no-cache`, `nosniff` and `Content-Security-Policy: default-src 'none'; connect-src 'self'; frame-ancestors 'none'`.
Built from TypeScript (`sw.ts` + `offline-cache.ts`, `tsconfig.sw.json`) into one classic script by
`scripts/build-runtime.mjs`; the server replaces a build placeholder with a hash of the worker, the shell modules,
the page scripts and styles and the runtime, so any change installs a new worker.

**Why the content frame is not cached as such:** spike S4 measured that no engine routes the opaque-origin
sandboxed iframe (navigation or subresources, same or separate content origin) through the app's worker. So the
worker stores an **offline deck document** instead and, offline, the shell mounts it with **`srcdoc`**:

- `GET /api/v1/decks/:id/offline` (owner session, JSON `{ id, revision, html }`, `no-store`): the current revision
  built by `buildOfflineDocument`: notes removed; images (`png`, `jpeg`, `gif`, `webp`, `avif`) and every bundled
  font face inlined as `data:` URIs; the CSP as the **first** `<meta>` of `<head>`: `default-src 'none';
  script-src 'nonce-…'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action
  'none'; base-uri 'none'; frame-src 'none'`. Missing assets stay `asset:` references and fail (→ `partial`).
- The shell takes `contentHtml` instead of `contentUrl` and refuses (`TypeError`) any string that does not start
  with exactly that `<meta>` (`isOfflineDocument`). Same iframe: `sandbox="allow-scripts"`, opaque origin.
- A srcdoc frame **inherits the page's CSP** (S4, all three engines), so both policies apply. The player and
  presenter pages therefore send `playerCsp`: the app CSP plus `'sha256-<RUNTIME_SHA256>'` in `script-src` (exactly
  the runtime, no other inline script) and `data:` in `font-src`. A content script carrying the right nonce is
  still blocked by the inherited policy (tested). The inherited `connect-src 'self'` is narrowed to `'none'` by the
  document's own `<meta>`.
- Barriers 2-3 on this path are tested in all three engines (player browser test "offline-srcdoc-security": opaque
  origin, no cookies/storage/parent/top navigation/`eval`, `fetch`/XHR blocked, zero requests to any server, a
  content navigation detected as a fault, a document without the CSP `<meta>` refused).

**What is stored** (explicit allowlist, `offline-cache.ts`; everything else is never touched by the worker):

| Cache | Entries |
|---|---|
| `pptaken-offline-shell-<build>` | `/_player/` modules, page scripts and styles, UI fonts (stored at install) |
| `pptaken-offline-v1-deck-<id>` | `/p/<id>`, `/p/<id>/presenter`, `/api/v1/decks/<id>/offline`, `/api/v1/decks/<id>/presenter`, bookkeeping `{revision, bytes, usedAt}` |

Never: `/api/v1/auth/*`, `/api/v1/decks/:id/content-url` (a 5-minute signed URL, useless offline), `/c/*` (signed
tokens). **Keys are origin + path**: the query and fragment are dropped, so no token is ever part of a key, and the
stored routes carry no token at all (the offline document needs none). Only a direct `200` from our origin with the
expected media type is stored: never an error, a redirect (login) or an opaque response.

**When:** the page asks the worker (`keep`, over a `MessageChannel`, validated both ways) once the deck reports
its preload; the worker fetches the four deck URLs itself and stores them **all or nothing**, replacing the deck's
previous entries (so one revision per deck). It never writes deck entries while proxying requests.

**Serving:** network first, so online behavior is unchanged. A stored copy answers when the network fails, or does
not answer within **2.5 s** ("lie-fi", slow refusals); after a failure, stored copies answer at once for 15 s (a
page loads in one go instead of waiting 2.5 s per module). A deck never kept answers, offline, with a small static
page (`data-state="unavailable"`): "This presentation is not available offline. Open it once with a connection to
keep a copy on this device."

**Quota:** before storing, `navigator.storage.estimate()`; if the copies would take the origin above 80 % of its
quota, least recently used decks (`usedAt`, refreshed on every offline open) are evicted first. A
`QuotaExceededError` evicts the next oldest deck and retries, until none is left (then nothing is stored, the copy
reports not kept).

**Updates:** no `skipWaiting()`, no `clients.claim()`. A new worker installs (stores the new shell) and waits until
no player or presenter page is open, so it never takes over mid-talk. On activation it deletes shell caches of other
builds and deck caches of other formats. Deck copies survive an update (each one is self-consistent: page, CSP hash
and runtime were stored together); if a future shell cannot drive an old copy (protocol version), the page shows
the load-timeout message and the next online open refreshes the copy.

**Privacy model:** the copies hold private content and speaker notes on this device, in the owner's browser
profile, like the browser's own cache. They are deleted (fail closed) when: the web app signs out (it deletes every
`pptaken-offline-*` cache directly, no worker needed); the worker sees a `401` or a redirect on a deck route (signed
out or expired session); the owner clicks "Forget offline copies" (web app deck list, shown when copies exist). After
that nothing is served offline. A shared computer should not be used to present private decks without signing out.

### Offline reload

`loadContent` asks for the signed content URL; if that request fails (or the API errors), it asks
`/api/v1/decks/:id/offline`, which the worker answers from the copy. `401` is never answered from a copy. The
presenter page does the same, so a presenter window can be opened, and reloaded, offline (layer 2).

## Remote control (F4)

A phone drives the talk through the server ([ADR-017](../adr/0017-remote-control.md), protocol in
[realtime.md](realtime.md)). The player engine itself only gained three small things; the socket client, the pairing
panel and the phone page are `@pptaken/realtime` modules loaded by the player page.

- **The shell stays the single source of truth.** The player page applies remote commands as local input
  (`next()`, `prev()`, `first()`, `last()`, `goto()`, `black()`), so the presenter window follows over
  `BroadcastChannel` exactly as with a key, and forwards every `onChange` to the socket as `state`. Navigation code
  in `shell.ts` is unchanged; a socket failure never reaches the shell.
- **Keys `r` and `k`** joined the closed key set (`KEY_CODES`, 24 codes; actions `remote` and `kick`). The shell
  does nothing with them: the page takes them in `onKey`. From the iframe they count only during a real user gesture
  (`navigator.userActivation`), like the other gated keys; so do Enter and Escape when they answer the approval
  prompt. Option `remoteKeys: true` lists them in the key help.
- **Laser layer.** `player.pointer({ x, y })` shows a dot at canvas coordinates 0..10000 (`null` hides it). It is a
  trusted element of the shell above the iframe and above the black layer, `pointer-events: none`, no change to the
  iframe protocol. Position: `s = min(w/W, h/H)`, offset `((w − W·s)/2, (h − H·s)/2)`, centre at
  `offset + (x/10000·W·s, y/10000·H·s)`, moved with `translate3d`; diameter `1.2 % × H × s` (at least 2 px), colour
  `#FF3B30` with a soft glow. Hidden after 1.5 s without a new point, when the black screen turns on, in the
  overview and in print (it is not an `iframe` child, so the print layout hides it), and when the socket drops.
- **QR code.** Never on the canvas by default: only while the presenter opens the panel (`r`), drawn in the
  player host (so it stays visible in full screen), or in the presenter window behind a button. The approval prompt
  ("Allow Android · Chrome · 42?") is shown in the host when a phone pairs.
- **Offline.** The remote modules are loaded with a dynamic `import()` after the deck is mounted and only when the
  deck came from the network; with a stored copy or no network nothing is loaded and nothing fails. The service
  worker does not store `/_rt/*`.

Tests: `apps/server/browser/remote.mjs` (Chromium, Firefox and WebKit, a laptop context and a phone context): QR not
shown by default and encoding `<origin>/r#<secret>`, the fragment stripped, the same two digits on both sides,
pending phone without data, Enter approves without navigating, every slide and step (51 positions of the 20-slide
example) from the phone, prev/first/last/black, a burst of 12 taps converging, latency click → slide (p50 2 ms in
Chromium and Firefox, 28 ms in WebKit, loopback), laser position within 1 px of the formula on 16:9 (1280×720,
1000×800, 700×900) and 4:3 (1280×720, 800×900) decks and pad mapping within 1 %, hidden under black, in the
overview and after 1.5 s, the server stopped while the screen keeps navigating and both reconnecting afterwards, the
phone offline and back, kick, notes on the phone and absent from every socket frame and every content document, the
presenter-window panel, no console errors. Last run: 65 checks per engine, all passing. Unit: `laser.test.ts`.

## API

```ts
// server
buildDeckDocument(deck, { nonce, assetBaseUrl?, lang?, frameAncestors? }): { html, csp }
contentHeaders({ nonce, assetBaseUrl?, frameAncestors? }): Record<string, string>
contentSecurityPolicy({ nonce, assetBaseUrl?, frameAncestors? }): string
assetHeaders(): Record<string, string>

renderNotes(markdown): string                      // speaker notes -> allowlisted HTML
parsePresenterData(json): PresenterData | null     // presenter API shape, validated

buildOfflineDocument(deck, { nonce, assets?, fonts? }): { html, missing }   // offline (srcdoc) document
RUNTIME_SHA256                                     // CSP hash source of the runtime

// browser (import "@pptaken/player/shell": no builder, no schema, no zod)
createPlayer(host, { contentUrl | contentHtml, initial?, hash?, keyboard?, showHud?, indicator?, title?, help?,
  locale?, presenterUrl?, sync?, onKey?, onReady?, onChange?, onRender?, onFault?, onOffline?, onLoadTimeout?,
  loadTimeoutMs?, remoteKeys? })
  -> { goto(slide, step?), next, prev, first, last, black(on?), toggleFullscreen, overview(on?), print(),
       openPresenter(), help(on?), pointer({x, y} | null), getState, getCanvas, getOffline, setOfflineCopy(on),
       iframe, ready, destroy }
// laser ("@pptaken/player/laser", pure): laserGeometry(view, canvas, x, y), LASER_COORD_MAX, LASER_SIZE,
//   LASER_TIMEOUT_MS
// offline ("@pptaken/player/offline", "/offline-client", "/offline-cache"): offlineStateOf, offlineStatus,
//   isOfflineDocument; loadContent, keepOfflineCopy, offlineCopyStatus, SignedOutError; routeOf, cacheKeyOf,
//   isCacheable, signsOut, pickEvictions, bytesToFree, parseClientMessage, parseWorkerReply
// state: { slide, step, slideId, slideCount, stepCount, black, mode, highlight }

// browser (import "@pptaken/player/presenter")
createPresenter(root, { contentUrl, data, sync?, locale?, now?, tickMs?, keyboard?, panelUrl?, onFinish?,
  onChange? })
  -> { goto, next, prev, toggleClock, resetClock, finish, getState, current, upcoming, ready, destroy }

// shared, pure
navigation: clamp, next, prev, first, last, isEnd, samePosition, parseHash, formatHash, overviewMove, KEY_ACTIONS
shell: keyHelpRows(labels, presenter, remote)
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
that the result cannot close a `<script>` element, and writes `dist/runtime-source.js` (`RUNTIME_SOURCE` and its
CSP hash `RUNTIME_SHA256`). The same script concatenates `offline-cache.ts` and `sw.ts` (compiled by
`tsconfig.sw.json` with the `WebWorker` lib) into the classic worker `dist/sw.js` (about 12.5 KB). No bundler.

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
  print, open help or open windows. End of the talk: no cue before the end, Esc there does nothing, the cue at the
  last slide and step in the presenter view and nowhere in the audience page or its content frame, hidden in
  print, Finish only in the presenter view, Esc at the end blacks the audience screen and closes the presenter
  window, and a window that cannot close itself shows the "you can close this window" message; the key help lists
  the presenter keys. Last run (with the offline sections): Chromium 452, Firefox 446, WebKit 446 checks, all
  passing.
- `pnpm --filter @pptaken/player test` also covers `isEnd` (against `next` over many shapes), `keyHelpRows` and
  the end/finish texts in both languages (`test/end.test.ts`).
- `apps/server` browser smoke test (`browser/presenter.mjs`, all three engines): the owner's presenter view has
  the "Back to panel" link (`/decks`, new tab, `noopener`), the audience page has none; the end cue shows in the
  presenter view and not in the audience page or its frames; Esc at the end closes the presenter window and the
  main window turns black.
- Overview with 200 slides (synthetic deck: heading, list, SVG and a step per slide; 1280×720): open to ready
  55-135 ms, first two frames 17-24 ms, scroll through the whole grid p95 about 16.7 ms cold and warm in all three
  engines, 30 ArrowDown presses 38-173 ms. No virtualization needed at this size.
- Offline, unit (`test/offline.test.ts`): `preload` validator and bounds, indicator state machine, offline
  document (CSP `<meta>` first, inlining, notes removed, invalid input refused, shape check), worker allowlist and
  token-free cache keys, cacheable/signed-out responses, cache names and versions, eviction and quota (fake
  estimates and errors), page/worker messages, `loadContent` fallback with a fake `fetch`.
- Offline, browser (player harness, all three engines): preload and dot (size, place, color, label), HUD and help
  text, every slide and step with the network cut (`setOffline` + every request aborted), overview and black screen
  offline, `partial` with a 404 asset, the srcdoc path under the production page CSP (traversal offline, opaque
  origin, no requests) and its hostile-content checks.
- `apps/server` browser test: the F3 definition of done on the real server (see `apps/server/browser/offline.mjs`):
  ready offline, network cut three ways (server stopped too), every slide and step, overview and selection, black
  screen, presenter opened before the cut (notes, next preview, clock, sync), and with the worker: presenter opened
  after the cut, player and presenter reloaded offline, a never-opened deck's message, srcdoc barriers, `partial`,
  token-free cache, logout deleting the copies.
- `apps/server`: Vitest for the presenter API and page (owner only, notes rendered, never on the content origin,
  rate limit, fonts) and the browser smoke test extended with the real presenter window (sync both ways, notes
  shown there and absent from content documents) in all three engines.

## Decisions and open questions (F3)

Decisions (the safer or simpler option where the brief left room):

- **Offline delivery through `srcdoc`, not through the worker intercepting the content frame**: no engine routes
  the sandboxed frame through the app's worker (S4). The offline document reuses the export's approach.
- **The page CSP gains the runtime hash and `data:` fonts** (player and presenter pages only), because a srcdoc
  frame inherits it. Alternative rejected: a worker on the content origin, which needs an unsandboxed document there.
- **Preload all declared font faces** (see Layer 1).
- **One offline copy per deck (current revision)**, stored all or nothing when the page asks, never while proxying.
- **Network first with a 2.5 s grace and a 15 s circuit breaker** when a copy exists: online behavior unchanged
  on a healthy network; a dead or slow network does not make an offline load crawl. A slow but working network
  may get the stored player page or presenter data (the deck itself still comes from the content route online).
- **No `skipWaiting`/`clients.claim`**; deck copies survive worker updates.
- **Logout clears copies in the web app directly** (Cache Storage, no worker needed), and the worker fails closed
  on `401`/redirects. Minimal "Forget offline copies" control in the deck list.
- **The dot is persistent** (8 px, letterbox corner, hidden in black screen and print), as the brand decided;
  the text is only on demand.

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
- **Presenter window opened after the network is cut, without a service worker** (plain `http://` on the local
  network): not possible (its page cannot load). Open it before the talk. An in-memory presenter rendered into an
  `about:blank` popup by the main page would remove that limit.
- **Gated mode keys cannot be tested in automation**: under Playwright `navigator.userActivation.isActive` is
  always `true` (all three engines), so the existing "content cannot change the mode" check relies on timing.
- **Real-browser offline**: Firefox's automatic offline mode and real Safari/iOS were not verified (only
  Playwright's emulations; see S4 for how each one interacts with the worker).
- **Memory**: every decoded image is kept for the whole talk; a 200-slide deck with many large images may need a
  budget or a sliding window.

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

## Interactive mode (author scripts, ADR-020)

Off unless the server builds a **scripted document** (`buildDeckDocument(deck, { scripts: true })`), which it does
only for the owner's approved session. The page passes `createPlayer({ contentUrl, scripts: true, expect,
fallbackUrl, onScriptError })`; with `contentHtml` (offline) script mode is never used.

**Scripted document.** `<html data-pptaken-scripts>`; the runtime in `<head>` without a nonce; each library's
stylesheet in `<head>` and its script, then one wrapped script per slide (`pptaken.register("<id>",
function (slide) { … });`, line breaks normalized to LF) as the last elements of `<body>`; scripted sections carry
`data-pptaken-script`. CSP (`contentSecurityPolicy({ scriptHashes })`): `script-src` lists only the SHA-256 of the
runtime, each library and each wrapped script (no nonce, no `'strict-dynamic'`, no `'unsafe-eval'`), plus
`script-src-attr 'none'; worker-src 'none'; object-src 'none'; webrtc 'block'; require-trusted-types-for 'script';
trusted-types default`. Every content document also gets `X-DNS-Prefetch-Control: off`.

**Runtime in script mode**, before any author script: captures the intrinsics it needs, runs the lockdown
(`lockdown.ts`: WebRTC and every `RTC*` global, `fetch`, XHR, WebSocket, EventSource, WebTransport, workers,
`BroadcastChannel`, `open`, `customElements`, `XSLTProcessor`, `navigator.sendBeacon`/`connection`/devices,
`document.write/open/execCommand`, element creation and HTML parsing of `script`, `link`, `meta`, `base`, frames,
`object`, `embed`, `form`; a Trusted Types `default` policy), opens a `MessageChannel` and posts `hello` with its
port (the first message, from `<head>`), and defines `pptaken.register`. At `DOMContentLoaded` it calls each
registered setup with `{ root, onEnter, onLeave, onStep, setSteps }` (errors caught per slide), then posts `ready`
with the declared step counts. It beats every second, reports author errors as `{ type: "error", slide }` (after
`ready`, at most 5 per slide, no text), never forwards synthetic (`isTrusted === false`) key events, and keeps keys
typed in form controls inside the frame except `Escape`, `b` and `f`.

**Protocol additions** (iframe → shell): `hello` (window, exactly one transferred port), then on the port only:
`beat`, `error {slide}` and the usual messages. **Shell in script mode**: the first window message from the frame
must be `hello` with a port, otherwise `onFault("protocol")`; every later window message is ignored. `ready` is
accepted once and must match `expect` (slide ids and canvas from the server), otherwise `protocol`. `preload` sets
the indicator to `unverified`, never `ready`. `state` must be inside the deck and equal the position the shell
asked for. From the frame, only `FRAME_KEYS_IN_SCRIPT_MODE` (navigation, `b`, `.`, `Escape`) are accepted, at most
10 per second, and they never reach `onKey` (so the remote control's `R`, `K`, `Enter` approval and `Escape`
denial cannot be driven by the frame); every gated key, `Enter` and `f` work from the trusted page only. `Escape`
from the frame moves focus to the host element. In static mode the gate also runs before `onKey` now.

**Watchdog.** Without a `beat` for 3.5 s while the page is visible (and not printing), the shell removes the frame,
shows a plain notice (never an iframe: it could share the busy process), calls `onFault("unresponsive")` and, with
`fallbackUrl`, mounts the static version at the same position. It only helps where the frame runs in another
process (desktop Chromium for every transport, Firefox for a cross-site content origin); elsewhere the whole tab
freezes for as long as the script runs (S5 §3, measured again by `browser/scripts.mjs`).

**Errors** reach the main page (`onScriptError`) and the presenter window over the sync channel
(`script-error {slide}`), which shows a discreet notice; nothing appears on the audience screen.

**Offline and export.** Script mode is online only: the offline document, the service worker copy and the
`.html`/`.pkn` exports are built from `staticDeck(deck)` (no scripts). The presenter window's previews and paired
phones always load the static version too.

**Tests.** `test/scripts.test.ts` (document, CSP, wrapper, hashing, libraries, protocol, key policy, lockdown
lists) and the adversarial corpus `browser/scripts.mjs` (`pnpm --filter @pptaken/player test:scripts`), see
ADR-020.
