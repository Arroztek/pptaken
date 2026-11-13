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
- Whether the SDK ships authorization-server helpers (relevant to the OAuth work in phase F5).

## Impact on ADRs
None yet. Re-check ADR for MCP transport once the real-client test is done.
