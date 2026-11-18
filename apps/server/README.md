# @pptaken/server

The PPTaken server: one Node.js process that composes Hono, the panel API ([`docs/spec/http-api.md`](../../docs/spec/http-api.md)),
the MCP endpoint (`@pptaken/mcp`), the player page and the isolated content routes, on top of `@pptaken/core`,
`@pptaken/auth-local`, `@pptaken/storage-sqlite` and `@pptaken/blob-fs`. License: AGPL-3.0-or-later.

```sh
pnpm --filter @pptaken/server build
PPTAKEN_DATA_DIR=./data node apps/server/dist/main.js     # prints "PPTaken ready at … · Install code: XXXX-XXXX"
pnpm --filter @pptaken/server test                       # integration tests (real SQLite, real blob-fs, real port)
pnpm --filter @pptaken/server test:browser               # Playwright: Chromium, Firefox, WebKit
pnpm --filter @pptaken/server test:remote                # Playwright: remote control, laptop + phone contexts
pnpm --filter @pptaken/server test:unlock                # Playwright: presenter-password unlock (ADR-021), 3 engines
pnpm --filter @pptaken/server test:vendor                # Playwright: vendoring + HTML import (ADR-022), 3 engines, 0 third-party requests
pnpm --filter @pptaken/server smoke:vendor               # MANUAL only: one real Google Fonts + jsDelivr fetch
```

`createServer(config, options)` (from `src/app.ts`) builds everything for tests; `src/main.ts` is the CLI entry.

## Routes

| Route | Auth | Notes |
|---|---|---|
| `GET /api/v1/setup/status`, `POST /api/v1/setup` | public | setup needs the install code; wrong codes count in the sign-in throttle |
| `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` | public / session | session rotation on login |
| `POST/GET /api/v1/tokens`, `DELETE /api/v1/tokens/:id` | owner session | secret shown once |
| `GET /api/v1/connect/status` | owner session | flips after the first authenticated MCP request |
| `GET /api/v1/decks`, `GET /api/v1/decks/:id`, `GET /api/v1/decks/:id/content-url` | owner session | read-only in F2 |
| `GET /api/v1/decks/:id/export?format=…&notes=…&revision=` | owner session | file download (`routes-export.ts`): single HTML file or `.pkn` archive; notes off for HTML, on for the archive by default |
| `POST /api/v1/decks/import` | owner session + CSRF | raw `.pkn` body (`application/zip`), own size limit, 10 imports / 10 min / IP; creates a new presentation |
| `POST /mcp` | `Authorization: Bearer ppt_…` | Streamable HTTP, stateless (SDK `createMcpHandler`: 2026-07-28 per-request protocol plus stateless 2025-era fallback) |
| `GET /.well-known/oauth-protected-resource[/mcp]` | public | RFC 9728 metadata, referenced by the `401` `WWW-Authenticate` header |
| `/api/v1/live…`, `POST /api/v1/remote/pair`, `GET /api/v1/remote/deck` | owner session + CSRF / pairing secret / device credential | remote control (`routes-live.ts`, F4, ADR-017): live sessions, screen tickets, pairing, approval, kick; deck data for an approved phone |
| `GET /ws` (WebSocket) | first frame `auth` (screen ticket or device credential) | `realtime.ts`: `ws` in noServer mode on the `upgrade` event; Host/Origin/IP checks by hand, 20 sockets per IP, 1 KB frames ([realtime spec](../../docs/spec/realtime.md)) |
| `GET /r`, `GET /_rt/*` | public | the phone page and the `@pptaken/realtime` browser modules, plus the pinned QR encoder (`routes-remote.ts`) |
| `GET /p/:deckId` | owner session (else `302 /login`) | trusted player page; loads `/_player/page.js` and the `@pptaken/player` shell modules |
| `GET /c/:deckId/:revision?ct=…` | signed content token (5 min, bound to deck + revision) | deck document built from the stored sanitized revision, CSP from `contentHeaders` |
| `GET /c/asset/:token/:sha256` | signed asset token (12 h, bound to the deck) | `assetHeaders()`, only assets linked to that deck |
| `GET /c/fonts/:family/:file.woff2` | public | bundled fonts with CORS (see open questions) |
| `GET /healthz`, `GET /readyz` | public | readiness checks the database and blob directory |
| everything else (`GET`) | — | the built web app from `PPTAKEN_WEB_DIR` with SPA fallback, only if it exists |

## Configuration

| Variable | Default | |
|---|---|---|
| `PPTAKEN_PUBLIC_URL` | derived from each request | origin only (`https://slides.example.com`) |
| `PPTAKEN_PORT` / `PPTAKEN_HOST` | `8080` / `0.0.0.0` | |
| `PPTAKEN_DATA_DIR` | `./data` | created `0700`; holds `secret.key` (`0600`), `pptaken.db`, `blobs/` |
| `PPTAKEN_TRUST_PROXY` | `false` | take the client IP from the **last** `X-Forwarded-For` entry and the scheme from `X-Forwarded-Proto` |
| `PPTAKEN_WEB_DIR` | `../web/dist` (relative to this package) | |
| `PPTAKEN_CONTENT_URL` | none | separate cookie-less origin for `/c/*` (recommended; needs `PPTAKEN_PUBLIC_URL`). On a different **site** it also isolates scripted decks in Firefox (ADR-020) |
| `PPTAKEN_SCRIPTS` | `off` | interactive mode (ADR-020): `owner` lets approved author scripts run in the owner's own session; `off` stores them but always serves the static version |
| `PPTAKEN_VENDOR_FETCH` | `on` | ingest-time vendoring (ADR-022): `on` downloads the external fonts, stylesheets, images and CDN scripts a deck references once, stores them and rewrites the deck; `off` refuses writes that reference external resources |
| `PPTAKEN_VENDOR_ALLOW_HOSTS` | (empty) | comma-separated hosts (and their subdomains) vendoring may fetch from; empty: any public https host |
| `PPTAKEN_VENDOR_DENY_HOSTS` | (empty) | comma-separated hosts (and their subdomains) vendoring never fetches from |
| `PPTAKEN_ALLOWED_HOSTS` | none | extra Host names (comma-separated) |
| `PPTAKEN_FONTS_DIR` | `../../packages/ui/fonts` | |
| `PPTAKEN_SECRET_KEY` / `PPTAKEN_SECRET_KEY_FILE` | none | inject the 256-bit secret (hex or base64) instead of `secret.key` |
| `PPTAKEN_LANG` | none | default deck language |
| `PPTAKEN_MAX_API_BODY_KB` / `PPTAKEN_MAX_MCP_BODY_MB` | `64` / `4` | enforced while reading, before parsing |
| `PPTAKEN_MAX_IMPORT_MB` | `100` | largest `.pkn` archive for `POST /api/v1/decks/import` (1–1024), checked from `Content-Length` and while reading |
| `PPTAKEN_LOG_LEVEL` | `info` | |

Invalid values stop the server with `Configuration error: <variable> …` (exit code 2).

## CLI

- `pptaken reset-password`: reads the new password from the terminal (not echoed, asked twice) or from stdin, applies
  the password policy and signs out every session. Needs access to the data directory.
- `pptaken backup <new dir>`: writes `<dir>/pptaken.db` (consistent online copy with SQLite `VACUUM INTO`) and
  `<dir>/blobs/sha256/…` (blobs are immutable and written atomically, so a plain copy is consistent). Restore = put
  both back into an empty data directory. The secret key is not copied: nothing stored depends on it.

## Cross-cutting controls

- **Host validation** (DNS rebinding, T14): Host must be the public/content host, `localhost`/`*.localhost`, an IP
  literal (rebinding needs a domain name) or a name in `PPTAKEN_ALLOWED_HOSTS`; otherwise `403`.
- **CSRF** (T13): every `POST`/`PUT`/`PATCH`/`DELETE` under `/api` needs `X-PPTaken-CSRF: 1` and an `Origin` (or
  `Referer`) equal to the public origin or the request's own origin. Applies to setup and login too.
- **No CORS** on `/api` and `/mcp`; `Access-Control-Allow-Origin: *` only on `/c/asset/*` and `/c/fonts/*`. `/mcp`
  refuses browser requests whose `Origin` is another site.
- **Headers** on every response: `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (all off except
  `fullscreen=(self)` for the player), `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`, CSP
  (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; …; frame-ancestors 'none'` on HTML,
  `default-src 'none'; frame-ancestors 'none'; sandbox` on everything else), HSTS when the public URL is HTTPS.
  `/c/*` keeps the player's own headers (CSP sandbox, `frame-ancestors <app origin>`).
- **Rate limits** (in memory, token buckets): sign-in and setup 5/min per IP with a delay doubling from the 3rd
  consecutive failure (1 s … 15 min) and a global failure budget (50 per 10 min); MCP 120 tool calls/min and 20
  writes/min per token (tool error `RATE_LIMITED` with `retry_after_sec`), 300 requests/min per token and 20 failed
  authentications/min per IP (HTTP `429` with `Retry-After`); `/api` 300 requests/min per IP.
- **Logs**: one JSON line per request (`method`, `path` without the query, `status`, `ms`, `ip`, `requestId`) through
  a ~40-line logger that redacts secrets by key and by value (tokens, Bearer values, session cookies, `ct=` query
  values). pino was not added: levels, JSON lines and redaction are all we need. The install code is printed once in
  the startup line on purpose (it is how the administrator reads it).
- **Graceful shutdown** on `SIGTERM`/`SIGINT`: stop accepting, close idle connections, close SQLite, exit (forced
  after 10 s).

## Decisions and open questions

| Topic | Decision |
|---|---|
| Content origin | Same origin by default (zero configuration). `PPTAKEN_CONTENT_URL` moves `/c/*` to a second host name on the same port (the app host then answers `404` on `/c/*` and the content host only serves `/c/*` and `/healthz`); the browser test runs with app on `localhost` and content on `127.0.0.1`. The player spec recommends the separate origin: on a single origin, a navigation started by unsanitized content would carry the `SameSite=Lax` cookie in WebKit (no API `GET` has side effects, and the shell treats it as a fault). **Open:** make a separate origin the default in the Docker/Caddy profile. |
| Asset URLs | `/c/asset/<asset token>/<sha256>` instead of `/c/asset/<sha256>`: assets need authorization (the iframe sends no cookie) and the builder can only prefix `asset:<hex>`, so the token lives in the asset base path (the CSP `img-src` names that path). Token lifetime 12 h, bound to the deck; the asset must be linked to the deck and the deck must not be in the trash. Caching is per token. |
| Document token | 5 minutes, bound to `deckId:revision`, purpose-separated from asset tokens (HKDF subkey `content-token`). The document itself is `no-store` (fresh nonce). |
| Fonts in documents | `buildDeckDocument` does not emit `@font-face` for the catalog fonts yet (player spec open question), and `packages/player` is not changed here. The server serves `packages/ui/fonts` at `/c/fonts/…` with CORS, but documents cannot use them yet (the CSP `font-src` is the asset path), so slides fall back to local fonts. Only 3 of the 9 catalog fonts are bundled. |
| `401` on `/mcp` | `WWW-Authenticate: Bearer realm="pptaken", error=…, resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"`, and that metadata document is served (no `authorization_servers` until the OAuth phase F5). |
| Agent connection status | Every authenticated MCP request updates `lastCallAt`; tool calls also set `lastTool`. `clientName` comes from the `initialize` `clientInfo` (or the per-request envelope of 2026-07-28 clients), falling back to `User-Agent`. |
| Session-only panel API | `/api/v1/*` accepts only the session cookie (no Bearer), since every F2 panel route is owner-only. `/mcp` accepts only Bearer API tokens. |
| Owner routes before setup | `409 SETUP_REQUIRED` (as `/auth/me`), otherwise `401 UNAUTHENTICATED`. |
| Body errors | Oversized bodies answer `413` with code `VALIDATION_ERROR`; non-JSON bodies `400 VALIDATION_ERROR` (the contract has no `413`/`415` codes). |
| `manage` URL | `create_presentation` returns `urls.manage = <base>/decks/<id>`: the presentation's page in the panel, with the approval screen of its scripts (ADR-021). |
| Base URL of agent-facing URLs | The MCP `base_url`/`urls` follow `PPTAKEN_PUBLIC_URL`, or the request's own origin when unset. |
| Backup format | A directory (`pptaken.db` + `blobs/`) instead of a `.tar`: no dependency needed. **Open:** `.tar` output. |
| Sign out everywhere | Implemented in `@pptaken/auth-local` (`revokeAllSessions`, also done by `reset-password`) but no HTTP route: the F2 contract has none. **Open:** add `POST /api/v1/auth/logout-all` to the contract. |
| Open | Audit log of auth events (sign-in, token creation/revocation) is only in the request logs, not in `audit_log`. |
| Export/import routes | `routes-export.ts` is mounted before the generic `/api` body limit (64 KB) because archives are bigger; its middleware is scoped to its two paths and repeats the panel guards (IP rate limit, CSRF, owner session). Import uses the raw body (`application/zip`), not multipart. Core `LIMIT_EXCEEDED`/`UNSUPPORTED_MEDIA` map to `VALIDATION_ERROR` (no new codes). Export downloads carry `Content-Security-Policy: sandbox` so they never render as app documents. The HTML export embeds the bundled fonts the deck uses (data: URIs), unlike the live content route. |
