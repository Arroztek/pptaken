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
| Card grid with a thumbnail that repeated the title, two badges per card ("By your agent", "Interactive · …") | Identical boxes and chip soup; the thumbnail carried no information the title did not. Replaced by a typeset list, and later by an optional grid whose thumbnail is the real first slide (section 8) |
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

## 8. Grid view with first-slide covers (added after the list redesign)

The list stays the default. A small segmented control (List / Grid, a hairline pill beside the search) switches to a
grid; the choice is remembered in this browser (`localStorage`, guarded) and nothing else decides it.

- **Cover = the first slide as rendered**, in a 16:9 frame with a hairline and the panel's 14 px radius; a 4:3 deck
  keeps its shape, centered with quiet bars, so a row stays even. Under it: the title (display face, semibold), one
  muted line (slides, edited), **Present** and the **More** menu, and the same single chip as the list, only when
  something needs the owner. No icon circles, no badges, no shadows or gradients; hover darkens the hairline and
  underlines the title.
- **The whole card is the title link** (stretched link); Present and More sit above it and are real controls in the tab
  order. The thumbnail frame is decorative and never takes focus.
- **Columns:** 1 at 360, 2 from 640, 3 from 1100 px.
- **Loading:** a quiet skeleton while a cover loads (still under reduced motion); lazy (only near the viewport), at
  most four at once, signed URLs asked for in one request per page and reused until a minute before they expire. When a
  cover cannot show (no slide, offline, slow, failed request) the frame shows the title on the neutral surface; there is
  never an error message for it.
- **Security:** the slide is never rendered in the panel's origin. See `docs/spec/http-api.md` (Covers) and
  `docs/spec/player.md` (Cover mode): a script-less, sandboxed document, always the simple version of an interactive
  deck, so a cover needs no approval.
- **Checked:** unit tests (store, limiter, persistence, API client), server tests (tokens, headers, first slide only),
  panel screenshots at 360/768/1280, light and dark, English and Spanish, with no horizontal overflow and the basic
  accessibility checks, keyboard tests, and a real-server run in Chromium, Firefox and WebKit
  (`apps/server/browser/covers-e2e.mjs`).

## 9. Sharing (public links, ADR-026, added 2026-11-20)

- **One action, one dialog.** "Share" sits next to Present on the presentation page and opens a dialog, not a new
  page. Two plain choices, written as who the link is for: "Anyone with the link can watch" and "For the person who
  will present", the latter with a quiet "Includes your notes" badge and one sentence that says anyone with the link
  can read the notes. No "view/presenter link", "token", "secret" or "hash" in the normal view; Developer details add
  the link id only.
- **Calm defaults.** View is preselected; the link works "until you stop it"; the name is optional and private;
  "Freeze this version" is one checkbox with a one-line hint. Two clicks make a link: Share, Create link.
- **After creating:** one success line, the link with a Copy button (the Spotlight of that state), and two quiet links
  ("Show QR code", "Make another link"). The QR code reuses the server's pinned encoder (`/_rt/qr.js`) inside the
  existing FramedQR plate.
- **Stopping is asked once, inline** (no stacked modal over a modal): the row expands with "Stop sharing this link?
  It stops working right away: nobody can open it again." and Cancel / Stop sharing.
- **The presenter password appears where it matters:** one line under the presenter choice ("Interactive parts need
  your presenter password on that computer") with "Set a presenter password" when none is set; nothing when
  interactive mode is off. The Security card stays as it was.
- **One chip at most:** the list's "Shared" mark is muted (not amber, not a warning) and yields to "Needs your OK"
  and "Had a problem".
- **Consequences said up front:** the delete confirmation adds "This also turns off N shared links"; Restore asks
  "Turn those links back on" (unchecked) only when the trash turned links off.
- **Off states** follow what happened + what to do + one button: "Sharing is turned off." + "Turn on … in Settings."
  + Open Settings (or the server variable when the operator turned it off).
- **Guests:** the slide fills the screen; one quiet line on first load ("Use the arrow keys to move. Press ? to see
  all keys."); the dead-link page is one calm sentence with no reason and no login prompt, in the browser's language.
- **Checked:** `share.spec.ts` in Chromium, Firefox and WebKit; screenshots of the Share dialog (choices with links,
  presenter choice with a custom date, ready with QR, off), the "Shared" chip and the restore question at 360/768/1280,
  light and dark, English and Spanish, with no horizontal overflow and the basic accessibility checks; guest pages in
  Chromium, Firefox and WebKit through `apps/server/browser/share-e2e.mjs`.
- **Not verified:** screen readers beyond the automated checks; the QR code scanned by a real phone camera (the
  matrix is the same encoder the phone pairing uses).

## 10. Loaders (added 2026-11-21)

Two loaders, one per surface, both drawn from the brand illustrations (`docs/brand/illustrations`): pure CSS on inline
SVG (no request, no library, nothing the strict CSPs need to allow), invisible for the first 180 ms so a fast load
never flashes, laid out as their final box (or a fixed overlay) so nothing jumps, and a polite live region with a
visually hidden "Loading" / "Cargando".

- **App: "the cue"** (`Loader` in `@pptaken/ui`, styles in `components.css`). The stage manager's cue light comes on
  (standby), a signal runs down the dotted wire, the slide lights amber with its arrow (go). Lights snap, the signal
  travels; one loop every 2.4 s. Sizes: `page` (boot and route changes, with the visible caption "Setting the
  stage…"), `section` (lists, the deck page, the trash, connected apps, access keys, sharing, approval, consent, the
  presenter password card), `inline` (busy buttons and the import line: only the slide, lit by a wipe, in
  `currentColor`, so it reads on an amber button; silent, the button's `aria-busy` says it). Use the component for
  every new loading state; do not write "Loading…" text.
- **Presentation: "the follow spot finds the screen"** (`loaderHtml` and `LOADER_CSS` in `@pptaken/player`). On the
  black stage a follow spot swings in from the wings, its pool travels the floor, the empty screen lights up as a slide
  (title and two lines), the light cuts and the spot travels on and irises out; 4.8 s a loop. Server-rendered in
  `/p/:id`, `/p/:id/presenter` and `/s/<secret>` (and its presenter window), so it is up before any module loads; the
  page scripts translate its label, hide it on `ready`, and hide it on every error, fault or dead link so the
  existing status messages stand alone. A slow load keeps it, with "taking too long" beside it. The presenter view
  stays transparent under it until ready (at most 10 s). Player pages are always dark: the loader uses the stage
  tokens.
- **Reduced motion:** nothing travels. The cue's slide rests lit and breathes slowly; the follow spot rests on the
  lit screen, which breathes.
- **Checked:** `apps/web/test/e2e/loader.spec.ts` (held requests: boot, list, Spanish, busy button, delay, reduced
  motion; three engines), `packages/player/test/loader.test.ts`, server tests for the pages and their CSS,
  screenshots at 360 and 1280 in light and dark with frame sequences of both loops.

## 7. Not verified

- Real Claude Desktop/web connector flow (external); verified only against the mock server and the server tests.
- Firefox and WebKit runs of the new e2e specs were not part of the final verification run (Chromium only); the
  `screens.spec.ts` matrix is Chromium-only by design.
- Grid covers: a page cannot tell a cover that failed inside its sandboxed frame from a blank slide (the server answers failures with an empty document, so it stays blank; a load that never finishes falls back after 12 s). Only the bundled fonts and the sample decks were checked.
- Screen-reader testing beyond the automated checks (landmarks, names, one h1, keyboard menus and drawer).
