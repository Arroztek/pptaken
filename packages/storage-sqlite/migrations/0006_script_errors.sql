-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0006_script_errors: author-script failures reported by the owner's player (script error visibility, ADR-023).
--
-- One row per distinct error (fingerprint = SHA-256 of kind, slide, name and message) per deck and scripts digest.
-- Every text column comes from code that ran in the sandboxed frame: it is untrusted, bounded and cleaned by the
-- core before it is stored, and is only ever displayed as plain text. The core keeps at most 30 rows per digest,
-- keeps only the current digest and the most recent previous one when a deck's code changes, and deletes every row
-- of a deck before the deck itself on permanent deletion.

CREATE TABLE deck_script_error (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  deck_id      TEXT    NOT NULL,
  digest       TEXT    NOT NULL, -- 64 lowercase hex: the scripts digest the page ran
  fingerprint  TEXT    NOT NULL, -- 64 lowercase hex
  kind         TEXT    NOT NULL CHECK (kind IN ('setup', 'handler', 'rejection', 'script-load', 'watchdog')),
  slide_id     TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  message      TEXT    NOT NULL,
  stack        TEXT    NOT NULL,
  count        INTEGER NOT NULL CHECK (count >= 1),
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, deck_id, digest, fingerprint),
  FOREIGN KEY (workspace_id, deck_id) REFERENCES deck (workspace_id, id)
);

CREATE INDEX deck_script_error_by_deck ON deck_script_error (workspace_id, deck_id, last_seen DESC);
