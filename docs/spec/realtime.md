# Real-time protocol (`@pptaken/realtime`), version 1, phase F4

The WebSocket protocol of the remote control: a phone drives the presentation shown by the player page. Design
background and decisions: [ADR-017](../adr/0017-remote-control.md). HTTP side (live sessions, pairing, device data):
[HTTP API](http-api.md#remote-control-f4). License of the package: Apache-2.0.

## Roles and trust

| Role | Who | Credential (first frame) | May send | Receives |
|---|---|---|---|---|
| `screen` | The player page (`/p/:deckId`), the window the audience sees | Screen ticket (60 s, from `POST /api/v1/live`) | `ping`, `state` | `welcome`, `pong`, `presence {remotes}`, `cmd`, `goto`, `pointer`, `pointer-off`, `replaced` |
| `remote` | A paired phone (`/r`) | Device credential (43 base64url characters) | `ping`, `cmd`, `goto`, `pointer`, `pointer-off` | `welcome`, `pong`, `presence {screen, status}`, `snapshot`, `state`, `ack`, `nack`, `revoked` |

The **screen is authoritative** for `{slide, step, black}`. The server never computes a position: it relays remote
commands to the screen and caches the last `state` the screen sent, to answer late or reconnecting remotes. A remote
command is applied by the page as local input (`player.next()`, …), so the presenter window (synced over
`BroadcastChannel`) follows too. One screen per live session: a newer screen replaces the older one.

A **pending** remote (paired, not yet approved on the laptop) receives only its `welcome`; anything it sends except
`ping` is dropped. When the owner approves it, it receives `presence` and `snapshot`.

## Endpoint and connection rules

- `GET /ws` with `Upgrade: websocket`, same host and port as the app. Not served on the content origin.
- The upgrade is refused (HTTP status, no socket) when: the path is not `/ws` (404); the `Host` is not allowed
  (403, same rule as HTTP, T14); the `Origin` header is absent, `null`, or not the request's own origin
  (`<scheme>://<Host>`) nor `PPTAKEN_PUBLIC_URL` (403); the client IP already has 20 sockets, or the server 500 (429);
  the server is shutting down (503). Behind a trusted proxy (`PPTAKEN_TRUST_PROXY`), the IP and scheme come from
  `X-Forwarded-For` / `X-Forwarded-Proto`.
- Text frames only, at most **1024 bytes** (UTF-8); a larger frame closes the socket with 1009. No compression.
- The **first frame must be `auth`** within 5 s; cookies are never used. Logging records the path only.
- Clients ping every 10 s; the server closes a socket that sent nothing for 35 s. Two missed pongs make a client
  drop the connection and reconnect.

## Frames

Every frame is a JSON object with **exactly** the listed keys plus `v: 1` and `type`. Receivers drop unknown types,
extra or missing keys, other versions, non-integers and out-of-range numbers (`parseClientFrame`, `parseToRemote`,
`parseToScreen`). After 20 invalid frames the server closes the socket (1008).

Bounds: `slide` 0..199, `step` 0..255, `slideCount` 1..200 with `slide < slideCount`, `n` and `seq` 0..2³¹−1,
`x`/`y` 0..10000, `credential` 1..600 characters of `[A-Za-z0-9._-]`.

### Client → server

| Frame | Fields | Role | Rate per connection |
|---|---|---|---|
| `auth` | `role`: `"screen"` or `"remote"`, `credential` | any, first frame only | once |
| `ping` | none | any | 1/s (burst 3) |
| `cmd` | `n`, `action`: `next`, `prev`, `first`, `last`, `black` (toggle) | remote | 10/s with `goto` |
| `goto` | `n`, `slide`, `step` | remote | 10/s with `cmd` |
| `pointer` | `x`, `y` (canvas coordinates, integers 0..10000) | remote | 30/s with `pointer-off` |
| `pointer-off` | none | remote | 30/s with `pointer` |
| `state` | `seq`, `slide`, `step`, `black`, `slideCount` | screen | 40/s |

Frames over a rate are **dropped silently** (no `nack`). A frame not allowed for the role counts as invalid.

### Server → client

| Frame | Fields | To | When |
|---|---|---|---|
| `welcome` | `role`, `status` (`approved`; `pending` for an unapproved remote) | both | after a valid `auth` |
| `pong` | none | both | answer to `ping` |
| `presence` | `remotes`: up to 8 `{id, label, code, status, online}` | screen | on join and whenever a device pairs, connects, leaves, is approved or revoked |
| `presence` | `screen` (boolean), `status` | approved remote | on approval, and when the screen comes or goes |
| `snapshot` | `state` (`{seq, slide, step, black, slideCount}` or `null`), `screen` | approved remote | on join and on approval |
| `state` | `seq`, `slide`, `step`, `black`, `slideCount` | approved remotes | the screen announced a state |
| `ack` | `n` | remote | a command was relayed (or was a duplicate) |
| `nack` | `n`, `reason`: `"no-screen"` | remote | no screen is connected; the command is not queued |
| `revoked` | none | remote | removed, kicked, or the session ended; the socket closes next |
| `replaced` | none | screen | a newer screen took over; the socket closes next |
| `cmd` | `action` | screen | relayed remote command (no `n`) |
| `goto` | `slide`, `step` | screen | relayed remote command (no `n`) |
| `pointer` / `pointer-off` | `x`, `y` / none | screen | laser |

`label` is built by the server from the User-Agent (`"Android · Chrome"`, at most 40 characters of a fixed
alphabet); `code` is two digits. Both are shown on the laptop as text.

### Close codes

| Code | Meaning | Client behaviour |
|---|---|---|
| 1001 | Server shutting down | reconnect with backoff |
| 1008 | Too many invalid frames | reconnect |
| 1009 | Frame over 1 KB | reconnect |
| 4001 | Replaced by a newer screen | stop |
| 4003 | Revoked (removed or kicked) | stop; the phone forgets its credential |
| 4004 | Session ended or expired | stop; the phone forgets its credential |
| 4401 | Bad or missing credential | screen: fetch a new ticket and retry; phone: forget the credential |
| 4408 | No `auth` within 5 s | reconnect |

## Semantics

- **De-duplication:** each connection keeps the highest `n` it sent. A `cmd`/`goto` whose `n` is not greater is
  acknowledged again and never relayed twice. `n` restarts per connection, and the phone never resends a command
  after a reconnect: it shows only state the server confirmed (`snapshot`, `state`).
- **Screen state:** the screen sends `state` on every change of slide, step, black screen or slide count, and right
  after its `welcome` (re-announce after a reconnect or a server restart). `seq` increases per page load.
- **Laser:** coordinates are normalised to the logical canvas (1920×1080 or 1440×1080). The phone maps its touch pad
  (the deck's aspect ratio) absolutely, sends at most one frame per animation frame and per 34 ms, and skips a frame
  while its socket has data buffered; the server also skips a pointer frame while the screen's socket is buffered.
  The shell draws the dot (diameter 1.2 % of the canvas height, scaled) and hides it after 1.5 s without frames,
  under the black screen, in the overview and in print (see the player spec).
- **Reconnect:** backoff 250 ms .. 5 s with jitter, and immediately on `visibilitychange` (visible), `online` and
  `pageshow`. The screen fetches a fresh ticket before every attempt.
- **Never on the socket:** speaker notes, slide content, titles, the deck document. The approved phone reads them
  over HTTP (`GET /api/v1/remote/deck`).

## Tests

- Unit (`packages/realtime/test`): every frame valid and invalid (extra keys, bounds, wrong role, prototype tricks,
  multi-byte size), the reducer (authority, de-duplication, no-screen, pending inertness, approval, replace, kick,
  revoke, end, volatile laser), the hub, token buckets, backoff, the reconnecting client with a fake socket and fake
  timers (no queueing, ping misses, terminal codes, credential failures).
- Server (`apps/server/test/realtime.test.ts`, real `ws` client): forbidden Host and Origin, unknown path, auth
  timeout, auth-first, forged ticket, oversize frame, connection cap, pairing one-time and rate limited, CSRF on
  pairing, pending device inert (no relay, no data), approval and relay both ways, laser, notes absent from every
  frame and from `/c/`, limit of two remotes, kick, newest screen wins, no-screen nack, shutdown 1001, credentials
  surviving a restart, device labels.
- Browser (`apps/server/browser/remote.mjs`, two contexts, Chromium, Firefox and WebKit): see the player spec.
