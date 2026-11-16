# ADR-018 · Built-in OAuth authorization server for `/mcp` (amends ADR-009)

**Status:** accepted (2026-11-15). Amends [ADR-009](0009-agent-authentication.md); see also
[security §3.2](../foundation/04-security-and-auth.md) and [http-api.md](../spec/http-api.md).

## Context

claude.ai, Claude Desktop and the Claude mobile apps connect to remote MCP servers only through the MCP
authorization flow (OAuth 2.1). Before this decision PPTaken's `/mcp` accepted API tokens only and its resource
metadata had no `authorization_servers`, so Claude Desktop's **Connect** failed with a registration error. ADR-009
already chose "API tokens + a minimal built-in authorization server" and left one assumption open: whether the MCP
SDK v2 ships reusable authorization-server helpers. It does not: `@modelcontextprotocol/server` 2.4.0 has resource
server pieces only (spike S2). The design below was checked against the 2026-07-28 MCP authorization specification
and Claude's connector documentation by the Fable advisor and signed off by the founder.

## Decision

1. **Hand-written, deliberately small authorization server** in `@pptaken/auth-local` (`OAuthService`, pure, no I/O)
   with HTTP glue in `apps/server/src/routes-oauth.ts`. No OAuth library: the surface is small enough to read in one
   sitting, and every library evaluated pulls in OIDC, JWT and confidential-client machinery we do not want. It
   implements only: authorization code + PKCE **S256**, public clients (`token_endpoint_auth_method: "none"`, never
   a client secret), refresh tokens with rotation, RFC 9207 `iss`, RFC 8707 resource indicators, RFC 7009
   revocation. No implicit, password or client-credentials grants; **no OpenID Connect, no step-up authorization,
   no DPoP in v1**.
2. **Issuer = `PPTAKEN_PUBLIC_URL`, exactly** (never derived from the `Host` header). OAuth is **enabled only when
   `PPTAKEN_PUBLIC_URL` is set and is https**, or http on a loopback host (`localhost`, `*.localhost`, `127.0.0.1`,
   `[::1]`) for development. When disabled there is no AS metadata, no `/oauth/*` endpoint, and the resource
   metadata omits `authorization_servers`; API tokens keep working. The server logs a warning when a public URL is
   set but OAuth is off because it is plain http.
3. **Endpoints**: `/.well-known/oauth-protected-resource[/mcp]` (now with `authorization_servers: [issuer]`),
   `/.well-known/oauth-authorization-server`, `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/token`,
   `POST /oauth/revoke`. Exact shapes in [http-api.md](../spec/http-api.md#oauth-authorization-server-adr-0018).
4. **Client registration: CIMD first, DCR as fallback.**
   - **CIMD** (client ID metadata documents): the `client_id` is an https URL; PPTaken fetches it through the
     SSRF-safe fetcher (`apps/server/src/safe-fetch.ts`: https and port 443 only, every resolved address must be
     public unicast, connection pinned to the checked address, **no redirects, 5 KB, 5 s**). The document's
     `client_id` must equal the URL; it must be a public client with 1–5 valid redirect URIs. Cached in memory for
     5 minutes to 24 hours (its `Cache-Control: max-age`, clamped), at most 50 entries. **Nothing is stored before
     consent**; the client row is written when the owner approves.
   - **DCR** (RFC 7591), on by default with caps: 10 registrations per hour per IP, about 100 registered clients
     without a grant instance-wide (then `503 temporarily_unavailable`), 4 KB body, at most 5 redirect URIs of at
     most 255 characters. Clients that never got a grant are purged after 24 hours; dead grants (revoked or expired)
     are deleted after 30 days, and their client with them once it has no grant left.
   - **Redirect URIs**: exact string match; https without fragment or userinfo, or http to `localhost`,
     `127.0.0.1` or `[::1]` where only the port may differ (RFC 8252 §7.3, Claude Code). **No custom schemes.**
5. **Authorization request validation order.** Client and redirect URI are validated **before** anything is sent to
   the redirect URI; if either is wrong PPTaken shows an error page and never redirects. After that, errors go back
   to the client with `error`, `state` and `iss`. A valid request becomes a pending request (memory, 10 minutes, at
   most 100) and the browser goes to the panel page `/connect/<id>`.
6. **Consent lives in the panel** (Svelte), not in a server-rendered form. `/connect/<id>` requires the owner session
   (signing in returns there through an internal-only `next`), shows the request and posts approve/deny to
   `/api/v1/oauth/requests/:id` with the usual CSRF check (`Origin` + `X-PPTaken-CSRF`), then navigates to the
   returned URL. **Never auto-approved.** The headline is the **redirect host**; a "Claude (claude.ai)" badge
   appears only when the redirect is exactly `https://claude.ai/api/mcp/auth_callback`; for CIMD the `client_id`
   host is shown; the client-supplied `client_name` is shown only as "calls itself …", with control and
   bidirectional characters stripped and capped at 60 characters; `logo_uri` is never fetched; loopback redirects
   get a stronger warning; scopes are checkboxes the owner can untick, and the token response returns the scope
   actually granted. The consent page navigates with `location.assign`, not a form post, so the app CSP's
   `form-action 'self'` needs no exception.
7. **Scopes** map 1:1 to the MCP scopes (`decks:read`, `decks:write`, `quiz:draft`). `offline_access` is accepted
   and ignored (refresh tokens are always issued); unknown scopes are dropped; a request with nothing grantable gets
   `invalid_scope`. **OAuth never grants `share:write`** (nor `live:control` or `admin`).
8. **Tokens**: opaque, prefixed, 256-bit: access `ppto_` (1 hour) and refresh `pptr_` (60 days, **sliding**), each
   `prefix + 43 base64url characters` (fits `bearerTokenOf`'s 200-character cap); only SHA-256 hashes are stored.
   Authorization codes: 256 bits, hashed, **60 seconds, single use**, bound to client, redirect URI, PKCE challenge,
   resource and scopes; **reusing a code revokes the grant**. Every refresh **rotates** the refresh token; presenting
   a rotated token revokes the whole grant, **except within a 60-second grace window** where the immediate
   predecessor is still accepted (lost responses, retries) and rotates again. A refresh token presented by another
   client is refused.
9. **Audience restricted to `/mcp`.** Each grant stores the canonical resource `<issuer>/mcp`; a mismatch at
   authorize or token time is `invalid_target` (an absent `resource` defaults to the single resource). The bearer
   middleware dispatches by prefix: `ppt_` API tokens as before; `ppto_` tokens only when the caller passes the
   resource, which only `/mcp` does, so they are **rejected on `/api/v1`**.
10. **`Principal.tokenId` = grant id**, stable across refreshes, so rate limits, the audit log and the agent
    connection status keep working per connection.
11. **401 challenge**: `WWW-Authenticate: Bearer realm="pptaken", resource_metadata="<iss>/.well-known/oauth-protected-resource/mcp", scope="decks:read decks:write quiz:draft"`,
    plus `error="invalid_token"` only when a token was presented (RFC 6750 §3; previously `invalid_request` was sent
    without credentials).
12. **CORS exceptions**: `Access-Control-Allow-Origin: *` (never credentials) and
    `Cross-Origin-Resource-Policy: cross-origin` only on the two metadata documents, `/oauth/token` and
    `/oauth/register`. `/mcp` keeps its `Origin` check and no CORS. The content origin keeps 404ing everything
    outside `/c/`.
13. **Storage**: new `OAuthStore` port with a contract suite (`runOAuthStoreContract`), memory and SQLite adapters,
    migration `0004_oauth` (`oauth_clients`, `oauth_grants`, `oauth_codes`, `oauth_tokens`). A clean-up job every
    10 minutes removes expired codes, tokens and pending requests, dead grants and unused clients.
14. **Revocation by the owner**: a "Connected applications" list in the panel (name, redirect host, scopes,
    connected, last used, disconnect); disconnecting revokes the grant and every token under it.

## Founder sign-offs (resolved as the advisor recommended)

1. DCR is **on by default**, with the caps above.
2. CIMD outbound fetches are **allowed**, only through the SSRF guard.
3. Refresh tokens last **60 days, sliding**, with a **60-second** reuse grace for the immediate predecessor.
4. Consent needs only a **live owner session** (no password re-entry).
5. OAuth **never grants `share:write`**.
6. A password change in the panel offers a checkbox "also disconnect applications"; the CLI
   `pptaken reset-password` **always** disconnects every application.
7. **No custom-scheme redirect URIs.**

## Deployment notes (Traefik, Dokploy and other proxies)

- Route `/.well-known/*` and `/oauth/*` to PPTaken (not only `/`, `/api` and `/mcp`).
- Do not strip or rewrite the `WWW-Authenticate` response header.
- No cross-host and no trailing-slash redirect on `/mcp`: Claude drops the `Authorization` header when it follows a
  redirect, which looks like an endless sign-in loop.
- `PPTAKEN_PUBLIC_URL` must be the exact https origin clients use; it is the issuer and the resource.

## Consequences

(+) claude.ai, Claude Desktop, mobile and Claude Code connect with the standard flow, without an external identity
provider. (+) Small, tested surface: conformance with the official SDK client, negative tests for every rule above,
a browser test of the consent page. (−) We own security-sensitive code: it needs the external review listed in
security §11 before 1.0. (−) Pending requests and the CIMD cache live in memory: a restart in the middle of a consent
means the client has to start again (acceptable for a single process). (−) Not verified against the live services
yet: the CIMD URL claude.ai uses for itself, and whether the Claude Desktop popup is affected by our
`Cross-Origin-Opener-Policy: same-origin` (the consent page is a top-level navigation, so it should not be).
