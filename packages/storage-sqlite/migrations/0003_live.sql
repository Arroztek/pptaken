-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0003_live: live sessions and remote pairing (phase F4, ADR-0017). The screen's position {slide, step, black} is
-- NOT stored: it lives in the in-memory hub and the screen re-announces it after a restart. Secrets are never
-- stored: only SHA-256 hashes of the one-time pairing secrets (128 bits) and of the device credentials (256 bits).

CREATE TABLE live_session (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  id           TEXT    NOT NULL, -- ULID
  deck_id      TEXT    NOT NULL,
  revision     INTEGER NOT NULL, -- the revision the screen loaded most recently
  started_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL, -- hard end: started_at + 12 h
  ended_at     INTEGER,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX live_session_by_deck ON live_session (workspace_id, deck_id, ended_at, expires_at);

CREATE TABLE live_pairing (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  live_id      TEXT    NOT NULL,
  secret_hash  TEXT    NOT NULL, -- SHA-256 hex of the one-time secret shown in the QR code
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL, -- created_at + 2 min
  redeemed_at  INTEGER,
  PRIMARY KEY (secret_hash),
  FOREIGN KEY (workspace_id, live_id) REFERENCES live_session (workspace_id, id)
);

CREATE INDEX live_pairing_by_session ON live_pairing (workspace_id, live_id);

CREATE TABLE live_device (
  workspace_id    TEXT    NOT NULL DEFAULT 'default',
  id              TEXT    NOT NULL, -- ULID
  live_id         TEXT    NOT NULL,
  credential_hash TEXT    NOT NULL, -- SHA-256 hex of the device credential kept by the phone
  label           TEXT    NOT NULL, -- e.g. "Android · Chrome", derived from the User-Agent
  code            TEXT    NOT NULL, -- two digits shown on the phone and in the approval prompt
  status          TEXT    NOT NULL CHECK (status IN ('pending', 'approved')),
  created_at      INTEGER NOT NULL,
  approved_at     INTEGER,
  revoked_at      INTEGER,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, live_id) REFERENCES live_session (workspace_id, id)
);

-- Credentials are looked up by hash (the credential carries no workspace); hashes are unique instance-wide.
CREATE UNIQUE INDEX live_device_by_credential ON live_device (credential_hash);
CREATE INDEX live_device_by_session ON live_device (workspace_id, live_id, revoked_at);
