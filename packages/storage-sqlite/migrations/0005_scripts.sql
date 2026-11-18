-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0005_scripts: the owner's approval of a deck's author scripts (interactive mode, ADR-020).
--
-- One row per deck: the scripts digest the owner approved, when and by which actor. The current state
-- (none | pending | approved) is derived by comparing this digest with the digest of the deck's current revision,
-- computed from the immutable revision document, so it can never go stale. The row is replaced on approval,
-- deleted on revocation and deleted before the deck itself on permanent deletion.

CREATE TABLE deck_scripts_approval (
  workspace_id      TEXT    NOT NULL DEFAULT 'default',
  deck_id           TEXT    NOT NULL,
  approved_digest   TEXT    NOT NULL, -- 64 lowercase hex
  approved_at       INTEGER NOT NULL,
  approved_by_actor TEXT    NOT NULL,
  approved_by_token TEXT,
  PRIMARY KEY (workspace_id, deck_id),
  FOREIGN KEY (workspace_id, deck_id) REFERENCES deck (workspace_id, id)
);
