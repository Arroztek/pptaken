# ADR-021 · Presenter password and approval screen

**Status:** accepted (2026-11-18). Builds on [ADR-020](0020-interactive-mode.md) (interactive mode, foundation
phase). Related: [HTTP API](../spec/http-api.md), [player](../spec/player.md),
[security](../foundation/04-security-and-auth.md), [user guide](../guides/interactive-decks.md). Extended by
[ADR-022](0022-vendoring-and-html-importer.md): the approval screen also shows the deck-level script and, per
vendored library, its final URL, redirect chain and size; the deck page lists every vendored resource.

## Context

ADR-020 shipped the trust model of author scripts (instance switch, consent by digest, hardened scripted document)
but left two gaps:

1. **No approval screen.** Agents returned `approve_url` and `urls.manage` (`/decks/<id>`), and the panel had no
   such page: the owner could only approve through the raw API.
2. **Scripts only in the owner's session.** Phase F5 will add presenter and public links, i.e. screens where no
   owner session exists (a conference PC, a colleague's laptop). The founder wants approved interactive code to be
   usable there too, unlocked by a **global presenter password** that the owner chooses, separate from the owner
   password.

Founder decisions that bound this ADR: self-hosted first; scripts only in owner-private decks for now; one global
presenter password (not per deck); offline always renders the static version and never asks for a password (an
optional instance setting to run JS offline may come later, not now); a separate-site content origin stays
optional on self-hosted and the UI only warns.

## Decision

### 1. The approval screen (`/decks/:id`)

A panel page per presentation (`urls.manage`; agents' `approve_url` is the same page with `#scripts`). Header: title,
slide count, revision, author, a status badge (`Static`, `Interactive · pending approval`, `Interactive · approved`,
`Interactive · scripts off`) and Present (new tab). The **Interactive** section shows, from one server read of the
current revision (`GET /api/v1/decks/:id/scripts`):

- the instance switch (`PPTAKEN_SCRIPTS`), and when off, how to turn it on (no dead end: the code stays readable);
- the approval state: none / pending / approved / **stale** (an approval exists for older code);
- the digest, short (`8…8` hex) and full (copyable);
- every slide script verbatim in a read-only viewer (monospace, line numbers, UTF-8 size, its own SHA-256,
  collapsible; scripts longer than 200 lines show the first 200 and a "Show all" button);
- the vendored libraries (name, version, SHA-256, the source URL they were vendored from);
- the sanitizer warnings of the static fallback (what the static version loses, e.g. `<canvas>`), capped at 50;
- the content-origin capability, with an amber warning when scripts are on without a separate site: "A runaway
  script can freeze the presenter tab in Firefox and Safari. For stronger isolation serve content from a separate
  site (PPTAKEN_CONTENT_URL).";
- a prominent "What approving means": "This code will run in your browser when you present this deck. It cannot
  reach the network. Approve only code you or your agent wrote and you have read." plus where it runs;
- Approve (a modal repeating the short digest, an explicit checkbox, then a POST carrying the digest **shown when
  the dialog opened**: if the deck changed meanwhile the server answers `409` and the page reloads the new code) and
  Revoke (confirmed).

Decks without scripts show a calm "Static deck" note. The deck list shows `Interactive · pending approval` /
`Interactive · approved` badges (the list summary gained `scripts: none|pending|approved`).

### 2. The presenter password

- One per instance, chosen by the owner on the Security page (set / change / remove). Same policy helper as the owner
  password (≥ 12 characters, not common, not repetitive). **Refused when equal to the owner password**, and a new
  owner password equal to it is refused too (panel change and `reset-password`): the two secrets stay separate.
- Stored as a scrypt hash in the instance settings (`presenter_password`), never the plain value; never logged.
- It can never sign in: `/auth/login` checks only the owner hash. Changing the owner password does not change it.
  `pptaken reset-password --clear-presenter-password` also removes it (a reset means the owner may have lost
  control).
- Audited: `presenter_password.set`, `.change`, `.remove` (panel or CLI), `presenter.unlock` ok / denied (with an
  internal reason, never the password).

### 3. The unlock

`POST /api/v1/presenter/unlock {deckId, password}`, **no owner session needed** (this is what F5 pages will call).

- Rate limits: 5 attempts per minute per IP with an increasing delay after 3 consecutive failures (1 s, 2 s, 4 s…
  up to 15 min); a global cap of 30 failures per 10 minutes that pauses every IP; 10 failures per 10 minutes per
  deck, whatever the IPs. The API-wide per-IP limit still applies. `429` carries `Retry-After`.
- Constant work: every attempt runs one scrypt verification (against a decoy hash when no presenter password is
  set) **and** reads the deck, whatever the input. Every failure (no password set, wrong password, the owner
  password, unknown deck, unapproved or edited scripts, switch off) is the same `401 Unlock failed`.
- Success returns `{ token, deckId, expiresAt }` (`Cache-Control: no-store`): an HMAC token (dedicated HKDF subkey
  `presenter-unlock`) with purpose `unlock`, subject `<deckId>:<approved digest>:<password epoch>` and an expiry of
  **8 hours**. The epoch is a fingerprint of the stored password hash, so changing or removing the presenter password
  ends every unlock. The verifier rebuilds the subject from the *current* state, so an edited deck (new digest), a
  revocation, or the instance switch turned off end it too; re-approving new code does not revive an old token.
- The token grants nothing else: it is not a Bearer credential (API and MCP answer `401`), it never reaches the
  panel, and on its own it does not even reveal the deck. A page without an owner session needs a **view grant** for
  the deck (`X-PPTaken-View`, purpose `view`, subject the deck id) to get the static version; the unlock token
  (`X-PPTaken-Unlock`) only upgrades that view grant to the scripted document, under the ADR-020 rules (switch on,
  approved digest equal, not `?safe=1`). Both travel in headers, never in a cookie or a URL. The content route
  (`/c/...`) is unchanged: it still re-checks the approval when it serves the document.

### 4. The trusted shell UI

On a page served without an owner session, the player page (trusted, outside the iframe) offers the unlock:

- opened by one plain key, **`U`** (no modifier: browsers reserve Ctrl/Cmd combinations such as Ctrl+W); listed in
  the key help;
- key events from the content frame never open it: the frame is cross-origin (its key events do not reach the page),
  forwarded keys travel over the protocol whose closed key set has no `U`, the module never listens to messages,
  and synthetic events (`isTrusted === false`) are ignored. Esc from a static frame returns the keyboard to the page;
- a focus-trapped modal drawn by the page over a full-viewport backdrop, the frame `inert` while it is open; the host
  name is shown in it; Esc closes; error, lockout and network messages; the password field is cleared after every
  attempt and has `autocomplete="off"`;
- success stores the token in `sessionStorage` (wrapped in try/catch; this tab only), replaces the frame with the
  scripted document at the same position, and shows a trusted "Interactive mode" indicator (hidden on black);
- when a stored token is refused on load (edit, expiry, password change), the page forgets it and says so;
- **offline the dialog is not offered** (no network, or running from the offline copy). The presenter view shows
  "Interactive mode needs a connection. Unlock before you go offline." when the deck has approved scripts and it
  runs offline; the audience screen never shows it.

Because F5 links do not exist yet, the guest page exists only as a **test route** (`GET /__test/guest/:deckId`,
registered only when `createServer(..., { testRoutes: true })`; `main.ts` never sets it). It mints an 8-hour view
grant and serves the same `page.js` with `data-viewer="guest"`. The flow is covered end to end in Chromium, Firefox
and WebKit (`apps/server/browser/unlock-e2e.mjs`).

### 5. How phase F5 links will use it

A presenter or public link page will be served by the link route instead of the test route:

1. The link route validates its own share credential (link token, expiry, revocation) and serves the player page
   with `data-viewer="guest"` and a view grant for that deck only (or an equivalent link-bound credential that
   `content-url` accepts in place of `X-PPTaken-View`). The view grant gives the static version only.
2. The page offers `U`. The unlock endpoint is unchanged; F5 may additionally bind the unlock to the link (adding the
   link id to the token subject) so a token unlocked through one link cannot be replayed through another.
3. Audience devices and the presenter previews keep getting the static version (ADR-020 §1); only the main screen of
   a presenter link can unlock. Public links remain static until the external review that ADR-020 requires.

## Threat analysis

| Threat | Mitigation | Residual |
|---|---|---|
| **Phishing the presenter password** (content drawing a fake dialog) | The real dialog is drawn by the trusted page over the whole viewport, with the host name, and only after a trusted `U`; static content has no text inputs (safe profile) and no scripts, so before an unlock nothing in the frame can collect keystrokes; content cannot open, move or cover the real dialog. | After an unlock, approved scripts run and could draw a fake "type the password again" form inside the canvas. The guide says PPTaken asks only after U. Approval is required for that code in the first place. |
| **Keylogging on a foreign PC** | The presenter password is separate from the owner password and cannot open the panel; it unlocks only already-approved code of decks the screen can already show; change it after use on an untrusted PC (every unlock ends). | A keylogger learns the presenter password: with a view grant for an approved deck it can run that deck's approved code until the password is changed. It gains no panel or API access. |
| **Brute force** | 12+ characters, policy helper, scrypt; per-IP limit with backoff, global failure cap, per-deck cap; generic errors; constant work. | A distributed attacker gets about 30 guesses per 10 minutes instance-wide. |
| **Token theft** | `sessionStorage` (not a cookie, not a URL, not sent to the content origin); 8-hour cap; useless without a view grant of the same deck; bound to digest and password epoch. | Script running in the trusted page (an XSS in PPTaken itself) could read it; the strict app CSP is the defence. |
| **Replay after an edit** | The subject includes the approved digest and is rebuilt from current state: any script/library change, revocation, re-approval of new code, switch off, or password change makes it fail. | None known. |
| **Owner/presenter secret confusion** | Equal values refused in both directions; separate settings; separate HKDF subkey; the unlock never touches sessions. | The owner could reuse a password used elsewhere; we cannot detect that. |
| **Offline prompts** | Offline never asks (no network to verify, and a cached verifier would turn the offline copy into an offline brute-force target); the offline copy is always static. | Interactive decks are online only. |
| **Denial of service by guessing** | Lockouts are per IP and per deck; the global pause affects only the unlock endpoint, never the owner's sign-in or session. | An attacker can keep a deck locked for presenters during an attack. |

## Consequences

- (+) The owner reviews and approves the exact code from the panel; agents now point to a real page.
- (+) F5 links get a ready, tested unlock path with no new trust in the token beyond "this deck's approved code".
- (−) A second secret to manage; a lost presenter password means setting a new one (the owner can).
- (−) The guest page is test-only until F5: the end-to-end coverage depends on the test route matching what F5
  will serve.

## Verification (2026-11-18)

Vitest: auth-local (presenter password), core (`getScriptsReview`), server (`unlock.test.ts`: approval API 409s,
agents never approve, password API, unlock failures, rate limits and lockouts, token binding and invalidation), web
(API client, router, formatting), player (unlock key, request, storage, guest loading). Playwright against the mock
server for the page and the Security card in Chromium, Firefox and WebKit, with screenshots at 360/768/1280 in light
and dark, English and Spanish. `apps/server/browser/unlock-e2e.mjs`: 16 checks per engine in Chromium, Firefox and
WebKit.
