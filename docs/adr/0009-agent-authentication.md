# ADR-009 · Agent authentication: API token + built-in OAuth 2.1 server

**Verified context.** Claude Code accepts fixed headers. claude.ai/Desktop/mobile only guarantee OAuth (or no authentication); fixed headers are in restricted beta. For OAuth, Claude requires: a `401` response with `WWW-Authenticate: Bearer resource_metadata=…`, RFC 9728 and RFC 8414 metadata, PKCE S256, and it accepts CIMD (if the server announces `client_id_metadata_document_supported: true` and `"none"` in `token_endpoint_auth_methods_supported`) or DCR. Return URI: `https://claude.ai/api/mcp/auth_callback` for the hosted apps, and *loopback* with a variable port for Claude Code.

**Options.**
1. API token only → leaves out claude.ai, which is where our target user is.
2. No authentication with a secret in the URL (`/mcp/<secret>`) → it would work with "No sign-in", but secrets in URLs end up in logs and histories; the specification forbids tokens in the *query* and Anthropic's documentation discourages it. Discarded.
3. Require an external identity provider (Keycloak, Auth0…) → unacceptable for "one command".
4. **A minimal built-in authorization server** → our work, but zero configuration for the user.

**Decision.** Options 1 + 4 combined:
- **API tokens** (`ppt_…`, 256 bits, only the hash is stored, scopes, optional expiry). The path for Claude Code and any script.
- **A built-in OAuth 2.1 authorization server, deliberately small**: only the *authorization code* flow + PKCE S256, public clients, CIMD as the preferred mechanism and DCR for compatibility, rotated *refresh tokens*, the `iss` parameter (RFC 9207), audience binding (RFC 8707). The consent screen requires the owner's session.
- Both produce the same internal object `Principal { actor: 'agent', scopes, tokenId }`.
- All behind the `AuthProvider` interface: the cloud will replace it with a multi-tenant OIDC provider.

**Consequences.** (+) Works with every Claude client without external services. (−) Implementing OAuth is delicate: it is kept to the minimum, tested against the specification and reviewed before 1.0. **Assumption to verify:** whether SDK v2 ships reusable authorization-server utilities (v1 did); if not, an audited library is evaluated before writing it by hand.
