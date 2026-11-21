# ADR-026 · Public links

**Status:** accepted (2026-11-20). Builds on [ADR-020](0020-interactive-mode.md) (interactive mode),
[ADR-021](0021-presenter-password-and-approval-screen.md) (presenter password, unlock, guest page),
[ADR-024](0024-approval-trust-lineage.md) (trust lineage) and [ADR-014](0014-immutable-revisions-soft-delete.md)
(trash). Related: [HTTP API](../spec/http-api.md), [player](../spec/player.md),
[security](../foundation/04-security-and-auth.md) §12.4, [sharing guide](../guides/sharing.md).

## Context

Until now a presentation opened only in the owner's signed-in browser (`/p/<deck>`). The founder's product principle
is "you hand over your presentation, PPTaken hosts it, you just present": a deck must be easy to show to people
without an account, and to present from a computer that is not the owner's (a conference PC, a colleague's laptop).
ADR-021 prepared the guest side (a view grant accepted by `content-url`, the presenter-password unlock, a test-only
guest page) and left "phase F5 links" open. The future audience tools (Q&A, quiz) also need no-account access; they
are not built here, but nothing below may block them.

## Decision

### 1. Two kinds of link, one URL shape

`/s/<secret>`, the kind stored on the server:

- **View link**: read-only. The simple (static) version of the deck, never author scripts, never speaker notes, no
  presenter window, no unlock dialog, no phone remote, no printing (`P` off, the browser prints a blank page), no
  export (export routes need the owner session). Keyboard and click navigation and the slide overview work.
- **Presenter link**: the player with the presenter experience on that computer: the presenter window (`S`,
  `/s/<secret>/presenter`) with notes, clock and next slide; keys, overview, full screen. It **reveals the speaker
  notes**, and the Share panel says so plainly. Interactive parts stay off until the presenter types the presenter
  password (`U`, ADR-021), and only for code the owner approved **with a click** (ADR-024 `ownerDigest`). A
  presenter link never grants API access, panel access or approval powers.

Each link: an optional private label (≤ 80 characters, plain text, control/bidi/invisible characters removed), an
optional expiry (never / 1 / 7 / 30 days / a date within a year), an optional **frozen revision** (default: it
follows the latest revision), turn off at any time, several links per deck. Retention never deletes a revision a link
is frozen on.

### 2. Secrets: hashed for lookup, sealed so the owner can see the link again

- 128 bits from the CSPRNG, base64url (22 characters).
- Stored as `secret_hash` = HMAC-SHA256 under the HKDF subkey `share-link-lookup` (a unique index; one equality
  lookup, then a constant-time compare) and `sealed_secret` = AES-256-GCM under the subkey `share-link-seal`, random
  96-bit nonce, the link id as additional data (a sealed value cannot be moved to another row).
- **Recoverable on purpose.** The owner must be able to copy a link again from the Share panel (people lose the
  message; a presenter asks for the link the day of the talk). The trade-off: someone with the database AND the
  instance secret can recover live links. Both together already give full control of the instance (sessions, tokens,
  content), so this adds no new capability to that attacker; the database alone reveals nothing (no secret, no
  usable hash without the key).
- **Key rotation story.** Rotating `secret.key` changes both subkeys: every link stops working at once and the panel
  shows "this link cannot be shown anymore; stop it and make a new one". A rotation is therefore also a "turn every
  link off" button, which is what someone rotating a possibly leaked key wants.

### 3. Serving a link

`GET /s/<secret>` (and `/s/<secret>/presenter` for presenter links) is a trusted page without a session:

1. Per-IP page limit (300/min: a whole audience may share one NAT address); a guessing pause before any lookup: 20 failed lookups per 10 min per IP and 300 per
   10 min instance-wide (a calm 429 page with `Retry-After`).
2. The switches: `PPTAKEN_PUBLIC_LINKS` (operator, default `on`) and the owner's Settings "Allow links that open
   without an account" (default on). Off: the generic page.
3. One keyed hash of the path segment (a decoy hash for malformed input, so every request does the same work), one
   indexed lookup, a constant-time compare, then the state checks (not turned off, not expired, deck not in the trash,
   frozen revision present).
4. **Every failure answers the same 404 page, byte for byte** for a given `Accept-Language` (English or Spanish):
   "This link is not available anymore. Ask the person who shared it for a new one." Unknown, malformed, turned off,
   expired, trashed, switched off, a view link asking for `/presenter`, any other path or method under `/s/`.
5. Success: the player page (`data-viewer="guest"`, `data-kind`) with a **link grant** embedded. Headers:
   `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`,
   the player CSP (`frame-ancestors 'none'`, no third-party source), `X-Frame-Options: DENY`; no cookie is set.

The **link grant** (`X-PPTaken-View`, purpose `link`, subject `<deck>:<link id>:<kind>`, 8 h, content subkey) is
checked AND the link is looked up again on every use: `content-url`, the guest presenter data
(`GET /api/v1/share/<deck>/presenter`, presenter links only), the opening counter
(`POST /api/v1/share/<deck>/opened`) and the unlock. From it, `content-url` mints **link-bound content tokens**
(`ldoc` `<deck>:<rev>:<link>`, `lsdoc` `<deck>:<rev>:<digest>:<link>`, 5 minutes) whose documents carry link-bound
asset URLs (`lasset` `<deck>:<link>`); the content routes re-check the link on every request. **Turning a link off
(or the trash, an expiry, a switch) stops new grants, document loads and image loads at once**, which is stronger
than the required "within the document TTL".

The test-only guest route of ADR-021 keeps its deck-only `view` grant; it is honoured only on a server created with
`testRoutes` (never in production) and behaves as a presenter link without a link id.

### 4. Unlock scoped to presenter links

`POST /api/v1/presenter/unlock` now also requires the page's grant of a **presenter** link of that deck: a view link,
a dead link or no grant fails exactly like a wrong password, after the same work (scrypt + deck read), and counts
against the same limits (ADR-021). The unlock token's subject gains the link id
(`<deck>:<digest>:<epoch>:<link id>`): an unlock made through one link cannot be replayed through another, and dies
with its link. A frozen presenter link unlocks only if its revision's code is the approved one.

### 5. Management (owner only)

Owner session + CSRF, audited by link id (`share:<id>`, never the secret or the label):
`GET/POST /api/v1/decks/:id/links`, `PATCH`/`DELETE /api/v1/decks/:id/links/:linkId`, `DELETE /api/v1/decks/:id/links`
(turn off all). The list carries the URL, kind, label, state (active/expired), dates, frozen revision, last opened and
the opening count; no IPs, no user agents. Limits: 50 active links per deck, 500 per instance (`LIMIT_EXCEEDED` → 409).
The core refuses every actor but the owner (`FORBIDDEN_ACTOR`); there is no MCP tool. `get_presentation_links` keeps
returning `urls.present`/`urls.manage` and reports `public_links: { active_count }`, a count only.

### 6. Trash, restore, purge

- Moving a deck to the trash turns its active links off **in the same transaction** (`revoked_reason = 'trash'`).
- Restoring keeps them off **unless the owner confirms**: the Trash page asks "Turn those links back on" (unchecked by
  default) when the trash turned links off; `POST /decks/:id/restore {restoreLinks: true}`. Only links the trash
  turned off come back (links the owner turned off stay off; expired ones stay expired). The panel's **Undo** right
  after a deletion restores them too: the owner just confirmed "This also turns off N shared links" and is taking
  that action back.
- Permanent deletion removes the rows.

### 7. Counting openings without a side-effecting GET

`GET /s/*` stays side-effect free (it reads and signs; failed lookups only take in-memory rate-limit tokens). The page
itself counts one opening with `POST /api/v1/share/<deck>/opened` (grant + CSRF header; guest calls are limited to 1200/min per link). Link-preview
bots that only fetch the URL never count.

### 8. Offline

A guest page preloads the deck in memory (offline layer 1), so a network drop during the talk does not stop it. The
persistent offline copy (layer 2, service worker scoped to `/p/`) is **not** applied to guests: it would leave a copy
of the deck on a computer the owner does not control, outliving the link and its revocation, and the worker would
have to store pages that carry the grant. Documented as later work (an opt-in "allow offline copies" per presenter
link).

### 9. Panel UX

A "Share" action next to Present on the deck page opens a dialog: two plain choices ("Anyone with the link can
watch"; "For the person who will present", badge "Includes your notes" and a one-line notes warning), the presenter
password line ("Interactive parts need your presenter password on that computer", with a link to set one when none
exists, shown only when interactive mode is on), when the link stops working, an optional name, "Freeze this
version", Create. Then the link with Copy and a QR code (drawn from the server's pinned encoder `/_rt/qr.js`). The
list: name, kind, end date, last opened, Copy, Stop sharing (asked inline), Turn on 7 more days for expired links,
Stop all. A quiet "Shared" chip on the deck list only when links are active and nothing more urgent needs a chip.
Delete confirmations say "This also turns off N shared links". Developer details add the link id.

## Threat analysis

See [security](../foundation/04-security-and-auth.md) §12.4 (T36–T47). In short: guessing (128 bits, keyed hash,
rate limits, generic answer), leakage through Referer/logs/caches/indexing (no-referrer, path redaction to
`/s/<link>` in logs, no-store, noindex, audit by id), forwarding (accepted: expiry, turn off, labels, freeze), notes
exposure (presenter links only, said plainly), scripts (never on view links; presenter links only after the presenter
password and only for owner-clicked digests), embedding (`frame-ancestors 'none'`), CSRF (guest endpoints carry no
ambient authority; POSTs still need the CSRF header and same origin), revoke latency (immediate), trash semantics, DoS
limits, and agent prompt injection (agents cannot create, list or turn off links).

## Consequences

- (+) The owner shares a deck in two clicks; a guest needs no account; the presenter gets notes and, with the presenter
  password, the approved interactive parts.
- (+) A turned-off link stops everything at once, including an already open page's later loads.
- (+) The guest grant, generic failure page and per-link limits are the base the audience tools (Q&A, quiz) can reuse
  for no-account access.
- (−) Recoverable secrets: whoever holds the database and the instance key can list live links (documented above).
- (−) No persistent offline copy for guests in this release.
- (−) A distributed guesser can pause link pages for everyone for up to 10 minutes (the global failure cap): the
  price of keeping guessing bounded without accounts.

## Verification (2026-11-20)

Vitest: auth-local (secret entropy and format, keyed hash, sealing, rotation), core (`share-links.test.ts`: owner
only, agents count only, validation and label cleaning, limits, generic resolve, expiry/extend, follow/freeze,
retention keeps frozen revisions, openings, trash/restore/purge, audit without secret or label), storage contract
(SQLite and memory), server (`share-links.test.ts`: management, CSRF, tokens refused, generic 404 byte for byte,
equal lookup work, headers, rate limits, switches, view links static with no notes/unlock/presenter data/export,
binding to deck and revision, revocation of grants/documents/assets, counter on POST only, presenter links with notes
and unlock bound to the link, guests never run automatic approvals, trash/restore/purge, logs and audit without the
secret), MCP (`get_presentation_links` count only). Playwright on the mock server (`share.spec.ts` in Chromium, Firefox
and WebKit; Share screens at 360/768/1280, light/dark, en/es). Real server: `apps/server/browser/share-e2e.mjs`, 10
checks per engine in Chromium, Firefox and WebKit.
