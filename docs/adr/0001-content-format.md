# ADR-001 · Content format: JSON envelope + isolated HTML canvas

**Status:** accepted. It is the most important decision of the project.

**Context.** The content is written by an agent and, in the cloud, will be uploaded by third parties. We need at once: (a) an LLM that can express itself freely and get it right, (b) content that cannot attack the presenter or the audience, (c) a stable, versionable schema, (d) revealable steps, notes and metadata that the player understands, (e) that it works offline, (f) a path to interactive demos.

**Options considered.**

| Option | In favor | Against |
|---|---|---|
| A. Free HTML sanitized with an allowlist (as in the `ppt` project) | Maximum expressiveness; LLMs master HTML/CSS | A sanitizer is a single barrier and sanitizers fail; no structure for notes/steps; a slide's global CSS breaks the interface |
| B. Pure structured format (block JSON or Markdown + components) | Secure by construction; easy to validate and edit | Forces us to invent and maintain a mini-PowerPoint of components; the result looks generic; every new need is a schema change. Contradicts "we are not a design tool" |
| **C. Hybrid: JSON envelope + per-slide HTML/CSS inside an isolated iframe** | Structure (title, notes, steps, theme) is validatable JSON; design is free HTML/CSS/SVG; security does not depend only on the sanitizer | Two layers to maintain; the iframe complicates keyboard focus and measurement |

**Decision.** Option C, with the format name **`pptaken.deck`**, schema version `1`.

1. **Envelope (JSON).** A presentation is a JSON document: `schemaVersion`, `title`, `lang`, `aspectRatio`, `theme` (shared CSS and variables), and `slides[]`. Each slide: stable `id`, `title`, `html`, optional `css`, `notes` (Markdown), optional `section`, optional `durationHintSec`.
2. **Canvas.** Each slide is drawn on a fixed logical canvas of **1920×1080** (or 1440×1080 in 4:3) that the player scales with *letterbox*. This way the agent works with predictable absolute pixels, just as `ppt` did.
3. **Revealable steps.** `data-step="n"` attribute on any element (no number = order of appearance). The player counts them; the agent declares nothing else.
4. **Assets.** Images are referenced as `asset:<id>`; the server rewrites them to internal hashed paths. **External URLs are not allowed** (no images, fonts or CSS): this guarantees offline and avoids trackers that leak the audience's IP.
5. **Fonts.** A closed catalog of libre families included in the image (see visual identity §7). The agent uses them by name.
6. **Trust model: three independent barriers.**
   - *Barrier 1 — sanitizing on ingest* (server): allowlist of tags, attributes and CSS properties; `<script>`, `on*`, `javascript:`, `<iframe>`, `<object>`, `<form>`, `@import` and external `url()` are removed. The response to the agent includes `warnings` with what was removed.
   - *Barrier 2 — isolation on display*: the deck document is served from a content route with a `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; …` header and mounted in an `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`. The browser gives it an **opaque origin**: even if something malicious slipped through, it cannot read cookies or storage or call the PPTaken API.
   - *Barrier 3 — no-network CSP*: `connect-src 'none'`, `img-src` and `font-src` only to the content route, `form-action 'none'`, `base-uri 'none'`. The content cannot exfiltrate anything.
7. **Modes.**
   - `safe` (default and only one in v1.0): HTML + CSS + SVG, CSS animations, no author JavaScript. The only script inside the iframe is the PPTaken *runtime* (steps, scaling, messaging), authorized by *nonce*.
   - `interactive` (v1.x, off by default): allows author `<script>` **inside the same isolated, network-free iframe**. It is enabled by the owner per instance (`PPTAKEN_ALLOW_SCRIPTS=true`) and per presentation ("I trust this content" checkbox). In the cloud it will also be served from a separate domain (`*.pptaken-usercontent.com`).
8. **Notes outside the canvas.** Speaker notes never enter the iframe or the public link: they live in the trusted interface.
9. **Versioning.** Integer `schemaVersion`. Compatible changes (new optional fields) do not increment it; incompatible ones do and require a `vN → vN+1` migrator in `@pptaken/schema`. The server accepts the current and the previous version. The JSON Schema is published with each release.

**Consequences.**
- (+) The agent writes what it writes best; we do not maintain design components.
- (+) A sanitizer failure stops being a critical vulnerability: it stays contained by the isolation.
- (+) Interactive demos are a future switch, not a redesign.
- (−) Player↔iframe communication through `postMessage` (keys, steps, size): that mini-protocol must be specified and tested.
- (−) No external resources: the agent cannot "paste an image link"; it must upload it (`add_asset`) or draw with SVG. It is intentional.
- (−) No JS in v1.0: data-driven animated charts are limited to CSS/SVG. Acceptable for an MVP.

**What we learned from `ppt` that supports this.** There, slides are code with *hooks* (`init/enter/leave/onStep`) and a sanitizer only protects the phone. It works because the author is the owner. In PPTaken the author is an agent: content becomes data and trust is inverted.

## Verification (phase-0 spike S1, 2026-11-13)

Barriers 2 and 3 were verified with Playwright in Chromium, Firefox and WebKit, using both the iframe
`sandbox="allow-scripts"` attribute and the `Content-Security-Policy: sandbox` header. Findings: assets under the
opaque origin load with `img-src 'self'`; fonts need `Access-Control-Allow-Origin` on the content routes; API routes
must never send permissive CORS; the CSP (not the attribute) is what blocks `eval`. Details in
[`docs/spikes/S1-isolation.md`](../spikes/S1-isolation.md).

## Verification (sanitizer browser test, 2026-11-14)

The sanitizer (`packages/sanitizer`) passed 265 sanitized documents in Chromium, Firefox and WebKit with no script
canary and no network request. Running the **raw, unsanitized** corpus in the sandbox also exposed three gaps in
barriers 2-3 that the sanitizer cannot close. They change the serving design:

1. **Limit `img-src` and `font-src` to the content asset path** (for example `<origin>/c/asset/`), not `'self'`.
   `'self'` covers the whole origin, so a raw `<img src="/api/...">` sent a GET to the API, and WebKit attached the
   `SameSite=Lax` session cookie to it.
2. **Serve content from a separate, cookie-less origin**, also for self-hosted instances. A raw
   `<meta http-equiv="refresh">` can navigate the content iframe to any URL and no CSP rule stops it; in WebKit a
   navigation to `/api` carried the session cookie. API GET requests must also stay free of side effects.
3. **Resource exhaustion can crash the renderer** (raw depth bombs crashed Chromium's renderer and the player
   tab). The sanitizer fails closed on such input; keep it mandatory on ingest.

Open question: slide `id`s must be unique deck-wide (they are) and the sanitizer's `<use>` check is per slide, so
colliding element ids across slides could rebuild `<use>` chains. Decide between deck-wide unique element ids or a
per-slide id prefix. Details: [`packages/sanitizer/README.md`](../../packages/sanitizer/README.md).

## Verification (offline presenting, spike S4, 2026-11-15)

No engine (Chromium, WebKit; Firefox not measured) routes the opaque-origin sandboxed content frame or its
subresources through the app origin's service worker, same origin or not. Offline (layer 2) therefore delivers a
server-built **offline deck document** through `<iframe sandbox="allow-scripts" srcdoc>`: images and fonts inlined
as `data:` URIs, notes removed, and the no-network CSP as the first `<meta>` (`connect-src 'none'`, `img-src
data:`, `font-src data:`, a nonce). Barrier 2 is unchanged (same sandbox attribute, opaque origin). Barrier 3 holds
with two policies: the document's `<meta>` and the player page's CSP, which a srcdoc frame inherits; the page CSP
gains only the runtime's exact hash and `data:` fonts. Verified in all three engines: opaque origin, no
cookie/storage/parent access, `fetch`/XHR blocked, zero requests, a nonced non-runtime script blocked by the
inherited policy, content navigation detected as a fault. `sandbox` and `frame-ancestors` cannot come from a
`<meta>`; the attribute provides the sandbox and a srcdoc document cannot be framed elsewhere. Details:
[`docs/spikes/S4-offline.md`](../spikes/S4-offline.md).
