# PPTaken

> **Your agent designs. You present.**

PPTaken is an open-source, self-hosted presentation **player**. An AI agent (such as Claude) creates
decks through [MCP](https://modelcontextprotocol.io); you present them from a URL, using your phone as
a clicker, and engage your audience with live Q&A and quizzes.

PPTaken does not try to be a slide designer. It is the stagehand behind the curtain.

> **Status: under construction (phase 0).** Nothing is usable yet. Follow the roadmap in
> [`docs/foundation/07-roadmap-and-backlog.md`](docs/foundation/07-roadmap-and-backlog.md).

## Planned for v1

- Self-hosted in one container; SQLite storage behind swappable interfaces.
- MCP server so agents can create, update, list and delete presentations.
- Player with speaker notes, timer, overview and an offline mode.
- Phone remote (QR pairing, laser pointer) that works on a local network without internet.
- Read-only public links.
- Audience tools: anonymous Q&A with votes, and a Kahoot-style quiz (draft until the owner approves it).

A hosted cloud service is planned for people who do not want to self-host. The open-source core stays
open: see [`docs/foundation/06-open-source-guide.md`](docs/foundation/06-open-source-guide.md).

## Development

Requirements: Node.js 22+ and [pnpm](https://pnpm.io) 10.

```bash
pnpm install
pnpm check       # lint + typecheck + tests + build
pnpm --filter @pptaken/server dev
```

## Repository layout

| Path              | Purpose                                 |
| ----------------- | --------------------------------------- |
| `apps/server`     | HTTP server composition (Hono)          |
| `apps/web`        | Web interface (Svelte, upcoming)        |
| `packages/schema` | Deck format (Apache-2.0)                |
| `packages/ui`     | Design tokens and components            |
| `docs/foundation` | Foundational design documents |
| `docs/adr`        | Architecture decision records           |

## License

The application is licensed under **AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)). The deck format and
player engine packages are **Apache-2.0** (each carries its own `LICENSE`).
