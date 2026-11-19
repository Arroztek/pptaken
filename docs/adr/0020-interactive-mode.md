# ADR-020 · Interactive mode (author scripts)

**Status:** accepted, foundation phase (2026-11-17); completed by [ADR-021](0021-presenter-password-and-approval-screen.md) (approval screen, presenter password). Implements the `interactive` mode planned in
[ADR-001 §7](0001-content-format.md) under the conditions measured by spike
[S5](../spikes/S5-script-mode.md). Related: [S1](../spikes/S1-isolation.md), [S4](../spikes/S4-offline.md),
[deck format](../spec/deck-format.md), [sanitizer](../spec/sanitizer.md), [player](../spec/player.md),
[HTTP API](../spec/http-api.md), [security](../foundation/04-security-and-auth.md).

## Context

Agents can already write slides as sanitized HTML/CSS/SVG. The founder wants agents to build *interactive* decks
(for example a quantum-computing talk with live circuit simulations) and publish them to the owner's own
instance. That means running JavaScript the agent wrote, and the agent may be steered by prompt injection: the
script is **untrusted code**, written for the owner but not by the owner.

S5 measured what a hostile author script can do inside the existing sandboxed, opaque-origin, no-network content
frame (Chromium, Firefox, WebKit under Playwright on Windows). The barriers of ADR-001 hold for HTTP channels,
storage, cookies, popups and top navigation, but five holes open as soon as author code runs:

1. **Nonce theft**: an author script reads `document.currentScript.nonce` and loads cross-origin `<script src>` or
   `import()`: a two-way channel to the attacker (all engines).
2. **WebRTC** (STUN/TURN): UDP/TCP egress and the viewer's public IP; no CSP, Permissions-Policy or sandbox
   control blocks it in Chromium; Firefox and real Safari unmeasured.
3. **Navigation** of the frame to the content origin or the app origin (allowed by the shell's `frame-src`); app
   GETs carry the `SameSite=Lax` session cookie in WebKit.
4. **CPU/DOM denial of service**: freezes the presenter tab in every engine without process isolation (WebKit,
   Firefox same-site, Playwright's headless Chromium). Only full Chromium contains it for every transport.
5. **Protocol forgery**: fake `ready`/`preload`/`state`, ungated navigation and black screen at will, gated keys
   (overview, presenter window, remote approve/kick) during any real gesture.

What is actually at stake when the owner runs an agent-written script in the owner's own session: the agent
already has the deck content, so the new exposures are (a) the owner's network identity and presence (IP via
STUN, timing), (b) keystrokes typed into the frame, (c) control of the trusted shell through the protocol (remote
approval, presenter window, navigation on the projector), (d) denial of service of the presenting tab, and (e)
more JavaScript attack surface for browser bugs. Public viewers would add people who did not opt in.

## Decision

### 1. Scope and trust levels

| Trust level | Who sees it | Scripts | Status |
|---|---|---|---|
| `safe` | everyone (owner, presenter view, phones, exports, offline copies, future public links) | never | the default, unchanged |
| `interactive-owner` | the owner's own player page (`/p/:id`) only, in the owner's signed-in session | the approved scripts | **built in this phase** |
| `interactive-public` | public links, audience devices | — | **explicitly not built** (S5 recommendation b: NO-GO) |

Scripts run only when **all** of these hold, checked on the server for every content URL and again when the
document is served:

1. the operator enabled them for the instance: `PPTAKEN_SCRIPTS=owner` (default `off`);
2. the request carries the owner's **human** panel session (cookie); API tokens, OAuth grants, devices and
   signed links never qualify;
3. the deck's current scripts digest equals the digest the owner approved (§3);
4. the page did not ask for the static version (`?safe=1`).

Everything else gets the **static fallback**: the same slides with the scripts and libraries removed and the
HTML re-sanitized with the `safe` profile. The presenter window's previews, paired phones, `.html`/`.pkn`
exports, the offline copy (service worker, `srcdoc`) and every future public link always get the static fallback.

### 2. Format (compatible addition to deck format v1)

- `slides[].script`: classic-script text, at most 128 KB per slide (UTF-16 code units) and 1 MB per deck. No
  `<script`, `</script`, `<!--`, NUL or lone surrogates (they would let the text escape its element or change
  its hash). Inline only: there is no `src`, no CDN, no network.
- `libs`: deck-level, ordered list (at most 16) of **vendored script assets**: `{ name, version?, sha256, source? }`
  where `sha256` is the hash of a script file **stored on the instance** and `source` the https URL it was vendored
  from (provenance only; viewers never contact it). A bundled id such as `"uplot@1"` is accepted as shorthand and
  expanded by the schema. This phase ships one bundled entry, **uPlot 1.6.32** (MIT, 51 KB minified, npm tarball
  integrity checked, file hash pinned in the schema and re-checked by the player build). The core refuses a
  reference to a hash the instance does not store (today: the bundled set).
- **Founder requirement: PPTaken does not limit what the user's Claude can author.** Claude artifacts are plain
  HTML/CSS/JS that load libraries from CDNs (cdnjs, jsDelivr, unpkg, esm.sh) and fonts from Google Fonts. They must
  be accepted as they are. The agreed architecture is **ingest-time vendoring**: when a deck is written, the server
  (owner-consented, SSRF-guarded fetcher: https only, no redirects into private networks, size/type/time limits)
  fetches each external dependency **once** (script, stylesheet, font file, image, ES module), stores it as a
  content-addressed asset and rewrites the deck to the local copy. Viewers never contact third parties (privacy,
  offline, strict CSP unchanged). Fetched scripts are `libs` entries, so they are part of the approval digest, and
  the approval screen lists their source URLs and hashes. **Built now:** the data model, the hash check, the
  digest and the CSP-hash plumbing (`BuildOptions.vendoredScripts`: stored scripts by hash; the builder verifies
  each file's SHA-256 against the reference before inlining it and hashing it into `script-src`), and the core
  check `checkVendoredScripts` (`packages/core/src/deck.ts`) whose known set is the extension point. **Done in
  [ADR-022](0022-vendoring-and-html-importer.md)** (fetcher, asset kinds, importer, vendored fonts and a deck-level
  script; ES modules remain unsupported). **Former next phase
  (extension points):** (1) the URL fetcher (reuse `apps/server/src/safe-fetch.ts`, the SSRF-safe CIMD fetcher) and
  a `text/javascript`/`text/css` asset kind in the core's asset store; (2) an HTML-artifact importer that rewrites
  `<script src>`, `<link rel=stylesheet>`, `@import`, `url()`, ES `import` specifiers and Google Fonts links into
  vendored assets and moves inline code into `script`; (3) the same vendoring for fonts and images ("vendored
  assets" generically), which **supersedes the closed 9-font catalog** of ADR-001 §5 and the brand fonts list;
  (4) ES modules (needs an import map or rewriting; hash-only CSP still applies, no `'strict-dynamic'`).
- `<script>` inside slide `html` is still removed by the sanitizer, now with a warning that points to `script`.
- No `schemaVersion` bump: the fields are optional. Objects are strict, so an older server rejects a deck that
  uses them (fail closed) instead of dropping the code silently.
- `.pkn` manifests of decks with scripts or libraries carry `requires: ["scripts"]`; a reader refuses unknown
  requirements. In this phase **exports produce the static version** (scripts and libraries omitted; the export
  response says so with `X-PPTaken-Scripts: omitted`), so the requirement only appears on archives written by a
  later phase or another tool. Importing an archive with scripts keeps them and starts in `pending`.

### 3. Consent by digest (human only)

- **Digest** = SHA-256 over a canonical JSON of `{ v: 1, libs: [[sha256 of the vendored script, source URL]...],
  slides: [[slide id, sha256 of script]...] }` (slides in deck order, only slides with a script). `null` when
  the deck has neither scripts nor libraries. Changing any script, the vendored scripts (bytes, order or source), or which
  slide carries a script changes the digest; labels (name, version) do not. Slide HTML/CSS edits do **not** (see
  residual risks).
- **State** is derived, never stored: `none` (digest `null`), `approved` (digest equals the stored approved
  digest) or `pending`. It cannot go stale: an agent edit that changes a script creates a new revision with a new
  digest, so the deck is `pending` and renders static until the owner approves again. Restoring an old revision
  restores its digest (approved only if that exact code was approved).
- **Storage**: table `deck_scripts_approval` (migration `0005_scripts.sql`): `approved_digest`, `approved_at`,
  `approved_by_actor`. One row per deck, replaced on approve, deleted on revoke and on purge.
- **Use cases** (`@pptaken/core`): `getScriptsStatus` (`decks:read`), `approveScripts` (owner actor only; the
  request must name the digest the owner reviewed and it must equal the current one, otherwise
  `REVISION_CONFLICT`-style refusal; refused when the instance switch is off), `revokeScripts` (owner only).
  Agents (API tokens, OAuth) get `FORBIDDEN_ACTOR`, and the refusal is audited (`denied`). Every approve and
  revoke is audited with the digest.
- **API**: `GET/POST /api/v1/decks/:id/scripts`, `/scripts/approve`, `/scripts/revoke` (panel session, CSRF on
  POST). No MCP tool can approve. MCP writes that leave a deck `pending` return
  `interactive: { status: "pending_owner_approval", approve_url }` and a `SCRIPTS_PENDING_APPROVAL` warning
  (`SCRIPTS_DISABLED` when the instance switch is off).
- **Done in [ADR-021](0021-presenter-password-and-approval-screen.md):** the owner-side approval screen in the panel
  (`/decks/:id`) with every script, the library list, the digest, the instance capability and the freeze warning.

### 4. Content origin: optional hardening on self-hosted, mandatory in the cloud

A separate **site** for content (`PPTAKEN_CONTENT_URL`) gives Firefox process isolation (Fission isolates
cross-site frames only) and removes the app-origin navigation channel. On a self-hosted instance (one user, the
owner) it is **optional**; the future cloud edition will **require** it before enabling scripts.

The server reports `contentOrigin: "same-origin" | "same-site" | "separate-site"` and the boolean capability
`separateSiteContent`. "Separate site" is computed conservatively offline, without the Public Suffix List: IP
literals are separate when they differ; host names are compared by their last two labels (`a.example.com` and
`b.example.com` → same site; `slides.example.com` and `content.example.net` → separate). Its limits are on the
safe side: multi-label public suffixes (`a.example.co.uk` vs `b.other.co.uk`) and private suffixes
(`x.github.io` vs `y.github.io`) are reported as *same site* although browsers isolate them; the scheme is ignored.
When scripts are on without a separate-site origin, `whoami`, the guide and the approval screen warn that a
runaway script can freeze the presenter tab in Firefox and Safari, and recommend the content origin.

When content shares the app origin (no `PPTAKEN_CONTENT_URL`), the frame can still navigate itself to app-origin
URLs (the shell's `frame-src 'self'`), and WebKit sends the `SameSite=Lax` cookie with those requests. Therefore
**every GET route of the app origin is side-effect free** and every state change requires POST + CSRF header; a
server test enumerates the registered GET routes against a reviewed allowlist. App pages already send
`frame-ancestors 'none'` and `X-Frame-Options: DENY`, so the frame can never render them.

### 5. Mitigations required by S5 (all implemented and tested)

1. **Hash-only CSP** for the scripted document: `script-src 'sha256-<runtime>' 'sha256-<each library>'
   'sha256-<each wrapped author script>'`, computed on the server at build time; **no nonce anywhere** in the
   document, no `'strict-dynamic'`, no `'unsafe-eval'`, no URLs; plus `script-src-attr 'none'`,
   `worker-src 'none'`, `webrtc 'block'` (ignored by some engines, added anyway) and
   `X-DNS-Prefetch-Control: off`.

   **New finding (2026-11-17, not covered by S5):** a hash source also authorizes an **external** script whose
   `integrity` attribute names that hash. A probe with a hash-only policy reached a cross-origin listener from
   `<script src integrity>` (classic and module) and `createContextualFragment` in Chromium, Firefox and WebKit,
   and from `<link rel=preload as=script integrity>` / `<link rel=modulepreload integrity>` in Chromium and
   Firefox. The hashes are public (the runtime is constant; `SecurityPolicyViolationEvent.originalPolicy` reveals
   the whole policy), so hash-only CSP **alone does not close the exfiltration channel**. Closing it takes two
   more layers, both installed by the runtime before any author script:
   - **Trusted Types**: `require-trusted-types-for 'script'; trusted-types default` and a `default` policy that
     refuses every script URL and script text, `document.write`, and any HTML string containing `<script`,
     `<link`, `<meta`, `<base`, `<iframe`, `<frame`, `<object`, `<embed`, `<portal` or `<fencedframe`. With it,
     the `<script src integrity>` variants were blocked in all three engines; `<link>` preloads were not (an
     `href` is not a Trusted Types sink).
   - **Element-creation lockdown**: `createElement`/`createElementNS` refuse those element names, the HTML
     parsing entry points (`innerHTML`/`outerHTML` setters, `insertAdjacentHTML`, `createContextualFragment`,
     `DOMParser`, `setHTMLUnsafe`, `parseHTMLUnsafe`, `document.write/open`, `execCommand`) apply the same
     check where Trusted Types is missing, and `customElements` and `XSLTProcessor` are removed. Existing
     `<script>` elements are inert when cloned (the "already started" flag is copied).

   Alternative considered: `script-src 'unsafe-inline'` with no hash sources closes the integrity channel
   natively (no hash, no match) but lets any markup that slipped past the sanitizer run unapproved code; rejected
   because consent must bind to the exact code. The probe is part of the adversarial corpus.
2. **Runtime lockdown before any author script** (the runtime is the first script; author scripts are the last
   elements of `<body>`): `RTCPeerConnection` and every other `RTC*`/`webkitRTC*`/`mozRTC*` global,
   `WebTransport`, `WebSocket`, `EventSource`, `XMLHttpRequest`, `fetch`, `Request`, `Worker`,
   `SharedWorker`, `importScripts`, `BroadcastChannel`, `window.open`, `navigator.sendBeacon`,
   `navigator.connection` (and their prototype copies) become non-configurable `undefined` (or throwing)
   properties; `document.write`/`writeln` throw. Fresh realms (`about:blank`/`srcdoc` child frames,
   `document.open`) are re-tested per engine.
3. **Shell `frame-src`** is exactly the content origin (no `'self'`) when a separate content origin exists, and
   `'self'` only when content shares the app origin (residual risk in §4).
4. **Protocol hardening in script mode** (`createPlayer({ scripts: true, expect })`): the runtime opens a private
   `MessageChannel` and transfers its port to the shell in the very first message, posted from `<head>` before
   any author script exists; afterwards the shell ignores every `window` message from the frame. Over the port:
   `ready` is accepted once and must match the slide ids and canvas the server announced (`expect`); `preload` is
   treated as unverified (the indicator shows "scripted: not verified", never "ready"); `state` must be inside the
   deck and match the position the shell asked for; **all gated keys** (`o s p ? r k f`) and `Enter` from the
   frame are dropped *before* the page's `onKey` (remote approval) sees them; navigation keys from the frame are
   rate-limited (10/s); `select` is honoured only while the shell opened the overview. The shell remains the
   source of truth. The runtime captures the intrinsics it uses before author code runs and ignores synthetic
   (`isTrusted === false`) key events.
5. **Watchdog**: the runtime posts `beat` every 1 s; after 3 missed beats (3.5 s, only while the page is visible)
   the shell removes the frame, shows a plain element (never an iframe) with a notice, calls
   `onFault("unresponsive")` and loads the static fallback. `?safe=1` forces the static version.
6. **Author API**: each script is wrapped as `pptaken.register("<slide id>", function (slide) { … })`; the
   runtime calls it at `DOMContentLoaded` with `{ root, onEnter, onLeave, onStep, setSteps(n) }`. Exceptions in
   author code (setup and callbacks, and uncaught errors) are caught per slide and reported as
   `{ type: "error", slide }` (no text crosses the boundary); the presenter window shows a discreet notice.
   **Changed by [ADR-023](0023-script-error-visibility.md):** bounded, cleaned error text now crosses, is reported to
   the owner's panel and returned to the agent as untrusted data; the presenter notice is actionable. Keys
   are forwarded unless focus is in a form control (`Escape`, `b`, `f` always forwarded; the shell still drops
   `f` from the frame in script mode, and `Escape` returns focus to the shell).
7. **Online only**: offline copies and exports are static in this phase.
8. **Resource limits** stay mandatory (sanitizer depth/node limits, script and library size limits). The corpus
   measures busy loop, allocation bomb, rAF storm and a 10^6-node DOM bomb per engine and asserts the shell stays
   responsive where the engine isolates the frame, and the documented freeze + watchdog/warning path where it
   does not.

### 6. Sanitizer profiles, re-sanitized at serve time

Two profiles: `safe` (unchanged) and `interactive` (adds `canvas`, `button`, `input` with `type` range, number or
checkbox only, `select`, `option`, `label`, `output`, `progress`, `meter`, their value attributes, and
`data-*` attributes other than the reserved ones). Still excluded in both: `on*` attributes (also blocked by CSP
`script-src-attr 'none'`), `<a href>`, `<form>`, `<iframe>`, media, `<script>`. **Storage keeps one rendering**:
decks that declare scripts or libraries are sanitized with the `interactive` profile on ingest (a strict
superset of `safe` that still contains no executable markup); every other deck with `safe`. **At serve time** the
static fallback re-sanitizes a scripted deck with the `safe` profile and drops `script`/`libs`. Storing two
renderings was rejected: it doubles storage and lets the two drift; re-sanitizing is deterministic and cheap for
the decks that need it.

## Residual risks (accepted for owner-private, not for public)

- **The integrity-hash channel relies on JavaScript barriers** (Trusted Types where supported, plus the
  creation lockdown). A creation or parsing path the lockdown does not know (a new DOM API) would reopen it.
- **WebRTC egress relies on one JavaScript barrier** (the lockdown). No declarative control exists in Chromium;
  Firefox and real Safari were not measured over a real network. If an engine exposes a constructor the lockdown
  does not know, STUN leaks the owner's IP to the script's author.
- **Busy loops freeze the presenter tab** in WebKit/Safari and in Firefox unless content is on a separate site;
  the watchdog cannot fire while the parent's event loop is blocked. Mitigation: owner approval, the warning, the
  optional separate-site origin, `?safe=1`.
- **Navigation to the content origin** (and, without `PPTAKEN_CONTENT_URL`, to the app origin) remains possible:
  data can reach our own server's request log (path only, no query is logged).
- **Approval binds code, not data**: slide HTML/CSS edits do not reset approval, so a script that reads data
  attributes can be steered by later HTML edits. It cannot gain capabilities beyond the lockdown.
- **The runtime shares the realm** with author code: after author code runs it can tamper with the runtime's DOM
  work (its own deck's rendering). The shell never trusts the frame; captured intrinsics protect only the
  message path.
- **Browser bugs**: more JavaScript in the frame is more attack surface for sandbox escapes.

## Not built here / later

Public links with scripts (after a real-browser WebRTC lockdown check on Chrome, Firefox, Safari desktop and iOS
over a real network, and an external security review); scripts for audience devices and the presenter previews;
offline and exported scripted decks (needs the deck's hashes in the page CSP, S5 §5); ingest-time vendoring of CDN scripts, stylesheets, fonts and images (fetcher, HTML-artifact importer; §2: done in ADR-022);
the owner approval screen (done: ADR-021); a mandatory separate content origin for the cloud edition.

## Consequences

- (+) Interactive decks for the owner, with consent bound to the exact code, and the static fallback everywhere
  else.
- (+) The safe path is unchanged for decks without scripts; scripted decks degrade to a meaningful static slide.
- (−) More code in the trust boundary (lockdown, port protocol, watchdog) that needs per-engine browser tests and
  an external review before any public use.
- (−) Scripts are off by default and need two explicit human steps (operator switch, owner approval per digest).

## Verification (2026-11-17)

Unit tests in schema, sanitizer, core, storage, MCP, player and server, and the adversarial corpus
`packages/player/browser/scripts.mjs` (12 sections, ~120 checks per engine) in Chromium 158 (headless shell and
full build), Firefox 159 (with and without Fission) and WebKit 27.2. Summary and numbers: [S5, implementation
status](../spikes/S5-script-mode.md#implementation-status-2026-11-17-adr-020-foundation-phase). Two results change
what we may claim: hash-only CSP needed the extra integrity-hash barrier (above), and Firefox with Fission did not
isolate the cross-site frame in this run (the spike had measured it did), so only full Chromium is known to survive
a busy loop. WebRTC egress is proven blocked only in Chromium (the harness cannot observe Firefox's, and this WebKit
build has none). Real browsers and mobile were not tested. Scripts therefore stay **off by default**, and public use
stays out of scope until the external review.
