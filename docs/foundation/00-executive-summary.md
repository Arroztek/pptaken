# 00 · Executive summary

> PPTaken · foundation documents · 2026-11-12 · Author: CTO. Status: proposal for the founder's validation.

**PPTaken is the stage, not the brush.** An AI agent designs the presentation and hands it over by MCP to your server; PPTaken gives you a URL and takes care of presenting: offline player, notes, phone as clicker, shareable link, questions and quiz. *"Your agent designs. You present."*

## Key decisions

| # | Decision | Why (in one line) | Detail |
|---|---|---|---|
| 1 | **Hybrid format**: JSON envelope (structure, notes, steps) + HTML/CSS/SVG per slide on a fixed 1920×1080 canvas, inside an **isolated iframe** with a no-network CSP. No author JavaScript in v1 | Agents master HTML; security does not rest on a sanitizer alone but on three independent barriers | ADR-001 |
| 2 | **TypeScript end to end on Node.js 26 LTS**, Hono server, a single process | One language for server, player and schemas; reference MCP SDK; the widest community. Go would save ~80 MB but duplicate schemas and raise the barrier | ADR-002, 003 |
| 3 | **SQLite** (WAL) + files on disk, behind interfaces; Postgres/S3 stay for the cloud | Zero administration for self-hosters; backup = copy a folder | ADR-005 |
| 4 | **Stateless Streamable HTTP MCP** at `/mcp`, 12 tools with actionable errors, revisions and trash | It is the current transport (specification 2026-07-28); an agent makes mistakes and you must be able to undo | ADR-008, 014 |
| 5 | **Two ways to authenticate the agent**: API token (Claude Code) and a **built-in OAuth 2.1 server** (claude.ai, Desktop, mobile) | claude.ai only guarantees OAuth and connects from Anthropic's cloud: without this, the target user is left out | ADR-009 |
| 6 | **WebSocket** for real time, with the server as the source of truth for the live session | Bidirectional, efficient for the pointer and the audience; enables the agent to control the presentation in the future | ADR-006 |
| 7 | **Bluetooth between browsers: not viable.** Physical Bluetooth clickers are supported (they are keyboards) and so is "same network, no internet" mode | Web Bluetooth does not exist in Safari/iOS or Firefox, and a browser cannot act as a peripheral | ADR-007 |
| 8 | **Offline in three layers**: in-memory preload (always), *service worker* (with HTTPS) and export to single HTML | The *service worker* does not work on local-network `http://`, exactly the no-internet case | 02 §6 |
| 9 | **Svelte 5 + Vite frontend**, with the player engine in framework-free TypeScript; Next.js is discarded | Light audience pages; Next.js adds complexity a self-hosted product does not need | ADR-004 |
| 10 | **Docker as the only official channel** (multi-architecture image, one volume, Caddy profile for HTTPS) | A single artifact to test and support | ADR-011 |
| 11 | **AGPL-3.0** for the application; **Apache-2.0** for the format and player engine; **license-grant CLA** | Protects the open-core model while staying genuinely open source, and keeps a private cloud option open | ADR-012 |
| 12 | **The cloud consumes the public repo's npm packages; never a fork** | Avoids divergence; extension points are added in public | ADR-013 |
| 13 | **Quiz and questions as modules** with a common contract; approving a quiz is a **human-only** action | Natural ground for contributions; an agent must not be able to publish in front of the audience | ADR-015 |
| 14 | **"Stagehand" brand**: Backstage (warm black), a single amber Spotlight `#FFB224`, violet Curtain; **neutral player, no brand** | PPTaken is who works behind the curtain; the protagonist is the content | 05 |
| 15 | **Delivery in small 0.x versions** (0.1 = MCP + player with Claude Code); 1.0 only stabilizes | Solid base before features; learn by using the product from the first month | 07 |

## Adjustments to the proposed scope

- **Added**: revisions and trash, export to single HTML, presentation export/import, built-in OAuth.
- **Reordered**: anonymous questions before quiz.
- **Clarified**: no Bluetooth; offline cannot depend only on the *service worker*; the "Copy setup prompt" button works literally in Claude Code, whereas in claude.ai the user pastes a URL in Settings (the model cannot add connectors to itself).
- Nothing is removed. If something has to be cut, the first thing to move to 1.1 is the quiz; never the quality of the player.

## The 5 biggest risks

1. **Content isolation** (XSS, or the iframe breaking keyboard/printing/Safari). It is the base of everything. → *Spike* before building, three barriers, attack corpus, external review.
2. **Connecting to claude.ai**: requires public HTTPS and an own OAuth server, and the MCP specification keeps moving. → Start with Claude Code + token; minimal OAuth on the official SDK; MCP isolated in one package.
3. **Large scope for one person.** → Small versions, strict definitions of done, explicit permission to cut.
4. **The agent does not get it right the first time** (overflowing slides, error loops). → Short authoring guide, errors with correction hints, automated evaluations with a real model.
5. **Self-hosting friction for the non-technical user** (needs a server with a domain to use claude.ai). → Honesty in the v1 positioning; this is exactly the gap the cloud will fill.

## What I verified and what I did not (2026-11-12)

**Verified** against official sources or registries: current MCP specification 2026-07-28 and its authorization chapter; Claude custom connector requirements (public HTTPS from Anthropic's cloud, OAuth with CIMD/DCR, return URI, fixed headers in beta, tunnels Enterprise-only); `claude mcp add` syntax in Claude Code; the TypeScript MCP SDK v2 (`@modelcontextprotocol/server` 2.4.0); Node.js 26 as active LTS; `node:sqlite` still at stability 1.2; npm versions of the cited libraries; `pptaken` free on npm; palette contrast (calculated). From the `hallzyx/ppt` repo I read: `README.md`, `server.js`, `Dockerfile` in full and the header and structure of `js/engine.js`, `js/deck.js`, `js/remote.js`, `js/remote-phone.js`.

**Unverified assumptions** (marked in the documents): prebuilt `better-sqlite3` binaries for Node 26 on Alpine arm64; which protocol version each Claude client currently negotiates with SDK v2; whether SDK v2 includes authorization-server utilities; native Argon2 in `node:crypto`; image sizes and memory use (they are targets, not measurements); exact licenses of the proposed fonts (believed OFL); availability of domains, the GitHub organization and the npm *scope*; trademark status of the name. The three phase-0 *spikes* resolve the technical ones.

> Update (2026-11-13): see `docs/spikes/`. `better-sqlite3` works on Node 22/24/26 Alpine amd64 (arm64 untested). With SDK 2.4.0 the `initialize` handshake negotiated at most `2025-11-25`, so the claim about spec 2026-07-28 support is **not confirmed**.

## Open questions for the founder

Answered on 2026-11-12, see [`08-founder-decisions.md`](08-founder-decisions.md).

| # | Question | Default recommendation |
|---|---|---|
| 1 | **License and contributions**: do you want to keep the option of private cloud code in the same process as the core and of selling commercial licenses? | Yes → **AGPL-3.0 + license-grant CLA**, with a public commitment to keep an OSI license. If you prefer maximum community trust and accept those limits → AGPL + DCO |
| 2 | **Name**: "PPT" evokes PowerPoint. Do we run a trademark search (and a brief legal consultation) before investing in identity? | Yes, before the first public announcement. Keep the name unless the search finds a conflict |
| 3 | **Organization and domain**: do we create the `pptaken` organization on GitHub (instead of `hallzyx/pptaken`) and reserve domain and npm *scope* now? | Yes, this week. It is cheap and hard to fix later |
| 4 | **Can the agent create public links on its own?** | Not by default (optional `share:write` scope when creating the token). The owner creates them in one click from the panel |
| 5 | **Project language**: code, issues and main documentation in English, with Spanish as a first-class translation? | Yes. Bilingual es/en interface from day 1 |
| 6 | **Scripts in slides** (interactive demos): do you accept that v1.0 ships without author JavaScript? | Yes. The isolation is ready; it is enabled in 1.x after a security review |
| 7 | **Do you have (or can you hire) a small VPS with a domain** to test the claude.ai connector from phase 0? | Yes, it is necessary: claude.ai cannot reach `localhost`. A few dollars a month |
| 8 | **Availability**: how many hours per week will you dedicate? | The roadmap estimates 23–31 *focused* weeks; with part-time dedication, multiply. Use this to decide whether the public beta is at 6 or 12 months |
| 9 | **Telemetry**: do you accept collecting no usage data from self-hosted instances? | Yes. No telemetry by default; measure adoption by image downloads and stars |
| 10 | **Mascot**: do you want one? | Not in v1. If later: "Cue", a small theatre spotlight (avoid frogs and the name "Pepe") |

## Index

| Document | Content |
|---|---|
| `01-product-and-scope.md` | Actors, use cases, stories, adjusted v1 scope, onboarding |
| `02-architecture.md` | Components, monorepo, data model, MCP contract, player, real time, modules, ports for the cloud |
| `03-stack-and-adrs.md` | 16 ADRs with alternatives and consequences |
| `04-security-and-auth.md` | Authentication, isolation, threat model, supply chain, disclosure |
| `05-visual-identity.md` | Concept, voice, color, typography, tokens, neutral-player rule |
| `06-open-source-guide.md` | The masterclass: files, versioning, CI/CD, community, brand, launch checklist |
| `07-roadmap-and-backlog.md` | Phases, definitions of done, risks, epics and first tasks |
| `08-founder-decisions.md` | The founder's answers to the open questions |
