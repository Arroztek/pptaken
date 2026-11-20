# Changelog

All notable changes to PPTaken are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor releases may contain breaking
changes; they are always listed under "Changed" or "Removed". See [`docs/releasing.md`](docs/releasing.md).

## [Unreleased]

## [0.1.0] - 2026-11-19

First release: the player, the MCP server, the owner panel, the phone remote, offline presenting, export and
import (including PowerPoint), interactive decks, the published Docker image and `npx pptaken`.

### Added

- Published Docker image `ghcr.io/arroztek/pptaken` for `linux/amd64` and `linux/arm64`, built by the release
  workflow on native runners. `docker/compose.yaml` pulls it instead of building from source.
- `docker/compose.build.yaml` override to build the image from a checkout.
- `docker/smoke-test.sh`, the container smoke test used by CI and the release workflow.
- `npx pptaken`: the npm package `pptaken` runs PPTaken locally without Docker (Node.js 22+, Windows, macOS, Linux;
  no compiler needed). One bundled package with `better-sqlite3` as its only dependency; safe local defaults
  (listens on 127.0.0.1, per-user data folder), a friendly start-up block with the install code and the Claude
  connection notes, `--port`/`--host`/`--data-dir`/`--public-url`/`--scripts`/`--admin-password-file`/`--open`/
  `--log-level`/`--json-logs`, the `backup` and `reset-password` commands, documented exit codes, and a clean stop on
  Ctrl+C. See `docs/guides/npx.md` and ADR-025.
- The release workflow tests the npm tarball as an installed copy and publishes it with npm trusted publishing and
  provenance; `npm-package.yml` runs the same installed-copy test on Linux, Windows and macOS with Node.js 22 and 24.

### Changed

- The final image keeps only the musl `better-sqlite3` binaries, and its healthcheck follows `PPTAKEN_PORT`.
- The server's start-up is reusable (`apps/server/src/start.ts`); a busy port now ends with a one-line error instead
  of an uncaught exception. Runtime file locations live in one module (`runtime-paths.ts`).
- `scripts/bump-version.mjs` also sets the version of `packages/pptaken`.

[Unreleased]: https://github.com/Arroztek/pptaken/commits/main
