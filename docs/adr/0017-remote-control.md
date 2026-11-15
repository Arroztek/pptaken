# ADR-017 · Remote control: authoritative screen, first-frame auth, approved pairing

**Status.** Accepted (phase F4). **Amends** [ADR-006](0006-real-time-websocket.md), security
[§5](../foundation/04-security-and-auth.md) and threat T7, and architecture [§7](../foundation/02-architecture.md).
Protocol: [docs/spec/realtime.md](../spec/realtime.md). User guide: [present with your phone](../guides/present-with-your-phone.md).

**Context.** F4 lets a phone drive a talk: next/previous, black screen, a laser pointer, and (for the presenter) the
notes, the next slide and a clock. ADR-006 chose WebSocket with the server as the source of truth; F3 then made
the player shell the single owner of `{slide, step}` and synced the presenter window over `BroadcastChannel`, with
offline presenting as a hard requirement. A remote must fit that design without making the talk depend on the
server, and a stranger in the room must never be able to take control (T5).

## Decisions

1. **The screen is authoritative** (amends ADR-006 "the server is the source of truth"). The player page's shell
   owns `{slide, step, black}`. The server relays remote commands to it and caches the last `state` the screen
   announced, only to answer late or reconnecting phones. The socket client lives in the player page: a remote
   command calls `player.next()` / `prev()` / `first()` / `last()` / `goto()` / `black()` exactly like a key, so the
   presenter window keeps following over its `BroadcastChannel`, and every `onChange` is published as `state`.
   `shell.ts` navigation is untouched. With the server down the talk goes on; socket errors never reach the shell.
   Consequence: architecture §7's `session.navigate(principal, command)` use case is not built; a future agent
   (`live:control`) will be one more role whose commands the hub relays to the screen.
2. **Transport.** One `/ws` endpoint on the same port, the `ws` package **8.22.1** (zero runtime dependencies,
   pinned one release behind the newest for the supply-chain cooldown) in `noServer` mode on the Node server's
   `upgrade` event; `@hono/node-server` 2.1.8 has no upgrade hook. An upgrade bypasses Hono middleware, so the
   controls are re-applied by hand with request-agnostic helpers extracted from `http.ts` (`clientIpFrom`,
   `protoFrom`, `isSameOrigin`, `isAllowedHost`): allowed `Host` (T14), the content host refused, `Origin` equal to
   the request's own origin or the public URL (absent or `null` refused), 20 sockets per IP and 500 in total,
   path-only logging. Sockets: `maxPayload` 1 KB (larger frames close with 1009), `perMessageDeflate` off, idle
   timeout 35 s, closed with 1001 on shutdown (before the HTTP server closes).
3. **Package `@pptaken/realtime`** (Apache-2.0, no runtime dependencies): hand-written validators in the style of
   `sync.ts` (exact keys, `v: 1`, bounds; no zod in the phone and player bundles, and the server uses the same
   validators), a pure reducer `(state, event) -> {state, effects}`, the in-memory `RealtimeHub` that runs it, and
   the browser modules (reconnecting client, screen, panel, phone). Sockets themselves live in `apps/server`.
4. **First-frame authentication.** No cookie authenticates a socket. The first frame must be
   `auth {role, credential}` within 5 s (4408 otherwise, 4401 for a bad credential). Roles: `screen` with a
   **screen ticket** (an HMAC-signed token, purpose `screen`, bound to the live session, 60 s, re-issued by
   `POST /api/v1/live` before every connection; key derived as `live-ticket`) and `remote` with a **device
   credential**. The same frame will carry agent tokens and audience identities later.
5. **Pairing with mandatory approval** (amends security §5, which required approval only for a second device).
   `POST /api/v1/live/:id/pairing` (owner session + CSRF) issues a **128-bit one-time secret, valid 2 minutes,
   stored only as SHA-256**; a new code invalidates the previous unredeemed one. The QR encodes
   `<origin>/r#<22 base64url chars>`. The phone strips the fragment with `history.replaceState` (also on a
   same-document `hashchange`, when a scan reuses the tab) and redeems it with `POST /api/v1/remote/pair` (JSON,
   CSRF header; 10/min per IP and a global cap of 50 failures per 10 minutes). Redeeming creates a **pending
   256-bit device credential** (SHA-256 at rest) with a random two-digit code. The phone shows the code; the laptop
   shows "Allow <device> · NN?" and **every** device must be approved (Enter, or the button; Escape denies). A
   pending device receives only its `welcome` and can send nothing that is relayed; it gets no deck data.
   Credentials are scoped to one live session, expire with it (end or 12 h), at most **2 remotes** (pending ones
   count), kept in the phone's `localStorage`. `K` (or "Disconnect all") revokes every credential and closes their
   sockets (4003). The device label is derived on the server from the User-Agent ("Android · Chrome") and never
   echoes the header.
6. **Persistence.** Live sessions, pairing-secret hashes and device-credential hashes are in SQLite (core port
   `LiveSessionStore`, migration `0003_live`, contract suite in `@pptaken/testing` run against memory and SQLite).
   The hub state is in memory: after a restart credentials still work and the snapshot is rebuilt when the screen
   re-announces its state. One active live session per deck is reused (its revision follows the screen).
7. **Command semantics.** Remote → server: `cmd {n, action}` (`next|prev|first|last|black`, black toggles),
   `goto {n, slide, step}`, `pointer {x, y}`, `pointer-off`. Screen → server: `state {seq, slide, step, black,
   slideCount}`. Relative commands are de-duplicated per connection by `n` (a repeated or older `n` is acknowledged
   again, never applied twice). Without a screen: `nack {n, "no-screen"}`; commands are never queued, and the phone
   never replays commands after a reconnect. The phone shows only confirmed state. One screen per live session:
   the newest wins and the old one gets `replaced` (4001). Rates per connection: navigation 10/s, pointer 30/s,
   screen state 40/s, ping 1/s; excess is dropped silently.
8. **Laser.** Integer coordinates 0..10000 of the logical canvas. The phone has a pad with the deck's aspect ratio
   over the current-slide preview, maps touches absolutely, coalesces per animation frame (at most 30/s) and never
   queues (a frame is skipped while `bufferedAmount > 0`, on the server too). The shell draws a trusted layer above
   the iframe (no iframe protocol change): `s = min(w/W, h/H)`, centred offset, `translate3d`, diameter 1.2 % of
   the canvas height × `s`; hidden after 1.5 s without frames, under the black screen, in the overview and in
   print. Colour `#FF3B30`: the one non-neutral mark the player draws, because a pointer must be seen.
9. **Notes to the approved phone over HTTP only** (amends threat T7 and the player spec's notes policy).
   `GET /api/v1/remote/deck` with `Authorization: Device <credential>` returns, to an **approved** device only, the
   presenter data of the session's revision (titles, plan, notes rendered by `renderNotes`) and a signed content
   URL for the previews. Notes never travel on the socket and never through `/c/*` or a public link; tests check
   every socket frame and every content document.
10. **Plain-HTTP posture.** `ws://` works on a LAN; there is no service worker on `http://<ip>`; commands, notes
    and the pairing code travel in clear. The panel and the phone say so. The Wake Lock API needs a secure context,
    so on plain HTTP the phone may sleep: the page says so and requests a wake lock only where it exists. The phone
    uses no `crypto.subtle` (it generates no secrets). CSP `connect-src 'self'` covers same-host `ws:` in Chromium,
    Firefox and WebKit (verified by the browser suite), so no explicit socket origin is added.
11. **QR encoder: `qr` 0.7.2** (paulmillr/qr, MIT or Apache-2.0, zero dependencies, one self-contained 43 KB ES
    module), pinned exactly and served from the server's dependency at `/_rt/qr.js`. Only its `raw` matrix output
    is used (ECC "medium", 4-module quiet zone); the panel builds the SVG node by node (no markup strings). The QR is
    never shown by default: only while the presenter opens the panel (`R` in the player, a button in the presenter
    window). On a loopback page without `PPTAKEN_PUBLIC_URL`, the panel offers the machine's IPv4 LAN addresses
    (`GET /api/v1/live/lan`, from `os.networkInterfaces()`; IP literals already pass the Host check).
12. **Phone clock.** The phone runs its own clock with `pace.ts` (start/pause/reset, pace when the deck has a plan).
    It is not synced with the presenter window's clock: two local clocks, no clock on the wire.
13. **Failures.** Clients reconnect on `visibilitychange`, `online` and `pageshow`, with backoff 250 ms .. 5 s plus
    jitter; app-level ping every 10 s and two missed pongs mean dead. A stale phone (slide count differs from its
    data) refetches the deck data.

## Alternatives considered

- **Server-authoritative navigation** (ADR-006 as written): would make offline presenting and the F3 sync depend on
  the server, and duplicate the step logic on the server. Rejected.
- **Cookie auth on the socket**: no second client type could use it (phones, agents, audience), and CSRF-like
  cross-site socket opening would rely on `Origin` alone. Rejected for first-frame auth.
- **Approval only for the second device** (security §5 as written): the first scanner of a photographed QR would get
  control silently. Rejected: every device is approved.
- **Notes on the socket**: simpler, but frames are relayed and cached by a hub that also serves other roles later.
  Rejected: HTTP with the device credential, approved devices only.
- **Zod schemas on the socket**: zod would ship in the phone and player bundles. Hand-written validators instead.

## Deviations from the brief (recorded for review)

- Added frames: `welcome {role, status}`, `ping`/`pong`; `presence` has one shape per role; frames relayed to the
  screen drop `n` (`cmd {action}`, `goto {slide, step}`); `snapshot` is `{state | null, screen}`.
- Keys `R` and `K` joined the closed key set forwarded by the content runtime (the key list grows; no message type
  changes), because keys pressed with focus in the iframe would otherwise never reach the page. From the iframe they
  act only during a real user gesture; Enter/Escape answer the prompt under the same rule.
- The screen socket opens **on demand**: when the deck's live session already has devices (a reload mid-talk) or when
  the panel opens. A talk without a remote opens no socket and creates no live session.
- Approvals, removals, kick and end are owner HTTP routes, not socket frames. The approval prompt is drawn on the
  player page (it may be projected); it shows only the device label and the two digits.

## Consequences

- One new runtime dependency on the server (`ws`) and one browser module (`qr`), both pinned and zero-dependency.
- The audience role (F5+) and an agent role reuse `auth`, the hub and the per-role validators.
- Real phones (iOS Safari, Android Chrome), HTTPS behind a proxy and Wake Lock were not verified in automation.
