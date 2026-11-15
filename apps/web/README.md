<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# @pptaken/web

The owner panel of PPTaken: first-run setup, "Connect your agent", the presentation list and agent tokens.
Svelte 5 + Vite, no SvelteKit ([ADR-004](../../docs/adr/0004-frontend-svelte.md)). It consumes the panel API in
[`docs/spec/http-api.md`](../../docs/spec/http-api.md); `apps/server` serves the built files.

## Scripts

| Command | Does |
|---|---|
| `pnpm --filter @pptaken/web dev` | Vite dev server on :5173, proxying `/api`, `/mcp`, `/p`, `/c` to `http://localhost:8080` (override with `PPTAKEN_DEV_BACKEND`) |
| `pnpm --filter @pptaken/web build` | `dist/` plus a per-page gzip size report; fails if the welcome page JS exceeds 100 KB gzip |
| `pnpm --filter @pptaken/web typecheck` | `svelte-check` over `src` and `test` |
| `pnpm --filter @pptaken/web test` | Vitest unit tests for `src/lib` (prompt builder, API client, router, i18n, formatting) |
| `pnpm --filter @pptaken/web test:browser` | Build, then Playwright in Chromium, Firefox and WebKit against `test/mock-server.mjs` |
| `pnpm --filter @pptaken/web mock` | Serve `dist/` with the in-memory mock API on http://127.0.0.1:4173 (`MOCK_INSTALLED=1`, `MOCK_DECKS=14`, `MOCK_HTTPS=1`, `MOCK_CONNECT_DELAY_MS`) |

`test:browser` writes full-page screenshots of every screen (360 and 1280 px, light and dark, en and es) to
`test/.screenshots/`, which is git-ignored (about 80 PNGs).

## Structure

- `index.html` + `src/main.ts`: one page, a tiny History API router (`src/lib/router.ts` decides, `src/lib/state.svelte.ts`
  navigates). Only `/`, `/welcome`, `/login`, `/decks`, `/tokens` are client routes; links to `/p/:id` and anything
  else are normal page loads. The server's SPA fallback serves `index.html` for unknown non-API paths.
- `src/pages/*`: one lazily loaded chunk per page. `src/components/*`: panel-only pieces built on `@pptaken/ui`.
- `src/lib/api.ts`: the typed client. Every response is validated with small hand-written guards (`validate.ts`);
  mutations send `X-PPTaken-CSRF: 1`; all requests use `credentials: "same-origin"`. Errors are translated by `code`.
- `src/lib/prompts.ts`: the Claude Code setup prompt and the generic client JSON, as pure functions.
- `src/i18n/{en,es}.ts`: panel strings that are not in `@pptaken/ui`'s copy bank; a unit test keeps both
  languages in sync (keys, placeholders, no exclamation marks or emoji).

## Security notes

- **CSP.** The app works under `default-src 'self'; img-src 'self' data:; style-src 'self'` (no `unsafe-inline` for
  scripts or styles): no inline scripts, Svelte styles are emitted as CSS files, no `style=""` attributes, no
  `data:` assets (`assetsInlineLimit: 0`), no module preload polyfill. The browser tests fail on any CSP violation,
  console error or request outside the app origin.
- **Token secrets** live only in memory (`secrets` in `state.svelte.ts`), never in storage or URLs, and are cleared
  when the path changes or the page is hidden for good (`pagehide`). The DOM holds a masked value until the owner
  selects Show; Copy reads the real value from memory. `localStorage` stores only `pptaken.lang` and `pptaken.theme`.
- **Open redirects.** `?next=` on `/login` only accepts `/decks`, `/tokens` or `/welcome`.

## Decisions and open questions

1. **Panel strings live in this package** (`src/i18n`), not in `packages/ui`, to avoid editing a shared package
   concurrently. The translator reads them first and falls back to `@pptaken/ui`'s dictionaries. They can move to
   `packages/ui` later unchanged.
2. **Language switch re-creates the tree.** `@pptaken/ui`'s `getI18n()` reads a fixed translator from context, so a
   language change re-mounts the app under `{#key}`. State that must survive (token secrets, theme) is module-level;
   focus returns to the language switch. Proposal for `@pptaken/ui`: let `setI18n` accept a getter so components
   follow a reactive locale.
3. **`Logo` is re-implemented as `BrandLogo`** because `@pptaken/ui`'s `Logo` has an inline `style` attribute, which
   `style-src 'self'` blocks. Proposal: move those three declarations into `.ppt-logo` in `components.css`.
   (`BigCode` and `FramedQR` have the same issue but are not used here.)
4. **Weak-password hints** are shown as the server sends them (English). The contract has no hint code, so they
   cannot be translated. Request: add a stable `hintCode` (e.g. `too_short`, `too_common`) next to `hint`.
5. **"Connect your agent" after setup** is the same `/welcome` route (signed in, installed); the "Step 2 of 2"
   eyebrow only appears right after setup. Polling of `/connect/status` runs every 2 s while the page is visible
   and not yet connected, on every tab.
6. **Prompt.** `claude mcp add --transport http pptaken "<url>" --header "Authorization: Bearer <token>" --scope user`,
   then `whoami`, then a one-line report, and "do not write the token anywhere else". The URL is percent-encoded
   outside a conservative character set so it is safe inside double quotes in bash, zsh, PowerShell and cmd; the
   token must match `ppt_` + 43 base64url characters. The prompt also asks the agent to request a restart if the
   new server's tools are not loaded yet in the current session.
7. **Deck cards** have no thumbnails in F2: a neutral title card plus a "By your agent" / "By you" badge from
   `createdBy`. The title link and Present both go to `/p/:id` (no deck detail page yet). No `StatusBadge` on
   cards (the API has no live/draft state); token rows use it (Active / Expired / Revoked).
8. **Count with pagination.** Without a total in the API, the list says "6+ presentations" while `nextCursor` is set.
   Request (optional): a `total` in `GET /decks`.
9. **Clipboard.** "Copy setup prompt" creates the token on click and copies through `ClipboardItem` with a promise
   (keeps Safari's user activation), falling back to `writeText` and then `execCommand("copy")` on plain-HTTP LANs.
10. **Publishing guide.** The HTTPS warning links to `#publish-guide` until the guide exists (no external links).
11. **Session end.** Any `401` on a signed-in page sends the owner to `/login?next=…` with "Your session ended."
