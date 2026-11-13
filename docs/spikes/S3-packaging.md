# Spike S3 — Packaging, SQLite and image size

**Date:** 2026-11-13 · **Status:** mostly done (arm64 not tested)

## Results
- `better-sqlite3` 13.1.1 installs and runs (WAL mode, SQLite 3.54.1) on `node:22-alpine`,
  `node:24-alpine` and `node:26-alpine`, **linux/amd64**. The Alpine images have no compiler, so a
  prebuilt binary was used.
- **linux/arm64 is not verified**: the local Docker has no emulation (`exec format error`). Verify it in
  CI with a native arm64 runner before claiming multi-arch support.
- Phase-0 skeleton image (`docker/Dockerfile`, Hono "hello", no SQLite yet): **176 MB uncompressed**,
  **~20 MiB RAM at idle**, runs as the non-root `node` user, `/healthz` answers `{"status":"ok"}`.
  Compressed size was not measured (the target is < 150 MB compressed).
- The image is based on Node 22 because that is what the dev machine runs; the ADR targets Node 26 LTS
  (`node:26-alpine` exists, v26.13.1). Decide the production baseline before 0.1.

## Impact on ADRs
- Supports ADR-007 (`better-sqlite3`): prebuilt binaries exist for Node 22/24/26 on amd64 Alpine.
