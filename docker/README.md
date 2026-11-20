# Running PPTaken with Docker

The image is published at `ghcr.io/arroztek/pptaken` (`linux/amd64` and `linux/arm64`, public, no login needed).
The compose files pull it; nothing is built unless you ask for it.

| File                             | What it does                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `docker/compose.yaml`            | The service: published image, one volume, hardened container, **no host port** (Dokploy, Coolify, Traefik). |
| `docker/compose.standalone.yaml` | Override that publishes `127.0.0.1:8080` (change with `PPTAKEN_BIND` / `PPTAKEN_PORT`) for use without a proxy. |
| `docker/compose.build.yaml`      | Override that builds the image from this checkout (tag `pptaken:local`) instead of pulling it.               |

```sh
# from the repository root, standalone on http://localhost:8080
docker compose -f docker/compose.yaml -f docker/compose.standalone.yaml up -d
docker compose -f docker/compose.yaml logs pptaken   # "PPTaken ready at … · Install code: XXXX-XXXX"
```

In Dokploy or Coolify point the application at `docker/compose.yaml` alone (or use the image
`ghcr.io/arroztek/pptaken` directly) and route your domain to container port 8080.

**Pin a version.** The default tag is `latest` (the newest stable release). In production pin one: set
`PPTAKEN_VERSION=0.1.0` in the environment or in a `.env` file next to where you run compose. `0.1` follows patch
releases only. Pre-releases (`0.2.0-rc.1`) are never `latest`.

**Update.** `docker compose -f docker/compose.yaml pull && docker compose -f docker/compose.yaml up -d` (add the
standalone file if you use it). Migrations run at start after a backup copy of the database. Read the
[changelog](../CHANGELOG.md) before a minor update while the version is below 1.0.

**Build from source** (development, or a platform the image does not cover):

```sh
docker compose -f docker/compose.yaml -f docker/compose.build.yaml up -d --build
# with a published port:
docker compose -f docker/compose.yaml -f docker/compose.build.yaml -f docker/compose.standalone.yaml up -d --build
```

Check an image yourself with `sh docker/smoke-test.sh IMAGE` (read-only root, no capabilities, temporary volume;
needs `docker` and `curl`). How releases are made: [`docs/releasing.md`](../docs/releasing.md).

**Skip the install code (optional):** set `PPTAKEN_ADMIN_PASSWORD` (or `PPTAKEN_ADMIN_PASSWORD_FILE`, a path to a file
with the password) and the owner is created at first start; nothing is printed in the logs and you sign in with that
password. It is only used while no owner exists (it never resets a password; use `pptaken reset-password`), and a
password that fails the policy stops the server with a clear message. Without it, the install-code flow below applies.

Open the public URL, enter the install code and choose a password (at least 12 characters). Set
`PPTAKEN_PUBLIC_URL` to the address people and agents use (for example `https://slides.example.com`); behind a reverse
proxy also set `PPTAKEN_TRUST_PROXY=true`.

- **Image**: multi-stage `node:22-alpine`, production dependencies only, no npm/corepack/yarn in the final layer,
  runs as `node` (uid 1000), `HEALTHCHECK` on `/healthz`, includes the built web app when `apps/web` exists.
  Measured on 2026-11-15: 208 MB (of which the Node binary is 124 MB), about 40 MiB of RAM when idle.
- **Data**: everything lives in the `/data` volume (`secret.key`, `pptaken.db`, `blobs/`). The container runs with
  `read_only: true` (plus a `tmpfs` on `/tmp`), `cap_drop: [ALL]` and `no-new-privileges`.
- **Maintenance** (inside the container):
  - `docker compose -f docker/compose.yaml exec pptaken pptaken reset-password` (asks twice; or pipe it on stdin)
  - `docker compose -f docker/compose.yaml exec pptaken pptaken backup /tmp/backup-1` then copy it out with
    `docker cp`. The backup is a directory with `pptaken.db` and `blobs/`.
- **Upgrades**: `docker compose -f docker/compose.yaml pull && docker compose -f docker/compose.yaml up -d`; migrations run at start after a copy of the database
  (`pptaken.db.pre-v<N>-<time>.bak`).

Plain HTTP on a local network works, but the password then travels unencrypted. Use HTTPS (a reverse proxy such as
Caddy, or a tunnel) for anything reachable by others.

## Connecting claude.ai and Claude Desktop (OAuth) behind Traefik / Dokploy

claude.ai, Claude Desktop and the mobile apps sign in to PPTaken with OAuth ([ADR-018](../docs/adr/0018-oauth-authorization-server.md)).
It is on only when `PPTAKEN_PUBLIC_URL` is the exact **https** origin people use (for example
`https://slides.example.com`); with plain http (other than localhost) the server logs a warning and only API tokens
work. Behind a reverse proxy:

- Route **all** paths of the host to PPTaken, in particular `/.well-known/*` and `/oauth/*` (not only `/`, `/api`
  and `/mcp`). In Dokploy a single domain rule ``Host(`slides.example.com`)`` without a path prefix does this.
- Do not strip or rewrite the `WWW-Authenticate` response header (no header-cleaning middleware on this router).
- No redirects on `/mcp`: no cross-host redirect (www/apex), no trailing-slash or `/mcp/` rewrite, no http→https
  redirect for the URL you paste into Claude (paste the https URL). Claude drops the `Authorization` header when it
  follows a redirect, which shows up as an endless sign-in loop.
- Set `PPTAKEN_TRUST_PROXY=true` so rate limits see client IPs (`X-Forwarded-For`), and keep the default
  `Host` forwarding (`passHostHeader`).
- Quick check from anywhere:
  `curl -i https://slides.example.com/.well-known/oauth-authorization-server` must answer `200` JSON whose
  `issuer` is exactly your public URL, and `curl -i -X POST https://slides.example.com/mcp` must answer `401` with a
  `WWW-Authenticate: Bearer … resource_metadata="https://slides.example.com/.well-known/oauth-protected-resource/mcp"`.

Connected applications are listed (and can be disconnected) under **Access & connections** in the panel.
`pptaken reset-password` disconnects every application.
