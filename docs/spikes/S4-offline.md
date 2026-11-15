# Spike S4 — Offline presenting: service worker vs. the sandboxed content frame

**Date:** 2026-11-15 · **Status:** done for desktop engines under Playwright 1.65 (Chromium, Firefox, WebKit on
Windows); real browsers, iOS and Android untested.

## Question
The deck document lives in an opaque-origin sandboxed iframe (`sandbox="allow-scripts"`, CSP `sandbox
allow-scripts`, short-lived signed URL), optionally on a separate content origin. Can a service worker of the app
origin intercept (a) the iframe's navigation and (b) its subresources (images, fonts), so that an offline reload
can serve them from a cache? And if not, does a `srcdoc` delivery work under the app page's CSP?

## Harness
[`s4-harness/`](s4-harness/) (`node docs/spikes/s4-harness/run.mjs`, raw output in `s4-harness/last-run.json`):
app origin `http://localhost:<A>` with a page, a page script and a logging service worker (scope `/`,
`skipWaiting` + `clients.claim` for the experiment); the same production-like content document (CSP header with
`sandbox allow-scripts`, nonce, `img-src`/`font-src` limited to `/c/`, `connect-src 'none'`) served same-origin
(`localhost:<A>/c/doc`) and cross-origin (`127.0.0.1:<B>/c/doc`); a `/c/sw-only` URL that only the worker could
answer; and two `srcdoc` documents (data: image and font, CSP `<meta>`, inline script), under a page whose CSP has
`script-src 'self' 'sha256-<that script>'` and `font-src 'self' data:`, and under a stricter page without `data:`.

## Results

| | Chromium | Firefox | WebKit |
|---|---|---|---|
| App page controlled by the worker | yes | **no in this harness** (scope `/`, even after `activated` and two navigations); **yes** in the real-server test (scope `/p/`) | yes |
| (a) sandboxed iframe navigation, same origin | **not intercepted** | **not measured** (page not controlled here) | **not intercepted** |
| (a) sandboxed iframe navigation, separate content origin | not intercepted (other origin) | not measured | not intercepted |
| (b) image and font requests of the sandboxed document | **not intercepted** | **not measured** | **not intercepted** |
| `/c/sw-only` in the sandboxed frame | 404 from the network | 404 (uncontrolled) | 404 |
| `srcdoc` document: runtime-like inline script allowed by the page's hash | runs | runs | runs |
| `srcdoc` document: a script not matching the hash (right nonce) | blocked | blocked | blocked |
| `srcdoc`: the page's CSP is inherited (data: font blocked under the strict page) | yes | yes | yes |
| `srcdoc`: `fetch()` blocked by the document's `<meta>` (`connect-src 'none'`) | yes | yes | yes |
| `srcdoc`: origin seen by the parent | `"null"` | `"null"` | `"null"` |
| `srcdoc`: inherited `frame-ancestors 'none'` blocks it | no | no | no |

The opaque-origin frame has no storage key a registration could match, so no engine routes it (or its
subresources) through the app's worker. A cross-origin content origin could only be covered by a worker
registered on the content origin, which needs an unsandboxed document there: rejected (it weakens ADR-001).

### Playwright network emulation and service workers (measured with the real server, `apps/server` browser test)

| Cut | Chromium | Firefox | WebKit |
|---|---|---|---|
| `context.setOffline(true)` | worker answers navigations | navigations fail **before** the worker | worker answers |
| `context.route("**/*", abort)` | worker answers | worker answers | navigations aborted **before** the worker |
| server stopped | worker answers | worker answers (slow refusals on Windows) | worker answers |

Also measured: under Playwright, `navigator.userActivation.isActive` is always `true` in all three engines, so
the shell's gate on mode keys coming from the content cannot be exercised in automation (the existing
network-path check passes for timing reasons). WebKit returns `""` for `document.cookie` inside a sandboxed
`srcdoc` document instead of throwing (no cookie is visible either way).

## Design decided from the results
1. **Layer 1, every browser:** the runtime preloads every image and font face in the content document itself
   and reports `preload`; the shell shows the state. No worker involved.
2. **Layer 2, secure contexts:** the worker (scope `/p/`) never touches the content frame or `/c/*`. It stores,
   per deck, the player and presenter pages, the presenter data and an **offline deck document** built by the
   server (`GET /api/v1/decks/:id/offline`: the same builder, images and fonts inlined as `data:` URIs, the
   no-network CSP as the first `<meta>`, notes removed), the approach of `@pptaken/export`.
3. **Offline, the shell mounts that document with `srcdoc`** in the same sandboxed iframe. The player and
   presenter pages' CSP adds only the runtime's exact hash and `data:` fonts (needed because the srcdoc frame
   inherits the page CSP); both CSPs apply to the content.
4. Online nothing changes: the page asks for the signed content URL first and only falls back to the offline
   document when that request fails.
5. The test cuts the network three ways for the mid-talk checks; for offline reloads it keeps the server down and
   lifts the emulation that sits in front of the worker in that engine (Firefox: `setOffline`; WebKit: `route`).

## Still open
- Firefox interception of the sandboxed frame was not measured (the design does not depend on it: the content
  frame is never served by the worker in any engine).
- Real Firefox and Safari (desktop and iOS) with a real network loss, and Firefox's automatic offline mode.
- Storage eviction by the browser itself (we only handle our own quota share).
