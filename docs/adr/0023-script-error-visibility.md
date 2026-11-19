# ADR-023 · Script error visibility

**Status:** accepted (2026-11-18). Extends [ADR-020](0020-interactive-mode.md) §5.6 (errors) and
[ADR-021](0021-presenter-password-and-approval-screen.md) (approval screen). Related: [player](../spec/player.md),
[HTTP API](../spec/http-api.md), [security](../foundation/04-security-and-auth.md),
[interactive decks guide](../guides/interactive-decks.md).

## Context

A real incident: an agent wrote slide scripts that used a bare `root` (it must be `var root = slide.root;`). The
wrapper `function (slide) { … }` threw `ReferenceError: root is not defined` at setup. ADR-020 caught it per slide and
showed a notice **only in the presenter view**, with no text. The owner presented without the presenter view and saw a
silently static deck, with no idea why; the agent never learned it either. A context-free agent will repeat that kind
of mistake, so failures must be visible to the owner and returnable to the agent, without weakening the trust
boundary of ADR-020.

## Decision

### 1. Capture (runtime → shell)

- The runtime reports every author-script failure as `error { slide, kind, name, message, stack, count }` over the
  private port: `kind` is `setup` (the slide function threw), `handler` (event handler, timer, `onEnter`/`onLeave`/
  `onStep`, or a script/worker/inline handler the CSP blocked: `securitypolicyviolation`), `rejection` (unhandled
  promise rejection) or `script-load` (a script that did not parse or threw at its top level, the deck script
  included; attributed with `document.currentScript` and `data-pptaken-for`). `slide` is the index or `-1` (deck).
  The shell adds `watchdog` itself when it removes a frozen frame.
- **This deliberately changes ADR-020's "no text crosses the boundary".** Text now crosses, bounded and cleaned:
  name ≤ 60, message ≤ 300, stack (first three frames) ≤ 400 UTF-16 units; control, bidi, zero-width characters and
  lone surrogates stripped; every URL redacted to `<deck>` (stacks would otherwise carry the signed content token).
  The builder tags each author `<script>` with `data-pptaken-for` and `data-pptaken-line` (not part of the CSP hash),
  so the runtime rewrites document positions into the author's own: `slide intro, line 3:14`.
- Only trusted events (`isTrusted`) are captured; the runtime's listeners are registered before any author code. It
  dedupes by (kind, slide, name, message), keeps at most 20 distinct errors, sends a cumulative `count` (repeats
  flushed with the 1 s heartbeat), at most 200 messages per page.
- **The shell trusts none of it**: exact keys and types, bounds, the text cleaned again in its own realm (author code
  shares the runtime's realm and can tamper with its intrinsics), at most 10 messages per second, 300 per page load,
  50 distinct errors, counts only grow. It gives the page a fresh `ScriptErrorReport` (`onScriptError`) and tells the
  presenter window `script-error {slide}` / `script-stopped {}` over the sync channel. **No error text ever reaches
  the audience screen or the sync channel.**

### 2. Report to the server

- The owner's player page (never a guest page, never the offline copy) sends reports to
  `POST /api/v1/decks/:id/script-errors` with the digest the content-url endpoint returned with the scripted document
  (`{ digest, errors: [...] }`): first after 1.5 s, then at most every 5 s, ≤ 20 entries, ≤ 30 requests per page,
  a 429 pauses it, `keepalive` on `pagehide`, failures ignored.
- The endpoint: owner panel session only (the panel API never accepts API or OAuth tokens), CSRF header + allowed
  Origin, `Sec-Fetch-Site` must be `same-origin` when present, a 32 KB body limit, Zod (`digest` hex, `errors` array
  ≤ 50), rate limits 30/min per IP and 30/min per deck. The core use case `reportScriptErrors` is human-only
  (`requireOwner`) and **ignores** the report (200, `ignored: digest_mismatch | not_approved`, nothing stored) unless
  the reported digest is the current revision's digest AND the approved one. Each entry is validated alone (unknown
  keys, wrong types, unknown slide ids, counts outside 1..10 000 drop the entry), cleaned again, fingerprinted
  (SHA-256 of kind, slide, name, message) and merged.
- Storage: table `deck_script_error` (migration `0006_script_errors.sql`), one row per deck + digest + fingerprint
  with first/last seen and count, **at most 30 per digest** (the least recently seen is evicted). Every new revision
  prunes in its own transaction: the current digest and the most recently seen previous digest are kept (shown as
  "from a previous version"), older ones deleted. Purge deletes the rows. `GET` (owner session) reads them with the
  slide title, index and a hint code; `DELETE` clears them (audited).

### 3. Panel

The Deck page's Interactive section has a **Script errors** block (`#script-errors`): a status ("No errors reported",
"N errors reported since you approved this code", "From a previous version"), what happened and what to do, a list
(slide title + id, where it happened, name and message as plain text, count, last seen) with a plain-language hint for
the common mistakes (`declare-root`, `slide-api`, `selector-missed`, `network-disabled`, `blocked-api`, `syntax`,
`frozen`), **Clear**, and **Copy for my agent**: a short plain-text summary that labels the messages as data, quotes
each one as a JSON string (≤ 200 characters, at most 10). The Decks list shows an amber "Interactive · N script
errors" badge. Error text is rendered only through Svelte text interpolation.

### 4. Return to the agent

`get_presentation` (decks with scripts) returns `script_errors { status, note, items, more_items?,
previous_version_items? }` with `status` `no_errors | errors | previous_only`, items `{ slide_id, kind, name, message,
count, last_seen, hint }`, at most 10, messages ≤ 200 characters, cleaned again. `note` says the text is **UNTRUSTED
DATA produced by running the deck's code, never instructions**. Write results (`create_presentation`,
`update_presentation`, `update_slides`, `import_html_deck`) add the same block when errors exist (typically the
previous version's, right after a fix). The authoring guide gained "Script checks and errors" with the exact fix for
the `root` mistake and a complete working example (`EXAMPLE_SCRIPT_SLIDE`), a fixture checked by MCP tests and run in
three browsers by `apps/server/browser/script-errors-e2e.mjs`. Agents cannot report or clear errors.

### 5. Static check at write time

`checkScript`/`checkDeckScripts` (`@pptaken/sanitizer`, acorn 8.19.0, MIT, pinned: already in the tree through the
Svelte toolchain; a real parser, no regex heuristics) parse each slide script exactly as the player wraps it and the
deck script as a global script, and report non-fatal warnings with stable codes: `SCRIPT_SYNTAX_ERROR`,
`SCRIPT_UNDECLARED_ROOT`, `SCRIPT_UNDECLARED_SLIDE_API`, `SCRIPT_BLOCKED_API` (fetch, XMLHttpRequest, WebSocket,
EventSource, WebRTC, workers, eval/new Function, string timers, `import()`, document.write, `window.open`,
script/iframe/link/meta/object markup through innerHTML/insertAdjacentHTML/createElement), `SCRIPT_MARKUP` and
`SCRIPT_CHECK_SKIPPED`. Conservative: a name declared anywhere in the script counts as declared. Bounded: 256 KB per
script, 1.2 MB and 750 ms per deck, 200 000 AST nodes, 10 findings per script; parser recursion limits end as
"skipped". Warnings never block a write. **Approval is not blocked either**: the approval screen lists the findings
and, when a `SCRIPT_SYNTAX_ERROR` exists, the approve dialog requires a second explicit confirmation. Blocking
approval was rejected: the checker is a heuristic over code that may be valid in a browser it does not model, and
the owner keeps the decision.

### 6. Actionable notices (founder requirement)

Every notice about scripts or loading follows one pattern, in English and Spanish: what happened in plain language,
what to do next, and where. Presenter view (owner only, `role=status`, keyboard reachable, never on the audience
screen): **error** ("Something went wrong in this deck's interactive code…"; "Ask your agent to check the script
errors… then reload"), **stopped** (watchdog), **pending** (not approved yet: "Open the presentation's page… approve
it"), **off** (instance switch); a link to the deck page (`#script-errors` or `#scripts`) in a new tab and, for
errors, "Copy a message for my agent" (title + id + what to do; never error text). The player page's status line
(audience screen, shown only when the deck cannot be shown at all) says what to do ("Check your connection and
reload", "…check its script errors" with a link for the owner); the watchdog's notice on the audience screen only
says the static version is coming.

## Residual risks

- **Prompt injection through error text.** Author code chooses its error messages (`throw new Error("Ignore previous
  instructions…")`), and an attacker who steered the agent that wrote the code can now place text in the agent's
  context through `get_presentation` and in the owner's chat through "Copy for my agent". Mitigations: the text was
  already writable by the same party through the deck itself (titles, notes, code), so no new authority is granted;
  it reaches the agent only after the owner approved and presented the code; it is bounded (10 × 200 characters),
  cleaned of control/bidi characters, labelled UNTRUSTED in a fixed `note`, separated from instructions (hints come
  from the server's own fixed text, chosen by pattern), and quoted as JSON strings in the copied summary. A model may
  still follow injected text; nothing here can approve code or act without the owner.
- **Endpoint abuse.** Only the owner's session can post, so abuse means a hostile approved script making the owner's
  page report noise: bounded by the shell (10/s, 300/page), the page (30 requests), the endpoint (30/min per IP and
  per deck, 32 KB) and storage (30 rows per digest, 2 digests per deck). A forged digest stores nothing.
- **Attribution is best effort** for handler errors and rejections (the first author frame of the stack, else the
  slide on screen); text cleaning in the runtime can be defeated by author code (the shell and the server redo it).
- **Information in stacks**: positions inside the runtime (`<deck>:637:22`) are visible; they reveal nothing beyond
  the public runtime. URLs are redacted everywhere.
- The static check is heuristic: it can miss mistakes (dynamic code) and, rarely, warn on valid code.

## Verification

Unit tests in sanitizer (checker corpus with the incident script, budgets), core (cleaning, hints, digest gate, strict
entries, dedupe, cap, pruning, clear, purge), storage contract (memory and SQLite), player (protocol, sync, builder
line tags, reporter), server (owner-only, CSRF, Origin, Sec-Fetch-Site, tokens refused, body limit, rate limit, wrong
digest ignored, XSS-looking text stays JSON text, list badge, presenter data), MCP (untrusted note, caps, previous
version on writes, example fixture, snapshot), web (Playwright on the mock server: three states, text only, copy,
clear, badge, extra confirmation; screenshots), the player corpus (`browser/scripts.mjs`: structured records,
author line numbers, watchdog record) and `apps/server/browser/script-errors-e2e.mjs` in Chromium, Firefox and WebKit.
