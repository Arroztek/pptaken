# Running PPTaken with `npx`

`npx pptaken` runs PPTaken on your own computer with one command, without Docker. It is meant for one person trying
PPTaken or presenting from their laptop. For a server that other people and Claude Desktop / claude.ai reach, use the
[Docker image](../../docker/README.md). Design and trade-offs: [ADR-025](../adr/0025-npx-distribution.md).

## Requirements

- Node.js **22 or newer** (`node --version`). Older versions get a short message explaining what to install.
- Windows, macOS, or Linux (glibc or musl), on x64 or arm64. SQLite comes as a ready-made binary for these systems
  (inside the `better-sqlite3` package), so nothing is compiled. On other systems (32-bit ARM, FreeBSD, ...) PPTaken
  stops with exit code 6 and a message; use Docker there, or build better-sqlite3 from source yourself
  (`npx node-gyp rebuild` inside its folder, with Python and a C++ compiler).
- About 35 MB of disk for the installed packages, plus your data.

## Quick start

```sh
npx pptaken
```

It prints a block like this:

```text
  PPTaken 0.1.0 is running.
  ----------------------------------------------------------------
  Open          http://localhost:8080
  Install code  CE7B-D8T4
                First run: enter this code on the welcome page to create your owner account.
  Data          C:\Users\ana\AppData\Local\PPTaken
  Stop          press Ctrl+C
  ----------------------------------------------------------------
  Next step: connect Claude -> https://docs-pkn.arroz.dev/connect/overview/
  ...
```

Open the address, enter the install code, choose your password, then follow **Connect Claude**. The install code is
shown only until the owner account exists; later starts say "Sign in" instead.

## Connecting Claude

- **Claude Code** on the same computer works with `http://localhost:<port>/mcp` and an access key: in the panel open
  **Connect Claude**, **Developer**, **Claude Code**, and copy the setup prompt.
- **Claude Desktop and claude.ai** connect from Anthropic's cloud. They cannot reach `http://localhost` on your
  computer; they need PPTaken on a public `https://` address (a server with Docker, a reverse proxy, or a tunnel you
  run yourself). Start PPTaken with that address: `npx pptaken --public-url https://slides.example.com`.

## Options

| Option                         | Environment variable          | Default                                  |
| ------------------------------ | ----------------------------- | ---------------------------------------- |
| `--port <n>`                   | `PPTAKEN_PORT`                | 8080, or the next free port if busy      |
| `--host <address>`             | `PPTAKEN_HOST`                | `127.0.0.1` (this computer only)         |
| `--data-dir <folder>`          | `PPTAKEN_DATA_DIR`            | per-user folder (below)                  |
| `--public-url <url>`           | `PPTAKEN_PUBLIC_URL`          | `http://localhost:<port>`                |
| `--scripts owner\|off`         | `PPTAKEN_SCRIPTS`             | `off`                                    |
| `--admin-password-file <file>` | `PPTAKEN_ADMIN_PASSWORD_FILE` | none (the install code is used)          |
| `--log-level <level>`          | `PPTAKEN_LOG_LEVEL`           | `warn`                                   |
| `--json-logs`                  |                               | human lines on stderr                    |
| `--open`                       |                               | do not open a browser                    |

An option wins over its variable. Every other [configuration variable](https://docs-pkn.arroz.dev/reference/configuration/)
works as with Docker. A port you chose (option or variable) is never changed: if it is busy, PPTaken stops with exit
code 3. `--host 0.0.0.0` makes PPTaken reachable from your network over plain HTTP and prints a warning; without
`--public-url` the address is then taken from each request, so links work from other devices.

**Data folder:** Windows `%LOCALAPPDATA%\PPTaken`, macOS `~/Library/Application Support/PPTaken`, Linux
`$XDG_DATA_HOME/pptaken` (when set to an absolute path) or `~/.local/share/pptaken`. It holds `pptaken.db`, `blobs/`
and `secret.key`, exactly like the Docker volume, so you can move it to Docker later. Only one PPTaken may use a
folder at a time (`pptaken.lock`).

## Commands

```sh
npx pptaken                                # start (same as: npx pptaken start)
npx pptaken backup ./pptaken-backup        # consistent copy of the database and files (safe while running)
npx pptaken reset-password                 # new owner password; signs every session out
npx pptaken reset-password --clear-presenter-password
npx pptaken --help
npx pptaken --version
```

`backup` and `reset-password` use the same data folder rules (pass the same `--data-dir` if you changed it).

## Stopping

Press **Ctrl+C**: PPTaken closes the connections and the database cleanly and says where your data is. Press it a
second time to stop at once. `SIGTERM` and closing the terminal window (SIGHUP) stop it cleanly too; a process that
starts PPTaken with an IPC channel can send the message `pptaken:shutdown`.

## Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | Stopped normally (or a command finished).                            |
| 1    | Unexpected error (run again with `--log-level debug` for details).   |
| 2    | Invalid option or setting.                                           |
| 3    | Port busy, or PPTaken already running with this data folder.         |
| 4    | The data folder cannot be created or written.                        |
| 5    | Node.js is older than 22.                                            |
| 6    | The SQLite module has no binary for this system.                     |
| 130  | Stopped at once by a second Ctrl+C.                                  |

## Updating

`npx pptaken@latest` (a bare `npx pptaken` may reuse a copy npx cached earlier). Pin a version with
`npx pptaken@0.2.0`. Database migrations run at start after a backup copy, as with Docker; read the
[changelog](../../CHANGELOG.md) before a minor update while PPTaken is below 1.0. Going back to an older version needs a
backup made by that version.

## Checking what you install

The package is published from GitHub Actions with npm provenance (the npm page links the commit and the workflow run);
`npm audit signatures` verifies it. It has a single dependency (`better-sqlite3`), no install scripts, and its
`THIRD-PARTY-NOTICES.md` lists every bundled component.

## Limits

- Runs while the terminal is open: no service, auto-start or auto-update yet.
- HTTP only; HTTPS needs a reverse proxy or a tunnel in front.
- Interactive decks need `--scripts owner`; they then run in your own session after you approve them.

## For maintainers

- Build: `pnpm build` at the root (builds the workspace, then `packages/pptaken`: bundle, assets, licence gate,
  notices). Unit tests: `pnpm --filter pptaken test`. Installed-copy test: `pnpm --filter pptaken test:installed`
  (needs network for the npm registry and Playwright's Chromium).
- Publishing: [docs/releasing.md](../releasing.md#npm-package-pptaken).
