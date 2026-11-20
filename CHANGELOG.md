# Changelog

All notable changes to PPTaken are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor releases may contain breaking
changes; they are always listed under "Changed" or "Removed". See [`docs/releasing.md`](docs/releasing.md).

## [Unreleased]

Nothing has been tagged yet. The first release will be 0.1.0 (the version already set in
`apps/server/package.json`); it contains everything built so far: the player, the MCP server, the owner panel, the
phone remote, export/import, PowerPoint import and interactive decks. When you cut it, move these entries under
`## [0.1.0] - <date>`.

### Added

- Published Docker image `ghcr.io/arroztek/pptaken` for `linux/amd64` and `linux/arm64`, built by the release
  workflow on native runners. `docker/compose.yaml` pulls it instead of building from source.
- `docker/compose.build.yaml` override to build the image from a checkout.
- `docker/smoke-test.sh`, the container smoke test used by CI and the release workflow.

### Changed

- The final image keeps only the musl `better-sqlite3` binaries, and its healthcheck follows `PPTAKEN_PORT`.

[Unreleased]: https://github.com/Arroztek/pptaken/commits/main
