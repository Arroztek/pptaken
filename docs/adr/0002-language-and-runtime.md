# ADR-002 · Language and runtime: TypeScript on Node.js LTS

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
