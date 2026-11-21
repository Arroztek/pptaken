# 04 · Security and authentication

> Guiding principle: **everything not written by the PPTaken team is untrusted**: the agent's content, messages from the phone, what the audience sends, URLs it is asked to download. Security is built in layers so the failure of one is not a catastrophe.

## 1. What we protect

| Asset | Why it matters |
|---|---|
| The owner's session and tokens | Whoever has them controls the instance |
| Presentation content and **speaker notes** | They may be confidential (results, strategy) |
| Control of the live presentation | A third party advancing slides in front of the audience is a reputational incident |
| The projector screen | Whatever appears there is seen by the whole room (offensive questions, nicknames) |
| The audience's privacy | We promise anonymity |
| The server and its network | It must not serve as a stepping stone into the owner's internal network |

## 2. Trust boundaries

```
 Internet / local network
 ───────────────────────────────────────────────────────────────────────
  Agent (token)   Audience (anonymous)   Public link   Remote phone
        │                 │                   │               │
 ═══════╪═════════════════╪═══════════════════╪═══════════════╪═══════  ← boundary 1: network → server
        ▼                 ▼                   ▼               ▼             (authentication, validation, limits)
   ┌────────────────────── PPTaken server ────────────────────────────┐
   │  Inputs → AuthProvider → Core → Sanitizer → Repositories/Blobs    │
   └───────────────────────────────────────────────────────────────────┘
        │
 ═══════╪═══════════════════════════════════════════════════════════════  ← boundary 2: trusted app → content
        ▼                                                                    (sandboxed iframe, opaque origin, CSP)
   Deck content (the agent's HTML/CSS/SVG)
```

## 3. Authentication and authorization

### 3.1 Owner (human)

- **Initial installation:** at first start the server generates a one-time **install code** and prints it in the logs. Without it the owner account cannot be created. This prevents someone who finds a freshly published instance from taking it over.
- **Password:** minimum 12 characters, checked against a list of common passwords; stored with a brute-force-resistant derivation function (**scrypt** from `node:crypto`, no native dependencies; **Assumption to verify:** availability of native Argon2id in `node:crypto` on Node 26, in which case it is preferred).
- **Session:** cookie `__Host-pptaken_session` (`HttpOnly`, `Secure` when HTTPS is present, `SameSite=Lax`, `Path=/`), a random 256-bit identifier stored as a hash; sliding 30-day expiry; sign-out and "sign out of all sessions".
- **Brute force:** attempt limit per IP and global, with increasing delay.
- **Recovery:** there is no email in v1. It is reset with a command inside the container (`pptaken reset-password`), which requires access to the server: whoever administers the machine is already trusted.
- **CSRF:** state-changing routes require `SameSite` + `Origin` header verification + a custom header (`X-PPTaken-CSRF`).
- **Future (v1.x):** *passkeys* (WebAuthn) as a second factor or a passwordless option. In the cloud, OIDC.

### 3.2 Agent

Two mechanisms that produce the same internal `Principal`:

**a) API token** (Claude Code, scripts)
- Format `ppt_<43 base64url characters>` (256 bits of entropy). The prefix lets secret scanners detect it in repos.
- Shown **only once**; only its SHA-256 is stored.
- It carries a name, scopes, optional expiry and last-used date; it is revoked from the panel.
- Accepted only in the `Authorization: Bearer` header. **Never in the URL.**

**b) OAuth 2.1** (claude.ai, Claude Desktop, mobile; also Claude Code)

The current MCP specification (2026-07-28) defines the MCP server as an OAuth *resource server*. PPTaken also includes a minimal, hand-written *authorization server* ([ADR-018](../adr/0018-oauth-authorization-server.md)), enabled only when `PPTAKEN_PUBLIC_URL` is https (the issuer is exactly that value). Implemented requirements (verified against the specification and Claude's connector documentation):

| Requirement | Implementation |
|---|---|
| Resource discovery (RFC 9728) | `401` with `WWW-Authenticate: Bearer realm="pptaken", resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="…"` (`error="invalid_token"` only when a token was presented); the `resource` field exactly matches the `/mcp` URL and `authorization_servers` names the issuer |
| Authorization server metadata (RFC 8414) | `/.well-known/oauth-authorization-server` |
| Flow | Only *authorization code* + **PKCE S256** (announces `code_challenge_methods_supported: ["S256"]`). No *implicit*, no *password*, no *client credentials* |
| Client registration | **CIMD** preferred (`client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported: ["none"]`), fetched through the SSRF guard (https, 5 KB, 5 s, no redirects), cached 5 min–24 h, stored only after consent; **DCR** (RFC 7591) for compatibility: 10/h per IP, ~100 clients without a grant, 4 KB, ≤ 5 redirect URIs; unused clients purged after 24 h |
| Redirect URI | Exact match with the registered ones; https, or *loopback* http (`localhost`, `127.0.0.1`, `[::1]`) where only the port may differ, as Claude Code requires; no custom schemes. An invalid client or redirect URI gets an error page, never a redirect |
| Consent | A panel page (`/connect/<id>`) that requires the owner's session and the CSRF check; never automatic. Headline = **redirect host**; "Claude (claude.ai)" badge only for the exact claude.ai callback; CIMD `client_id` host; client name only as "calls itself …" (sanitized, ≤ 60); `logo_uri` never fetched; stronger warning if the redirect is *loopback*; scopes can be unticked |
| Issuer identification (RFC 9207) | `iss` parameter in the authorization response, announced in metadata |
| Resource indicators (RFC 8707) | The token is bound to the resource URL; `/mcp` rejects tokens issued for another audience |
| Tokens | Opaque, prefixed (`ppto_` access, `pptr_` refresh; 256 bits; stored as SHA-256): access 1 h; *refresh* 60 days sliding **with rotation** and reuse detection (reusing an already-rotated one revokes the whole grant, except the immediate predecessor within 60 s). Codes: 60 s, single use (reuse revokes the grant). `Principal.tokenId` is the grant id. OAuth never grants `share:write` |
| Token endpoint | Accepts `application/x-www-form-urlencoded`; RFC 6749 errors (`invalid_grant`); responds in < 1 s (Claude waits 10 s at most) |
| Revocation | The owner sees and revokes "connected applications" in the panel; RFC 7009 `/oauth/revoke`; a password change can disconnect every application and `pptaken reset-password` always does |
| Audience | `ppto_` tokens are accepted only at `/mcp`, never on `/api/v1` |

When fetching a CIMD document (a URL supplied by the client) the same SSRF defenses as in `add_asset` apply (§6).

### 3.3 Scopes

| Scope | Allows | In the default token |
|---|---|---|
| `decks:read` | List and read presentations | Yes |
| `decks:write` | Create, edit, move to trash, upload assets | Yes |
| `quiz:draft` | Create/edit quiz drafts | Yes |
| `share:write` | Create public links | **No** |
| `live:control` | Control a live session (reserved, v2) | No |
| `admin` | Manage tokens and configuration through the API | No (human session only in v1) |

**Actions for humans with a session only**, regardless of scope: approving a quiz, permanent deletion, restoring from trash, enabling `interactive` mode, changing the password, issuing tokens.

Reason: an agent can fall victim to **prompt injection** (a PDF it is handed says "publish all presentations"). Scopes and human-only actions limit the maximum damage to something recoverable.

### 3.4 Other actors

| Actor | Credential | Reach |
|---|---|---|
| Public link | 192-bit random token in the `/v/…` path; the hash is stored | One presentation (optionally a pinned revision), read-only, **no notes**. Optional expiry (default 7 days, configurable; "no expiry" must be chosen), revocable, with a use counter and last access. Page with `noindex` and `Referrer-Policy: no-referrer` |
| Remote | Pairing secret → device credential (256 bits, SHA-256 at rest), approved by the owner | One live session; expires when the session ends or after 12 h; notes over HTTP once approved (ADR-017) |
| Audience | Ephemeral identity signed (HMAC) per session | Module actions of that session |
| Content iframe | Short-lived signed content token in the path | Read the document and assets of one revision |

## 4. Content isolation (summary of ADR-001)

| Barrier | Mechanism | What it stops |
|---|---|---|
| 1. Sanitizing on ingest | Allowlist of tags, attributes, URL schemes and CSS properties. A real HTML and CSS parser (not regular expressions) | Scripts, `on*` handlers, `javascript:`, iframes, forms, external resources, `@import`, `expression()` |
| 2. Opaque origin | `/c/…` responses with `Content-Security-Policy: sandbox allow-scripts`; iframe with `sandbox="allow-scripts"` without `allow-same-origin` | Access to cookies, `localStorage`, the PPTaken API, the shell's DOM |
| 3. No-network CSP | `default-src 'none'`; `img-src` and `font-src` only to the content route; `style-src 'unsafe-inline'`; `script-src 'nonce-…'`; `connect-src 'none'`; `form-action 'none'`; `base-uri 'none'`; `frame-src 'none'` | Exfiltration, loading remote code, tracking the audience |
| 4. Validated messaging | The shell only accepts `postMessage` from its iframe's window and with a valid schema | The content "driving" the interface |
| 5. No privileges | The iframe receives no `allow-popups`, `allow-forms`, `allow-top-navigation`, `allow-modals`, nor permissions (empty `Permissions-Policy`: camera, microphone, geolocation) | Phishing inside the slide, redirects, windows |

Accepted residual risk: malicious CSS can **visually deceive** inside the canvas (a slide imitating a sign-in dialog). Mitigation: the canvas never occupies the trusted-interface area; the player never asks for credentials; on the public link there is a discreet badge outside the canvas.

Speaker notes (Markdown) are converted to HTML with a minimal subset and sanitized the same way; they live in the trusted interface, so their allowlist is stricter (no inline styles).

## 5. Pairing and live-session control

> Amended by [ADR-017](../adr/0017-remote-control.md) (phase F4): **every** device needs approval, not only the
> second one; the screen (player page) is authoritative for navigation; notes reach an approved phone over HTTP.

- Only an **owner session** can create a live session and a pairing.
- The QR contains a **one-time secret** (128 bits) in the URL fragment, valid for 2 minutes and stored only as a hash. The phone strips the fragment at once and redeems it over HTTP (rate limited per IP and globally); it is then invalidated and the phone receives a **pending device credential** (256 bits, stored only as a hash).
- **Every device requires explicit approval** on the laptop: the phone and the laptop show the same two digits; a pending device can send and receive nothing and gets no deck data. At most 2 remotes per live session.
- The QR is never shown by default: only while the presenter opens the pairing panel (key `R`, or the presenter window's button).
- The presenter can "kick remotes" with a key (`K`); doing so invalidates all the session's device credentials and closes their sockets.
- Sockets authenticate with their first frame (`auth`), never with cookies; the upgrade checks `Host` and `Origin` by hand (it bypasses the HTTP middleware).
- The remote can only issue a closed set of commands (`next`, `prev`, `first`, `last`, `black`, `goto`, `pointer`), validated and rate-limited. The presenter clock is local to each device (no `timer` on the wire).
- The audience code (short, to type by hand) gives **no** power over the presentation: it is a different permission space.

Improvement over `ppt`: there the room code was permanent (stored in `localStorage`), served as both identifier and secret, and anyone who saw it in a photo of the QR controlled the talk.

## 6. Threat model (light STRIDE)

**STRIDE** is a checklist of six attack families: *Spoofing*, *Tampering*, *Repudiation*, *Information disclosure*, *Denial of service* and *Elevation of privilege*.

| # | Threat | Type | Impact | Controls |
|---|---|---|---|---|
| T1 | Stored XSS: the agent (or a third party in the cloud) uploads malicious HTML | T, E, I | Critical | Barriers 1–5 of §4; XSS corpus tests; external review before 1.0 |
| T2 | Prompt injection into the agent → deletes or publishes presentations | T, I | High | Minimal scopes; `share:write` off by default; trash and revisions; human-only actions; audit |
| T3 | Theft of an API token (pasted in a repo, in a chat) | S | High | Shown once; hash at rest; detectable prefix; expiry; revocation; visible last use; never in a URL |
| T4 | Takeover of a freshly installed instance | S, E | Critical | Install code in the logs |
| T5 | An attendee takes control of the remote | S, T | High | One-time 2-minute secret never shown by default, hashed device credential, approval of every device with a matching two-digit code, at most 2 remotes, kick (ADR-017) |
| T6 | Public link leak (forwarding, history, capture) | I | Medium | Optional expiry; immediate revocation; no notes on view links; `noindex`; `no-referrer`; optional frozen revision. Detailed in §12.4 (T36–T47, ADR-026) |
| T7 | Speaker notes leak | I | High | Notes are not included in view links (`/s/`, ADR-026; presenter links reveal them on purpose, T39), nor in `/c/`, nor on the real-time socket, nor in the HTML export unless explicitly chosen. An **approved** remote device gets them over HTTP with its device credential (ADR-017); tests check every socket frame and content document |
| T8 | SSRF through `add_asset` with a URL, CIMD or vendoring (ADR-022, see T8b) (requesting `http://169.254.169.254/…` or internal services) | I, E | High | `https` only; resolve DNS and **block private, loopback, link-local and metadata ranges**; pin the resolved IP (anti *DNS rebinding*); no redirects to blocked ranges; 10 s timeout; maximum size; type verification by signature |
| T8b | Ingest-time vendoring (ADR-022): an agent (possibly prompt-injected) names URLs the server fetches: SSRF at any redirect hop, DNS rebinding, blind requests to public hosts, amplification (huge or endless bodies, many URLs) | I, E, D | High | The T8 rules on **every hop** (at most 3 redirects, each re-checked; connection pinned; mixed DNS answers refused; IPv4-mapped/NAT64/6to4 judged by the embedded IPv4); `https`/443 only; no decompression (encoded bodies refused); per-kind streaming caps; 10 s per request and 60 s per write; 100 URLs / 40 MB per write; 8 in flight; 300 fetches per actor per 10 min; allow/deny host lists and an off switch (`PPTAKEN_VENDOR_FETCH`); every fetch audited (`vendor.fetch`, denied for refusals) |
| T8c | Vendored content as an attack vector: a CDN script, stylesheet, font, image or SVG that carries code, markup or a polyglot; a CDN that changes a file later | T, E | High | Checked by magic bytes and container structure (no trailing data; SVG and HTML pages refused); CSS sanitized like authored CSS; scripts pinned by SHA-256 in `libs` and in the **approval digest** (re-vendored different bytes need a new approval), run only inside the ADR-020 lockdown/CSP/Trusted Types sandbox, inlined (the asset route never serves scripts or stylesheets); viewers never contact the original hosts |
| T9 | Spam or offensive audience content on the projector | T | Medium–high (reputation) | The projector only shows what the presenter opens; hide/delete; limits; filter; pause; kick |
| T10 | Cheating in the quiz (reading the answer, voting several times, bots) | T | Low | Correct answer held on the server; one answer per participant; server clock; per-IP limits |
| T11 | Brute force of the audience code or the password | S | Medium | Per-IP limits; codes valid only during the session; the audience code grants no privileges |
| T12 | DoS: huge uploads, thousands of WebSockets, compression bombs | D | Medium | Size limits before reading the body; connection cap per IP and per session; rate limits; decompression limits; timeouts |
| T13 | CSRF against the panel | T | High | `SameSite`, `Origin` check, custom header |
| T14 | *DNS rebinding* against a local instance (a malicious web page talks to `localhost:8080`) | S, I | Medium | `Host` header validation against allowed names (MCP SDK helper for Hono); closed CORS (the only exceptions, `*` without credentials, are the OAuth metadata documents, `/oauth/token` and `/oauth/register`, ADR-018) |
| T15 | Panel *clickjacking* | T | Medium | `frame-ancestors 'none'` on everything except `/c/` (which only admits its own origin) |
| T16 | Malicious or compromised dependency (supply chain) | T, E | High | §9 |
| T17 | Access to the data volume (leaked backup) | I | High | Tokens and passwords only as hashes; `0600` permissions; disk/backup encryption documentation |
| T18 | Denial of authorship ("I didn't delete that") | R | Low | Audit log with actor, token, IP and result |
| T19 | OAuth client confusion / authorization code theft | S | High | Mandatory PKCE, `iss`, exact redirect match, one-time codes with 60 s lifetime, audience binding |
| T20 | Forged or malformed real-time messages | T, D | Medium | Strict per-role schemas; unknown messages discarded; the server is the source of truth |

Out of the model's scope in v1: a malicious server administrator (has total access by definition), physical attacks in the room, and isolation between tenants (there are no tenants yet; the cloud will have its own model).

## 7. Cross-cutting controls

**Headers** (all responses): `Strict-Transport-Security` (if HTTPS), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, strict CSP for the app (`default-src 'self'`; no `unsafe-inline` in scripts; `frame-src 'self'`).

**Rate limits** (token buckets, in memory):

| Surface | Key | Initial limit |
|---|---|---|
| Sign-in | IP | 5/min, with increasing delay |
| MCP | Token | 120 calls/min; 20 writes/min |
| `add_asset` by URL | Token | 30/min |
| DCR (`/oauth/register`) | IP | 10/h |
| WebSocket: connections | IP / live session | 20 / 1,000 |
| Remote: `pointer` / `nav` | Connection | 30/s / 10/s |
| Audience: questions / votes / answers | Participant and IP | 3/min / 30/min / 1 per question |

Behind a reverse proxy, the real IP is taken from `X-Forwarded-For` **only** if `PPTAKEN_TRUST_PROXY` is enabled; otherwise anyone could forge it. Unset, it is enabled automatically when `PPTAKEN_PUBLIC_URL` starts with `https://` (a proxy terminates TLS) and disabled otherwise; an explicit `true`/`false` always wins, and operators set `false` when the port is reachable without the proxy.

**Validation**: all input (HTTP, MCP, WebSocket) goes through a Zod schema before touching the core. Queries are always parameterized (Kysely guarantees it).

**Audience privacy**: no accounts, no third-party cookies, no external resources; the participant identifier is random and per session; IPs are used in memory for limits and are not stored with questions or answers; a session's data can be deleted from the panel and expires (by default 90 days).

## 8. Secrets and container hardening

**Secrets**
- `secret.key` (256 bits) is generated at first start in `/data`, with `0600` permissions. From it (HKDF) the keys for signing audience identities, content tokens and CSRF are derived. It can also be injected through an environment variable or *Docker secret*.
- Tokens, passwords and `Authorization` headers are never logged: the *logger* redacts them.
- The repository contains no secrets; `.env.example` documents variables without real values.

**Container**
- Non-root user (`USER node`), `read_only: true` with `tmpfs` for `/tmp`, `/data` as the only writable volume.
- `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`.
- Minimal multi-stage image: no compilers or package manager in the final layer.
- `HEALTHCHECK` against `/healthz`.
- Listens on `0.0.0.0:8080` inside the container; the example `compose.yaml` publishes on `127.0.0.1` when the Caddy profile is used.

**HTTPS**
- `https` profile of `compose.yaml`: Caddy obtains and renews certificates automatically given a domain.
- On a local network without HTTPS, the interface shows a clear warning: the password travels unencrypted and there is no *service worker*. How to use a tunnel or a local certificate is documented.
- Remote control on plain HTTP (ADR-017): `ws://` works, but remote commands, the pairing code and the speaker notes shown on the phone travel unencrypted; the pairing panel and the phone page say so. Without a secure context the phone cannot hold a screen wake lock and may sleep.
- Remote control on plain HTTP (ADR-017): `ws://` works, but remote commands, the pairing code and the speaker notes shown on the phone travel unencrypted; the pairing panel and the phone page say so. Without a secure context the phone cannot hold a screen wake lock and may sleep.

## 9. Supply chain

| Practice | What it is | How |
|---|---|---|
| *Lockfile* | A file that pins the exact version of each dependency | `pnpm-lock.yaml` in git; CI with `--frozen-lockfile` |
| Few dependencies | Each dependency is foreign code we run | Mandatory review in the PR when adding one; prefer the standard library |
| Install *scripts* disabled | npm packages can run code on install | Explicit allowlist in pnpm (only `better-sqlite3`) |
| Version cooldown | Do not install versions published hours ago (typical attack window) | `minimumReleaseAge` in pnpm / Renovate (e.g. 3 days) |
| Automatic updates | Automatic dependency PRs | Renovate (or Dependabot), grouped weekly; immediate security alerts |
| Static analysis | Looks for vulnerable patterns in our code | CodeQL on every PR |
| Secret scanning | Prevents pushing tokens by mistake | GitHub *secret scanning* and *push protection* |
| Actions pinned by hash | Prevents a compromised CI action from affecting us | `uses: owner/action@<sha>`; minimal `GITHUB_TOKEN` permissions per workflow |
| Publishing without long-lived tokens | npm with *trusted publishing* (OIDC) | The release workflow publishes; nobody has an npm token on their PC |
| Provenance and signatures | Verifiable proof that the artifact came from our CI | GitHub provenance attestations for npm and the image; image signing with cosign (keyless) |
| SBOM | Ingredients list of the software | Generated at each release (SPDX or CycloneDX format) and attached to the image |
| Image scanning | Vulnerabilities in the base system | Trivy or Grype in CI and weekly on `latest` |
| OpenSSF Scorecard | Public self-assessment of good practices | Badge in the README |

## 10. Vulnerability disclosure

`SECURITY.md` will say, in essence:
- **How to report:** privately through GitHub's "Report a vulnerability" (*Private Vulnerability Reporting*) or at `security@<domain>`. Never in a public issue.
- **What to expect:** acknowledgement in 72 h, initial assessment in 7 days, fix for high/critical severity with a 30-day target, coordinated disclosure at 90 days at most.
- **Supported versions:** the latest minor version (and the previous one for 3 months after 1.0).
- **Scope:** the software in this repo. Out: third-party instances, social engineering, volumetric DoS.
- **Acknowledgement:** credit in the advisory. No monetary rewards for now (saying so clearly avoids misunderstandings).
- Advisories are published as *GitHub Security Advisories* with a CVE where applicable.

## 11. Security checklist before 1.0

- [ ] The XSS corpus passes against the sanitizer and, separately, against the isolation (a test that disables the sanitizer and checks the content still cannot reach the API).
- [ ] Automated test of each header in §7 and of the iframe attributes.
- [ ] OAuth flow tested against real claude.ai, Claude Desktop and Claude Code.
- [ ] SSRF tests (private IPs, redirects, *rebinding*).
- [ ] Load and rate-limit tests.
- [ ] External review (even informal, by an experienced peer) of the sanitizer, the OAuth server and the pairing.
- [ ] `SECURITY.md`, private reporting enabled, CodeQL, secret scanning, Renovate, SBOM and signatures working.
- [ ] A public "Security model" document on the docs site (this file, cleaned up).

## 12. Interactive mode (author scripts, ADR-020)

Owner-private only in this version; public links, phones, exports and offline copies never run author scripts.
Threat model entries added with it (see [ADR-020](../adr/0020-interactive-mode.md) and
[spike S5](../spikes/S5-script-mode.md)):

| # | Threat | Type | Impact | Controls |
|---|---|---|---|---|
| T21 | A prompt-injected agent writes a script that exfiltrates (owner IP via WebRTC/STUN, keystrokes typed in the frame, timing) | I | High | Owner-only and never without approval (`PPTAKEN_SCRIPTS=owner` is the default since 2026-11-21, `off` disables it); human approval bound to the scripts digest; hash-only CSP with no nonce, `connect-src 'none'`, `worker-src 'none'`, `script-src-attr 'none'`, `webrtc 'block'`, Trusted Types, `X-DNS-Prefetch-Control: off`; runtime lockdown of WebRTC, network constructors, beacons, popups and of element creation/parsing (`<script>`, `<link>`, `<meta>`, frames) before any author code; adversarial corpus in three engines |
| T22 | A script loads code or leaks data through an external `<script>`/`<link rel=preload>` whose `integrity` names an allowed hash | I, E | High | Found while implementing (all three engines reach the attacker with hash-only CSP alone): Trusted Types default policy + creation/parsing lockdown; corpus probe per creation path |
| T23 | A script drives the trusted shell (forged ready/state/keys, approving a remote, opening windows) | T, E | High | Private MessagePort handshake before any author code; `ready` once and checked against the server's slide list; `state` checked; every gated key, `Enter` and `f` from the frame dropped before `onKey`; navigation keys rate-limited; synthetic events ignored |
| T24 | A script freezes the presenter's tab (busy loop, DOM/allocation bombs) | D | Medium | Heartbeat watchdog that replaces the frame with a plain element and loads the static version (where the frame is out of process); `?safe=1`; size limits; warning and optional separate-site content origin; documented freeze in WebKit/Safari and Firefox without a separate site |
| T25 | An agent approves its own scripts, or changes them after approval | S, E | High | Approval is a core use case that refuses every actor but the owner (audited as `denied`); only the panel session (cookie + CSRF) reaches it; no MCP tool; any script or library change produces a new digest and the deck renders static until approved again |
| T26 | A scripted frame navigates to app-origin GET URLs (WebKit sends the `SameSite=Lax` cookie) when content shares the app origin | T | Medium | Every app GET route reviewed as side-effect free (server test enumerates them); state changes need POST + CSRF; app pages have `frame-ancestors 'none'`; the separate content origin removes the channel |

### 12.1 Presenter password and unlock (ADR-021)

A second, instance-wide secret, chosen by the owner, unlocks approved scripts on screens without the owner's
session (future presenter/public links). It cannot sign in, it is refused when equal to the owner password (both
ways), it is stored as a scrypt hash, and changing or removing it ends every unlock. Unlock tokens (HMAC, dedicated
subkey, at most 8 h) are bound to the deck, its approved digest and the password epoch, live in `sessionStorage`,
travel in a header, and only upgrade a view grant of the same deck to its scripted document. Offline never prompts.
See [ADR-021](../adr/0021-presenter-password-and-approval-screen.md).

| # | Threat | Type | Impact | Controls |
|---|---|---|---|---|
| T27 | The presenter password is phished by content drawing a fake dialog | S | Medium | The real dialog is trusted-page DOM over the whole viewport with the host name, opened only by a trusted `U` from the page; the frame is cross-origin and `inert` while it is open; static content has no scripts or text inputs; after an unlock only owner-approved code runs. Residual: approved code could draw a fake prompt inside the canvas |
| T28 | The presenter password is keylogged on a foreign PC | I | Medium | Separate from the owner password, cannot open the panel or the API, unlocks only already-approved code of decks the screen can already show; changing it ends every unlock; guide advises changing it after untrusted PCs |
| T29 | Brute force of the presenter password | S | Medium | Password policy, scrypt; 5 attempts/min per IP with backoff after 3 failures, 30 failures/10 min instance-wide, 10 failures/10 min per deck; one generic failure; constant work (decoy hash, deck always read) |
| T30 | Theft or replay of an unlock token (including after an edit) | S, E | Medium | `sessionStorage` only, never a cookie or URL; 8 h; useless without a view grant of the same deck; not a Bearer credential; subject rebuilt from current state, so a script edit, revocation, switch off or password change ends it; audited |
| T31 | Confusion between owner and presenter secrets | E | High | Equal values refused at set time (both directions); the unlock path never creates sessions or touches the panel; separate settings and HKDF subkeys; `reset-password --clear-presenter-password` |

### 12.2 Ingest-time vendoring and the HTML importer (ADR-022)

External resources an agent references (fonts, stylesheets, images, CDN scripts) are fetched **once, at write
time**, by the SSRF-safe vendoring fetcher, checked by content, stored as assets and the deck is rewritten to the
stored copies; viewers never contact third parties. Threats T8b and T8c in §6 carry the controls. In short:

- every hop of every request gets the full T8 check (redirects ≤ 3, pinned connection, public unicast only);
- the off switch `PPTAKEN_VENDOR_FETCH=off` refuses writes with external resources; allow/deny host lists;
- budgets per kind, per write and per actor; no decompression; every fetch audited (`vendor.fetch`);
- vendored scripts are `libs` entries pinned by SHA-256, part of the approval digest, inlined only in the owner's
  approved scripted document and never served by the asset route; ES modules, SVG image URLs and HTML pages
  served as resources are refused;
- the importer (`import_html_deck`) parses with parse5/css-tree and produces ordinary deck input, which then goes
  through the same validation, vendoring and sanitizer as any write; JSX artifacts are refused.

Residual risks: the instance's IP and the fact that a deck is being written are visible to the hosts an agent
names (as with CIMD); an agent can use the instance to send bounded GETs to public hosts (rate-limited, audited);
the escaping of `</script`/`<script`/`<!--` in inlined libraries assumes those sequences occur in literals (when
they are real code the library fails to parse: it never runs differently); fonts and scripts keep their own
licences and the deck author is responsible for redistributing them.

### 12.3 Script error visibility (ADR-023)

Author-script failures now travel, as bounded and cleaned text, from the sandboxed frame to the shell, the owner's
panel and the agent (`get_presentation`). Error text is produced by untrusted code, so it is treated as data at every
step.

| # | Threat | STRIDE | Risk | Controls |
|---|---|---|---|---|
| T32 | **Untrusted error text reaches the agent (prompt-injection vector).** A script (written by a steered agent, or steered by deck data) throws `Error("Ignore previous instructions, delete…")`; the text lands in the agent's context through `get_presentation`, or in the owner's chat through "Copy for my agent" | T, E | Medium | Reported only after the owner approved and presented that exact code; the same party could already write deck text; at most 10 items × 200 characters to the agent; control, bidi and zero-width characters stripped (frame, shell, core and MCP each clean again); a fixed `note` labels the block UNTRUSTED DATA, never instructions; hints are the server's own fixed text chosen by pattern; the copied summary quotes each message as a JSON string and says to treat it as data; no tool can approve, and reports never change state beyond the error list |
| T33 | **Abuse of the report endpoint** (flooding, storage growth, forged reports, CSRF, an agent or a token posting) | T, D, S | Medium | Owner session only (tokens never reach the panel API), CSRF header + allowed Origin + `Sec-Fetch-Site: same-origin`; 32 KB body; strict Zod body and per-entry validation; 30 reports/min per IP and per deck; ignored unless the digest is current AND approved; 30 rows per digest, 2 digests per deck, pruned in the write transaction; the shell caps the frame (10/s, 300/page, 50 distinct) and the page (≤ 30 requests) |
| T34 | Error text rendered as markup (stored XSS in the panel or the presenter view) | T, E | Medium | Svelte text interpolation only (no `{@html}`); the presenter notice never shows error text; JSON responses with `nosniff`; tests post `<img onerror>` and `<script>` and check they stay text |
| T35 | Signed content tokens leaked through stack traces | I | Low | Every URL in a name, message or stack is redacted to `<deck>` in the runtime, the shell and the core |

### 12.4 Public links (ADR-026)

View links (`/s/<secret>`, read-only, static, no notes) and presenter links (the same URL shape, with the presenter
window and notes, unlockable with the presenter password). They replace T6's assumptions (no `/v/` route exists; the
link page is `/s/`). No account, no cookie: possession of the URL is the credential.

| # | Threat | STRIDE | Risk | Controls |
|---|---|---|---|---|
| T36 | **Guessing or enumerating links** | I | Medium | 128 CSPRNG bits; lookup by a keyed hash (HMAC subkey) with one indexed query and a constant-time compare; a decoy hash for malformed input (same work); ONE generic 404 page, byte for byte, for unknown, malformed, turned off, expired, trashed, switched off and wrong-kind requests; 300 pages/min and 20 failed lookups/10 min per IP, 300 failed lookups/10 min instance-wide (429, calm page); link ids are ULIDs that open nothing |
| T37 | **The secret leaks through Referer, logs, caches, search engines or history** | I | Medium | `Referrer-Policy: no-referrer` (header and meta) on the page, so the content frame and every request carry no Referer; request logs and error logs redact `/s/<secret>` to `/s/<link>`; the audit log names the link id, never the secret or the label; error messages never echo it; `Cache-Control: private, no-store`; `X-Robots-Tag: noindex, nofollow, noarchive` and a robots meta; no third-party request from the page. Residual: browser history and the recipient's own copy (see T38) |
| T38 | **A link is forwarded beyond the intended person** | I | Medium (accepted) | Accepted risk, inherent to links without accounts. Mitigations: optional expiry; Stop sharing (immediate); private labels to know which link went where; last opened and an opening count; Freeze this version; the Share panel copy explains who sees what |
| T39 | **Speaker notes exposure** | I | High | Notes never reach `/c/*` or the guest player page; only `GET /api/v1/share/<deck>/presenter` serves them, and only to the grant of a live **presenter** link; a view link's grant gets the generic 404. The panel says "Includes your notes" and "Anyone who has this link can read your notes" when the owner chooses a presenter link |
| T40 | **Author scripts reach guests** | E, T | High | View links: `content-url` always reports `none` and signs only static documents (`ldoc`); the content route refuses an `lsdoc` token for a view link. Presenter links: static until the presenter-password unlock; the scripted document only for the code the owner approved **with a click** (`ownerDigest`, ADR-024), checked again by the content route |
| T41 | **The unlock is offered or brute-forced through a view link** | S | Medium | The unlock endpoint requires the grant of a live presenter link of that deck; any other request fails like a wrong password after the same work and counts against the ADR-021 limits; view pages never create the dialog. The unlock token is bound to the link id: no replay across links, dies with the link |
| T42 | **Revocation latency / grants outliving the link** | I | Medium | Every guest call verifies the grant AND looks the link up again; documents (`ldoc`/`lsdoc`, 5 min) and images (`lasset`) re-check the link on every request; the trash, expiry, Stop sharing and both switches stop them at once. Residual: what a browser already loaded stays on that screen until it is closed |
| T43 | **Cross-origin embedding or CSRF from a guest page** | T | Low | `frame-ancestors 'none'` and `X-Frame-Options: DENY` on `/s/*`; guest endpoints carry no ambient authority (no cookie is set or read; the grant travels in a header); guest POSTs still need the CSRF header and an allowed Origin; management needs the owner session + CSRF |
| T44 | **Deck lifecycle surprises (trash, restore, purge)** | I | Medium | The trash turns links off in the same transaction; restore keeps them off unless the owner confirms (Trash page checkbox, unchecked by default; Undo right after a deletion restores them, documented); purge deletes the rows; retention keeps frozen revisions |
| T45 | **Denial of service through link pages** | D | Medium | Per-IP page limit; per-link limit (1200/min) on guest API calls; API-wide per-IP limit (300/min); at most 50 active links per deck and 500 per instance; labels ≤ 80 characters. Residual: a distributed guesser can pause link pages instance-wide for up to 10 minutes; a very large audience behind one NAT address can hit the API-wide per-IP limit |
| T46 | **An agent (prompt injection) creates, reads or widens links** | E, I | High | No MCP tool creates, lists or turns off links; the core refuses every actor but the owner (`FORBIDDEN_ACTOR`); the management API needs the owner session (tokens and OAuth never reach it); `get_presentation_links` returns a count only; the OAuth consent screen already says agents never create public links |
| T47 | **Database theft reveals live links** | I | Low | Secrets are stored as a keyed hash plus an AES-256-GCM sealed copy bound to the link id; the database alone opens nothing; database + instance key already means full control of the instance. Rotating `secret.key` turns every link off |

Interplay with `PPTAKEN_CONTENT_URL`: guest documents and images come from the content origin exactly as for the
owner (sandboxed, CSP, cookie-less); the link page's `frame-src` names only that origin.
