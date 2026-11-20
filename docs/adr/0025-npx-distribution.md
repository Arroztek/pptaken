# ADR-025 · npx distribution: one bundled npm package `pptaken`

**Status:** accepted (2026-11-19). Amends [ADR-011](0011-packaging-and-distribution.md) (Docker stays the official
server channel; `npx pptaken` becomes the second, local one). Related: [ADR-002](0002-language-and-runtime.md),
[ADR-005](0005-database-sqlite-postgres.md), [ADR-010](0010-monorepo-and-tooling.md), [ADR-012](0012-license.md),
[ADR-018](0018-oauth-authorization-server.md), [npx guide](../guides/npx.md), [releasing](../releasing.md).

## Context

Docker is the right way to run PPTaken on a server, but it is a wall for the people PPTaken is for when they only want
to try it on their own computer (a teacher, an executive with Claude Code). ADR-011 listed `npx pptaken` as a later,
experimental channel because of SQLite's native module. Since then better-sqlite3 13 ships prebuilt binaries for
Windows, macOS and Linux (glibc and musl), x64 and arm64, **inside its npm package** with no install script, so a
plain `npm install` needs no compiler. The monorepo has ~15 private workspace packages plus `apps/server`; users must
receive one package, not fifteen.

## Decision

### 1. One package, bundled

- A new workspace package `packages/pptaken` (name **`pptaken`**, unscoped, the only package ever published) builds the
  artifact with **esbuild** (pinned exactly; already in the lockfile through Vite and tsx, so no new third-party code):
  `dist/app/cli.js` (CLI + server + every `@pptaken/*` package + their npm dependencies, one readable, unminified ESM
  file) and `dist/app/worker.js` (the PowerPoint import worker, which `@pptaken/import-pptx` starts as `./worker.js`).
- **`better-sqlite3` is the only runtime dependency**, kept external because it is a native addon, pinned exactly to the
  version `@pptaken/storage-sqlite` uses (the build refuses a mismatch). Everything else is bundled. ws's optional
  native helpers (`bufferutil`, `utf-8-validate`) stay external and absent: ws falls back to JavaScript.
- Runtime files ship inside the package and are found **relative to the bundle**, never through the monorepo layout,
  `process.cwd()` or Docker's environment variables: `dist/web` (built web app), `dist/fonts`, `dist/migrations`,
  `dist/player`, `dist/realtime`, `dist/qr/qr.js`. The seam is one small module, `apps/server/src/runtime-paths.ts`,
  which the bundler swaps for `packages/pptaken/src/runtime-paths.ts`. Docker and source checkouts are unchanged.
- The server gained an embeddable start-up (`apps/server/src/start.ts`: build, listen, return a handle whose `close()`
  stops sockets and closes the database); `main.ts` (Docker) and the npx CLI both use it.
- `files` is an allowlist (`bin/pptaken.cjs`, `dist/`, the licence files, the notices, `npm-shrinkwrap.json`); a test
  runs `npm pack --dry-run` and fails on sources, tests, maps, screenshots, `.env` files or a size above 15 MB.
- A generated **`npm-shrinkwrap.json`** (from `pnpm-lock.yaml`, no network) pins the installed tree, better-sqlite3
  and node-addon-api, to the exact tested versions and SHA-512 hashes. npm honours a published shrinkwrap for
  dependencies and npx, so nothing in the tree floats to a newer (possibly compromised) release on the user's machine.
- Licences: `LICENSE` (AGPL-3.0-or-later), `LICENSE-APACHE-2.0.txt` (schema, player, realtime) and a generated
  `THIRD-PARTY-NOTICES.md` built from esbuild's metafile (what was really bundled) plus the code the web app inlines
  (Svelte runtime, Vite's preload helper), shipped files (QR encoder, fonts under OFL-1.1), vendored code (uPlot) and
  better-sqlite3. The build **stops** on a licence outside an explicit allowlist, a missing licence, or a package
  with no licence text (a reviewed override exists only for an exact `name@version`).

### 2. Safe local defaults

- Listens on **127.0.0.1** (Docker keeps 0.0.0.0 inside its network namespace). `--host 0.0.0.0` prints a warning that
  the network can reach it over plain HTTP.
- Data in the per-user application data folder, not the current directory (npx runs from anywhere): Windows
  `%LOCALAPPDATA%\PPTaken` (local, not roaming), macOS `~/Library/Application Support/PPTaken`, Linux
  `$XDG_DATA_HOME/pptaken` or `~/.local/share/pptaken`. Implemented without a dependency; printed at start.
- `PPTAKEN_PUBLIC_URL` defaults to `http://localhost:<port>` on loopback (so OAuth works for local clients); exposed
  without `--public-url` it stays unset and the address is derived per request.
- Port 8080, moving to the next free port when 8080 is busy, but never when the person chose the port. A lock file
  refuses a second instance on the same data folder. Quiet logs (`warn`) in a human format on stderr; `--json-logs`
  for collectors.
- Friendly messages and documented exit codes for the common failures (port busy, data folder, invalid option, Node.js
  too old, SQLite binary missing). The Node.js check lives in a tiny CommonJS shim written in old syntax, so Node 16 or
  18 prints a sentence instead of a syntax error.
- Clean stop on Ctrl+C / SIGTERM / SIGHUP (and an IPC message, the portable path on Windows): sockets closed, database
  closed so SQLite merges its WAL. A second Ctrl+C forces the exit.
- The banner says plainly that Claude Desktop and claude.ai cannot reach `http://localhost` and need a public HTTPS
  address, while Claude Code works locally with an access key.

### 3. Publishing: trusted publishing and provenance

- The first version is published **by hand** by the maintainer (npm needs the package to exist before a trusted
  publisher can be attached to it). After that, the release workflow publishes on the same `vX.Y.Z` tags as the image,
  from a **separate job** with `contents: read` and `id-token: write` only, using **npm trusted publishing (OIDC)**: no
  npm token is stored in GitHub. Versions published by the workflow carry an npm **provenance** statement (`publishConfig.provenance`); version 0.1.0, published by hand, does not.
- The job publishes the exact tarball that passed the installed-copy test (checked by SHA-256), checks that the tag
  equals the package version, never runs on dry runs or forks, runs only after the image is published, skips with a
  notice while the package does not exist, and uses the `next` dist-tag for pre-releases.
- The package has **no install scripts**; neither has its dependency tree (checked by the end-to-end test).

### 4. Why not publish the workspace packages

They are internal seams (ports and adapters), not APIs: publishing them would freeze their interfaces, multiply the
supply-chain surface (fifteen names to own, protect and keep in sync), and make `npx` resolve a tree of our own
packages at install time. One bundled package is one thing to audit, sign and test. The Apache-2.0 format and player
packages may be published separately later if a real consumer appears (ADR-012); that is a separate decision.

### 5. Versioning and updates

- `pptaken` carries the product version (`scripts/bump-version.mjs` updates it with the root and `apps/server`), so
  `npx pptaken@0.2.0` is exactly image `0.2.0`. Same SemVer rules as the image (docs/releasing.md).
- Update story: `npx pptaken@latest` (npx may reuse a cached older copy for a bare `npx pptaken`). Migrations run
  forward at start with a backup copy, as in Docker. Data folders are compatible between the npm and Docker channels
  (same database and blob layout), so moving to Docker later is copying the folder.

## Consequences

- (+) One command for people without Docker; one artifact to audit; no compiler on the supported platforms.
- (+) The Docker image is untouched; the server change is a small seam plus a reusable start-up.
- (−) better-sqlite3 installs all eight platform binaries (about 17 MB) and the SQLite source (about 10 MB): npm cannot
  pick one per platform for this package layout. Our own package is about 6 MB unpacked.
- (−) Node.js 22 or newer is required on the user's machine. Other platforms (32-bit ARM, FreeBSD, …) need a manual
  build of better-sqlite3 or Docker.
- (−) The bundle duplicates some code between the CLI and the worker (about 1 MB); acceptable for clarity.

## Not done yet

- A Windows service / macOS launch agent / systemd unit for auto-start; today PPTaken runs while the terminal is open.
- Auto-update (today: `npx pptaken@latest`, or a notice in the panel when a newer version exists).
- A tunnel helper for a public HTTPS address (so Claude Desktop / claude.ai can connect without a server).
- Signed standalone binaries (Node SEA) once `node:sqlite` can replace the native addon.
