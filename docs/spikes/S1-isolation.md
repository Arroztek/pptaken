# Spike S1 — Content isolation (sandboxed iframe + CSP)

**Date:** 2026-11-13 · **Status:** partially done (Chromium, header-driven isolation only)

## What was tested
A throwaway harness ([`s1-harness/server.mjs`](s1-harness/server.mjs), run with `node server.mjs`, open
`http://localhost:5391/parent`) serves a parent page and a "deck" document at `/c/deck` with this header:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; img-src 'self'; font-src 'self';
  style-src 'unsafe-inline'; script-src 'nonce-…'; connect-src 'none'; form-action 'none';
  base-uri 'none'; frame-src 'none'
```

The deck runs a script that tries to break out and reports the results to the parent with `postMessage`.
Tested in the built-in browser pane of the Claude desktop app (Chromium-based).

## Results that hold
| Attempt from inside the content | Result |
|---|---|
| `postMessage` origin seen by the parent | `"null"` (opaque origin) |
| `document.cookie` | `SecurityError` |
| `localStorage` | `SecurityError` |
| `parent.document` | `SecurityError` |
| `fetch("/api/secret")` | blocked (`TypeError`, `connect-src 'none'`) |
| `eval(...)` | blocked (`EvalError`) |
| `top.location = "http://example.com"` | `SecurityError` (blocked) |
| `window.open(...)` | returns `null` (blocked) |
| External image | blocked |
| Parent reading the iframe's DOM | blocked |

**Control experiment:** the same document served *without* `sandbox` navigated the top page to
`example.com`. That shows the sandbox is what stops top navigation, so barrier 2 of ADR-001 is doing real work.
A CSP `sandbox` response header alone is enough to get the opaque origin, even without the iframe attribute.

## What could NOT be verified (the pane is the limit, not the design)
- **Assets under an opaque origin.** With `sandbox` active, requests for the slide's own image and fonts never
  reached the server (not even with explicit origins in `img-src`/`font-src`), while the same document without
  `sandbox` did request them. The built-in pane may drop requests coming from an opaque (`null`) origin; this
  must be re-checked in a real browser. If it is real Chromium behavior it is a **design-level risk**: the
  fallback is to inline assets as `data:` URLs or to serve them with CORS headers.
- **Fonts under an opaque origin** need CORS (`Access-Control-Allow-Origin`) in any case: they are cross-origin
  requests. The harness has one font route with the header and one without to compare.
- **The `<iframe sandbox="allow-scripts">` attribute together with the header.** In the pane, such an iframe
  never requested its `src` from the server, but the pane's sandboxed `srcdoc` iframes worked. Again a
  pane limitation until proven otherwise.
- Keyboard focus across the iframe boundary, forwarding keys, printing/PDF, offline preload, and
  **Firefox and Safari (including iOS)**.

## Next step
Repeat the harness with **Playwright against Chromium, Firefox and WebKit** (it is already planned for the repo),
and on a real iPhone. If asset loading under the opaque origin fails in a real browser, escalate it as an
architecture question (it affects ADR-001 and the asset pipeline).
