# PPTaken

> **Your agent designs. You present.**

PPTaken is an open-source, self-hosted presentation **player**. An AI agent such as Claude creates decks through
[MCP](https://modelcontextprotocol.io); you present them from your browser, use your phone as a clicker, and keep
everything on your own computer. This package runs PPTaken with one command, no Docker needed.

## Quick start

You need [Node.js](https://nodejs.org) 22 or newer.

```sh
npx pptaken
```

PPTaken prints where to open it (usually http://localhost:8080) and, on the first run, a one-time **install code**.
Open the address, enter the code, choose your owner password, and follow **Connect Claude**. Press `Ctrl+C` in the
terminal to stop it; your presentations stay saved for the next run.

To get the newest version later: `npx pptaken@latest`.

## Connecting Claude

- **Claude Code** (on the same computer) works right away: the panel's **Connect Claude → Developer → Claude Code**
  copies a setup prompt with an access key for `http://localhost:8080/mcp`.
- **Claude Desktop and claude.ai** connect from Anthropic's cloud, so they **cannot reach `http://localhost`**. They
  need PPTaken on a public `https://` address (a server, a reverse proxy, or a tunnel). See
  [why and how](https://docs-pkn.arroz.dev/connect/overview/#why-claude-needs-a-public-https-address).

Guide: https://docs-pkn.arroz.dev/connect/overview/

## Options

```text
npx pptaken [start] [options]
  --port <number>            default 8080; the next free port is used when 8080 is busy (not when you chose it)
  --host <address>           default 127.0.0.1 (this computer only); 0.0.0.0 exposes it to your network over HTTP
  --data-dir <folder>        where your data is stored (default below)
  --public-url <url>         the address people and Claude use, e.g. https://slides.example.com
  --scripts <owner|off>      interactive decks run only after you approve them; off never runs them (default owner)
  --admin-password-file <f>  create the owner from a password file instead of the install code
  --open                     open the browser when ready
  --log-level <level>        debug, info, warn (default) or error
  --json-logs                JSON log lines on stdout
npx pptaken backup <new folder>     consistent copy of the database and files
npx pptaken reset-password          new owner password (signs everyone out)
npx pptaken --help | --version
```

The usual `PPTAKEN_*` environment variables work too
([configuration reference](https://docs-pkn.arroz.dev/reference/configuration/)); a command-line option wins.

**Where your data lives** (shown at start):

| System  | Default folder                                       |
| ------- | ---------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\PPTaken`                             |
| macOS   | `~/Library/Application Support/PPTaken`              |
| Linux   | `$XDG_DATA_HOME/pptaken` or `~/.local/share/pptaken` |

Back it up with `npx pptaken backup <folder>` (safe while PPTaken runs).

**Exit codes:** 0 stopped normally, 1 unexpected error, 2 invalid option or setting, 3 port busy or already running
with this data folder, 4 data folder not usable, 5 Node.js too old, 6 the SQLite module cannot load on this system,
130 stopped at once by a second `Ctrl+C`.

## Requirements and limits

- Node.js 22 or newer on Windows, macOS or Linux (glibc or musl), x64 or arm64. The only dependency,
  [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), ships ready-made binaries for those systems, so no
  compiler is needed. Other systems: use the Docker image.
- It runs while the terminal is open: there is no background service, auto-start or auto-update yet.
- By default only this computer can reach it. `--host 0.0.0.0` exposes it to your network over plain HTTP (no
  encryption); for anything beyond a trusted network, put it behind HTTPS. For a server, the
  [Docker image](https://docs-pkn.arroz.dev/deploy/standalone/) is the recommended way.
- Pre-1.0: minor versions may change things; read the changelog before upgrading, and keep a backup.

## Verify what you install

Versions after 0.1.0 are meant to be built and published from GitHub Actions with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements) (the npm page then links the exact commit and
workflow run, and `npm audit signatures` checks it); 0.1.0 was published by hand and has none. The package has no install scripts, and its `npm-shrinkwrap.json`
pins its one dependency (and that dependency's own) to exact, hash-checked versions.

## Links

- Documentation: https://docs-pkn.arroz.dev
- Source code and issues: https://github.com/Arroztek/pptaken
- Security reports: see `SECURITY.md` in the repository (please do not open public issues)

## License

PPTaken is licensed under **AGPL-3.0-or-later** (`LICENSE`). The deck format, player and remote-control packages
included in it are Apache-2.0 (`LICENSE-APACHE-2.0.txt`). Third-party components and their licences are listed in
`THIRD-PARTY-NOTICES.md`.
