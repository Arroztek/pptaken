# @pptaken/auth-local

Authentication for self-hosted PPTaken ([security §3, §7, §8](../../docs/foundation/04-security-and-auth.md)):
the single owner and its install code, password policy and hashing, panel sessions, API tokens, CSRF checks, rate
limiting, signed tokens, the instance secret and log redaction. License: AGPL-3.0-or-later. Depends on
`@pptaken/core` only (for `Principal`, scopes and `ownerPrincipal`).

```ts
const auth = createLocalAuth({ store, secret: loadOrCreateSecretKey({ dataDir }).key, ids });
const code = await auth.ensureInstallCode();          // print it while no owner exists
const who = await auth.authenticate({ authorization, sessionId }); // AuthProvider: Principal or null
```

## Pieces

| Piece | Behaviour |
|---|---|
| Install code | 8 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ` (no look-alikes), shown `XXXX-XXXX`; regenerated on every start until the owner exists; stored as an HMAC (HKDF subkey `install-code`); consumed atomically with the owner insert (`AuthStore.completeSetup`), so two concurrent setups cannot both win. |
| Password hashing | scrypt from `node:crypto`, N = 2^17, r = 8, p = 1 (OWASP), 128-bit salt, constant-time compare, parameters stored in the hash (`$scrypt$ln=17,r=8,p=1$salt$hash`) and rehash on sign-in when weaker. Argon2id is **not** used: `crypto.argon2` does not exist in Node 22 (the image runtime; it appeared in Node 24.7). |
| Password policy | 12 to 1024 characters (code points), not two or fewer distinct characters, not a common password: `src/common-passwords.ts` ships ~160 base words, ~70 suffixes and ~80 long literals, expanded at check time (≈ 10,000 candidates such as `Password123!`, `qwertyuiop123`, `iloveyou2024`, `passwordpassword`). It targets what people type to reach 12 characters; shorter passwords are already refused. |
| Sessions | 256-bit random id (base64url) in the cookie, SHA-256 stored, sliding 30-day expiry (extended at most every 5 min), new id on every sign-in, logout, revoke all, all sessions dropped on password reset. |
| API tokens | `ppt_` + 43 base64url characters (256 bits), SHA-256 stored (unique index), name, scopes (only `decks:read`, `decks:write`, `quiz:draft` are assignable in F2), optional expiry, `last_used_at` (written at most once a minute), immediate revocation. Accepted only as `Authorization: Bearer`; a present but invalid header never falls back to the cookie. |
| CSRF | `checkCsrf`: safe methods pass; others need `X-PPTaken-CSRF: 1` and an `Origin` (or `Referer` when absent) in the allowed list; `Origin: null` never matches. |
| Rate limiting | `TokenBucketLimiter` (continuous refill, bounded memory) and `SignInThrottle` (per IP 5/min, delay doubling from the 3rd consecutive failure up to 15 min, failures forgotten after 1 h, global failure budget 50 per 10 min). Injected clock. |
| Secrets | `secret.key` (256 bits, hex) created with `wx` and `0600`, or injected (`PPTAKEN_SECRET_KEY`, `PPTAKEN_SECRET_KEY_FILE`); `deriveKey(secret, purpose)` is HKDF-SHA256 per purpose. `signToken`/`verifyToken`: `payload.HMAC` with purpose, subject and expiry, constant-time check. |
| Redaction | `redact()` for log records: sensitive keys (`authorization`, `cookie`, `password`, `token`, `secret`, `installCode`…) and secret-looking values (`ppt_…`, `Bearer …`, session cookies, `?ct=`/`?token=` query values). |

## Storage port

`AuthStore` (`src/store.ts`): owner, settings (install code), sessions, API tokens, MCP activity. Adapters:
`MemoryAuthStore` (here, tests) and `createSqliteAuthStore` in `@pptaken/storage-sqlite` (migration `0002_auth.sql`).
The SQLite adapter does not import this package; TypeScript's structural typing checks the match where they are
wired, and both run the contract suite `runAuthStoreContract` from `@pptaken/auth-local/contract` (needs Vitest
in the consuming test environment). The port lives here rather than in `@pptaken/core` because only the auth
layer uses it; core stays untouched.

## Tests

`pnpm --filter @pptaken/auth-local test`: token formats, hashing and policy, setup/install code (including the race),
session expiry/sliding/rotation/revocation, token scopes/expiry/revocation, rate limits with a fake clock, CSRF,
signed tokens, secrets, redaction, and the store contract.
