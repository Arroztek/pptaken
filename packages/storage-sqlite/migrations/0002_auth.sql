-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0002_auth: the self-hosted owner account, panel sessions, API tokens, auth settings (the install code) and the
-- last MCP call (for the panel's "agent connected" state). Used by @pptaken/auth-local through the adapter in
-- src/auth.ts. Secrets are never stored: only hashes (SHA-256 for random 256-bit values, scrypt for the password,
-- HMAC for the install code).

CREATE TABLE auth_owner (
  workspace_id  TEXT    NOT NULL DEFAULT 'default',
  id            TEXT    NOT NULL, -- ULID
  password_hash TEXT    NOT NULL, -- "$scrypt$ln=..,r=..,p=..$<salt>$<hash>"
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- A workspace has exactly one owner in the self-hosted edition.
CREATE UNIQUE INDEX auth_owner_single ON auth_owner (workspace_id);

CREATE TABLE auth_session (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  id_hash      TEXT    NOT NULL, -- SHA-256 hex of the random session id held in the cookie
  owner_id     TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL, -- sliding
  PRIMARY KEY (workspace_id, id_hash),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES auth_owner (workspace_id, id)
);

CREATE INDEX auth_session_by_expiry ON auth_session (workspace_id, expires_at);

CREATE TABLE api_token (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  id           TEXT    NOT NULL, -- ULID
  name         TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL, -- SHA-256 hex of the secret "ppt_..."
  scopes       TEXT    NOT NULL, -- JSON array of scope names
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER,
  PRIMARY KEY (workspace_id, id)
);

-- Tokens are looked up by hash (the secret carries no workspace); hashes are unique instance-wide.
CREATE UNIQUE INDEX api_token_by_hash ON api_token (token_hash);

CREATE TABLE auth_setting (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  key          TEXT    NOT NULL, -- e.g. 'install_code' (value: HMAC of the code)
  value        TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- One row per workspace: the most recent MCP call served with an API token.
CREATE TABLE mcp_activity (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  last_call_at INTEGER NOT NULL,
  last_tool    TEXT,
  client_name  TEXT,
  token_id     TEXT,
  PRIMARY KEY (workspace_id)
);
