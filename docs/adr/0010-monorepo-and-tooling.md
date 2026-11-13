# ADR-010 · Monorepo and tooling

**Decision.** A monorepo with **pnpm workspaces**: `apps/` (what gets deployed) and `packages/` (what is reusable). Versioning and publishing with **Changesets**. Lint and formatting with **Biome**. Tests with **Vitest** (unit and contract) and **Playwright** (end to end). No Turborepo/Nx at the start: `pnpm -r` is enough; task caching is added when CI exceeds ~5 minutes.

**Why a monorepo:** a schema change touches server, player and MCP at once; in one repo that is one PR, one review and one CI. **Why Biome and not ESLint+Prettier:** one tool, one configuration, much faster; less friction for first-time contributors.

Detailed structure: `02-architecture.md` §3.
