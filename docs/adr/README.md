# Architecture Decision Records (ADR)

An **ADR** (*Architecture Decision Record*) is a short note that records **what was decided, why, and what was discarded**. It exists so that a year from now nobody (not even you) has to guess. When a decision changes, the ADR is not deleted: a new one is written that replaces it. Each ADR lives in its own file in this folder.

| Number | Title | Status |
|---|---|---|
| 0001 | [Content format: JSON envelope + isolated HTML canvas](0001-content-format.md) | accepted |
| 0002 | [Language and runtime: TypeScript on Node.js LTS](0002-language-and-runtime.md) | accepted |
| 0003 | [HTTP server: Hono; Next.js is discarded](0003-http-server-hono.md) | accepted |
| 0004 | [Frontend: Svelte 5 + multi-page Vite; framework-free player engine](0004-frontend-svelte.md) | accepted |
| 0005 | [Database: SQLite when self-hosted, Postgres in the cloud, behind ports](0005-database-sqlite-postgres.md) | accepted |
| 0006 | [Real time: WebSocket with an in-memory hub](0006-real-time-websocket.md) | accepted, amended by 0017 |
| 0007 | [Bluetooth: not between browsers; yes for physical clickers](0007-bluetooth.md) | accepted |
| 0008 | [MCP: stateless Streamable HTTP, in the same process](0008-mcp-streamable-http.md) | accepted |
| 0009 | [Agent authentication: API token + built-in OAuth 2.1 server](0009-agent-authentication.md) | accepted, amended by 0018 |
| 0010 | [Monorepo and tooling](0010-monorepo-and-tooling.md) | accepted |
| 0011 | [Packaging and distribution](0011-packaging-and-distribution.md) | accepted |
| 0012 | [License: AGPL-3.0 for the application, Apache-2.0 for the format and client libraries; license-grant CLA](0012-license.md) | accepted |
| 0013 | [Relationship between `pptaken` (public) and `pptaken-cloud` (private)](0013-pptaken-and-pptaken-cloud.md) | accepted |
| 0014 | [Immutable revisions and soft delete](0014-immutable-revisions-soft-delete.md) | accepted |
| 0015 | [Compiled audience modules with a common contract](0015-compiled-audience-modules.md) | accepted |
| 0016 | [Observability and privacy](0016-observability-and-privacy.md) | accepted |
| 0017 | [Remote control: authoritative screen, first-frame auth, approved pairing](0017-remote-control.md) | accepted |
| 0018 | [Built-in OAuth authorization server for `/mcp`](0018-oauth-authorization-server.md) | accepted |
| 0019 | [PowerPoint import](0019-powerpoint-import.md) | accepted |
| 0020 | [Interactive mode (author scripts)](0020-interactive-mode.md) | accepted (foundation phase), completed by 0021 |
| 0021 | [Presenter password and approval screen](0021-presenter-password-and-approval-screen.md) | accepted |
| 0022 | [Ingest-time vendoring and the HTML-artifact importer](0022-vendoring-and-html-importer.md) | accepted |
