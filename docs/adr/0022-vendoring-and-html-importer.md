# ADR-022 · Ingest-time vendoring and the HTML-artifact importer

**Status:** accepted (2026-11-18). Completes the "next phase" extension points of [ADR-020 §2](0020-interactive-mode.md)
and supersedes the closed font catalog of [ADR-001 §5](0001-content-format.md) as a limit on what decks may use.
Related: [ADR-021](0021-presenter-password-and-approval-screen.md), [deck format](../spec/deck-format.md),
[sanitizer](../spec/sanitizer.md), [player](../spec/player.md), [HTTP API](../spec/http-api.md),
[security](../foundation/04-security-and-auth.md) (T8, T8b, T8c), guides
[interactive decks](../guides/interactive-decks.md) and [bring your Claude artifact](../guides/bring-your-artifact.md).

## Context

Founder principle (non-negotiable): **PPTaken must not limit what a user's Claude can author.** Claude artifacts are
plain HTML/CSS/JS that load libraries from CDNs (cdnjs, jsDelivr, unpkg, esm.sh), fonts from Google Fonts and
images by URL. Until now the sanitizer removed every external URL, fonts were limited to 9 bundled families and
libraries to one bundled id, so such decks lost their typography, images and code.

At the same time the content model of ADR-001 must not weaken: deck documents have no network
(`connect-src 'none'`, `img-src`/`font-src` only the instance's asset path), viewers must never contact third
parties (privacy, offline, strict CSP), and code only runs after the owner approved the exact bytes (ADR-020).

## Decision

### 1. Vendor once, at write time

When a deck is written (`create_presentation`, `update_presentation`, `update_slides`, `import_html_deck`), the
server finds every external resource the content references, **fetches it once**, checks it, stores it as a
content-addressed asset of the deck and **rewrites the deck** to `asset:<sha256>`. The stored revision never
contains a third-party URL that is used at view time; the original URL is kept as provenance (`vendored`,
`libs[].source/finalUrl`, `theme.fontFaces[].source`).

| Kind | Found in | Stored as | Rewritten to |
|---|---|---|---|
| stylesheet | `<link rel=stylesheet>`, `@import` (nested, depth ≤ 3, loops cut), `theme.googleFonts` | asset `text/css` (provenance/cache; never served) | its rules are inlined (sanitized as usual); `@font-face` extracted |
| font | `@font-face src` (authored or in a fetched sheet; woff2 > woff > ttf > otf) | asset `font/woff2|woff|ttf|otf` | `theme.fontFaces[]` entry; the player emits `@font-face` on the asset URL |
| image | `<img src/srcset>`, `<picture><source>`, SVG `<image href>`, CSS `url()` (stylesheets and `style`) | asset `image/png|jpeg|gif|webp|avif` | `asset:<sha256>` |
| script | `libs` entries that are https URLs, `<script src>` in slide HTML or an imported document | asset `text/javascript` (inlined, never served) | `libs[]` `{ name, version, sha256, source, finalUrl, bytes }` |

Unsupported, removed with a specific warning telling the agent why and what to do instead: video, audio, iframes,
embeds, objects (no network at view time), ES modules (`type=module`, files with top-level `import`/`export`:
use the UMD/IIFE build), SVG image URLs (inline the SVG instead: an SVG file can carry markup), relative URLs
without a base, and runtime network (fetch/XHR/WebSocket stay blocked by the lockdown and the CSP).

**Best effort:** a resource that cannot be vendored is dropped with `VENDOR_FAILED` (with the error class) and
the write succeeds; the panel shows failed resources. **Fail fast:** the deck is schema-validated (with
placeholders for URL `libs` and `googleFonts`) **before** any network access.

### 2. The fetcher (`apps/server/src/vendor-fetch.ts`, port `VendorFetcher` in the core)

- `https` only, port 443, no credentials in the URL; every resolved address must be public unicast (private,
  loopback, link-local, CGNAT, metadata, documentation, multicast, reserved; IPv4-mapped, NAT64 and 6to4 forms
  judged by the embedded IPv4); a mixed DNS answer is refused; the connection is **pinned** to the checked address
  (no second resolution): reuses `resolveSafeTarget`/`isBlockedAddress` of `safe-fetch.ts`.
- At most **3 redirects**, each re-checked from scratch (scheme, port, credentials, allow/deny lists, DNS, pin).
- `Accept-Encoding: identity`; any `Content-Encoding` is refused, so nothing is ever decompressed (no
  decompression bomb). Bodies are capped while they stream: script 2 MB, stylesheet 512 KB, font 2 MB, image 8 MB.
- Content checked by **magic bytes and structure**, never by `Content-Type`: images by the core's container walk
  (no trailing data, pixel cap); fonts by the WOFF/WOFF2 length field or the sfnt table directory (no data after the
  last table, collections refused); scripts and stylesheets must be strict UTF-8 without NUL and not an HTML page.
- 10 s per request (per hop, covering the body: a slow-loris body is cut), a 60 s deadline per write, 8 fetches in
  flight per instance and 4 per write, 300 fetches per actor per 10 minutes, at most 100 distinct URLs and 40 MB per
  write (font subsets beyond the budget are trimmed, basic Latin first).
- Cache: in memory by kind + URL for an hour (64 MB); persistently, a URL already vendored for the deck (its
  provenance and the stored blob) is reused without network on later writes.
- Errors: `blocked-address`, `not-allowed-host`, `too-large`, `timeout`, `bad-type`, `http-error`,
  `rate-limited`, `disabled`, `fetch-failed`.
- Operator: `PPTAKEN_VENDOR_FETCH=on|off` (default on; off refuses writes with external resources with
  `FETCH_BLOCKED`), `PPTAKEN_VENDOR_ALLOW_HOSTS` (empty: any public host), `PPTAKEN_VENDOR_DENY_HOSTS`.
- Every fetch is **audited** (`vendor.fetch`, deck, actor, kind, origin+path of the URL and of the final URL,
  redirects, bytes, sha256, error class; `denied` for SSRF/policy refusals). Queries are not logged.
- A browser-like `User-Agent` ending in `PPTaken-vendor/1` (Google Fonts serves WOFF2 by User-Agent).

### 3. Scripts stay behind the approval pipeline

Vendored scripts are `libs` entries: their SHA-256 and source URL are in the **scripts digest**, so the owner must
(re)approve; a different file at the same URL (re-vendored) changes the digest. The approval screen lists source,
final URL, redirect chain, size and hash. Scripts are **inlined** in the scripted document (no script is ever
served by the asset route): CDN code that contains `</script`, `<script` or `<!--` inside strings is escaped
(`<\/script`, `<script`, `<\!--`), which keeps its meaning in strings, template and regular-expression
literals and identifiers; the CSP hash is computed over the embedded text; the builder verifies the stored bytes
against the referenced hash first. Files with NUL or lone surrogates are refused. UMD/IIFE builds work as
classic scripts in the same realm, after the runtime's lockdown and before the deck and slide scripts.
**ES modules are not supported in this phase** (no import maps, no `'strict-dynamic'`): a module file is refused
with a clear message pointing to the UMD build.

**Deck-level script** (new, compatible addition): `deck.script`, one classic script run once in the global scope
after `libs` and before the slide scripts; at most 512 KB, counted in the 1 MB total; same embedding rules. It is in
the digest as an extra `deck` member **only when present**, so the digests (and approvals) of existing decks are
unchanged.

### 4. Fonts

`theme.fontFaces: [{ family, src: "asset:<sha256>", format, weight?, style?, unicodeRange?, source? }]` (≤ 96)
replaces the closed catalog as the limit: families declared there are accepted by the sanitizer exactly like the
bundled ones (the catalog keeps working, `theme.fonts` keeps its meaning). The builder emits `@font-face` on the
instance's asset URL (`font-src` already allows it; the asset route sends `Access-Control-Allow-Origin: *`).
Offline copies and the single-file HTML export inline them as `data:` URIs. Convenience input
`theme.googleFonts: [{ family, weights?, italic? }]` (≤ 8, not stored): the server builds the css2 URL and vendors
it. **Decision:** a bare `font-family: 'X'` that is neither bundled nor vendored is **not** auto-resolved through
Google Fonts (that would turn any family name into an outbound request); it is removed with a warning that says
how to vendor it.

### 5. HTML-artifact importer (`import_html_deck`, `Core.importHtml`)

A new MCP tool (not an option of `create_presentation`: different input, different result, clearer for agents)
takes `{ html, title?, lang?, aspect_ratio?, split?, idempotency_key? }`. The pure part
(`@pptaken/sanitizer` `importHtmlArtifact`, parse5 + css-tree) builds the deck parts; the core then creates it
exactly like `create_presentation` (validation, vendoring, sanitizing, audit `presentation.import_html`).

- **Splitting heuristics, in order** (result `heuristic`): elements with `data-slide`; elements with class
  `slide`; the largest group (≥ 2) of sibling `<section>`; `<h1>`/`<h2>` boundaries among the children of the
  content root (body or its only wrapper); else one slide. `split` forces `slides`, `headings` or `single`.
- **CSS**: every `<style>` (and `<link>` as `@import`) becomes theme CSS; `html`, `body` and `:root` selectors
  become `section[data-slide]` (each slide is the artifact's page); viewport units become canvas pixels
  (`100vw` = 1920 px); rules that hide inactive slides (`.slide{display:none}`, `opacity:0`, translate) lose those
  declarations and the artifact's "current" classes (`.slide.active`) are added to every slide; over 64 KB, whole
  rules are dropped from the end (warning).
- **Scripts**: `<script src>` → `libs`; inline classic scripts (and module scripts without imports) → the deck
  script, in document order; `on*` attributes → `addEventListener` calls appended to it (an id is assigned when
  needed); data blocks (`<script type=application/json id=…>`) → hidden elements with the same id and text.
- **Navigation policy** (artifacts often have their own `showSlide()` and arrow-key handlers): their code is kept
  (it is the owner's to approve) but the PPTaken player drives navigation: the hiding CSS is neutralized, so those
  handlers cannot hide the current slide; elements outside the slides (nav bars, counters) are kept in a hidden
  container in the first slide when the document has scripts (so `getElementById` does not throw) and dropped
  otherwise; warning `IMPORT_NAVIGATION_HANDLERS`.
- **Out of scope**: JSX/React or TypeScript that needs a runtime transpiler (`text/babel`, Babel standalone) →
  clear `VALIDATION_ERROR` with reason `JSX_UNSUPPORTED`. React UMD with plain `createElement` works as a library.
- Result: deck id, urls, `heuristic`, the vendoring report, warnings, and `interactive.approve_url` when scripts
  are present.

### Honest fidelity limits

Each slide is a fixed 1920×1080 canvas, not a scrolling page: long single-page artifacts are clipped; layouts sized
for another fixed size (960×540 containers) render at that size; slides are separate `<section>`s, so code that
expects one page of slides only works where it addresses elements by id/class; hidden slides have zero size until
shown (charts with responsive resizing recover); forms degrade (only range/number/checkbox inputs, buttons,
selects in the interactive profile); `<a>` links are unwrapped; anything that needs live network at view time
cannot work; the static fallback (phones, exports, presenter preview, unapproved decks) shows no canvas content.

## Threat model additions (security doc T8, T8b, T8c)

- **SSRF per hop and DNS rebinding**: full checks on every redirect hop, pinned connections, mixed answers refused,
  IP literals in every notation normalized by the WHATWG URL parser before the check.
- **Blind SSRF / egress abuse by a prompt-injected agent**: an agent can make the server send GETs to public hosts
  of its choice (port 443 only), not read internal responses. Bounded by the rate per actor, URL/byte budgets per
  write, timeouts, the audit trail, the deny/allow lists and the off switch. Accepted: the instance's IP is visible
  to the hosts the agent names (as for CIMD).
- **Supply chain**: CDN content is pinned at ingest by SHA-256; the approval digest binds the fetched bytes and
  their source; a CDN that changes a file later does not affect stored decks; re-vendoring different bytes needs a
  new approval. A malicious library still only runs inside the lockdown/CSP/Trusted Types sandbox of ADR-020.
- **Amplification**: no decompression, streaming caps, per-write budgets, concurrency limits, cache.
- **Content smuggling**: SVG and HTML pages refused as images/scripts; fonts and images checked structurally; CSS
  goes through the sanitizer like authored CSS; scripts never served from the asset route.
- **Licences**: fonts and scripts keep their licences; the deck's author (and the instance owner) is responsible
  for redistributing them on the instance; provenance records where each came from.
- **Privacy benefit**: viewers, phones and offline copies never contact Google Fonts or CDNs.

## Consequences

- (+) Claude artifacts and agent-written decks work as authored (fonts, images, CDN libraries), with the same
  view-time isolation as before and an auditable provenance.
- (+) Bundled catalog decks are unchanged; scripts digests of existing decks are unchanged.
- (−) The server now makes outbound requests on behalf of agents (off switch, lists, audit).
- (−) More parsing code before the sanitizer (still followed by it).

## Verification (2026-11-18)

Unit tests: fetcher over a fake network (`apps/server/test/vendor-fetch.test.ts`: redirect chains, blocked
addresses directly and at every hop incl. decimal/hex IPv4, IPv4-mapped, NAT64, 6to4, link-local, metadata,
localhost, http, other ports, credentials; DNS rebinding; oversize; magic bytes; compressed bodies; timeouts and
slow-loris; deadline; concurrency; cache; allow/deny; switch; rate limit), core orchestration
(`packages/core/test/vendoring.test.ts`), pure rewriting and importer fixtures
(`packages/sanitizer/test/vendoring.test.ts`), server integration (`apps/server/test/vendoring.test.ts`), builder
escaping and deck script (`packages/player/test/scripts.test.ts`). Browser: `apps/server/browser/vendor-e2e.mjs`
in Chromium, Firefox and WebKit (owner after approval: vendored font loaded, library + deck script + widget work,
the library's runtime `fetch` is neutralized; guest: static, font and image still load; zero third-party requests,
asserted by interception). A manual smoke (`apps/server/scripts/vendor-smoke.mjs`) fetched a real Google Fonts css2
stylesheet, one of its WOFF2 files and a jsDelivr script once (its SHA-256 equals the bundled uPlot pin).
