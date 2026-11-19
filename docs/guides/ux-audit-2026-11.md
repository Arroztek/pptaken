# UX audit and simplification pass · 2026-11

**Principle (founder):** "You hand over your presentation, PPTaken hosts it, you just present." Two audiences:
developers, and people who only want to present (executives, teachers). Security is silent by default and speaks only
when a real decision exists: one plain sentence, one click. Friction budget: no main task above 3–4 clicks.

Screenshots (session scratchpad, not committed): `before/` (the panel before this pass, 1280 light en and 360 dark es),
`after/` (same screens after), `screens/` (the Playwright matrix: every redesigned screen at 360/768/1280, light and
dark, English and Spanish, 564 files). Regenerate with `PPTAKEN_SCREENSHOTS_DIR=<dir> pnpm --filter @pptaken/web exec
playwright test screens.spec.ts --project=chromium`.

## 1. Journeys: clicks in the panel

| Journey | Before | After | What changed |
|---|---|---|---|
| J1 First run: install → connect Claude → first presentation | 5 (Create owner, pick the right tab, Copy URL, Allow access, Go to presentations) | 4 (Continue, Copy, Allow, Go to presentations) | Claude Desktop/web is the default three-step path; Claude Code and other tools fold under Developer |
| J2 "My agent made a presentation": open, present | 1 (Present on the card) | 1 (Present on the row) | Same; the row no longer carries two badges |
| J3 Edit via the agent, see it update (interactive deck) | 5 (open link, Approve these scripts, tick "I read the code", Approve, Present) | 1 (Present); 3 when a new outside library was added (link, Allow, Present) | ADR-024: edits of approved code are allowed automatically |
| J4 Interactive deck needs permission → allow → present | 5 (+ sign-in) | 3 (link, Allow, Present) (+ sign-in, returns to the same screen) | One-click approval screen `/decks/:id/approve` |
| J5 Delete or restore | Not possible in the panel | Delete 3 (More, Move to trash, confirm) + Undo 1; Restore 2 (Trash, Restore); Delete forever 3 (Trash, Delete forever, confirm) | Trash routes and view |

## 2. Terms a non-technical person would not understand (before)

| Screen | Terms |
|---|---|
| Connect | token, setup prompt, MCP, MCP client, Streamable HTTP, Bearer, connector URL, permissions `decks:read decks:write quiz:draft`, "called whoami" |
| Presentations | r1 (revision), "Interactive · pending approval", "Interactive · 4 script errors", "By your agent / By you" |
| Deck | Interactive scripts, scripts can run, approval, content origin, same origin, fingerprint (SHA-256), digest, PPTAKEN_SCRIPTS=owner, PPTAKEN_CONTENT_URL, runaway script, static version, libraries, vendored from, answered by, redirects, vendored resources, stylesheet, script errors, promise rejection, callback, get_presentation |
| Access & connections | tokens, agent tokens, Bearer token, fingerprint, connected applications, returns to, scopes |
| Security | owner password, presenter password (no "optional"), static version |
| Setup / errors | owner, install code "from the server logs", server logs, "the server refused this request" |

## 3. Alerts that were not an actionable problem (before)

| Screen | Alert | Now |
|---|---|---|
| Deck | Amber "runaway script can freeze the presenter tab" on every scripted deck | Developer details only |
| Deck | Amber "What approving means" box with a shield | One plain sentence in the status line |
| Deck | Green "Content is served from a separate site" | Developer details only |
| Deck | Red "1 resource(s) could not be downloaded" (Claude already told) | One muted line under "Files saved from the web" |
| Deck | Amber "This PPTaken does not download external resources" | One muted line |
| Deck | "Static deck" info box | Status line "Ready" |
| Deck | "No errors reported" panel on every approved deck | Nothing (status line "Ready") |
| Deck | Amber "Changed since you approved it" + digest | "Needs your OK for its interactive parts" + why, or nothing (automatic update) |
| Connect | Amber "claude.ai cannot reach this server" | Calm info note with what to do |
| Import | Amber "things were adjusted" | Success with the grouped list |
| Sign in | Amber "Your session ended" | Calm info note |

## 4. Glossary (applied in en and es; enforced by `apps/web/src/lib/i18n.test.ts`)

| Jargon | Plain words (en) | Palabras simples (es) | Where the technical word survives |
|---|---|---|---|
| fingerprint, hash, SHA-256, digest | (hidden) | (oculto) | Developer details |
| scripts, author scripts | interactive parts | partes interactivas | Developer details, copy for Claude |
| approve scripts | Allow the interactive parts / Allow | Permitir las partes interactivas / Permitir | |
| stop running scripts / revoke | Turn interactive parts off for this presentation | Apagar las partes interactivas de esta presentación | |
| token, agent token | access key | clave de acceso | Developer fold of Connect ("Access key (token)") |
| connected applications, Access & connections | Connected apps | Apps conectadas | |
| vendored resources | files saved from the web | archivos guardados de la web | Developer details |
| static version | simple version (without the interactive parts) | versión simple | Developer details |
| MCP, MCP client, connector URL | your PPTaken address | la dirección de tu PPTaken | Developer fold ("MCP server URL", "Other MCP clients") |
| script errors | some interactive parts had problems | algunas partes interactivas tuvieron problemas | Developer details |
| owner password | your password | tu contraseña | |
| revision r3 | (hidden) | (oculto) | Developer details ("Revision 3") |
| export / .pkn archive | Download: a single file / a PPTaken backup | Descargar: un solo archivo / una copia de seguridad | |
| your agent | Claude | Claude | |

Every notice follows: what happened, in plain words → what to do → one button. The normal view never contains
"virus", "malicious", "danger", "attack" (test-enforced).

## 5. What changed per area

- **Shell:** sidebar labels Presentations, Connect Claude, Connected apps, Security, Settings. Status (host + online
  dot; version only with Developer details), theme and language moved to a slim app bar (≥ 768 px, a `banner`,
  right-aligned slots, `--ppt-size-appbar`). **Sign out** is the only item of the sidebar foot, after a rule, quiet,
  one click and no confirmation (accidental sign-out costs one sign-in and loses nothing; it is now in a different
  screen region from every toggle, measured > 300 px apart in `shell.spec.ts`). Phones: slim top bar; the drawer
  shows status, theme and language at its top and Sign out alone at its bottom.
- **Presentations:** a typeset list (hairline rules, display-font titles, one quiet metadata line) instead of a grid
  of identical cards; at most one chip, only when the owner is needed ("Needs your OK", "Had a problem"), linking
  where the fix is; Present + a More menu (Details, Download, Move to trash); Undo toast; Trash link at the foot.
  Empty state shows the exact request to send Claude and a primary "Copy this request".
- **Deck page:** title, Present, More; one status card (Ready · Needs your OK for its interactive parts · Some
  interactive parts had problems · Ready · simple version) with at most one primary action; quiet links: See what will
  run, Review changes, Turn interactive parts off. Sections appear only when relevant. Developer details show
  everything that existed before (fingerprint, approval mode, instance switch, content origin, freeze note, static
  check, what the simple version leaves out, vendored provenance, raw script errors).
- **Approval screen** `/decks/:id/approve` (focused layout): one sentence, Allow, Not now, See what will run; then
  "Done. You can present." with Present. Sign-in returns to it.
- **Settings** (new): appearance; "Allow interactive updates automatically" (server-side, default on); "Show developer
  details" (per browser, `localStorage` `pptaken.dev`, guarded, default off); this PPTaken (address, status, version).
- **Connected apps:** plain columns (App, Can, Connected, Last used); access keys under "Advanced: access keys"
  (open with Developer details or the old `/tokens` address).
- **Security:** "Your password"; "Presenter password (optional)" as a status line and one button, the form only on demand.
- **Connect Claude:** three steps for Claude Desktop/web with the live status; Claude Code and other MCP clients under
  "Developer".
- **Errors:** server text never shown in the normal view (import errors and weak-password hints are plain; the server
  message is under Developer details).

## 6. Design review: what was removed as slop, and why

| Removed | Why |
|---|---|
| Card grid with a thumbnail that repeated the title, two badges per card ("By your agent", "Interactive · …") | Identical boxes and chip soup; the thumbnail carried no information the title did not. Replaced by a typeset list |
| Amber/red/green notices on the deck page (freeze, approval meaning, capability, vendoring) | Colour as decoration; none asked the owner to do anything |
| Shield icon heading "What approving means" and the checkbox "I read the code" | Fear framing and ceremony; consent is the one click on a plain sentence, the code one link away |
| Instance block, version and both toggles in the sidebar foot next to Sign out | Clutter and an error trap; moved to the app bar |
| Info box with an icon under Connect ("managed in Access & connections › …") | Decorative icon, filler; now one muted line |
| "Copy example prompt" next to Import in the list header | Meaningless out of context; the request lives in the empty state |
| Heavy bold page titles in every page | Replaced by the landing's typography: light display weight with tight tracking for the one page title, semibold for list titles; weight contrast instead of boxes |
| "No errors reported" panel, "Static deck" panel, revision numbers, digests | Status the owner never needs; one status line says "Ready" |
| Microcopy such as "Your agent designs. You present. … less than a minute" and "Good." | Filler; replaced by short, concrete steps |

Kept on purpose: the empty-stage illustration (it teaches the product's metaphor once, on an empty list), the
spotlight colour only on the single primary action, the focus rings, hairline borders, the 6/14 px radii.

## 7. Not verified

- Real Claude Desktop/web connector flow (external); verified only against the mock server and the server tests.
- Firefox and WebKit runs of the new e2e specs were not part of the final verification run (Chromium only); the
  `screens.spec.ts` matrix is Chromium-only by design.
- Screen-reader testing beyond the automated checks (landmarks, names, one h1, keyboard menus and drawer).
