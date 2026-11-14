# Player engine (`@pptaken/player`), phase F1

The player shows a sanitized `pptaken.deck` in the browser: one slide at a time, revealable steps, scaling with a
black letterbox, keyboard navigation and the position in the URL. License: Apache-2.0. Design background:
[ADR-001](../adr/0001-content-format.md) and [architecture §6](../foundation/02-architecture.md).

It has three parts with clear trust boundaries:

| Part | Runs | Trust |
|---|---|---|
| **Builder** (`buildDeckDocument`, `contentHeaders`) | server, pure function | input must come from `sanitizeDeck` (barrier 1) |
| **Runtime** (`RUNTIME_SOURCE`, about 5 KB) | inside the sandboxed iframe, the only script there | runs next to untrusted content |
| **Shell** (`createPlayer`) | the app page | trusted; owns the state |

The shell and the runtime talk only through a small, versioned `postMessage` protocol validated on both ends.
Presenter view, overview, offline preload, service worker, print and HTML export are F3; the design leaves room
for them (reserved `mode` values, a single iframe per deck, state owned by the shell).

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

Keys are matched on `KeyboardEvent.key` (layout aware). Keys with Ctrl, Alt or Meta are ignored, Shift too except
Shift+Space, as are keys typed in inputs, text areas, selects and `contenteditable` elements of the parent page.

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
| shell → iframe | `goto` | `slide` 0..199, `step` 0..255 |
| shell → iframe | `mode` | `mode: "present"` (`"overview"`, `"print"` reserved for F3) |
| iframe → shell | `ready` | `slides: [{ id, steps }]`, 1..200 entries, ids in the schema alphabet and unique |
| iframe → shell | `key` | `code`, one of the closed set of key codes |
| iframe → shell | `state` | `slide`, `step`: what the iframe shows after a `goto` |

The shell accepts messages only when `event.source` is its iframe's window and `event.origin` is `"null"` (the
content always has an opaque origin). The runtime accepts messages only from `window.parent`. Both post with
target `"*"`: the content origin is opaque, and messages carry no secrets. The shell is the single source of
truth for `{ slide, step }`; the runtime only applies `goto` and reports.

**Faults.** A deck document loads exactly once. A second `load` event of the iframe means the content navigated
it (for example a `<meta http-equiv="refresh">` that slipped past the sanitizer): the shell blanks the iframe,
stops and calls `onFault("unexpected-navigation")`.

## API

```ts
// server
buildDeckDocument(deck, { nonce, assetBaseUrl?, lang?, frameAncestors? }): { html, csp }
contentHeaders({ nonce, assetBaseUrl?, frameAncestors? }): Record<string, string>
contentSecurityPolicy({ nonce, assetBaseUrl?, frameAncestors? }): string
assetHeaders(): Record<string, string>

// browser (import "@pptaken/player/shell": no builder, no schema, no zod)
createPlayer(host, { contentUrl, initial?, hash?, keyboard?, showHud?, title?, onReady?, onChange?, onRender?, onFault? })
  -> { goto(slide, step?), next, prev, first, last, black(on?), toggleFullscreen, getState, iframe, ready, destroy }

// shared, pure
navigation: clamp, next, prev, first, last, samePosition, parseHash, formatHash, KEY_ACTIONS
protocol: parseShellMessage, parseContentMessage, PROTOCOL_VERSION, MAX_SLIDES, MAX_STEPS, message types
keys: keyCodeOf, KEY_CODES
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

## Open questions

- **Reveal animations.** Authors cannot select `pptaken-revealed`. Expose a stable, content-visible hook for
  CSS transitions (for example a state attribute the sanitizer allows in selectors only), or keep reveals instant.
- **Fonts.** The deck's catalog fonts need `@font-face` rules pointing at the asset path; the builder does not
  emit them yet (it should take the catalog file URLs from the server).
- **Document-wide names** (`@keyframes`, SVG ids) are shared by all slides in one document (sanitizer README).
- **Many slides in one document**: up to 200 slides of 256 KB each. If memory becomes a problem, F3 can keep only
  neighbouring slides in the DOM.
- **Unexpected navigation** is detected after the fact; the separate cookie-less origin is what makes it harmless.
- **Click to advance** and pointer/touch input are not handled in F1.
