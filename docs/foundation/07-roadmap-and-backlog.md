# 07 · Roadmap and backlog

> Philosophy: **a solid base before many features**. The whole agreed v1 scope is kept, but delivered in **small, public 0.x versions**, each usable on its own. 1.0 adds no features: it declares the contracts stable.
>
> Durations are **estimates in weeks of focused work** (one person with a coding assistant), not dates. They depend on the founder's availability. Use them to compare sizes, not to promise.

## 1. Map

```
F0 Foundations ─► F1 Format & player ─► F2 MCP ─► F3 Present well ─► F4 Remote ─► F5 Share & claude.ai ─► F6 Audience ─► F7 Harden ─► 1.0
   (internal)        (internal)         0.1 alpha     0.2               0.3            0.4                  0.5 / 0.6      0.9 beta, rc
```

| Phase | Version | Visible result | Estimate |
|---|---|---|---|
| F0 | — | Repo, CI, skeleton, three risk *spikes* resolved | 1–2 wk |
| F1 | — | A deck JSON is shown and navigated in the browser, isolated | 3–4 wk |
| F2 | **0.1** | "I ask Claude Code for a presentation and get a URL" | 3–4 wk |
| F3 | **0.2** | Notes, clock, overview, guaranteed offline, export to HTML | 2–3 wk |
| F4 | **0.3** | Phone as clicker with laser pointer | 2–3 wk |
| F5 | **0.4** | Public link; claude.ai connector (OAuth); full panel | 4–5 wk |
| F6 | **0.5 / 0.6** | Anonymous questions (0.5) and quiz (0.6) | 5–6 wk |
| F7 | **0.9 → 1.0** | Reviewed security, documentation, stability | 3–4 wk |

Indicative total: 23–31 focused weeks.

**Why this order**
1. First the riskiest technical item that everything depends on: the **format** and its isolation (F1).
2. Then the **differentiator**: MCP (F2). With Claude Code and a token, the short path. From here on the founder uses the product daily (*dogfooding*).
3. OAuth for claude.ai goes in F5 and not earlier: it is costly and delicate, and does not block learning from the product. But it goes **before 1.0** because the target user is there.
4. Questions before quiz: simpler, and it validates the module contract before building the most complex one.

## 2. Phases, definition of done and risks

### F0 · Foundations

Deliverables: pnpm monorepo, Biome, Vitest, Playwright; green CI; a Dockerfile that starts a "hello"; license and minimal community files; ADRs in `docs/adr/`.

**Three *spikes*** (short, disposable experiments to kill uncertainty before building):
- **S1 · Isolation**: sandboxed iframe + CSP + `postMessage` + keyboard + offline preload, in Chrome, Firefox and Safari (incl. iOS). Does focus work? Do assets load with an opaque origin? Can it be printed?
- **S2 · Real MCP**: minimal server with SDK v2 and one tool, connected from Claude Code (token) and from claude.ai (no auth, via a temporary tunnel). Which protocol version does each client negotiate?
- **S3 · Packaging**: `better-sqlite3` on `node:26-alpine` for amd64 and arm64. Measure image size and idle RAM.

Done when: the three spikes have a result note in `docs/spikes/` and, if any contradicts an ADR, the ADR is updated.

### F1 · Format and minimal player

Deliverables: `@pptaken/schema` (format v1 + JSON Schema), `@pptaken/sanitizer` with corpus, `@pptaken/player` (navigation, steps, scaling), `/c/` route with CSP, minimal viewer, three example presentations written by hand in the format.

Done when:
- [ ] A 20-slide example deck with steps, SVG and images navigates by keyboard at 60 fps.
- [ ] The XSS corpus (≥ 150 vectors) executes nothing, **with and without** the sanitizer active.
- [ ] The JSON Schema is generated at build time and validates the three examples.
- [ ] A real block of the `ppt` presentation is ported to the new format and what could not be expressed is documented.

### F2 · MCP and first onboarding → **0.1 (alpha)**

Deliverables: core (presentations, revisions, trash, assets), `storage-sqlite`, `blob-fs`, API tokens, MCP tools 1–10, install with code, welcome page with the Claude Code tab, published Docker image.

Done when:
- [ ] On a clean machine: one command → welcome → copy prompt → Claude Code configures itself → "create a presentation about X" → working URL. **Without touching documentation.**
- [ ] Agent evaluation: in 10 different assignments, ≥ 8 finish without tool errors left uncorrected.
- [ ] `get_authoring_guide` < 2,500 tokens; typical tool response < 2,000.
- [ ] Editing a slide does not resend the whole deck.
- [ ] Image < 150 MB compressed and idle RAM < 120 MB (or ADR updated with the real values).

### F3 · Present well → **0.2**

Deliverables: presenter view (notes, next, clock with target and pace per section), overview, full screen, black screen, HID clicker support, state in URL, print/PDF mode, **offline preload with indicator**, *service worker*, **export to single HTML**, `.pptaken` export/import.

Done when:
- [ ] Automated test: open, wait for "ready offline", cut the network, go through all slides and steps, open notes and overview.
- [ ] The exported HTML opens with a double click on Windows and macOS without a server.
- [ ] The founder gives a real talk with it.

### F4 · Remote control → **0.3**

Deliverables: `@pptaken/realtime` (protocol + hub), live sessions, QR pairing, remote (next/previous, clock, laser pointer), reconnection, rate limits, "no internet" recipe.

Done when:
- [ ] Pair in < 10 s; latency < 150 ms on a local network.
- [ ] Switching the phone's WiFi off and on: reconnects by itself in < 5 s and shows the right state.
- [ ] A used QR does not work; a second device asks for approval.
- [ ] Tested on iPhone (Safari) and Android (Chrome).
- [ ] Works with the server on the laptop and the phone on its *hotspot*, without internet.

### F5 · Sharing, claude.ai and panel → **0.4**

Deliverables: public links (create, expire, revoke, pinned revision), MCP tools 11–12 and scopes, **OAuth 2.1 server** (CIMD + DCR, PKCE, rotation), claude.ai tab in the welcome page, full panel (presentations, revisions and restore, trash, tokens, connected applications, audit), `https` profile with Caddy, `backup`/`restore`.

Done when:
- [ ] Connector added from claude.ai (web), Claude Desktop and the mobile app against an instance with a domain; full consent and token renewal flow.
- [ ] The same server keeps working with Claude Code by token and by OAuth.
- [ ] A revoked link stops working instantly; notes do not appear in any `/v/` response.
- [ ] Restoring a backup on a new instance recovers everything.

### F6 · Audience → **0.5** (questions) and **0.6** (quiz)

Deliverables: `audience-kit` (contract, ephemeral identity, limits), audience page, `module-qa`, `module-quiz` with draft→approval flow, projector views, results export.

Done when:
- [ ] 300 simulated connections on 1 vCPU without losing messages; audience page < 60 KB compressed.
- [ ] A quiz created through MCP cannot be launched without human approval (automated test that tries it with a token).
- [ ] The correct answer appears in no message to the audience before closing (automated test).
- [ ] Real session with ≥ 20 people.
- [ ] A toy module ("applause") written by someone else using only the contract documentation, in under a day.

### F7 · Harden → **0.9 beta → 1.0**

Deliverables: the security checklist of `04` §11 complete, external review, documentation site (es/en), AA accessibility, upgrade test from 0.4+, migration guide, contract freeze.

Done when:
- [ ] Four weeks in beta with no open critical bugs.
- [ ] Contracts (format, MCP, configuration) declared stable and documented.
- [ ] Release checklist of `06` §13 complete.

## 3. After 1.0

**v1.1 — "Comfort"**
- Slide mirror on the phone (the remote renders the same document).
- Lock-screen controls and Bluetooth headset buttons (MediaSession, Android).
- stdio bridge and `.mcpb` desktop extension for instances on a private network.
- Delegated presenter link (a third party presents with notes, without being the owner).
- Passkeys for the owner.
- Experimental `npx` channel.
- A third simple audience module (reactions or poll) to test the contract.

**v1.x — "Interactivity"**
- `interactive` mode (isolated scripts), after a security review.
- User-uploaded fonts. Reusable themes.

**v2 — "Live and open"**
- **The agent controls the presentation live** (`control_presentation`, scope `live:control`).
- Third-party audience modules (public contract and isolation).
- Multiple users and roles in one instance.
- Postgres adapter in the public repo.
- Optional WebRTC for the remote.

**Cloud** (repo `pptaken-cloud`; starts once 1.0 is stable and there are signs of demand)
- C0: a single instance managed by the founder for a waiting list (validate willingness to pay with minimal code).
- C1: multi-tenant: `storage-postgres`, `blob-s3`, `auth-oidc`, per-user URL, per-plan limits.
- C2: billing, plans, account panel.
- C3: teams, custom domains, SSO, session analytics.

## 4. Main risks

| # | Risk | Prob. | Impact | Mitigation | Warning sign |
|---|---|---|---|---|---|
| R1 | **Content isolation has a hole** (XSS) or breaks the experience (focus, printing, Safari) | Medium | Critical | Spike S1 before anything; three barriers; corpus; external review | A corpus vector runs code; erratic keyboard in Safari |
| R2 | **Connecting to claude.ai is harder than expected** (own OAuth, public HTTPS, MCP specification changes: revision 2026-07-28 removed sessions and the handshake, and deprecated DCR) | High | High | Token + Claude Code first; spike S2; minimal OAuth; follow the official SDK instead of implementing the protocol; isolate MCP in one package | The connector fails in a client after an update |
| R3 | **Scope too large for one person** → burnout or a mediocre base | High | High | Small 0.x versions; strict definitions of done; explicit permission to cut (the quiz falls to 1.1 first, never the quality of the player) | Two consecutive phases take double the estimate |
| R4 | **The agent does not get it right the first time** (HTML overflowing the canvas, ugly slides, error loops) | Medium | High | Short authoring guide with an example; errors with `hint`; automated evaluations; iterate the contract during 0.x | Evaluation success rate < 80 % |
| R5 | **Self-hosting friction for the target user** (executive with no server or domain) → low adoption outside technical profiles | High | Medium | Be honest in positioning: v1 is for technical people or people with technical help; tunnel recipe; the cloud as the answer | Non-technical testers do not get past installation |
| R6 | Brand: conflict over "PPT" | Low–medium | High if late | Prior-art search before investing in identity | — |
| R7 | npm supply chain | Low | High | Controls from `04` §9 | Compromised dependency alert |
| R8 | The presentation fails live (the worst possible moment) | Medium | High (reputation) | Preload + HTML export + status indicator; the founder presents with it from 0.2 | Any failure in a real talk is treated as a critical bug |

## 5. Initial backlog by epics

Priority: **P0** essential for the indicated version · **P1** important · **P2** if time allows.

### E0 · Repository foundations (F0)
1. P0 · Create pnpm monorepo with `apps/server`, `apps/web`, `packages/schema`; strict TypeScript.
2. P0 · Biome + Vitest + Playwright with one trivial test of each kind.
3. P0 · `ci.yml`: install, lint, types, tests, build.
4. P0 · `LICENSE`, minimal `README` ("under construction"), `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`.
5. P0 · Move the ADRs to `docs/adr/` (one per file).
6. P0 · Spike S1 (isolation).
7. P0 · Spike S2 (MCP with real clients).
8. P0 · Spike S3 (Docker image, SQLite, measurements).
9. P1 · Lint rule for package boundaries.
10. P1 · Renovate, CodeQL, secret scanning, `main` protection.

### E1 · `pptaken.deck` format and sanitizer (F1)
1. P0 · Zod v1 schema of the envelope and slides; limits.
2. P0 · JSON Schema generation at build time.
3. P0 · HTML sanitizer (allowlist of tags and attributes).
4. P0 · CSS sanitizer (properties, `url()`, `@import`).
5. P0 · SVG sanitizer (inline and as asset).
6. P0 · XSS corpus + "legitimate content intact" tests.
7. P0 · `asset:<id>` resolution.
8. P1 · Markdown notes → minimal sanitized HTML conversion.
9. P1 · Three example decks; one ported from `ppt`.
10. P2 · Schema version migrator (structure, no real migrations yet).

### E2 · Player engine (F1, F3)
1. P0 · Iframe runtime: build sections, scale and *letterbox*.
2. P0 · Steps (`data-step`), navigation and `goto`.
3. P0 · Validated `postMessage` protocol; key forwarding.
4. P0 · `/c/` route with CSP headers and content token.
5. P0 · Shell: keyboard, full screen, state in URL.
6. P0 · Asset preload + "ready offline" indicator.
7. P1 · Presenter view (notes, next, clock, pace).
8. P1 · Overview.
9. P1 · HID clicker keys and black screen.
10. P1 · Print / PDF mode.
11. P1 · *Service worker* with per-revision cache.
12. P1 · Export to single HTML.
13. P2 · Touch gestures; reduced-motion preference.

### E3 · Core and storage (F2)
1. P0 · Ports (`DeckRepository`, `RevisionRepository`, `BlobStore`, `Clock`, `IdGenerator`).
2. P0 · Use cases: create, read, list, update, delete (trash), restore.
3. P0 · Revisions and optimistic concurrency.
4. P0 · `storage-sqlite`: migrations and repositories.
5. P0 · `blob-fs` with hash addressing.
6. P0 · Repository contract test suite.
7. P1 · Asset upload: signature verification, limits.
8. P1 · Download by URL with SSRF protection.
9. P1 · Audit log.
10. P1 · Orphan blob collector and trash purge.
11. P2 · `.pptaken` export/import.

### E4 · MCP server (F2, F5)
1. P0 · Mount `/mcp` (stateless Streamable HTTP) with SDK v2.
2. P0 · `whoami`, `get_authoring_guide`.
3. P0 · `create_presentation`, `get_presentation`, `list_presentations`.
4. P0 · `update_presentation`, `update_slides`, `delete_presentation`.
5. P0 · Common error format with `hint`; sanitizer `warnings`.
6. P0 · `tools/list` snapshot and contract tests.
7. P1 · `add_asset`, `get_presentation_links`.
8. P1 · Evaluation script with a real agent.
9. P1 · `create_share_link`, `save_quiz_draft` (F5/F6).
10. P2 · Reserve `control_presentation` (documented, not implemented).

### E5 · Authentication and onboarding (F2, F5)
1. P0 · Install code and owner creation.
2. P0 · Sessions, CSRF, attempt limits.
3. P0 · API tokens with scopes (create, list, revoke).
4. P0 · Welcome page: Claude Code tab with prompt and "waiting for first call".
5. P1 · Protected-resource metadata and compliant `401`.
6. P1 · Authorization server: `authorize`, consent, `token`, PKCE, `iss`.
7. P1 · CIMD (with SSRF protection) and DCR.
8. P1 · Refresh tokens with rotation; "connected applications".
9. P1 · claude.ai tab in the welcome page, with public HTTPS detection.
10. P2 · `reset-password` via CLI.

### E6 · Real time and remote control (F4)
1. P0 · Message protocol and schemas.
2. P0 · In-memory `RealtimeHub` + WebSocket.
3. P0 · Live session with server-side state.
4. P0 · One-time QR pairing (local QR generation).
5. P0 · Remote interface: next/previous, status, clock.
6. P0 · Reconnection and resync.
7. P1 · Laser pointer.
8. P1 · Second-device approval; kick remotes.
9. P1 · Per-connection rate limits.
10. P2 · Vibration, landscape mode, keep screen on (*Wake Lock*).

### E7 · Sharing and panel (F5)
1. P0 · Public links: create, expire, revoke.
2. P0 · Read-only viewer `/v/` without notes.
3. P0 · Panel: presentation list and detail.
4. P1 · Revisions: view and restore; trash.
5. P1 · Tokens, connected applications and audit panel.
6. P1 · `backup` / `restore`.
7. P1 · `https` profile with Caddy and guide.
8. P2 · Pinned revision on links; access counter.

### E8 · Audience (F6)
1. P0 · `audience-kit` contract and module lifecycle.
2. P0 · Audience code, QR and entry page.
3. P0 · Signed ephemeral identity and per-participant/IP limits.
4. P0 · `module-qa`: submit, vote, list.
5. P0 · `module-qa`: moderation and projector view.
6. P0 · `module-quiz`: model, draft, human-only approval.
7. P0 · `module-quiz`: execution, server-side scoring, ranking.
8. P1 · Quiz review panel (edit, approve, deck-changed warning).
9. P1 · Nicknames and moderation; results export.
10. P1 · 300-connection load test.
11. P2 · Example toy module + "write your module" guide.

### E9 · Identity and interface (cross-cutting)
1. P0 · `packages/ui`: tokens and CSS variables; local fonts.
2. P1 · Base components.
3. P1 · Final logo and favicon.
4. P1 · es/en internationalization.
5. P2 · Accessibility audit.

### E10 · Distribution, documentation and launch (cross-cutting, F7)
1. P0 · Multi-stage Dockerfile, non-root, *healthcheck*; `compose.yaml`.
2. P0 · `release.yml`: Changesets, npm, multi-architecture image.
3. P1 · Signatures, SBOM, image scanning.
4. P1 · Documentation site with a 10-minute tutorial.
5. P1 · MCP and format reference generated from code.
6. P1 · Demo GIF/video.
7. P1 · External security review.
8. P2 · Listing in MCP server directories.

## 6. First ten tasks (in order)

1. Answer open questions 1–3 of the executive summary (license/CLA, name, organization).
2. Reserve the GitHub organization, npm *scope* and domain.
3. E0.1–E0.4: monorepo, tooling, CI, minimal files.
4. E0.6: isolation *spike* (the one that can change the most).
5. E0.7: MCP *spike* with Claude Code and claude.ai.
6. E0.8: Docker image *spike*.
7. Update ADRs with what was learned.
8. E1.1–E1.2: format schema.
9. E1.3–E1.6: sanitizer with corpus.
10. E2.1–E2.5: minimal player showing an example deck.
