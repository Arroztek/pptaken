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
