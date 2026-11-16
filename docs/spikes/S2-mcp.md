# Spike S2 — MCP server with the official SDK v2

**Date:** 2026-11-13 · **Status:** partially done

## What was tested
A throwaway stateless server (`@modelcontextprotocol/server` 2.4.0 + `@modelcontextprotocol/hono` 2.0.2 +
Hono) with one tool, exercised by the SDK's own client (`@modelcontextprotocol/client`) over Streamable HTTP.

## Results
- Stateless Streamable HTTP on `/mcp` works: connect, `tools/list` and `tools/call` succeed
  (server created per request, `sessionIdGenerator: undefined`).
- **Protocol negotiation.** Raw `initialize` calls against the server:

  | Client asks for | Server answers |
  |---|---|
  | `2026-07-28` | `2025-11-25` (falls back) |
  | `2025-11-25` | `2025-11-25` |
  | `2025-06-18` | `2025-06-18` |

  So with SDK 2.4.0 the `initialize` handshake negotiates at most `2025-11-25`. The foundation docs
  state that the SDK implements spec `2026-07-28`; that claim is **not confirmed** by this test (the
  package also exports a `Discover*` schema, which may be the newer handshake path). Needs a closer
  read of the SDK before we rely on 2026-07-28 features.

## Still open (needs the founder's VPS)
- Connect from Claude Code (API token) and from claude.ai (needs public HTTPS: Dokploy + Traefik).
- Record which protocol version each real client negotiates.
- ~~Whether the SDK ships authorization-server helpers~~ Answered 2026-11-15: `@modelcontextprotocol/server` 2.4.0
  ships none (resource-server pieces only), so the authorization server is hand-written (ADR-018). The client
  package (`@modelcontextprotocol/client` 2.4.0) does ship `auth()` and `OAuthClientProvider`; PPTaken's
  conformance tests drive the whole flow with them (DCR and CIMD, refresh after expiry).

## Impact on ADRs
ADR-009 is amended by ADR-018 (hand-written authorization server). Re-check the ADR for MCP transport once the
real-client test is done.

## OAuth notes for the real-client test (2026-11-15)
- The SDK client logs a warning when a provider does not persist discovery state across the redirect (SEP-2352);
  real clients do. Our browser test implements it.
- Not verified yet against the live services: which CIMD URL claude.ai presents as its `client_id` (it may use DCR
  instead), and the Claude Desktop sign-in window's behaviour with our `Cross-Origin-Opener-Policy: same-origin`.
- Behind Traefik/Dokploy: route `/.well-known/*` and `/oauth/*`, keep `WWW-Authenticate`, and avoid any
  redirect on `/mcp` (Claude drops `Authorization` on redirects).
