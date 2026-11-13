# ADR-008 · MCP: stateless Streamable HTTP, in the same process

**Verified context.** The current specification is **2026-07-28**: it removes sessions and the `initialize` *handshake* (each request is independent), deprecates HTTP+SSE and dynamic client registration (DCR) in favor of *Client ID Metadata Documents* (CIMD). The TypeScript SDK v2 implements it.

**Decision.**
- **Transport: Streamable HTTP** on `POST /mcp`, **stateless**. It fits naturally: our tools are CRUD and need no session.
- **Same process and same port** as the web: one container, one URL to remember.
- **stdio is not offered on the server.** For clients that only speak stdio or private-network instances, a thin bridge (`pptaken-mcp`, also packaged as a `.mcpb` desktop extension) will be published in v1.1, forwarding to the instance over HTTP with a token.
- **Tools only** in v1. We do not use *resources*, *prompts*, *sampling* or *elicitation*: support across clients is uneven and several of those features are deprecated in the current revision.
- Tool definitions live in `@pptaken/mcp` and call use cases from `@pptaken/core`: the same logic serves the panel's REST API.
- We follow the specification's recommendation of returning `tools/list` in deterministic order.

**Assumption to verify in the phase-2 spike:** real compatibility of SDK v2 with the protocol versions that claude.ai, Claude Desktop and Claude Code negotiate today (the SDK declares backward compatibility; it must be tested against the real clients). *Phase-0 note: see `docs/spikes/S2-mcp.md`.*

Contract detail: `02-architecture.md` §5. Authentication: `04-security-and-auth.md` §3.
