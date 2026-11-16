# Running PPTaken with Docker

```sh
# from the repository root
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml logs pptaken   # "PPTaken ready at … · Install code: XXXX-XXXX"
```

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
- **Upgrades**: `docker compose pull && docker compose up -d`; migrations run at start after a copy of the database
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
