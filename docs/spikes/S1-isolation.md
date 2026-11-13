# Spike S1 — Content isolation (sandboxed iframe + CSP)

**Date:** 2026-11-13 · **Status:** done for desktop engines (Chromium, Firefox, WebKit); real iPhone and printing still untested

## What was tested
A throwaway harness ([`s1-harness/`](s1-harness/)) serves a parent page and a "deck" document at `/c/deck` with
this header:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; img-src 'self'; font-src 'self';
  style-src 'unsafe-inline'; script-src 'nonce-…'; connect-src 'none'; form-action 'none';
  base-uri 'none'; frame-src 'none'
```

The deck runs a script that tries to break out and reports to the parent with `postMessage`. It was run with
**Playwright against Chromium, Firefox and WebKit** (`node docs/spikes/s1-harness/run.mjs`; raw output in
`s1-harness/last-run.json`) in four configurations: A) iframe `sandbox="allow-scripts"` attribute **plus** the
header (the planned production setup), B) header only, C) attribute only (no CSP), D) A with an explicit origin
in `img-src`/`font-src` instead of `'self'`.

An earlier run in the Claude desktop app's built-in browser pane was inconclusive: that pane never forwarded
requests from opaque-origin contexts, which looked like a design problem and was not. Playwright settled it.

## Results (identical in Chromium, Firefox and WebKit unless noted)
| Attempt from inside the content | Result |
|---|---|
| `postMessage` origin seen by the parent | `"null"` (opaque origin) |
| `document.cookie`, `localStorage`, `parent.document` | `SecurityError` |
| `fetch("/api/secret")` | blocked (`TypeError`) |
| `eval(...)` with the CSP | blocked (`EvalError`); **allowed** in config C (no CSP) |
| `top.location = …` | `SecurityError` |
| `window.open(...)` | blocked (`null`; Firefox throws `InvalidAccessError`) |
| Slide's own image under the opaque origin (`img-src 'self'`) | **loads** in all three engines (also with the explicit origin) |
| Slide's font **with** `Access-Control-Allow-Origin` | loads |
| Slide's font **without** CORS header | **fails** in Chromium and Firefox; loads in WebKit (more lenient) |
| Key pressed while the iframe has focus | forwarded to the parent via `postMessage` in all three |
| Parent reading the iframe DOM | blocked |

Control experiment (built-in pane): the same document served *without* `sandbox` redirected the top page.

## Conclusions that change the design
1. **ADR-001 barriers 2 and 3 hold** in all three desktop engines, in the attribute+header combination.
2. **Assets work under the opaque origin.** `img-src 'self'` is enough. No need to inline assets as `data:` URLs.
3. **Fonts and any other CORS-fetched resource need `Access-Control-Allow-Origin` on `/c/…` asset routes** (the
   opaque origin makes them cross-origin). Set it only on the content/asset routes.
4. **Never send permissive CORS (`Access-Control-Allow-Origin: *`) on API routes.** The opaque origin cannot read
   the API today (`fetch` fails), and a wildcard there would change that.
5. **The CSP is what stops `eval`.** The iframe attribute alone does not; keep both layers.
6. **Keyboard forwarding works** (iframe → `postMessage` → shell), so clicker keys keep working when the
   content holds focus.

## Still open
- Real iPhone Safari (WebKit on Windows is not the same as iOS Safari), printing/PDF of the iframe content and
  the offline preload. Track them in phase F1.
- Playwright is now a root dev dependency; the planned E2E suite can reuse this harness.
