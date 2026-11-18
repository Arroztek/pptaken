# Spike S5 — Author scripts in the content frame ("interactive" mode)

**Date:** 2026-11-16 · **Status:** done for desktop engines under Playwright 1.65 on Windows (Chromium 158, Firefox
159, WebKit 27.2). Real Chrome/Firefox/Safari, iOS and Android were **not** verified.

## Question
ADR-001 plans an opt-in `interactive` mode: author `<script>` runs inside the same sandboxed, opaque-origin, no-network
content frame (`sandbox="allow-scripts"`, the production CSP from `contentSecurityPolicy`, `Permissions-Policy`,
`frame-ancestors`). Before deciding, what can a **hostile** author script still do: send data out, freeze the
presenter's page, or drive the trusted shell? Measured with the content served same-origin, same-site/cross-origin,
cross-site, and through the offline `srcdoc` path, under a shell page whose CSP has the `playerCsp` shape.

## Harness
[`s5-harness/`](s5-harness/) (`node docs/spikes/s5-harness/run.mjs`, raw output in `s5-harness/last-run.json`,
details in its README). It uses the **real** content headers (`contentHeaders`), runtime (`RUNTIME_SOURCE`), offline
`<meta>` CSP and shell (`createPlayer`) from `packages/player/dist`. Origins: app `http://localhost:A`, same-site
`http://localhost:B`, cross-site `http://127.0.0.1:C`, attacker listener `http://[::1]:L` (a fourth site) plus UDP
(STUN) and TCP (TURN, preconnect) counters. "Reached" below always means **the listener logged the request**, not
what the script believed.

The baseline variant (`prod`) gives the author script the document's nonce, which is the obvious way to allow it.
Two other variants: `prod + webrtc 'block'` and `hash-only` (no nonce anywhere; runtime and author scripts allowed by
`sha256` only).

Two measurement facts matter for reading the results:
- **Playwright's default Chromium (headless shell) has no site isolation**: one renderer for the page and every
  frame. The full Chromium build in new headless mode (`channel: "chromium"`, reported as `chromium-full`) isolates
  like desktop Chrome. Playwright's Firefox runs with Fission off; `firefox-fission` turns it on. Process results are
  given for all five.
- **`page.evaluate` grants transient user activation** (`navigator.userActivation.isActive` is true inside any
  evaluate in all three engines). That is why S4 saw "always true". With no evaluate and no input, the shell's gate
  can be measured; the harness records `isActive` at the moment each message reaches the shell page.

## Results

### 1. Self-navigation exfiltration (`nav`; 17 probes, each in its own frame)

Probes: `location =`, `location.replace`, injected `<meta http-equiv=refresh>`, `document.open`+refresh,
`navigation.navigate`, `<a>.click()` (self, `_blank`, `_top`, `download`, `ping`), form GET/POST `submit()`,
`window.open`, `top.location`, and `document.write` during parsing of `<iframe>`, `<link rel=prefetch|preload|
modulepreload|stylesheet|preconnect|dns-prefetch>`, `<img srcset>`, `<picture>`, `<script src>`, `<video poster>`.

| Destination | Shell CSP | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| Attacker origin (all self-navigation probes) | `frame-src 'self' <content>` (strict) | **blocked, no request** | **blocked, no request** | **blocked, no request** |
| Attacker origin | `frame-src *` (control) | reached: assign, replace, meta refresh, docopen refresh, Navigation API, `<a>` click, `download`, `ping` link | same | same |
| Content's own origin, any path/query (`/x-exfil/…?secret`) | strict | **reached** | **reached** | **reached** |
| App origin (`'self'` in the shell's `frame-src`) | strict | **reached**, no cookie | **reached**, no cookie | **reached, with the app's `SameSite=Lax` cookie** |
| `window.open`, `_blank`, `top.location`, `_top`, forms, `a[ping]` ping, downloads | any | blocked (sandbox) | blocked (`window.open` throws) | blocked |
| `document.write` subresources and frames | any | blocked (content CSP), 0 preconnect TCP | same | same |

Same for same-origin, cross-site and `srcdoc` content (the srcdoc frame is governed by the same parent `frame-src`).
`navigate-to` was removed from CSP and is not implemented: not testable. In Chromium and WebKit a navigation blocked by
`frame-src` still fires a second `load` (error page), so the shell's `unexpected-navigation` fault triggers; in
Firefox the frame stays put and no fault fires (harmless: the content keeps running). Allowed navigations fire the
fault in all three. The app cookie in WebKit was set on `localhost` and is therefore also sent to `localhost:<other
port>`: cookies ignore ports, so "another port" is not a cookie-less origin. Confidence: high (all engines, three
transports, request counted at the server).

### 2. Network side channels (`net`)

| Channel | Chromium | Firefox | WebKit | Blocked by |
|---|---|---|---|---|
| `fetch` (cors, no-cors), XHR, WebSocket, EventSource, `sendBeacon` | not reached | not reached | not reached | `connect-src 'none'` |
| `new Image`, CSS `background`, `FontFace`, `@font-face`, `<svg><image>`, `<video>`, `<audio>`, `<object>`, `<embed>`, child `<iframe>`, `<link rel=prefetch/preload/stylesheet/icon>` | not reached | not reached | not reached | content CSP |
| `<link rel=preconnect>` | 0 TCP connections | 0 | 0 | content CSP |
| `<link rel=dns-prefetch>` | not measurable on loopback | — | — | — |
| `Worker`/`SharedWorker` (URL, `blob:`, `data:`) | blocked | blocked | blocked | `worker-src` → `script-src` |
| WebTransport | blocked (`connect-src` violation) | rejected | absent | `connect-src` |
| `eval` | blocked | blocked | blocked | CSP |
| **`<script src=attacker>` with the nonce read from `document.currentScript.nonce`** | **reached** | **reached** | **reached** | nothing (`prod`); **hash-only** blocks it |
| **`import("http://attacker/…")` from the nonced author script** | **reached** | **reached** | **reached** | nothing (`prod`); **hash-only** blocks it |
| Inline `<script>` re-using the stolen nonce | runs | runs | runs | hash-only blocks it |
| **WebRTC STUN (UDP) / TURN over TCP** | **4 UDP packets, 1 TCP connection** | 0 (see note) | `RTCPeerConnection` absent in this build | **nothing**: CSP `webrtc 'block'` ignored (Chromium); no Permissions-Policy feature exists; sandbox does not cover it |
| Host ICE candidates | mDNS (`*.local`), no raw IP | mDNS | — | browser default |
| `navigator.connection` | readable (`effectiveType`, `rtt`, `downlink`) | absent | absent | — (no egress by itself) |
| `window.print()` | no print (no `allow-modals`) | same | same | sandbox |

The nonce is hidden from `getAttribute` but not from the `.nonce` property, and the runtime's own `<script>` exposes
it too, so **any author script in a nonce-based document can load arbitrary cross-origin script and modules** (a full
two-way channel through URLs and responses). With `hash-only` all three engines blocked both, with no change to the
runtime. Firefox note: no STUN packet left Firefox, but its ICE stack ignores loopback addresses by default
(`media.peerconnection.ice.loopback`), so the loopback harness cannot show a Firefox WebRTC leak: **Firefox and real
Safari WebRTC are not verified** and must be assumed to leak like Chromium. A STUN/TURN request is a data channel
(destination host, port and DNS name carry bits) and reveals the **viewer's public IP** to the attacker's server,
which is exactly the tracker ADR-001 forbids.

**Fresh realms** (could a "lockdown" that deletes `RTCPeerConnection`/`fetch` be undone?): a child `about:blank` or
`srcdoc` iframe created by the content was **not accessible** to it (`SecurityError`) in all three engines;
`document.open()` kept the deleted globals deleted. Workers are blocked. A runtime lockdown of `window` is therefore
not trivially reversible in these engines (still a single JavaScript barrier; aliases such as
`webkitRTCPeerConnection` must be covered). Confidence: high for the HTTP channels (all engines, three transports);
high for STUN in Chromium; Firefox/WebKit WebRTC unmeasured.

### 3. Resource abuse and containment (`abuse`, `watchdog`)

Parent heartbeat every 20 ms; "gap" = longest pause of the parent's event loop; key latency = Playwright key to the
parent's `keydown`. Busy loop and rAF storm run 7 s.

| Probe | chromium (headless shell) | **chromium-full** | firefox | **firefox-fission** | webkit |
|---|---|---|---|---|---|
| Busy loop, same-origin | gap 7.0 s, key 5.0 s | **gap 22 ms, key 2 ms** | gap 7.0 s | gap 7.0 s | gap 7.0 s |
| Busy loop, same-site (`localhost:B`) | 7.0 s | **21 ms** | 7.0 s | 7.0 s | 7.0 s |
| Busy loop, cross-site | 7.0 s | **22 ms** | 7.0 s | **27 ms** | 7.0 s |
| Busy loop, `srcdoc` | 7.0 s | **21 ms** | 7.0 s | 7.0 s | 7.0 s |
| 10^6 DOM nodes | 6.2 s | 34 ms | 7.5 s | 8.0 s same-origin / **23 ms** cross-site | key 11–13 s (parent blocked past the window) |
| rAF storm (45 ms/frame) | 136 ms | 29 ms | 100 ms | 96 / 23 ms | 76 ms |
| 1.5 GB allocation (bounded) | 0.5 s, no crash | 22 ms | 0.3 s | 0.25 s / 22 ms | 0.3 s, no crash |
| 16384×8192 canvas + 64 MB readback | 0.37 s | 22 ms | 0.2 s | 0.2 s / 22 ms | 0.34 s |
| Content frame out of process | no (1 renderer) | **yes, all four transports** (CDP: iframe target) | no | cross-site only (inferred) | no |

Sandboxed frames are isolated by full Chromium even when same-origin or `srcdoc` (sandboxed-iframe isolation);
Firefox Fission isolates only the cross-site origin; WebKit isolated nothing.

**Watchdog** (runtime-style heartbeat every 1 s; the shell replaces the frame after 3 missed beats + 0.5 s; content
busy-loops 20 s):

| | chromium (shell) | chromium-full | firefox | firefox-fission | webkit |
|---|---|---|---|---|---|
| Parent frozen during the loop | 20 s, all transports | **no** (gap ≤ 47 ms) | 20 s | 20 s except cross-site (23 ms) | 20 s |
| Watchdog fired | after the loop ended, or never (beats queued behind the timer) | **yes, while the loop ran** (3 missed beats + 0.5 s by construction; the frame's `busy-start` message itself was never delivered before the frame was removed) | after the loop (20 s) | **cross-site: 2.7 s after busy start**; others 20 s | after the loop (20 s) |
| Safe replacement loaded | — | 9–11 ms, but **16.3 s for same-origin content** (the new sandboxed `srcdoc` frame joined the busy process) | ~10 ms after detection | ~10 ms | ~6 ms |

A watchdog only helps where the frame is out of process; elsewhere the whole tab freezes for as long as the script
wants, and an endless loop freezes it until the browser's own hang dialog (not measured: Playwright disables the
hang monitor). The replacement must not be an iframe (it can share the busy process). The bounded allocation did not
crash any renderer; the sanitizer spike already crashed Chromium's renderer with depth bombs. Confidence: high for
the measured builds; real Safari and mobile browsers unknown (WebKit on Windows had no isolation at all).

### 4. Protocol forgery against the real shell (`proto`)

Identical in all three engines and both transports. The page did no evaluate and no input for 10 s, then one real
click inside the frame, later one real `ArrowRight` with the frame focused.

| Forged message (from author script) | `isActive` at arrival | Shell effect |
|---|---|---|
| `ready` with 200 fake slides, posted while parsing (before the runtime's) | false | **accepted** (slide count 200 until the real `ready` replaced it) |
| `preload {ok:true, images:9999}` before the runtime's | false | **accepted; the real report was then ignored**; indicator stays "ready", 9999 images |
| `key ArrowRight` ×2, `key KeyB` (ungated) | false | **acted** (advanced 2 steps; black screen on and off) |
| `state {slide:150}` (deck has 4) | false | **`onRender({slide:150})` called** |
| `KeyO`, `?`, `KeyS`, `KeyR`, `KeyK` while idle (also 8 s later) | false | ignored by the shell gate; `onKey` (the remote screen) was still called with them and must gate itself, which `screen.ts` does |
| `select 5` outside the overview | false | ignored |
| `KeyO` right after a real click | **true** | **overview opened** |
| `select 3` 300 ms after the click (overview open) | true | **navigated to slide 3** |
| `KeyS` 600 ms after the click | true | **presenter window opened** (`window.open`) |
| `?`, `KeyR` 1 s / 3 s after | false | ignored (`window.open` had consumed the activation) |
| `KeyO`, `KeyK` sent together with a real `ArrowRight` | **true** | **overview opened**; `KeyK` reached `onKey` as a real gesture |

So the gate is real (it does not depend on Playwright: the idle forgeries were refused with `isActive` false), but it
only proves *some* recent gesture, not *which* key: a script that listens to the user's clicks or keys can attach any
gated key to them. With the remote control (`screen.ts`), a forged `Enter` during a real gesture would approve a
pairing prompt and `KeyK` would disconnect remotes; not exercised here, same mechanism. Confidence: high.

### 5. `srcdoc` (offline) path with author script (`srcdoc`)

| | Chromium | Firefox | WebKit |
|---|---|---|---|
| Page CSP inherited by the srcdoc frame | yes | yes | yes |
| Author inline script runs when the page CSP has only the runtime hash | **no** (runtime runs) | no | no |
| Author inline script runs when its `sha256` is in the page CSP | yes | yes | yes |
| Stolen-nonce `<script src>`, `import()`, inline nonce reuse inside srcdoc | blocked (the page CSP has no nonce) | blocked | blocked |
| Network, navigation, STUN | as in 1–2 (STUN still leaves Chromium) | — | — |

So the offline path already behaves like `hash-only`; enabling author scripts there means adding each script's hash
to the player/presenter page CSP of that deck. Printing: `window.print()` from content is inert in all three.

## What is closed, what is not

**Closed by existing barriers (all three engines, same-origin and cross-origin content):** reading cookies, storage,
the parent DOM or the API; every HTTP/WS/fetch/beacon/worker/media/font/image/link channel to another origin;
popups, top navigation, forms, downloads, pings; `eval`; navigation of the frame to an attacker origin, provided the
shell page keeps a tight `frame-src` (the shell's CSP, not the content's, is what stops it); idle forged gated keys.

**Open with author script enabled as ADR-001 describes (nonce shared):**
1. **Nonce theft → cross-origin `<script src>` and `import()`**: full exfiltration/infiltration channel. All engines.
2. **WebRTC (STUN/TURN)**: exfiltration and viewer IP disclosure; no CSP, Permissions-Policy or sandbox control
   blocks it in Chromium; unverified elsewhere.
3. **Navigation to the content origin or the app origin** (`'self'` in `frame-src`): data reaches our own server logs;
   app GETs carry the session cookie in WebKit.
4. **CPU/DOM denial of service**: freezes the presenter's tab in every engine without process isolation (WebKit,
   Firefox for same-site, Playwright's headless Chromium); only full Chromium contains it for every transport.
5. **Protocol forgery**: ungated navigation and black screen at will; fake `ready`/`preload`/`state`; gated keys
   (overview, presenter window, remote approve/kick) during any real gesture.

## New mitigations required before enabling scripts
1. **CSP: hash-only scripts.** No nonce in any script-mode document. `script-src 'sha256-<runtime>' 'sha256-<each
   author script>'`, no `'strict-dynamic'`, no `'unsafe-inline'`, no URLs; author scripts must be inline (external
   `src` refused at ingest). Measured to close channel 1 in all engines. The srcdoc path already works this way; the
   player/presenter page CSP gains the deck's author hashes (it is already per deck and `no-store`).
2. **CSP stays as is otherwise** (`connect-src 'none'`, `frame-src 'none'`, `worker-src` implied, `form-action
   'none'`); add `webrtc 'block'` anyway (free, future-proof; ignored today).
3. **Runtime lockdown before any author script**: the runtime runs first and deletes or replaces
   `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCIceCandidate`, `RTCRtpSender/Receiver`,
   `RTCSessionDescription`, `RTCDataChannel`, `WebTransport`, `navigator.connection`, `navigator.sendBeacon`, and
   freezes `window`'s copies it relies on (`postMessage`, `parent`). Child realms were inaccessible and
   `document.open` did not restore globals, but this is one JavaScript barrier: needs its own browser test per
   engine, including real Firefox and Safari over a real network.
4. **Shell page `frame-src`: exactly the content origin** (`frame-src https://content.example`, no `'self'`, no
   wildcard subdomains); with only `srcdoc` (offline) it can be `'none'` for remote frames. The content origin must
   be a **different host** (not another port of the app host: cookies ignore ports), cookie-less, without open
   redirects, and its GET routes side-effect free.
5. **Protocol hardening in interactive mode** (shell): accept `ready` once per load and ignore any later one; accept
   `preload` only after `ready` and treat it as unverified in script mode (indicator relies on layer 2 or says
   "unverified"); drop `state` whose slide/step is outside the reported deck or that answers no pending `goto`; drop
   **all gated keys and remote approval keys from the frame** (they work with focus on the page, or through an
   explicit shell control), not only "unless a gesture is active"; rate-limit frame-originated navigation keys (for
   example 10/s) and never forward them to remotes or live viewers as authoritative.
6. **Watchdog**: the runtime posts `{type:"beat"}` every **1 s**; the shell replaces the frame after **3 missed beats
   (≈3.5 s)** with a **plain element** in the shell (not an iframe, which can share the busy process), sets the fault
   `unresponsive` and offers "reload without scripts". Only effective where the frame is out of process (desktop
   Chrome/Edge for every transport; Firefox only for a cross-**site** content origin); serve script-mode content
   from a separate **site** (registrable domain), not a subdomain of the app, to get Firefox's isolation.
7. **Resource limits stay mandatory**: the sanitizer's depth limits, slide size limits; document that WebKit/Safari
   (and Firefox same-site) cannot be protected from a busy loop.

## Recommendation
- **(a) Owner-private decks: GO, conditional** on mitigations 1, 3, 4, 5 and 6 (hash-only scripts, WebRTC lockdown,
  `frame-src` reduced to the content origin, protocol hardening, watchdog), still opt-in per instance and per deck.
  Residual risk: a script the agent wrote under prompt injection could freeze the owner's tab in WebKit/Firefox, and
  WebRTC egress relies on one JavaScript barrier. The owner sees and accepts the content.
- **(b) Public links: NO-GO** for now. Viewers did not opt in; a STUN request reveals their IP to whoever wrote the
  script (the tracker ADR-001 rules out), no standard browser control blocks it, and the only barrier (runtime
  lockdown) is unverified on real Firefox and Safari/iOS; a busy loop freezes viewers' tabs in WebKit and in Firefox
  unless the content is cross-site. Revisit after the lockdown is verified on real browsers over a real network and
  if a declarative WebRTC block ships (CSP `webrtc` or a Permissions-Policy feature) in at least Chromium and WebKit.

## Not verified
- Real Chrome/Edge, Firefox and Safari desktop builds (only Playwright builds; Chromium "full" stands in for Chrome).
- **iOS Safari and Android Chrome** (process model, WebRTC, hang behaviour) — not run at all.
- WebRTC egress in Firefox (loopback ignored by its ICE stack) and WebKit (no `RTCPeerConnection` in this build).
- DNS leaks (`dns-prefetch`, STUN hostnames): no resolver on loopback.
- The browser's own hang/slow-script dialogs (disabled under Playwright) and an unbounded allocation (we stopped at
  1.5 GB).
- How long transient activation lasts per engine (here it was consumed by `window.open` after ~0.6 s; gated keys
  should not rely on it anyway).
- The remote-control approval forgery through `screen.ts` (inferred from the measured gesture behaviour, not run).

## Implementation status (2026-11-17, ADR-020 foundation phase)

Implemented as [ADR-020](../adr/0020-interactive-mode.md): owner-private only, off by default
(`PPTAKEN_SCRIPTS=owner` to enable), consent bound to a scripts digest, static fallback everywhere else. Every
mitigation of "New mitigations required" above is built and re-measured by `packages/player/browser/scripts.mjs`
(same method as this harness: real attacker listener on `[::1]`, STUN/TURN counters, real builder/runtime/shell;
engines Chromium 158 headless shell and full, Firefox 159 with and without Fission, WebKit 27.2; raw output in
`packages/player/browser/scripts-last-run.json`).

| Mitigation | Implementation | Measured (all five engine variants unless noted) |
|---|---|---|
| 1. Hash-only scripts | `contentSecurityPolicy({ scriptHashes })`, no nonce in the document | nonce probe: every `script.nonce` empty, stolen-nonce `<script src>` impossible, 0 hits |
| (new) integrity-hash channel | Trusted Types `default` policy + creation/parsing lockdown | **New finding:** with hash-only CSP alone, `<script src integrity=allowed>` reaches the attacker in all three engines and `<link rel=preload/modulepreload integrity>` in Chromium and Firefox. With the lockdown: 15 creation/parsing paths refused, 0 hits |
| 2. CSP otherwise unchanged + `webrtc 'block'` | plus `script-src-attr 'none'`, `worker-src 'none'`, `object-src 'none'`, `X-DNS-Prefetch-Control: off` | net probe: 0 hits for fetch, XHR, WebSocket, EventSource, beacon, image, CSS, font, workers, `import()`, WebTransport; `eval`/`new Function` blocked |
| 3. Runtime lockdown | `packages/player/src/lockdown.ts`, runs from `<head>` | RTC constructors `undefined` and not restorable; realm probe: no iframe (DOM or HTML), `fetch` cannot be rewritten, `new Document()` cannot create `<link>`. STUN/TURN: 0 packets in the probe; the control page leaks 4 UDP + 1 TCP in Chromium (so the measurement can see a leak there) |
| 4. `frame-src` exactly the content origin | `playerCsp(contentOrigin)` | navigation to the attacker: 0 hits for 11 techniques × 2 transports. To the content origin: reached (residual, as before). To the app origin when content shares it: reached, **with the `SameSite=Lax` cookie in WebKit** (residual; GET routes reviewed side-effect free by a server test) |
| 5. Protocol hardening | private `MessageChannel` handshake, `expect`, gated keys dropped before `onKey`, 10/s limit | forged hello/ready(200)/preload/state(150)/select/keys on `window`, a poisoned `MessagePort.prototype.postMessage`, synthetic key events and forged gated keys during a real click: no effect; real gated keys typed in the frame: dropped; 60 keys in ~0.1 s: 10 navigations |
| 6. Watchdog | 1 s beat, 3.5 s, plain notice, static fallback | busy loop 8 s: full Chromium contains it (parent gap 21 ms, watchdog at 3.6 s while the loop runs); headless Chromium, Firefox, Firefox+Fission and WebKit freeze the parent for the whole loop (8 s) and recover afterwards (watchdog fires after the loop, fallback shown). 10^6 nodes: full Chromium 37 ms gap; others 3.3–3.7 s freeze, then fallback. rAF storm: parent responsive everywhere (≤ 105 ms), no watchdog. 1 GB allocation: no crash; ≤ 280 ms gap except headless Chromium (5.7 s) |
| 7. Resource limits | schema 128 KB/slide, 1 MB/deck, 16 vendored scripts; sanitizer limits unchanged | — |

Differences from the original measurements: Firefox with Fission froze for the cross-site busy loop here
(localhost → 127.0.0.1), where the spike measured 27 ms; treat Firefox as unprotected until measured with a real
separate site. Still **not verified**: real Chrome/Firefox/Safari builds, iOS and Android; WebRTC egress in
Firefox (its control page sent nothing even with `media.peerconnection.ice.loopback` on) and WebKit (no
`RTCPeerConnection` in this build); DNS-based leaks; browser hang dialogs.
