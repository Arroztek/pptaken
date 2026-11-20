# PPTaken

> **Your agent designs. You present.**

PPTaken is an open-source, self-hosted presentation **player**. An AI agent (such as Claude) creates
decks through [MCP](https://modelcontextprotocol.io); you present them from a URL, using your phone as
a clicker, and engage your audience with live Q&A and quizzes.

PPTaken does not try to be a slide designer. It is the stagehand behind the curtain.

> **Status: early, usable, pre-1.0.** The player, the MCP server, the owner panel, phone remote, offline
> presenting, export/import, PowerPoint import and interactive decks work today. Public share links,
> audience Q&A, quizzes, an `npx` installer and the hosted cloud are not built yet. Documentation:
> https://docs.pptaken.com (coming soon). Roadmap:
> [`docs/foundation/07-roadmap-and-backlog.md`](docs/foundation/07-roadmap-and-backlog.md).

## What works today

- Self-hosted in one container (Docker), SQLite storage; works behind Dokploy, Coolify or Traefik.
- MCP server so Claude (Desktop, web, Code) can create, update, list and delete presentations; sign-in with OAuth.
- Sandboxed player with speaker notes, timer, overview, print and offline presenting.
- Phone remote (QR pairing with approval, laser pointer) that works on a local network.
- Export to a single HTML file or a `.pkn` archive; import of `.pkn` and PowerPoint (`.pptx`).
- Interactive decks (JavaScript) that only run after you allow them, plus fonts and libraries saved from the web.

## Coming next

- Read-only public links and presenter links.
- Audience tools: anonymous Q&A with votes, and a Kahoot-style quiz (draft until the owner approves it).
- `npx` installer and a published Docker image.

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
