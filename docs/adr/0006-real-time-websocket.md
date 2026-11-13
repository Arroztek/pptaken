# ADR-006 · Real time: WebSocket with an in-memory hub

**Context.** Messages in both directions: remote commands, laser pointer (~20 msg/s), player state, answers and votes from hundreds of phones, live boards.

**Options.**

| | SSE + POST (as in `ppt`) | **WebSocket** | WebRTC (data channel) |
|---|---|---|---|
| Direction | Server→client; the rest by POST | Bidirectional | Bidirectional between peers |
| Pointer at 20 msg/s | One POST per message (headers, queue) | Frames of a few bytes | Ideal |
| 6-connections-per-origin limit (HTTP/1.1, typical on a LAN without TLS) | **Affects it** (player + notes + panel + tabs) | No | No |
| Proxies | Needs anti-buffer tricks (`ppt` has them) | Supported by Caddy, nginx, Traefik, Cloudflare | Needs signaling and sometimes TURN |
| Complexity | Low | Low–medium | High |
| Works without a server? | No | No | No (needs signaling) |

**Decision.** **WebSocket** as the only transport in v1, with:
- A typed, validated JSON message protocol (`@pptaken/realtime`), with a version `v`.
- **The server is the source of truth** for the live session (slide, step, active modules): whoever connects late receives a snapshot; reconnection with *backoff* and resync.
- A `RealtimeHub` interface (publish/subscribe per room). v1 implementation: in memory. The cloud can use Redis/NATS without touching the rest.
- Rate limits per connection and per message type (token buckets, an idea inherited from `ppt`).

**SSE** stays as a possible *fallback* only if evidence appears of networks blocking WebSocket. **WebRTC** is reserved for v2 (a remote that survives the server going down); its real value is low because it still needs the server for pairing.
