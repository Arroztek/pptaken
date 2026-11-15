# Panel HTTP API (v1, phase F2)

The contract between `apps/server` (implements it) and `apps/web` (consumes it). JSON over HTTP, all routes under
`/api/v1`. Phase F2 covers first-run setup, owner sign-in, API tokens, agent-connection status and a read-only
presentation list. Later phases add more routes; do not rely on routes that are not listed here.

## Conventions

- **Content type:** requests and responses are `application/json; charset=utf-8`.
- **Errors:** non-2xx responses carry `{ "error": { "code": string, "message": string, "hint"?: string } }`.
  Codes: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
  `SETUP_REQUIRED` (409, no owner yet), `ALREADY_SETUP` (409), `RATE_LIMITED` (429, with `Retry-After`),
  `INTERNAL` (500). Messages are human-readable English; the web app translates by `code`.
- **Session:** an `HttpOnly`, `SameSite=Lax`, `Path=/` cookie named `__Host-pptaken_session` when the request is HTTPS
  and `pptaken_session` over plain HTTP (the `__Host-` prefix requires `Secure`). Opaque random identifier, only its
  hash is stored. Sliding 30-day expiry.
- **CSRF:** every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) must send the header
  `X-PPTaken-CSRF: 1` **and** a matching `Origin` (or `Referer`) header; otherwise `403 FORBIDDEN`.
- **Timestamps** are ISO-8601 strings in UTC. **Ids** are strings.
- **No secrets in responses** except the one-time token value returned by `POST /tokens`.

## Setup and session

### `GET /api/v1/setup/status` (public)
```json
{
  "installed": false,
  "publicUrl": "http://localhost:8080",
  "https": false,
  "version": "0.1.0"
}
```
`installed` becomes `true` once the owner exists. `publicUrl` comes from `PPTAKEN_PUBLIC_URL` or the request.
`https` is true when `publicUrl` is HTTPS (the web app uses it to adapt the claude.ai instructions).

### `POST /api/v1/setup` (public, only while `installed` is false)
Body `{ "installCode": "7K2M-9QXD", "password": "..." }`. The install code is printed in the server logs at first
start; it is single-use. Password: at least 12 characters, not in a common-passwords list. On success: `201`, sets the
session cookie, returns `{ "owner": { "id": string } }`. Errors: `VALIDATION_ERROR` (weak password, with `hint`),
`FORBIDDEN` (wrong code, counted by the rate limiter), `ALREADY_SETUP`, `RATE_LIMITED`.

### `POST /api/v1/auth/login` (public)
Body `{ "password": "..." }`. `200` and the session cookie, or `UNAUTHENTICATED` / `SETUP_REQUIRED` /
`RATE_LIMITED` (5 attempts per minute per IP, increasing delay).

### `POST /api/v1/auth/logout`
`204`. Invalidates the current session.

### `GET /api/v1/auth/me`
`200 { "owner": { "id": string }, "csrf": "1" }` when signed in; `401 UNAUTHENTICATED` otherwise;
`409 SETUP_REQUIRED` when nobody has set the instance up yet.

## API tokens (owner session required)

### `POST /api/v1/tokens`
Body `{ "name": "Claude Code", "scopes"?: string[], "expiresInDays"?: number }`. Default scopes:
`["decks:read", "decks:write", "quiz:draft"]`; `share:write`, `live:control` and `admin` are not assignable in F2.
Response `201`:
```json
{
  "token": { "id": "01J...", "name": "Claude Code", "scopes": ["decks:read","decks:write","quiz:draft"],
             "createdAt": "...", "expiresAt": null },
  "secret": "ppt_..."
}
```
`secret` is shown **once**; only its SHA-256 is stored. Format `ppt_` + 43 base64url characters.

### `GET /api/v1/tokens`
`200 { "tokens": [{ "id", "name", "scopes", "createdAt", "expiresAt", "lastUsedAt", "revokedAt" }] }` (never the secret).

### `DELETE /api/v1/tokens/:id`
`204`; revokes immediately. `NOT_FOUND` if unknown.

## Agent connection (owner session required)

### `GET /api/v1/connect/status`
```json
{
  "mcpUrl": "http://localhost:8080/mcp",
  "agentConnected": false,
  "lastCallAt": null,
  "lastTool": null,
  "clientName": null
}
```
`agentConnected` is true once any MCP call authenticated with an API token has been served (the "Waiting for your
agent's first call…" state in the welcome page). `lastCallAt`/`lastTool`/`clientName` describe the most recent call.
The web app polls this endpoint every 2 seconds while the welcome page is open.

## Presentations (owner session required, read-only in F2)

### `GET /api/v1/decks?cursor=&q=`
`200 { "decks": [{ "id", "title", "lang", "slideCount", "revision", "updatedAt", "createdBy" }], "nextCursor": string|null }`.
Trashed decks are excluded. `createdBy` is `"owner"` or `"agent"`.

### `GET /api/v1/decks/:id`
`200` with the same summary plus `{ "urls": { "present": string } }`.

## Presenting (owner session required)

- `GET /p/:deckId` serves the trusted player page for a presentation (shell that embeds the content iframe).
- `GET /c/:deckId/:revision` serves the isolated content document with the CSP headers from `@pptaken/player`,
  authorized by a short-lived signed content token in the query string. The shell page obtains the URL (with its
  token) from `GET /api/v1/decks/:id/content-url` → `200 { "url": string }`.

## Static files and pages

`apps/server` serves the built web app. Routes handled by the web app (client-side): `/` (redirects to `/welcome`
before setup, to the presentation list after), `/welcome` (setup wizard and "Connect your agent"), `/login`,
`/decks`. Unknown non-API paths fall back to the web app's `index.html`.

## MCP endpoint

`POST /mcp` — Streamable HTTP, stateless, `Authorization: Bearer ppt_...`. Defined in
[`docs/foundation/02-architecture.md`](../foundation/02-architecture.md) §5; not part of the panel API.

<!-- BEGIN presenter view (F3) -->
## Presenter view (owner session required, F3)

### `GET /api/v1/decks/:id/presenter`
The data of the presenter view for the deck's current revision. Owner session only (`401 UNAUTHENTICATED`
without it, `409 SETUP_REQUIRED` before setup, `404 NOT_FOUND` for an unknown or deleted deck), rate limited like
the rest of the API (`429`), `Cache-Control: no-store`. It never exists on the content origin.

```json
{
  "title": "string",
  "revision": 3,
  "aspectRatio": "16:9",
  "targetMinutes": 20,
  "slides": [
    {
      "id": "intro",
      "title": "string",
      "section": "string",
      "durationHintSec": 60,
      "notesHtml": "<p>Say <strong>hello</strong></p>"
    }
  ]
}
```

- `targetMinutes`, `section` and `durationHintSec` are present only when the deck sets them.
- `notesHtml` is the slide's Markdown notes rendered by `renderNotes` (`@pptaken/player`): allowlisted tags only
  (`p br strong em code pre ul ol li h3 h4 blockquote`), no attributes except a numeric `ol start`, no styles, no
  URLs; links, images and raw HTML appear as text. Empty string when the slide has no notes.
- No slide HTML or CSS. The number of steps per slide is not included (the server does not run the document); the
  presenter view takes it from the player's `ready` message.
- Together with the owner-only, opt-in export (see the export section), this is the only route that returns speaker notes (threat T7): they are stripped from `/c/*`, and the public link
  and remote must never get them.

### `GET /p/:deckId/presenter`
The trusted presenter page (owner session; `302 /login` without it, `404` for an unknown deck), with the same
strict app CSP as `/p/:deckId`. It loads `/_player/presenter-page.js`, which fetches the route above and
`/api/v1/decks/:id/content-url`, and mounts `createPresenter`. The main player opens it with the key `s`; both
windows stay in sync over a same-origin `BroadcastChannel` (no server round trip).

Supporting static files (app origin, no session needed, no data): `/_player/presenter.js` and the other player
modules, `/_player/presenter.css` (Inter and JetBrains Mono `@font-face` rules) and
`/_player/fonts/{inter|jetbrains-mono}/<file>.woff2`.

## Offline presenting (F3)

### `GET /api/v1/decks/:id/offline`
The offline deck document of the current revision, for the player's service worker (layer 2): `200 { id,
revision, html }`, `Cache-Control: no-store`, owner session only (same errors and rate limit as the presenter data).
`html` is built by `buildOfflineDocument`: speaker notes removed, images and every bundled font inlined as `data:`
URIs, the no-network CSP as its first `<meta>`. It is JSON on the app origin and is only ever mounted by the shell
in the sandboxed iframe through `srcdoc` (docs/spec/player.md, "Offline presenting").

### `GET /p/sw.js`
The service worker (no session, no data): `text/javascript`, `Cache-Control: no-cache`, `nosniff`,
`Content-Security-Policy: default-src 'none'; connect-src 'self'; frame-ancestors 'none'`. Scope `/p/`.

The player and presenter pages (`/p/:deckId`, `/p/:deckId/presenter`) send the app CSP plus
`'sha256-<runtime>'` in `script-src` and `data:` in `font-src`, needed by the offline (srcdoc) document.
<!-- END presenter view (F3) -->

<!-- BEGIN export and import (F3) -->
## Export and import (owner session required, phase F3)

Human-only actions (security §3.3): they need the panel session cookie; API and OAuth tokens get
`401 UNAUTHENTICATED` here, and the core refuses any non-owner principal (`FORBIDDEN_ACTOR`). Not MCP tools.
Every export and import is written to the audit log (`presentation.export`, `presentation.import`). These routes
are served before the generic `/api` body limit and apply their own (see `POST /decks/import`); the rate limit per
IP of the rest of the panel API also applies.

### `GET /api/v1/decks/:id/export?format=html|pptaken&notes=0|1&revision=`
A file download.

- `format` (required): `html` = one self-contained page that opens from disk (`file://`) without a server or a
  network (`@pptaken/export` `exportHtml`); `pptaken` = the portable archive described below.
- `notes`: `0` or `1`. Default: **`0` for `html`** (the file is meant to be shared; threat T7) and **`1` for
  `pptaken`** (the owner's own backup or transfer). In the HTML file, notes live only in the outer page (shown with
  the `n` key), never in the sandboxed deck frame.
- `revision`: optional older revision (positive integer); default the current one.
- `200` headers: `Content-Type: text/html; charset=utf-8` or `application/zip`;
  `Content-Disposition: attachment; filename="<ascii-slug>.<ext>"; filename*=UTF-8''<percent-encoded title>.<ext>`
  (RFC 6266/8187; the ASCII name is `[a-z0-9-]` only, the Unicode one has no quotes, separators or controls);
  `Cache-Control: no-store`; `X-Content-Type-Options: nosniff`;
  `Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'` (a download is never rendered as
  an app document); `X-PPTaken-Revision` (the exported revision) and `X-PPTaken-Notes` (`0`/`1`).
- Errors: `VALIDATION_ERROR` (bad `format`, `notes` or `revision`), `NOT_FOUND` (unknown, other workspace, trashed,
  or the revision is not kept), `UNAUTHENTICATED`, `SETUP_REQUIRED`, `RATE_LIMITED`.
- The web app uses a plain `<a href download>` to this URL (same origin, the cookie goes along).

### `POST /api/v1/decks/import`
Creates a **new** presentation (revision 1) from a `.pptaken` archive; it never overwrites one.

- Body: the raw archive bytes with `Content-Type: application/zip` (no multipart: the simplest robust option, and a
  cross-site form cannot send this type without a CORS preflight). CSRF rules as for every `POST`.
- Size limit `PPTAKEN_MAX_IMPORT_MB` (default 100 MB), enforced from `Content-Length` before reading and while
  reading → `413 VALIDATION_ERROR`. Rate limit: 10 imports per 10 minutes per IP → `429 RATE_LIMITED` with
  `Retry-After`.
- `201`:
  ```json
  {
    "deck": { "id": "01J...", "title": "...", "lang": "en", "slideCount": 20, "revision": 1,
              "updatedAt": "...", "createdBy": "owner" },
    "assetCount": 2,
    "warnings": [{ "code": "UNUSED_ASSET", "message": "...", "path"?: "slides[3].html", "slideId"?: "intro" }]
  }
  ```
  Warning codes: the sanitizer's (`REMOVED_ELEMENT`, `REMOVED_CSS_RULE`…), `UNKNOWN_ASSET_REF` (a reference without
  a file in the archive; it will not display) and `UNUSED_ASSET` (a file no slide references; not imported).
- Errors: `VALIDATION_ERROR` with a precise English message for anything wrong with the archive (not a ZIP, unsafe
  or unexpected entry names, symbolic links, duplicates, encryption, ZIP64, compression ratio or size limits, CRC or
  SHA-256 mismatch, missing or invalid `manifest.json`/`deck.json`, an unsupported `formatVersion`), with the deck
  (schema), or with an asset (type detected from the content, declared type, pixel and size limits; the core's
  `UNSUPPORTED_MEDIA` and `LIMIT_EXCEEDED` are reported as `VALIDATION_ERROR` with their hint);
  `FORBIDDEN` (CSRF), `UNAUTHENTICATED`, `SETUP_REQUIRED`, `RATE_LIMITED`. No new error code was added.

### The `.pptaken` archive (format version 1)
A ZIP (stored or deflated entries, UTF-8 names) with exactly:

- `manifest.json`: `{ "format": "pptaken.archive", "formatVersion": 1, "exportedAt": ISO-8601, "generator":
  "pptaken <version>", "deck": { "title", "lang" }, "notes": boolean, "assets": [{ "sha256", "mediaType", "bytes",
  "width"?, "height"? }] }`. Readers ignore unknown keys; a higher `formatVersion` is refused with a clear message.
- `deck.json`: the `pptaken.deck` envelope as stored (sanitized), without notes when exported with `notes=0`.
- `assets/<sha256>`: the raw bytes of each referenced asset, named by their SHA-256; only assets the deck references.
- Optionally an `assets/` directory entry. Anything else makes the archive invalid.

Imports never trust the archive: the deck is validated with `parseDeck`, sanitized again and validated again; every
asset is re-checked like `add_asset` (content signature, declared type, SHA-256, limits); all rows are written in one
transaction.
<!-- END export and import (F3) -->

<!-- BEGIN remote control (F4) -->
## Remote control (F4)

Design: [ADR-017](../adr/0017-remote-control.md); socket protocol: [realtime.md](realtime.md). All routes are
rate limited per IP like the rest of the API, answer `Cache-Control: no-store`, and every `POST`/`DELETE` needs the
CSRF header and a same-origin `Origin` (the phone sends both too).

### Owner routes (session required)

| Route | Body / query | Response |
|---|---|---|
| `GET /api/v1/live?deck=<id>` | | `200 { live: { id, deckId, revision, expiresAt, devices } \| null }`: the deck's active live session (`devices`: paired, not revoked) |
| `POST /api/v1/live` | `{ deckId }` | `201` (new) or `200` (reused) `{ live: {…}, screenTicket, publicUrl }`. Starts or reuses the deck's live session (12 h), records the current revision, and issues a **screen ticket** (60 s) for the socket's first frame. `publicUrl` is `PPTAKEN_PUBLIC_URL` or `null` |
| `GET /api/v1/live/lan` | | `200 { addresses: ["http://192.168.1.20:8080", …] }`: this machine's IPv4 LAN addresses with the request's port, for the QR when the page is on `localhost` |
| `POST /api/v1/live/:id/pairing` | `{}` | `201 { secret, expiresAt, path: "/r" }`: a one-time 128-bit secret (22 base64url characters), valid 2 minutes, stored only as SHA-256; older unredeemed codes stop working. The page shows `<origin>/r#<secret>` as a QR |
| `GET /api/v1/live/:id/devices` | | `200 { devices: [{ id, label, code, status, online }] }` |
| `POST /api/v1/live/:id/devices/:deviceId/approve` | `{}` | `204`; `404` unless the device is pending |
| `DELETE /api/v1/live/:id/devices/:deviceId` | | `204`: deny a pending device or remove an approved one (its socket closes with 4003) |
| `POST /api/v1/live/:id/kick` | `{}` | `200 { revoked: n }`: every device credential of the session is revoked and its sockets close |
| `DELETE /api/v1/live/:id` | | `204`: ends the session; every credential stops working |

`404 NOT_FOUND` for an unknown, ended or expired session.

### Phone routes (no session)

#### `POST /api/v1/remote/pair`
Body `{ "secret": "<22 characters>" }`. Redeems the code once and creates a **pending** device:
`201 { credential, deviceId, liveId, code, label, expiresAt }`. `credential` (43 base64url characters, 256 bits) is
shown once and stored only as SHA-256; `code` is the two digits the laptop shows in its approval prompt; `label` is
derived from the User-Agent. Errors: `401 UNAUTHENTICATED` (unknown, used or expired code: indistinguishable),
`403 FORBIDDEN` (two remotes already paired, or CSRF), `429 RATE_LIMITED` (10 per minute per IP, and at most 50
failures per 10 minutes instance-wide).

#### `GET /api/v1/remote/deck`
Header `Authorization: Device <credential>` (never in the URL). For an **approved** device only: `200` with the
presenter data of the session's revision (the same shape as `GET /api/v1/decks/:id/presenter`: `title`, `revision`,
`aspectRatio`, `targetMinutes?`, `slides[{ id, title, section?, durationHintSec?, notesHtml }]`) plus `liveId` and
`contentUrl` (a signed 5-minute URL of the content document, for the slide previews). `401` for an unknown,
revoked or expired credential, `403` while the device is pending. With the owner-only presenter API and export, this
is the only route that returns speaker notes (threat T7).

### Pages and files

- `GET /r`: the phone page (no session, `noindex`, the player page's CSP). The pairing secret travels in the URL
  fragment, which browsers never send; the page strips it at once.
- `GET /_rt/<module>.js`: the browser modules of `@pptaken/realtime` (`client`, `dom`, `i18n`, `limits`, `panel`,
  `phone`, `protocol`, `screen`), `phone-page.js`, `phone.css`, and `qr.js` (the pinned QR encoder). No data.
- `GET /ws`: the WebSocket endpoint ([realtime.md](realtime.md)).
<!-- END remote control (F4) -->