-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0001_init: presentations, immutable revisions, assets, audit log and idempotency keys.
--
-- Portable SQL rules (a Postgres adapter will mirror this schema): simple types only (TEXT, INTEGER), JSON stored
-- as TEXT, timestamps as epoch-millisecond INTEGERs, ULID identifiers as TEXT. Every table carries workspace_id
-- (always 'default' in the self-hosted edition) as the first column of its primary key.
-- Later phases (share links, quizzes, live sessions, API tokens, OAuth) add their own numbered migrations.

CREATE TABLE deck (
  workspace_id     TEXT    NOT NULL DEFAULT 'default',
  id               TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  lang             TEXT,
  current_revision INTEGER NOT NULL,
  slide_count      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  created_by_actor TEXT    NOT NULL,
  created_by_token TEXT,
  PRIMARY KEY (workspace_id, id)
);

-- Listing newest first walks the primary key backwards; this partial index serves the trash retention sweep.
CREATE INDEX deck_trash ON deck (workspace_id, deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE revision (
  workspace_id     TEXT    NOT NULL DEFAULT 'default',
  deck_id          TEXT    NOT NULL,
  number           INTEGER NOT NULL,
  document         TEXT    NOT NULL, -- sanitized deck envelope (JSON)
  title            TEXT    NOT NULL,
  slide_count      INTEGER NOT NULL,
  summary          TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  created_by_actor TEXT    NOT NULL,
  created_by_token TEXT,
  PRIMARY KEY (workspace_id, deck_id, number),
  FOREIGN KEY (workspace_id, deck_id) REFERENCES deck (workspace_id, id)
);

CREATE TABLE asset (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  sha256       TEXT    NOT NULL, -- 64 lowercase hex; the blob key
  media_type   TEXT    NOT NULL,
  bytes        INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, sha256)
);

-- Blobs are shared across workspaces: the garbage collector asks whether any workspace references a hash.
CREATE INDEX asset_by_sha256 ON asset (sha256);

CREATE TABLE deck_asset (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  deck_id      TEXT    NOT NULL,
  sha256       TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, deck_id, sha256),
  FOREIGN KEY (workspace_id, deck_id) REFERENCES deck (workspace_id, id),
  FOREIGN KEY (workspace_id, sha256) REFERENCES asset (workspace_id, sha256)
);

CREATE INDEX deck_asset_by_asset ON deck_asset (workspace_id, sha256);

CREATE TABLE audit_log (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  id           TEXT    NOT NULL, -- ULID: sorts by time
  at           INTEGER NOT NULL,
  actor        TEXT    NOT NULL,
  token_id     TEXT,
  action       TEXT    NOT NULL,
  target       TEXT,
  ip           TEXT,
  result       TEXT    NOT NULL,
  detail       TEXT, -- JSON
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX audit_log_by_target ON audit_log (workspace_id, target, id);

CREATE TABLE idempotency_key (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  key          TEXT    NOT NULL, -- principal-scoped: actor:token:client key
  request_hash TEXT    NOT NULL,
  deck_id      TEXT    NOT NULL,
  result       TEXT    NOT NULL, -- JSON
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, key),
  FOREIGN KEY (workspace_id, deck_id) REFERENCES deck (workspace_id, id)
);

CREATE INDEX idempotency_key_by_deck ON idempotency_key (workspace_id, deck_id);
