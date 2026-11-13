# ADR-003 · HTTP server: Hono; Next.js is discarded

**Decision.** Hono as the HTTP router, in a single process that serves the API, MCP, WebSocket and the frontend static files.

**Alternatives.**
- **Next.js (discarded).** It is a React framework with server rendering designed for SEO sites and deployment on managed platforms. We have a static single-page app + API + long-lived connections. Next would add: heavier builds, larger image and memory, its own conventions (server components, caching) that a contributor must learn, and WebSocket off its natural path. It brings nothing we need.
- **Fastify.** Excellent and mature; it would lose to Hono only on portability (Hono uses standard `Request/Response` and runs the same on Node, Bun, Deno or *workers*, useful for the cloud) and because the MCP SDK v2 ships helpers for Hono (`@modelcontextprotocol/hono`, with `Host` header validation).
- **Express 5.** Ubiquitous, but slower and with weaker types.
- **`node:http` with no dependencies (like `ppt`).** Admirable for a deck; for a product it forces rewriting routing, validation and middleware. No.

**Consequences.** (+) Small core, web standard. (−) Smaller plugin ecosystem than Fastify; we will write some middleware ourselves.
