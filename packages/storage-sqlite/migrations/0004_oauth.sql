-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0004_oauth: the OAuth 2.1 authorization server (ADR-0018). Clients (DCR registrations, and CIMD clients once the
-- owner approved one), grants (one per approval; the grant id is the Principal's tokenId), one-time authorization
-- codes and access/refresh tokens. Secrets are never stored: codes and tokens only as SHA-256 hex. Deleting a grant
-- deletes its codes and tokens; deleting a client deletes its grants.

CREATE TABLE oauth_clients (
  workspace_id  TEXT    NOT NULL DEFAULT 'default',
  id            TEXT    NOT NULL, -- pptc_… (DCR) or the metadata document URL (CIMD)
  kind          TEXT    NOT NULL CHECK (kind IN ('dcr', 'cimd')),
  name          TEXT,             -- client-supplied, untrusted (sanitized for display)
  redirect_uris TEXT    NOT NULL, -- JSON array
  metadata      TEXT    NOT NULL, -- JSON echoed by POST /oauth/register
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE oauth_grants (
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  id           TEXT    NOT NULL, -- ULID
  client_id    TEXT    NOT NULL,
  client_name  TEXT,
  redirect_uri TEXT    NOT NULL,
  scopes       TEXT    NOT NULL, -- JSON array
  resource     TEXT    NOT NULL, -- canonical audience, <issuer>/mcp
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER NOT NULL, -- newest refresh token's expiry (sliding)
  revoked_at   INTEGER,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, client_id) REFERENCES oauth_clients (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX oauth_grants_by_client ON oauth_grants (workspace_id, client_id);

CREATE TABLE oauth_codes (
  code_hash      TEXT    NOT NULL PRIMARY KEY, -- SHA-256 hex of the 256-bit code
  workspace_id   TEXT    NOT NULL DEFAULT 'default',
  grant_id       TEXT    NOT NULL,
  client_id      TEXT    NOT NULL,
  redirect_uri   TEXT    NOT NULL,
  code_challenge TEXT    NOT NULL, -- PKCE S256
  resource       TEXT    NOT NULL,
  scopes         TEXT    NOT NULL, -- JSON array
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL, -- created_at + 60 s
  used_at        INTEGER,
  FOREIGN KEY (workspace_id, grant_id) REFERENCES oauth_grants (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX oauth_codes_by_grant ON oauth_codes (workspace_id, grant_id);

CREATE TABLE oauth_tokens (
  token_hash   TEXT    NOT NULL PRIMARY KEY, -- SHA-256 hex of ppto_… / pptr_…
  workspace_id TEXT    NOT NULL DEFAULT 'default',
  grant_id     TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  replaced_by  TEXT,              -- refresh tokens: hash of the successor after rotation
  rotated_at   INTEGER,
  FOREIGN KEY (workspace_id, grant_id) REFERENCES oauth_grants (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX oauth_tokens_by_grant ON oauth_tokens (workspace_id, grant_id);
CREATE INDEX oauth_tokens_by_expiry ON oauth_tokens (workspace_id, expires_at);
