-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0008_share_links: public links of a presentation (ADR-026).
--
-- secret_hash:     keyed lookup hash of the link secret (HMAC-SHA256 under an instance subkey), unique.
-- sealed_secret:   AES-256-GCM copy of the secret under another instance subkey (bound to the link id), so the
--                  owner's panel can show the link again. Never the secret in clear.
-- kind:            'view' (simple version, no notes) or 'presenter' (presenter view with notes; unlockable).
-- label:           the owner's private label, plain text, at most 80 characters.
-- expires_at:      epoch ms, NULL: never expires.
-- pinned_revision: a revision the link is frozen on, NULL: follows the latest revision.
-- revoked_at, revoked_reason: when and why the link stopped ('owner' or 'trash'); a revoked link never works again
--                  unless the owner restores the deck from the trash and asks to turn its links back on.
-- last_opened_at, open_count: how many times the guest page was opened (no IP, no user agent).

CREATE TABLE share_link (
  workspace_id    TEXT    NOT NULL,
  id              TEXT    NOT NULL,
  deck_id         TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('view', 'presenter')),
  label           TEXT    NOT NULL DEFAULT '',
  secret_hash     TEXT    NOT NULL,
  sealed_secret   TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  pinned_revision INTEGER,
  revoked_at      INTEGER,
  revoked_reason  TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN ('owner', 'trash')),
  last_opened_at  INTEGER,
  open_count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, deck_id) REFERENCES deck (workspace_id, id)
);

CREATE UNIQUE INDEX share_link_secret ON share_link (secret_hash);
CREATE INDEX share_link_deck ON share_link (workspace_id, deck_id);
