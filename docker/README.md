# Running PPTaken with Docker

```sh
# from the repository root
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml logs pptaken   # "PPTaken ready at … · Install code: XXXX-XXXX"
```

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
