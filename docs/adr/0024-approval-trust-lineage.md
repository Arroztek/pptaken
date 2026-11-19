# ADR-024 · Approval bound to a trust lineage (automatic interactive updates)

**Status:** accepted (2026-11-18). Amends [ADR-020](0020-interactive-mode.md) (approval binds a digest) and
[ADR-021](0021-presenter-password-and-approval-screen.md) (approval screen). Related: [ADR-022](0022-vendoring-and-html-importer.md)
(vendored libraries), [ADR-023](0023-script-error-visibility.md) (script errors), [HTTP API](../spec/http-api.md),
[interactive decks guide](../guides/interactive-decks.md), [UX audit 2026-11](../guides/ux-audit-2026-11.md).

## Context

ADR-020 binds the owner's approval to one exact scripts digest. Every agent edit of a slide script changes the digest,
so every edit sent the deck back to "pending" and the owner had to read code and click again. For the people PPTaken
is for (an executive, a teacher) that is friction with no matching benefit: they cannot judge the diff, they just want
to present, and the agent that edits the code is the same agent they already trusted on the first approval. The UX
principle is "secure defaults the user never notices; ask only when a real decision exists, in one sentence, with one
click". The real decision is new **third-party** code, not the owner's own agent polishing a chart.

## Decision

### 1. The lineage

- An explicit owner approval (`POST /api/v1/decks/:id/scripts/approve`, panel session + CSRF, unchanged) starts a
  **trust lineage** for the deck. The approval record now stores: `mode` (`owner` | `auto`), `ownerDigest` (the last
  digest the owner approved with a click), `trustedLibs` (every library approved anywhere in the lineage, as
  `"<sha256> <source URL>"` keys) and `previousRevision` (for `auto`, the revision whose code was replaced).
  Migration `0007_trust_lineage` adds the columns; existing rows become `mode = owner`, `ownerDigest = approved_digest`.
- **The server, never a caller, decides** whether a write continues the lineage. It runs inside the write's own
  transaction (`commitRevision`), for every revision-creating use case (create is excluded by construction: no
  approval exists yet). The rule (`lineageDecision`, pure, in `@pptaken/core`) continues the lineage only when ALL hold:
  1. the instance runs scripts (`PPTAKEN_SCRIPTS=owner`);
  2. the owner's setting **"Allow interactive updates automatically"** is on (default on; stored server-side; changeable
     only from the owner's panel session; read before the transaction; any failure reading it = off);
  3. the code being replaced was approved: `approval.digest == digest(previous revision)`; so a revoked deck, a deck
     never approved, or a deck that already waits for the owner (stale) never resumes on its own;
  4. the new digest is different and not empty;
  5. every library of the new code is in the trusted set (the lineage's `trustedLibs` plus the libraries of the
     approved previous version): **same content hash AND same source URL**. A new origin, or new bytes behind a known
     URL or name, is new third-party code.
- When it continues, the approval moves to the new digest with `mode: auto`, the same `ownerDigest` and trusted set,
  and `presentation.scripts_auto_approve` is audited (actor = the writer, `rule: trust_lineage`, previous digest,
  owner digest, revision). When the rule fails because of a new library or the setting being off,
  `presentation.scripts_lineage_break` is audited with the reason (and the new libraries). Nothing else changes: the old
  approval stays, so the deck shows its simple version until the owner clicks.
- A new explicit approval extends the trusted set with the current libraries. Revoke deletes the record: the lineage ends.

### 2. What never changes

- **No agent-callable API can approve.** The approval and settings routes accept only the owner's panel session (no API
  or OAuth tokens), with CSRF; the core still refuses `approveScripts` for any actor but the owner. The agent cannot
  turn the setting on, cannot start a lineage, and cannot resume a broken one.
- **Guest contexts never run automatically approved code.** The presenter-password unlock (`unlockableDigest`) and the
  guest branch of `content-url` require `ownerDigest == current digest`: screens without the owner's session run only
  code the owner clicked for. The owner's own player and presenter view run `auto` code.
- The instance switch, the no-network CSP, lockdown, the separate-site content option, offline and exports always
  static, and script-error reporting (ADR-023) are unchanged.

### 3. What the owner sees

- The deck page says, in plain words: "Updated by Claude {time}; allowed automatically." with **Review changes**
  (previous vs current code, side by side: `GET /decks/:id/scripts` returns `previous` for `auto` approvals) and
  **Turn interactive parts off for this presentation** (revoke).
- When a click is needed, the agent gets `interactive.message_for_user`: one family-friendly sentence in the instance
  language (`PPTAKEN_LANG`, es* → Spanish), with the one-click link `approve_url` (`/decks/:id/approve`), and a `reason`
  (`first_time`, `new_library`, `every_change`). The guide tells the agent to relay it word for word. When the edit was
  allowed automatically the result says `approved` (+ `allowed_automatically`) and the agent says nothing alarming.

## Adversarial review: residual risk

**The main residual risk is accepted on purpose:** after one approval, a prompt-injected agent (or an attacker holding
the agent's token) can swap the deck's own script code for different code and it will run in the owner's browser the
next time the owner presents, without a new click. Under ADR-020 that needed one more owner click on code most owners
would not read anyway.

What still bounds it:

- **No network.** Author code runs in the sandboxed frame under a CSP with no `connect-src`, no frames, no workers,
  no `eval`; it cannot exfiltrate or fetch anything (ADR-020 §5).
- **No new third-party code without a click.** Swapping in a different library (new URL or new bytes) breaks the
  lineage: the classic supply-chain path (point `libs` at a hostile CDN file) always needs the owner.
- **Owner-only execution.** `auto` code runs only in the owner's signed-in session; never on presenter-password screens
  (guest), phones, the presenter preview, exports or offline copies.
- **Lockdown and isolation** (frozen intrinsics, separate origin or site for content, watchdog) and the slide-scoped
  API stay as before; what code can do is what an approved script could already do.
- **Visibility.** Every automatic approval is in the audit log and on the deck page with the time and **Review changes**;
  script errors still flow back (ADR-023).
- **Revoke and the setting.** One click turns a deck's interactive parts off; one setting returns to "ask for every
  change" for all decks (it is enforced at the next write).
- **Token hygiene.** The agent's access key (or OAuth grant) can be revoked from Connected apps; the edits it already
  made stay audited.

Other cases considered:

- *Agent re-adds an old trusted library after removing it:* allowed (same hash and URL were approved).
- *Agent restores an old revision whose code was never approved:* if its libraries are all trusted and the current code
  is approved, it is a code change like any other and continues the lineage (same risk class as above).
- *Agent edits while the deck is stale:* stays pending (rule 3); the owner's next click restarts the lineage.
- *Race: owner revokes while an agent write is in flight:* both are serializable transactions; whichever commits second
  sees the other's result (a revoke after the write leaves no approval; a write after the revoke finds none).
- *Settings store unavailable:* fails closed (no automatic approval).

## Consequences

- Most agent edits of interactive decks need no click; the click count of "update an interactive deck" drops from 3–4
  to 0 (see the UX audit). New outside code costs exactly one click from a one-click link.
- `ScriptApprovalRecord` gains four fields (storage contract updated); `ScriptsStatus` gains `approvalMode`,
  `ownerApproved`, `newLibs`, `previousRevision`; the review gains `previous`.
- Library consumers of `@pptaken/core` without a `trust` policy keep ADR-020 behaviour (no automatic approval).
- Tests: `packages/core/test/trust-lineage.test.ts` (rule and write path, negatives: new source, new bytes, setting
  off, failing policy, revoke, stale, no policy, agent approve refused), `apps/server/test/trash-and-lineage.test.ts`
  (settings route owner-only, guest exclusion, token refusals), MCP `message_for_user`, and the panel e2e
  `approval.spec.ts`.
