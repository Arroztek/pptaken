# ADR-011 · Packaging and distribution

**Decision.**
- **Single official channel in v1: Docker image** `ghcr.io/<org>/pptaken`, multi-architecture (`linux/amd64`, `linux/arm64`, for VPS and Raspberry Pi), tags `1.2.3`, `1.2`, `1` and `latest`.
- Base `node:26-alpine` in a multi-stage build; non-root user; read-only filesystem except `/data`; `HEALTHCHECK`.
- A `compose.yaml` is shipped with two profiles: basic (HTTP on port 8080) and `https` (adds **Caddy** with automatic certificates given a domain).
- All state in **one volume** `/data`: `pptaken.db`, `blobs/`, `secret.key`.
- Configuration through environment variables with sensible defaults; zero mandatory configuration.

**Alternatives.**
- **`npx pptaken`**: attractive for developers, but it requires Node installed and SQLite's native module complicates Windows support. Evaluated for v1.1 as an "experimental" channel.
- **Single binary** (Node SEA, `bun build --compile`): removes Docker for the end user, but is today incompatible with our native module without tricks. Re-evaluated when `node:sqlite` is stable.
- **Native installers / desktop app**: out of scope.

**Consequences.** (+) A single artifact to test and support. (−) It requires Docker; for the non-technical user that is already friction, and it is part of the cloud's argument.
