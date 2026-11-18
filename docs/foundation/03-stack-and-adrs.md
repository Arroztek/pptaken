# 03 · Stack and architecture decision records (ADR)

> An **ADR** (*Architecture Decision Record*) is a short note that records **what was decided, why, and what was discarded**. It exists so that a year from now nobody (not even you) has to guess. When a decision changes, the ADR is not deleted: a new one is written that replaces it. When the repo is created, each ADR will move to its own file in `docs/adr/`.

Versions verified on **2026-11-12** against the npm registry, nodejs.org and official documentation. Anything marked **Assumption** was not verified.

## Stack summary

| Layer | Choice | Verified current version |
|---|---|---|
| Language | TypeScript across the project | 7.0.x |
| Runtime | Node.js LTS | 26 "Lithium" (active LTS); 24 remains in maintenance |
| HTTP | Hono + `@hono/node-server` | 4.13 / 2.1 |
| MCP | Official SDK v2: `@modelcontextprotocol/server` + `@modelcontextprotocol/hono` | 2.4.0 / 2.0.2 (implements specification 2026-07-28) |
| Validation | Zod (one source of truth → types + JSON Schema) | 4.6 |
| Database | SQLite (WAL) via `better-sqlite3`, queries with Kysely | 13.1 / 0.29 |
| Real time | WebSocket (`ws`, `@hono/node-ws`) | 8.23 / 1.3 |
| Frontend | Svelte 5 + Vite (static multi-page app, no SvelteKit) | 5.57 / 8.3 |
| Player engine | Framework-free TypeScript (`@pptaken/player`) | n/a |
| Monorepo | pnpm workspaces + Changesets | 12.x / 3.0 |
| Quality | Biome (lint+format), Vitest, Playwright | 2.6 / 5.1 / 1.65 |
| Logs | pino (JSON) | 10.4 |
| Distribution | Multi-architecture Docker image (amd64, arm64) on GHCR | n/a |
| License | AGPL-3.0-or-later (application) + Apache-2.0 (format and client libraries) | n/a |

> Update (2026-11-13), from the phase-0 spikes in `docs/spikes/`: `better-sqlite3` installs prebuilt on Node 22/24/26 Alpine amd64 (arm64 untested). With the MCP SDK 2.4.0, the `initialize` handshake negotiated at most protocol `2025-11-25`, so support for specification 2026-07-28 is **not confirmed**. The scaffold currently runs on Node 22 and the pnpm 10 line; the "pnpm 12.x" and "Node 26" rows above remain targets to re-verify.

---

## ADR-001 · Content format: JSON envelope + isolated HTML canvas

**Status:** accepted. It is the most important decision of the project.

**Context.** The content is written by an agent and, in the cloud, will be uploaded by third parties. We need at once: (a) an LLM that can express itself freely and get it right, (b) content that cannot attack the presenter or the audience, (c) a stable, versionable schema, (d) revealable steps, notes and metadata that the player understands, (e) that it works offline, (f) a path to interactive demos.

**Options considered.**

| Option | In favor | Against |
|---|---|---|
| A. Free HTML sanitized with an allowlist (as in the `ppt` project) | Maximum expressiveness; LLMs master HTML/CSS | A sanitizer is a single barrier and sanitizers fail; no structure for notes/steps; a slide's global CSS breaks the interface |
| B. Pure structured format (block JSON or Markdown + components) | Secure by construction; easy to validate and edit | Forces us to invent and maintain a mini-PowerPoint of components; the result looks generic; every new need is a schema change. Contradicts "we are not a design tool" |
| **C. Hybrid: JSON envelope + per-slide HTML/CSS inside an isolated iframe** | Structure (title, notes, steps, theme) is validatable JSON; design is free HTML/CSS/SVG; security does not depend only on the sanitizer | Two layers to maintain; the iframe complicates keyboard focus and measurement |

**Decision.** Option C, with the format name **`pptaken.deck`**, schema version `1`.

1. **Envelope (JSON).** A presentation is a JSON document: `schemaVersion`, `title`, `lang`, `aspectRatio`, `theme` (shared CSS and variables), and `slides[]`. Each slide: stable `id`, `title`, `html`, optional `css`, `notes` (Markdown), optional `section`, optional `durationHintSec`.
2. **Canvas.** Each slide is drawn on a fixed logical canvas of **1920×1080** (or 1440×1080 in 4:3) that the player scales with *letterbox*. This way the agent works with predictable absolute pixels, just as `ppt` did.
3. **Revealable steps.** `data-step="n"` attribute on any element (no number = order of appearance). The player counts them; the agent declares nothing else.
4. **Assets.** Images are referenced as `asset:<id>`; the server rewrites them to internal hashed paths. **External URLs are not allowed** (no images, fonts or CSS): this guarantees offline and avoids trackers that leak the audience's IP. (Amended by ADR-022: external URLs are vendored at write time; the stored deck still references no third party.)
5. **Fonts.** A closed catalog of libre families included in the image (see visual identity §7). The agent uses them by name. (Since ADR-022, other families work once vendored.)
6. **Trust model: three independent barriers.**
   - *Barrier 1 — sanitizing on ingest* (server): allowlist of tags, attributes and CSS properties; `<script>`, `on*`, `javascript:`, `<iframe>`, `<object>`, `<form>`, `@import` and external `url()` are removed. The response to the agent includes `warnings` with what was removed.
   - *Barrier 2 — isolation on display*: the deck document is served from a content route with a `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; …` header and mounted in an `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`. The browser gives it an **opaque origin**: even if something malicious slipped through, it cannot read cookies or storage or call the PPTaken API.
   - *Barrier 3 — no-network CSP*: `connect-src 'none'`, `img-src` and `font-src` only to the content route, `form-action 'none'`, `base-uri 'none'`. The content cannot exfiltrate anything.
7. **Modes.**
   - `safe` (default and only one in v1.0): HTML + CSS + SVG, CSS animations, no author JavaScript. The only script inside the iframe is the PPTaken *runtime* (steps, scaling, messaging), authorized by *nonce*.
   - `interactive` (v1.x, off by default): allows author `<script>` **inside the same isolated, network-free iframe**. It is enabled by the owner per instance (`PPTAKEN_ALLOW_SCRIPTS=true`) and per presentation ("I trust this content" checkbox). In the cloud it will also be served from a separate domain (`*.pptaken-usercontent.com`).
8. **Notes outside the canvas.** Speaker notes never enter the iframe or the public link: they live in the trusted interface.
9. **Versioning.** Integer `schemaVersion`. Compatible changes (new optional fields) do not increment it; incompatible ones do and require a `vN → vN+1` migrator in `@pptaken/schema`. The server accepts the current and the previous version. The JSON Schema is published with each release.

**Consequences.**
- (+) The agent writes what it writes best; we do not maintain design components.
- (+) A sanitizer failure stops being a critical vulnerability: it stays contained by the isolation.
- (+) Interactive demos are a future switch, not a redesign.
- (−) Player↔iframe communication through `postMessage` (keys, steps, size): that mini-protocol must be specified and tested.
- (−) No external resources: the agent cannot "paste an image link"; it must upload it (`add_asset`) or draw with SVG. It is intentional.
- (−) No JS in v1.0: data-driven animated charts are limited to CSS/SVG. Acceptable for an MVP.

**What we learned from `ppt` that supports this.** There, slides are code with *hooks* (`init/enter/leave/onStep`) and a sanitizer only protects the phone. It works because the author is the owner. In PPTaken the author is an agent: content becomes data and trust is inverted.

---

## ADR-002 · Language and runtime: TypeScript on Node.js LTS

**Context.** A single junior maintainer, a community to build, need for a solid MCP SDK, a frontend that is inevitably JS/TS.

**Evaluation.**

| Criterion | TypeScript/Node | Go | Rust | Python | Bun / Deno |
|---|---|---|---|---|---|
| Official MCP SDK | Yes, the reference one (v2 already implements 2026-07-28) | Yes, official | Yes, official | Yes, official | They use the TS one |
| One language with the frontend | **Yes** (shared types and validation) | No | No | No | Yes |
| Ease of contributing (target audience: web people) | **Very high** | Medium | Low | High | Medium |
| Ecosystem for sanitizing HTML/CSS/SVG | **Mature** | Good in HTML, weak in CSS | Good | Good | npm's |
| Docker image (estimated) | ~80–150 MB | **~15–25 MB** | **~10–20 MB** | ~120–200 MB | ~60–120 MB |
| Idle RAM (estimated) | ~60–100 MB | **~10–20 MB** | **~5–15 MB** | ~50–90 MB | ~40–90 MB |
| Single binary | Possible, awkward | **Native** | **Native** | No | Bun/Deno compile |
| Maturity risk for self-hosted production | Low | Low | Low | Low | Medium |
| Continuity with `ppt` (founder's code) | **Direct** | Rewrite | Rewrite | Rewrite | Direct |

**Decision.** TypeScript end to end on **Node.js 26 LTS** (minimum supported: 24).

**Why not Go**, the serious alternative: we would gain ~80 MB of image and ~60 MB of RAM, but we would pay for two languages, duplicated schemas (the MCP contract, the deck format and the real-time protocol are validated on server *and* client) and a higher contribution barrier exactly where we need the most help. On a 512 MB VPS, 100 MB of RAM is not the bottleneck. If it ever were, the core is isolated behind ports and the protocol is JSON: the server could be rewritten without touching clients.

**Why not Bun/Deno as the official runtime:** they are attractive (built-in SQLite, single binary) but add compatibility risk with native modules and have less production history. We do not block them: Hono is portable and we avoid Node-only APIs outside the adapters.

**Consequences.** (+) One language, one package manager, shared types. (−) Larger image and memory than with Go/Rust. (−) We depend on the hygiene of the npm ecosystem (mitigated in security §9).

---

## ADR-003 · HTTP server: Hono; Next.js is discarded

**Decision.** Hono as the HTTP router, in a single process that serves the API, MCP, WebSocket and the frontend static files.

**Alternatives.**
- **Next.js (discarded).** It is a React framework with server rendering designed for SEO sites and deployment on managed platforms. We have a static single-page app + API + long-lived connections. Next would add: heavier builds, larger image and memory, its own conventions (server components, caching) that a contributor must learn, and WebSocket off its natural path. It brings nothing we need.
- **Fastify.** Excellent and mature; it would lose to Hono only on portability (Hono uses standard `Request/Response` and runs the same on Node, Bun, Deno or *workers*, useful for the cloud) and because the MCP SDK v2 ships helpers for Hono (`@modelcontextprotocol/hono`, with `Host` header validation).
- **Express 5.** Ubiquitous, but slower and with weaker types.
- **`node:http` with no dependencies (like `ppt`).** Admirable for a deck; for a product it forces rewriting routing, validation and middleware. No.

**Consequences.** (+) Small core, web standard. (−) Smaller plugin ecosystem than Fastify; we will write some middleware ourselves.

---

## ADR-004 · Frontend: Svelte 5 + multi-page Vite; framework-free player engine

**Context.** Five surfaces with different needs:

| Surface | Device | Priority |
|---|---|---|
| Player (trusted interface around the iframe) | Laptop / projector | Fluidity, offline, zero distractions |
| Slide runtime (inside the iframe) | Laptop / phone | Tiny (< 5 KB), no dependencies |
| Remote control | Phone | Instant load, big buttons |
| Audience pages | Phones on saturated WiFi | Minimal weight (< 60 KB) |
| Owner panel | Laptop / phone | Productivity (forms, lists) |

**Decision.**
- **`@pptaken/player`**: navigation, steps, scaling and messaging engine in **framework-free TypeScript**. It is the heart and must be embeddable anywhere (HTML export, cloud, future integrations).
- **Interface**: **Svelte 5** compiled with **Vite** as a multi-page app (one entry per surface). **No SvelteKit**: we need neither server rendering nor its router.

**Alternatives.** React (the best known, but ~45 KB base and more ceremony); Preact (4 KB and a React API: the second-best option); Solid; Lit; all vanilla (viable for player and remote, painful for the panel).

**Why Svelte:** it compiles to JS without a heavy runtime (key for audience pages), its syntax is close to HTML (low barrier for new contributors) and Svelte 5 is stable and well supported by coding assistants. **Honest trade-off:** there are fewer Svelte developers than React ones. We mitigate by keeping logic in framework-free packages; the Svelte layer is thin and replaceable.

---

## ADR-005 · Database: SQLite when self-hosted, Postgres in the cloud, behind ports

**Decision.**
- **SQLite in WAL mode** as the only database of the self-hosted edition. One file at `/data/pptaken.db`.
- Access with **Kysely** (a typed query builder, not an ORM) and **numbered SQL migrations** (`0001_init.sql`, …) applied at startup, inside a transaction, with a prior copy of the file.
- Driver: **`better-sqlite3`**, encapsulated in a single module.
- The domain does not know SQL: it talks to **repositories** (interfaces). The cloud will implement the same repositories on **Postgres**.
- Binaries (images) do **not** go in the database: they go to a `BlobStore` (local disk; S3 in the cloud), addressed by SHA-256 hash.

**Why SQLite and not Postgres for self-hosted.**

| Criterion | SQLite | Postgres |
|---|---|---|
| Installation | Nothing: it runs inside the process | Second container, credentials, volume, version |
| Backup | Copy a file (or `VACUUM INTO`) | `pg_dump`, more steps |
| Extra RAM | ~0 | 50–150 MB |
| Expected load | More than enough: thousands of writes/s in WAL; a 300-person quiz is tens/s | More than enough |
| Scaling to several nodes | No | Yes |

Our target user must not administer a database. The case that needs several nodes is the cloud, and the adapter exists for that.

**Why Kysely and not Drizzle/Prisma.** Prisma adds an engine and a heavy generation step. Drizzle is good but defines different schemas per dialect (`sqlite-core` vs `pg-core`), which duplicates work when we want the same code on SQLite and Postgres; it is also still 0.x. Kysely is dialect-agnostic, thin and predictable. Rules to keep the SQL portable: simple types (text, integer, JSON as text), dates as epoch-ms integers, ULID identifiers as text.

**Why `better-sqlite3` and not `node:sqlite`.** The built-in `node:sqlite` module is still at stability 1.2 (*release candidate*) on both Node 24 and 26 (verified). `better-sqlite3` is mature and fast, at the cost of being a native module (it compiles per architecture). **Assumption to verify in the first spike:** that it publishes prebuilt binaries for Node 26 on linux-x64 and linux-arm64 (musl and glibc). When `node:sqlite` reaches stable, migrating will mean changing one file and will remove our only native dependency.

**Consequences.** (+) Zero operation for the user. (−) A single node (accepted). (−) Maintaining portable-SQL discipline; verified by running the same contract test suite against both adapters once the Postgres one exists.

---

## ADR-006 · Real time: WebSocket with an in-memory hub

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

---

## ADR-007 · Bluetooth: not between browsers; yes for physical clickers

**Founder's question:** can the phone control the laptop over Bluetooth?

**Research (2026-11).**
- **Web Bluetooth** only exists in Chromium browsers (Chrome, Edge, Opera, on desktop and Android). **Safari (macOS and iOS) and Firefox do not implement it**, and Apple has announced no plans. On iOS all browsers use Safari's engine: every iPhone is left out.
- More important: Web Bluetooth only lets the browser act as a **client** (central) of a peripheral. **A browser cannot advertise itself as a peripheral**, so two browsers cannot talk to each other over Bluetooth, not even Chrome with Chrome.
- **Local WebRTC** works between devices on the same network, but it requires a signaling server for the initial handshake. If that server is reachable, WebSocket already solves the problem.

**Decision.** Browser↔browser Bluetooth is not implemented. It is not our limitation but the web platform's.

**What we do instead:**
1. **Physical Bluetooth/USB clickers**: they present themselves to the system as a keyboard. The player maps the keys they emit (PageDown/PageUp, arrows, `b` or `.` for black screen, F5/Esc). It works without a network and without a server. It is the official recommendation for rooms without WiFi.
2. **No internet but local network**: server on the same WiFi, or on the laptop itself with the phone connected to the laptop's *hotspot*. Documented as the "airplane mode" recipe.
3. **v1.1**: lock-screen and Bluetooth headset controls via MediaSession (the near-silent audio technique from `ppt`), Android/Chromium only.

---

## ADR-008 · MCP: stateless Streamable HTTP, in the same process

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

---

## ADR-009 · Agent authentication: API token + built-in OAuth 2.1 server

**Verified context.** Claude Code accepts fixed headers. claude.ai/Desktop/mobile only guarantee OAuth (or no authentication); fixed headers are in restricted beta. For OAuth, Claude requires: a `401` response with `WWW-Authenticate: Bearer resource_metadata=…`, RFC 9728 and RFC 8414 metadata, PKCE S256, and it accepts CIMD (if the server announces `client_id_metadata_document_supported: true` and `"none"` in `token_endpoint_auth_methods_supported`) or DCR. Return URI: `https://claude.ai/api/mcp/auth_callback` for the hosted apps, and *loopback* with a variable port for Claude Code.

**Options.**
1. API token only → leaves out claude.ai, which is where our target user is.
2. No authentication with a secret in the URL (`/mcp/<secret>`) → it would work with "No sign-in", but secrets in URLs end up in logs and histories; the specification forbids tokens in the *query* and Anthropic's documentation discourages it. Discarded.
3. Require an external identity provider (Keycloak, Auth0…) → unacceptable for "one command".
4. **A minimal built-in authorization server** → our work, but zero configuration for the user.

**Decision.** Options 1 + 4 combined:
- **API tokens** (`ppt_…`, 256 bits, only the hash is stored, scopes, optional expiry). The path for Claude Code and any script.
- **A built-in OAuth 2.1 authorization server, deliberately small**: only the *authorization code* flow + PKCE S256, public clients, CIMD as the preferred mechanism and DCR for compatibility, rotated *refresh tokens*, the `iss` parameter (RFC 9207), audience binding (RFC 8707). The consent screen requires the owner's session.
- Both produce the same internal object `Principal { actor: 'agent', scopes, tokenId }`.
- All behind the `AuthProvider` interface: the cloud will replace it with a multi-tenant OIDC provider.

**Consequences.** (+) Works with every Claude client without external services. (−) Implementing OAuth is delicate: it is kept to the minimum, tested against the specification and reviewed before 1.0. **Assumption to verify:** whether SDK v2 ships reusable authorization-server utilities (v1 did); if not, an audited library is evaluated before writing it by hand.

---

## ADR-010 · Monorepo and tooling

**Decision.** A monorepo with **pnpm workspaces**: `apps/` (what gets deployed) and `packages/` (what is reusable). Versioning and publishing with **Changesets**. Lint and formatting with **Biome**. Tests with **Vitest** (unit and contract) and **Playwright** (end to end). No Turborepo/Nx at the start: `pnpm -r` is enough; task caching is added when CI exceeds ~5 minutes.

**Why a monorepo:** a schema change touches server, player and MCP at once; in one repo that is one PR, one review and one CI. **Why Biome and not ESLint+Prettier:** one tool, one configuration, much faster; less friction for first-time contributors.

Detailed structure: `02-architecture.md` §3.

---

## ADR-011 · Packaging and distribution

**Decision.**
- **Single official channel in v1: Docker image** `ghcr.io/<org>/pptaken`, multi-architecture (`linux/amd64`, `linux/arm64`, for VPS and Raspberry Pi), tags `1.2.3`, `1.2`, `1` and `latest`.
- Base `node:26-alpine` in a multi-stage build; non-root user; read-only filesystem except `/data`; `HEALTHCHECK`.
- A `compose.yaml` is shipped with two profiles: basic (HTTP on port 8080) and `https` (adds **Caddy** with automatic certificates given a domain).
- All state in **one volume** `/data`: `pptaken.db`, `blobs/`, `secret.key`.
- Configuration through environment variables with sensible defaults; zero mandatory configuration.

**Alternatives.**
- **`npx pptaken`**: attractive for developers, but it requires Node installed and SQLite's native module complicates Windows support. Evaluated for v1.1 as an "experimental" channel.
- **Single binary** (Node SEA, `bun build --compile`): removes Docker for the end user, but is today incompatible with our native module without tricks. Re-evaluated when `node:sqlite` is stable.
- **Native installers / desktop app**: out of scope.

**Consequences.** (+) A single artifact to test and support. (−) It requires Docker; for the non-technical user that is already friction, and it is part of the cloud's argument.

---

## ADR-012 · License: AGPL-3.0 for the application, Apache-2.0 for the format and client libraries; license-grant CLA

**Context.** *Open core* model: open core + paid cloud service. A jargon-free explanation of the options:

| License | In one sentence | For the founder | For whoever contributes/uses |
|---|---|---|---|
| **MIT / Apache-2.0** (permissive) | "Do whatever you want, just keep the notice" | Maximum adoption; anyone can run a closed PPTaken-cloud with your code | No restrictions. Apache adds patent protection |
| **AGPL-3.0** (network *copyleft*) | "If you modify it and offer it as a service, publish your changes" | A competitor cannot close their improvements; you remain genuinely open source (OSI-approved) | Using or self-hosting it unmodified obliges nothing. Some large companies ban AGPL by policy |
| **BUSL / FSL / SSPL** (*source-available*) | "You can see the code but not compete with me" | Maximum commercial protection | **Not open source**: the community perceives it that way and contributes less |

**Decision.**
1. **AGPL-3.0-or-later** for `apps/*` and the server packages. It protects the business model while remaining genuine open source, and it is the de facto standard in comparable self-hosted open-core projects.
2. **Apache-2.0** for what we want the ecosystem to adopt without hesitation: `@pptaken/schema` (the deck format), `@pptaken/player` (the player engine) and the future `pptaken-mcp` bridge. Letting anyone generate or play `pptaken.deck` decks makes the project bigger.
3. **Contributions: license-grant CLA** (not a copyright assignment), signed with one click through a bot. The contributor keeps authorship and grants the project the right to license their contribution under other terms as well. It is accompanied by a public commitment in `GOVERNANCE.md`: **the community edition will remain under an OSI-approved license**.

**Why a CLA and not just a DCO.** The **DCO** (*Developer Certificate of Origin*) is a `Signed-off-by` line on each commit saying "I have the right to contribute this"; it is lightweight but contributions enter only under AGPL. With that, any cloud code that runs **in the same process** as the core would also have to be published under AGPL, and selling commercial licenses to companies that do not accept AGPL would require each contributor's permission. The CLA preserves those options. Its cost is friction and some wariness in part of the community; it is mitigated with the public commitment and with transparency.

**Valid alternative if the founder prioritizes trust over optionality:** AGPL + DCO, publishing as open source all the adapters that run in-process (Postgres, S3, OIDC) and leaving private only the cloud's control plane (sign-up, billing, operations) as a separate service. It is a sound architecture in any case and I recommend it also with a CLA.

**Notices.** I am not a lawyer: before accepting the first external contribution, a brief legal review of the CLA is advisable. The content users create (their presentations) is not affected by the software's license.

---

## ADR-013 · Relationship between `pptaken` (public) and `pptaken-cloud` (private)

**Decision.**
- `pptaken` publishes the `@pptaken/*` packages on npm with semantic versioning (Changesets) and the Docker image.
- `pptaken-cloud` **consumes those packages as dependencies**. It never copies code or maintains a *fork*.
- The cloud has its own composition app (`apps/cloud-server`) that wires the same core with other adapters: `storage-postgres`, `blob-s3`, `auth-oidc`, `realtime-redis`, plus the control plane (accounts, plans, limits, billing).
- **Golden rule:** if the cloud needs an extension point that does not exist, it is added as an interface in the public repo (with its public PR) and the cloud implements it. The cloud never patches the core.
- **Anti-divergence:** the cloud's CI runs every night against the public repo's `main` branch (canary) in addition to the latest published version.
- What is paid is decided by **operating cost or business value** (hosting, domains, SSO, teams, analytics), never by removing features that are already in the core.

Interface detail: `02-architecture.md` §9. Community management: `06-open-source-guide.md` §11.

---

## ADR-014 · Immutable revisions and soft delete

**Context.** The editor is an agent: it can misunderstand, overwrite or delete.

**Decision.**
- Every write creates an immutable **revision** (a full snapshot of the JSON envelope; assets are shared by hash). The last 50 per presentation are kept (configurable).
- Writes require `expected_revision` (optimistic concurrency control): if the deck changed, the agent receives `REVISION_CONFLICT` with the current revision.
- **Deleting = moving to trash** for 30 days. Permanent deletion is only done by a human in the panel.
- A **live session pins the revision** it started with: if the agent edits during the talk, the screen does not change until the presenter decides.

**Consequences.** (+) Cheap undo and confidence to delegate. (−) More storage (JSON text, bounded by the revision limit).

---

## ADR-015 · Compiled audience modules with a common contract

**Decision.** Quiz and questions are **modules** that implement the same contract (manifest + pure server-side state reducer + three views: presenter, audience, projector). In v1 they are packages of the repo itself, **compiled into the application**: there is no dynamic loading of third-party plugins.

**Why not dynamic plugins yet:** running third-party code on the server is a security and API-stability problem we cannot take on before having two or three real modules that validate the contract. The contract is designed as if they were external, to open it in v2.

Detail: `02-architecture.md` §8.

---

## ADR-016 · Observability and privacy

**Decision.** JSON logs to standard output (pino) with a request identifier; `/healthz` and `/readyz`; optional Prometheus metrics at `/metrics` protected by a token; an **audit log** in the database (which actor, with which token, did what). **No telemetry to the project by default.** If one is ever added, it will be optional, anonymous and documented.

**Why:** in self-hosted software, trust is part of the product. Auditing is especially valuable when the one acting is an agent.

---

## Deferred decisions (with trigger)

| Topic | Decided when… |
|---|---|
| Task caching (Turborepo) | CI exceeds ~5 min |
| `node:sqlite` instead of `better-sqlite3` | It reaches stability 2 on an LTS |
| SSE *fallback* for real time | There are real reports of blocked WebSocket |
| `npx` channel / single binary | After 1.0, according to demand |
| `interactive` mode (scripts) | After a security review of the isolation and real demand |
| Documentation site (Starlight vs VitePress) | When preparing the public beta |

> Each ADR now also lives as its own file in [`docs/adr/`](../adr/README.md).
