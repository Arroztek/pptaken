// SPDX-License-Identifier: AGPL-3.0-or-later
// The OAuth 2.1 authorization server of a self-hosted instance (ADR-0018, amending ADR-009). Deliberately small:
// authorization code + PKCE S256 for public clients only, CIMD (client_id metadata documents) preferred and DCR
// (RFC 7591) for compatibility, rotated refresh tokens with reuse detection, `iss` in the authorization response
// (RFC 9207) and tokens bound to the single resource `<issuer>/mcp` (RFC 8707). No network and no HTTP here: the
// server passes requests in and a CIMD fetcher (SSRF-safe) is injected. Fails closed everywhere.
import { sha256Hex } from "./crypto.js";
import {
  canonicalResource,
  displayClientName,
  generateAccessToken,
  generateAuthorizationCode,
  generateDcrClientId,
  generateRefreshToken,
  generateRequestId,
  hostOf,
  isCimdClientId,
  MAX_REDIRECT_URIS,
  OAUTH_ACCESS_PATTERN,
  OAUTH_CODE_PATTERN,
  OAUTH_DCR_CLIENT_PATTERN,
  OAUTH_REFRESH_PATTERN,
  OAUTH_REQUEST_ID_PATTERN,
  OAUTH_SCOPES,
  type OAuthScope,
  onlyOAuthScopes,
  PKCE_CHALLENGE_PATTERN,
  parseScopeRequest,
  type RedirectKind,
  redirectKind,
  redirectUriMatches,
  redirectUriProblem,
  verifyPkceS256,
  withQuery,
} from "./oauth-primitives.js";
import type {
  OAuthClientKind,
  OAuthGrantRecord,
  OAuthStore,
  OAuthTokenRecord,
} from "./oauth-store.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const OAUTH_ACCESS_TTL_MS = HOUR;
export const OAUTH_REFRESH_TTL_MS = 60 * DAY;
export const OAUTH_CODE_TTL_MS = 60 * SECOND;
export const OAUTH_PENDING_TTL_MS = 10 * MINUTE;
/** A rotated refresh token is still accepted this long if it is the immediate predecessor (network retries). */
export const OAUTH_REFRESH_GRACE_MS = 60 * SECOND;
export const OAUTH_MAX_PENDING = 100;
/** DCR: at most this many registered clients that never got a grant (instance-wide). */
export const OAUTH_MAX_CLIENTS_WITHOUT_GRANT = 100;
export const OAUTH_CIMD_CACHE_MIN_MS = 5 * MINUTE;
export const OAUTH_CIMD_CACHE_MAX_MS = DAY;
export const OAUTH_CIMD_CACHE_ENTRIES = 50;
export const OAUTH_DEAD_GRANT_RETENTION_MS = 30 * DAY;
export const OAUTH_UNUSED_CLIENT_TTL_MS = DAY;
const GRANT_TOUCH_INTERVAL_MS = MINUTE;
const MAX_STATE_LENGTH = 1024;
const MAX_CLIENT_NAME_LENGTH = 200;

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "invalid_target"
  | "access_denied"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "temporarily_unavailable"
  | "not_found";

/** An OAuth protocol error (RFC 6749 §5.2, RFC 7591 §3.2.2). `description` never echoes secrets. */
export class OAuthProtocolError extends Error {
  override readonly name = "OAuthProtocolError";
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

/** The CIMD document fetched by the injected fetcher (HTTP caching hint in seconds, if any). */
export interface CimdDocument {
  body: unknown;
  maxAgeSec: number | null;
}
export type CimdFetcher = (url: string) => Promise<CimdDocument>;

export interface OAuthServiceOptions {
  store: OAuthStore;
  ids: { ulid(): string };
  clock?: { now(): number };
  workspaceId?: string;
  /** PPTAKEN_PUBLIC_URL, or null: the authorization server is disabled (no metadata, no endpoints). */
  issuer: string | null;
  /** SSRF-safe fetcher of client metadata documents; without it CIMD clients are refused. */
  fetchClientMetadata?: CimdFetcher;
}

interface ResolvedClient {
  id: string;
  kind: OAuthClientKind;
  name: string | null;
  redirectUris: string[];
  metadata: string;
}

interface PendingRequest {
  id: string;
  client: ResolvedClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  scopes: OAuthScope[];
  createdAt: number;
  expiresAt: number;
}

/** What the consent page shows (`GET /api/v1/oauth/requests/:id`). */
export interface PendingRequestView {
  id: string;
  client: {
    id: string;
    kind: OAuthClientKind;
    /** Sanitized client-supplied name, shown as "calls itself …"; never trusted. */
    name: string | null;
    /** For CIMD clients: the host of the client_id URL (who vouches for the metadata). */
    idHost: string | null;
  };
  redirectUri: string;
  redirectHost: string;
  redirectKind: RedirectKind;
  scopes: OAuthScope[];
  expiresAt: number;
}

export type AuthorizeOutcome =
  /** The client or its redirect URI is not trustworthy: show an error page, never redirect. */
  | { kind: "error_page"; error: OAuthErrorCode; description: string }
  | { kind: "redirect"; location: string };

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** An application connected through OAuth, as the panel lists it. */
export interface ConnectedApp {
  id: string;
  clientId: string;
  clientKind: OAuthClientKind | null;
  clientName: string | null;
  redirectHost: string;
  scopes: OAuthScope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}

export interface OAuthAccess {
  grant: OAuthGrantRecord;
  scopes: OAuthScope[];
  expiresAt: number;
}

const hash = (secret: string) => sha256Hex(secret);

export class OAuthService {
  private readonly store: OAuthStore;
  private readonly ids: { ulid(): string };
  private readonly clock: { now(): number };
  private readonly ws: string;
  readonly issuer: string | null;
  private readonly fetchClientMetadata: CimdFetcher | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cimdCache = new Map<string, { client: ResolvedClient; expiresAt: number }>();

  constructor(options: OAuthServiceOptions) {
    this.store = options.store;
    this.ids = options.ids;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.ws = options.workspaceId ?? "default";
    this.issuer = options.issuer;
    this.fetchClientMetadata = options.fetchClientMetadata;
  }

  get enabled(): boolean {
    return this.issuer !== null;
  }

  /** The single protected resource: `<issuer>/mcp`. */
  get resource(): string | null {
    return this.issuer === null ? null : `${this.issuer}/mcp`;
  }

  private requireIssuer(): string {
    if (this.issuer === null)
      throw new OAuthProtocolError("not_found", "OAuth is not enabled", 404);
    return this.issuer;
  }

  /** RFC 8414 metadata. */
  metadata(): Record<string, unknown> {
    const iss = this.requireIssuer();
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      registration_endpoint: `${iss}/oauth/register`,
      revocation_endpoint: `${iss}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...OAUTH_SCOPES, "offline_access"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // -----------------------------------------------------------------------------------------------------------
  // Clients

  /** Dynamic client registration (RFC 7591). Public clients only: never issues a secret. */
  async registerClient(input: unknown): Promise<Record<string, unknown>> {
    this.requireIssuer();
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new OAuthProtocolError("invalid_client_metadata", "The body must be a JSON object");
    }
    const body = input as Record<string, unknown>;
    const redirectUris = this.checkRedirectUris(body.redirect_uris, "invalid_redirect_uri");
    const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
    if (
      !Array.isArray(grantTypes) ||
      grantTypes.length === 0 ||
      !grantTypes.every((g) => g === "authorization_code" || g === "refresh_token") ||
      !grantTypes.includes("authorization_code")
    ) {
      throw new OAuthProtocolError(
        "invalid_client_metadata",
        "grant_types must be authorization_code (and optionally refresh_token)",
      );
    }
    const responseTypes = body.response_types ?? ["code"];
    if (
      !Array.isArray(responseTypes) ||
      responseTypes.length !== 1 ||
      responseTypes[0] !== "code"
    ) {
      throw new OAuthProtocolError("invalid_client_metadata", 'response_types must be ["code"]');
    }
    const name = body.client_name;
    if (name !== undefined && (typeof name !== "string" || name.length > MAX_CLIENT_NAME_LENGTH)) {
      throw new OAuthProtocolError(
        "invalid_client_metadata",
        `client_name must be a string of at most ${MAX_CLIENT_NAME_LENGTH} characters`,
      );
    }
    if ((await this.store.countClientsWithoutGrant(this.ws)) >= OAUTH_MAX_CLIENTS_WITHOUT_GRANT) {
      throw new OAuthProtocolError(
        "temporarily_unavailable",
        "Too many registered clients are waiting for approval; try again later",
        503,
      );
    }
    const now = this.clock.now();
    const id = generateDcrClientId();
    const metadata: Record<string, unknown> = {
      client_name: typeof name === "string" ? name : undefined,
      redirect_uris: redirectUris,
      grant_types: [...new Set(grantTypes as string[])],
      response_types: ["code"],
      // Public client: whatever was asked for, no secret is issued (RFC 7591 §3.2.1 allows the replacement).
      token_endpoint_auth_method: "none",
    };
    if (typeof body.scope === "string") {
      const scopes = parseScopeRequest(body.scope);
      if (scopes.ok) metadata.scope = scopes.scopes.join(" ");
    }
    for (const k of Object.keys(metadata)) if (metadata[k] === undefined) delete metadata[k];
    await this.store.upsertClient({
      workspaceId: this.ws,
      id,
      kind: "dcr",
      name: typeof name === "string" ? name : null,
      redirectUris,
      metadata: JSON.stringify(metadata),
      createdAt: now,
    });
    return { client_id: id, client_id_issued_at: Math.floor(now / 1000), ...metadata };
  }

  private checkRedirectUris(value: unknown, code: OAuthErrorCode): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REDIRECT_URIS) {
      throw new OAuthProtocolError(
        code,
        `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} redirect URIs`,
      );
    }
    for (const uri of value) {
      const problem = redirectUriProblem(uri);
      if (problem !== null) throw new OAuthProtocolError(code, `redirect URI ${problem}`);
    }
    return [...new Set(value as string[])];
  }

  /** Looks a client up (DCR) or fetches and validates its metadata document (CIMD, cached in memory). */
  private async resolveClient(clientId: string): Promise<ResolvedClient> {
    if (OAUTH_DCR_CLIENT_PATTERN.test(clientId)) {
      const c = await this.store.getClient(this.ws, clientId);
      if (c === null || c.kind !== "dcr")
        throw new OAuthProtocolError("invalid_client", "Unknown client_id");
      return c;
    }
    if (!isCimdClientId(clientId)) {
      throw new OAuthProtocolError(
        "invalid_client",
        "client_id must be a registered id or an https metadata document URL",
      );
    }
    const now = this.clock.now();
    const cached = this.cimdCache.get(clientId);
    if (cached !== undefined && cached.expiresAt > now) return cached.client;
    if (this.fetchClientMetadata === undefined) {
      throw new OAuthProtocolError(
        "invalid_client",
        "Client metadata documents are not supported here",
      );
    }
    let doc: CimdDocument;
    try {
      doc = await this.fetchClientMetadata(clientId);
    } catch (error) {
      throw new OAuthProtocolError(
        "invalid_client",
        `Could not fetch the client metadata document: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}`,
      );
    }
    const client = this.validateCimd(clientId, doc.body);
    const ttl = Math.min(
      OAUTH_CIMD_CACHE_MAX_MS,
      Math.max(OAUTH_CIMD_CACHE_MIN_MS, (doc.maxAgeSec ?? 0) * 1000),
    );
    this.cimdCache.delete(clientId);
    while (this.cimdCache.size >= OAUTH_CIMD_CACHE_ENTRIES) {
      const oldest = this.cimdCache.keys().next().value;
      if (oldest === undefined) break;
      this.cimdCache.delete(oldest);
    }
    this.cimdCache.set(clientId, { client, expiresAt: now + ttl });
    return client;
  }

  private validateCimd(url: string, body: unknown): ResolvedClient {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new OAuthProtocolError(
        "invalid_client",
        "The client metadata document is not a JSON object",
      );
    }
    const doc = body as Record<string, unknown>;
    if (doc.client_id !== url) {
      throw new OAuthProtocolError(
        "invalid_client",
        "The client metadata document's client_id does not equal its URL",
      );
    }
    const auth = doc.token_endpoint_auth_method;
    if (auth !== undefined && auth !== "none") {
      throw new OAuthProtocolError(
        "invalid_client",
        'Only public clients (token_endpoint_auth_method "none") are supported',
      );
    }
    if (
      doc.grant_types !== undefined &&
      (!Array.isArray(doc.grant_types) || !doc.grant_types.includes("authorization_code"))
    ) {
      throw new OAuthProtocolError(
        "invalid_client",
        "The client does not use the authorization_code grant",
      );
    }
    const redirectUris = this.checkRedirectUris(doc.redirect_uris, "invalid_client");
    const name =
      typeof doc.client_name === "string" ? doc.client_name.slice(0, MAX_CLIENT_NAME_LENGTH) : null;
    return {
      id: url,
      kind: "cimd",
      name,
      redirectUris,
      metadata: JSON.stringify({ client_id: url, client_name: name, redirect_uris: redirectUris }),
    };
  }

  // -----------------------------------------------------------------------------------------------------------
  // Authorization endpoint

  /**
   * `GET /oauth/authorize`. The client and the redirect URI are validated before anything is sent to the redirect
   * URI; a valid request becomes a pending request (memory, 10 minutes) and the browser goes to the consent page.
   */
  async authorize(params: URLSearchParams): Promise<AuthorizeOutcome> {
    const iss = this.requireIssuer();
    const page = (error: OAuthErrorCode, description: string): AuthorizeOutcome => ({
      kind: "error_page",
      error,
      description,
    });
    const seen = new Set<string>();
    for (const key of params.keys()) {
      if (seen.has(key)) return page("invalid_request", `The parameter ${key} appears twice`);
      seen.add(key);
    }
    const clientId = params.get("client_id");
    if (clientId === null || clientId === "")
      return page("invalid_request", "client_id is required");
    let client: ResolvedClient;
    try {
      client = await this.resolveClient(clientId);
    } catch (error) {
      if (error instanceof OAuthProtocolError) return page(error.code, error.description);
      throw error;
    }
    const redirectUri = params.get("redirect_uri");
    if (redirectUri === null || redirectUri === "")
      return page("invalid_request", "redirect_uri is required");
    if (
      redirectUriProblem(redirectUri) !== null ||
      !client.redirectUris.some((r) => redirectUriMatches(r, redirectUri))
    ) {
      return page("invalid_request", "redirect_uri is not registered for this client");
    }

    // From here on, errors go back to the client (RFC 6749 §4.1.2.1) with state and iss (RFC 9207).
    const rawState = params.get("state") ?? undefined;
    const state =
      rawState !== undefined && rawState.length <= MAX_STATE_LENGTH ? rawState : undefined;
    const fail = (error: OAuthErrorCode, description: string): AuthorizeOutcome => ({
      kind: "redirect",
      location: withQuery(redirectUri, { error, error_description: description, state, iss }),
    });
    if (rawState !== undefined && state === undefined)
      return fail("invalid_request", "state is too long");
    if (params.get("response_type") !== "code") {
      return fail("unsupported_response_type", 'response_type must be "code"');
    }
    const challenge = params.get("code_challenge");
    if (challenge === null || challenge === "")
      return fail("invalid_request", "code_challenge is required (PKCE)");
    if (params.get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "code_challenge_method must be S256");
    }
    if (!PKCE_CHALLENGE_PATTERN.test(challenge))
      return fail("invalid_request", "code_challenge is malformed");
    const resource = params.get("resource");
    if (resource !== null && canonicalResource(resource) !== this.resource) {
      return fail("invalid_target", "Unknown resource");
    }
    const scope = parseScopeRequest(params.get("scope") ?? undefined);
    if (!scope.ok) return fail("invalid_scope", "None of the requested scopes can be granted");

    const now = this.clock.now();
    this.sweepPending(now);
    while (this.pending.size >= OAUTH_MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const id = generateRequestId();
    this.pending.set(id, {
      id,
      client,
      redirectUri,
      codeChallenge: challenge,
      state,
      scopes: scope.scopes,
      createdAt: now,
      expiresAt: now + OAUTH_PENDING_TTL_MS,
    });
    return { kind: "redirect", location: `${iss}/connect/${id}` };
  }

  private sweepPending(now: number): void {
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
  }

  private livePending(id: unknown): PendingRequest | null {
    if (typeof id !== "string" || !OAUTH_REQUEST_ID_PATTERN.test(id)) return null;
    const p = this.pending.get(id);
    if (p === undefined) return null;
    if (p.expiresAt <= this.clock.now()) {
      this.pending.delete(id);
      return null;
    }
    return p;
  }

  /** The pending request for the consent page, or null (unknown, expired or already decided). */
  pendingRequest(id: unknown): PendingRequestView | null {
    const p = this.livePending(id);
    if (p === null) return null;
    return {
      id: p.id,
      client: {
        id: p.client.id,
        kind: p.client.kind,
        name: displayClientName(p.client.name),
        idHost: p.client.kind === "cimd" ? hostOf(p.client.id) : null,
      },
      redirectUri: p.redirectUri,
      redirectHost: hostOf(p.redirectUri),
      redirectKind: redirectKind(p.redirectUri),
      scopes: [...p.scopes],
      expiresAt: p.expiresAt,
    };
  }

  /**
   * The owner's decision (the caller has checked the session and CSRF). Approving creates the grant and a
   * one-time code; the scopes the owner kept must be a non-empty subset of those requested. Returns where to send
   * the browser. Throws `not_found` for an unknown or expired request.
   */
  async decide(
    id: unknown,
    decision: { approve: boolean; scopes?: readonly unknown[] | undefined },
  ): Promise<{ redirectUrl: string }> {
    const iss = this.requireIssuer();
    const p = this.livePending(id);
    if (p === null)
      throw new OAuthProtocolError(
        "not_found",
        "This request expired or was already answered",
        404,
      );
    let scopes: OAuthScope[] = p.scopes;
    if (decision.approve && decision.scopes !== undefined) {
      const kept = new Set(decision.scopes);
      scopes = p.scopes.filter((s) => kept.has(s));
      if (scopes.length === 0)
        throw new OAuthProtocolError("invalid_scope", "Keep at least one permission");
    }
    this.pending.delete(p.id);
    if (!decision.approve) {
      return {
        redirectUrl: withQuery(p.redirectUri, {
          error: "access_denied",
          error_description: "The owner denied the request",
          state: p.state,
          iss,
        }),
      };
    }
    const now = this.clock.now();
    if (p.client.kind === "cimd") {
      const existing = await this.store.getClient(this.ws, p.client.id);
      await this.store.upsertClient({
        workspaceId: this.ws,
        id: p.client.id,
        kind: "cimd",
        name: p.client.name,
        redirectUris: p.client.redirectUris,
        metadata: p.client.metadata,
        createdAt: existing?.createdAt ?? now,
      });
    } else if ((await this.store.getClient(this.ws, p.client.id)) === null) {
      throw new OAuthProtocolError("not_found", "The client registration expired", 404);
    }
    const grantId = this.ids.ulid();
    const resource = this.resource as string;
    await this.store.insertGrant({
      workspaceId: this.ws,
      id: grantId,
      clientId: p.client.id,
      clientName: p.client.name,
      redirectUri: p.redirectUri,
      scopes,
      resource,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: now + OAUTH_CODE_TTL_MS,
      revokedAt: null,
    });
    const code = generateAuthorizationCode();
    await this.store.insertCode({
      workspaceId: this.ws,
      codeHash: hash(code),
      grantId,
      clientId: p.client.id,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      resource,
      scopes,
      createdAt: now,
      expiresAt: now + OAUTH_CODE_TTL_MS,
      usedAt: null,
    });
    return { redirectUrl: withQuery(p.redirectUri, { code, state: p.state, iss }) };
  }

  // -----------------------------------------------------------------------------------------------------------
  // Token endpoint

  /** `POST /oauth/token` (form parameters already parsed). */
  async token(params: URLSearchParams): Promise<TokenResponse> {
    this.requireIssuer();
    for (const key of new Set(params.keys())) {
      if (params.getAll(key).length > 1)
        throw new OAuthProtocolError("invalid_request", `The parameter ${key} appears twice`);
    }
    const grantType = params.get("grant_type");
    const clientId = params.get("client_id");
    if (grantType === null)
      throw new OAuthProtocolError("invalid_request", "grant_type is required");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      throw new OAuthProtocolError("unsupported_grant_type", "Unsupported grant_type");
    }
    if (clientId === null || clientId === "")
      throw new OAuthProtocolError("invalid_request", "client_id is required");
    if (!OAUTH_DCR_CLIENT_PATTERN.test(clientId) && !isCimdClientId(clientId)) {
      throw new OAuthProtocolError("invalid_client", "Unknown client_id");
    }
    const resource = params.get("resource");
    if (resource !== null && canonicalResource(resource) === null) {
      throw new OAuthProtocolError("invalid_target", "resource is malformed");
    }
    return grantType === "authorization_code"
      ? this.exchangeCode(params, clientId, resource)
      : this.refresh(params, clientId, resource);
  }

  private async exchangeCode(
    params: URLSearchParams,
    clientId: string,
    resource: string | null,
  ): Promise<TokenResponse> {
    const code = params.get("code");
    const invalid = (d: string) => new OAuthProtocolError("invalid_grant", d);
    if (code === null || !OAUTH_CODE_PATTERN.test(code))
      throw invalid("Invalid authorization code");
    const consumed = await this.store.consumeCode(hash(code), this.clock.now());
    if (consumed === null) throw invalid("Invalid authorization code");
    const now = this.clock.now();
    const c = consumed.code;
    if (!consumed.firstUse) {
      // A replayed code may mean it was stolen: everything issued from it dies (RFC 6749 §4.1.2).
      await this.store.revokeGrant(this.ws, c.grantId, now);
      throw invalid("The authorization code was already used");
    }
    if (c.expiresAt <= now) throw invalid("The authorization code expired");
    if (c.clientId !== clientId) throw invalid("The code was issued to another client");
    if (params.get("redirect_uri") !== c.redirectUri)
      throw invalid("redirect_uri does not match the authorization request");
    if (!verifyPkceS256(params.get("code_verifier"), c.codeChallenge))
      throw invalid("PKCE verification failed");
    if (resource !== null && canonicalResource(resource) !== c.resource) {
      throw new OAuthProtocolError("invalid_target", "The code was issued for another resource");
    }
    const grant = await this.store.getGrant(this.ws, c.grantId);
    if (grant === null || grant.revokedAt !== null) throw invalid("The grant was revoked");
    return this.issue(grant, null, now);
  }

  private async refresh(
    params: URLSearchParams,
    clientId: string,
    resource: string | null,
  ): Promise<TokenResponse> {
    const invalid = (d: string) => new OAuthProtocolError("invalid_grant", d);
    const secret = params.get("refresh_token");
    if (secret === null || !OAUTH_REFRESH_PATTERN.test(secret))
      throw invalid("Invalid refresh token");
    const presented = await this.store.getTokenByHash(hash(secret));
    if (presented === null || presented.kind !== "refresh") throw invalid("Invalid refresh token");
    const now = this.clock.now();
    const grant = await this.store.getGrant(this.ws, presented.grantId);
    if (grant === null || grant.revokedAt !== null) throw invalid("The grant was revoked");
    if (grant.clientId !== clientId)
      throw invalid("The refresh token was issued to another client");
    if (presented.expiresAt <= now) throw invalid("The refresh token expired");
    if (resource !== null && canonicalResource(resource) !== grant.resource) {
      throw new OAuthProtocolError("invalid_target", "The grant is for another resource");
    }
    const scope = params.get("scope");
    if (scope !== null && scope !== "") {
      const asked = scope.split(" ").filter((s) => s !== "" && s !== "offline_access");
      if (asked.some((s) => !grant.scopes.includes(s))) {
        throw new OAuthProtocolError("invalid_scope", "A refresh cannot widen the granted scope");
      }
    }
    let current: OAuthTokenRecord = presented;
    if (presented.replacedBy !== null) {
      const successor = await this.store.getTokenByHash(presented.replacedBy);
      const inGrace =
        presented.rotatedAt !== null &&
        now - presented.rotatedAt <= OAUTH_REFRESH_GRACE_MS &&
        successor !== null &&
        successor.replacedBy === null;
      if (!inGrace || successor === null) {
        // Reuse of a rotated refresh token: assume theft and revoke the whole grant.
        await this.store.revokeGrant(this.ws, grant.id, now);
        throw invalid("The refresh token was already used");
      }
      current = successor;
    }
    return this.issue(grant, current, now);
  }

  /** Issues an access token and a refresh token (rotating `previous` when given). */
  private async issue(
    grant: OAuthGrantRecord,
    previous: OAuthTokenRecord | null,
    now: number,
  ): Promise<TokenResponse> {
    const refresh = generateRefreshToken();
    const refreshRecord: OAuthTokenRecord = {
      workspaceId: this.ws,
      tokenHash: hash(refresh),
      grantId: grant.id,
      kind: "refresh",
      createdAt: now,
      expiresAt: now + OAUTH_REFRESH_TTL_MS,
      replacedBy: null,
      rotatedAt: null,
    };
    if (previous === null) {
      await this.store.insertToken(refreshRecord);
    } else if (!(await this.store.rotateRefreshToken(previous.tokenHash, refreshRecord, now))) {
      throw new OAuthProtocolError("invalid_grant", "The refresh token was already used");
    }
    const access = generateAccessToken();
    await this.store.insertToken({
      workspaceId: this.ws,
      tokenHash: hash(access),
      grantId: grant.id,
      kind: "access",
      createdAt: now,
      expiresAt: now + OAUTH_ACCESS_TTL_MS,
      replacedBy: null,
      rotatedAt: null,
    });
    await this.store.updateGrant(this.ws, grant.id, {
      expiresAt: refreshRecord.expiresAt,
      lastUsedAt: now,
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(OAUTH_ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: onlyOAuthScopes(grant.scopes).join(" "),
    };
  }

  /**
   * `POST /oauth/revoke` (RFC 7009). Unknown tokens are ignored (the endpoint always answers 200). A refresh token
   * revokes its whole grant; an access token only itself.
   */
  async revokeToken(params: URLSearchParams): Promise<void> {
    if (this.issuer === null) return;
    const token = params.get("token");
    if (token === null || token.length > 200) return;
    const isAccess = OAUTH_ACCESS_PATTERN.test(token);
    if (!isAccess && !OAUTH_REFRESH_PATTERN.test(token)) return;
    const record = await this.store.getTokenByHash(hash(token));
    if (record === null) return;
    const clientId = params.get("client_id");
    if (clientId !== null) {
      const grant = await this.store.getGrant(this.ws, record.grantId);
      if (grant === null || grant.clientId !== clientId) return;
    }
    if (record.kind === "refresh")
      await this.store.revokeGrant(this.ws, record.grantId, this.clock.now());
    else await this.store.deleteToken(record.tokenHash);
  }

  // -----------------------------------------------------------------------------------------------------------
  // Resource server side

  /**
   * Resolves a `ppto_` access token presented at `resource`. Null for anything unknown, expired, revoked or bound
   * to another audience.
   */
  async authenticateAccessToken(secret: string, resource: string): Promise<OAuthAccess | null> {
    if (this.resource === null || !OAUTH_ACCESS_PATTERN.test(secret)) return null;
    if (canonicalResource(resource) !== this.resource) return null;
    const record = await this.store.getTokenByHash(hash(secret));
    if (record === null || record.kind !== "access" || record.workspaceId !== this.ws) return null;
    const now = this.clock.now();
    if (record.expiresAt <= now) return null;
    const grant = await this.store.getGrant(this.ws, record.grantId);
    if (grant === null || grant.revokedAt !== null || grant.resource !== this.resource) return null;
    if (grant.lastUsedAt === null || now - grant.lastUsedAt >= GRANT_TOUCH_INTERVAL_MS) {
      await this.store.updateGrant(this.ws, grant.id, { lastUsedAt: now });
      grant.lastUsedAt = now;
    }
    return { grant, scopes: onlyOAuthScopes(grant.scopes), expiresAt: record.expiresAt };
  }

  // -----------------------------------------------------------------------------------------------------------
  // Panel and maintenance

  /** Grants that can still be used (not revoked, not expired), newest first. */
  async connectedApps(): Promise<ConnectedApp[]> {
    const now = this.clock.now();
    const out: ConnectedApp[] = [];
    for (const g of await this.store.listGrants(this.ws)) {
      if (g.revokedAt !== null || g.expiresAt <= now) continue;
      const client = await this.store.getClient(this.ws, g.clientId);
      out.push({
        id: g.id,
        clientId: g.clientId,
        clientKind: client?.kind ?? null,
        clientName: displayClientName(g.clientName),
        redirectHost: hostOf(g.redirectUri),
        scopes: onlyOAuthScopes(g.scopes),
        createdAt: g.createdAt,
        lastUsedAt: g.lastUsedAt,
        expiresAt: g.expiresAt,
      });
    }
    return out;
  }

  /** Revokes a grant and every token issued under it. False for an unknown id. */
  async revokeGrant(id: unknown): Promise<boolean> {
    if (typeof id !== "string" || id.length > 64) return false;
    return this.store.revokeGrant(this.ws, id, this.clock.now());
  }

  /** "Disconnect every application" (password reset and, optionally, password change). */
  async revokeAllGrants(): Promise<number> {
    return this.store.revokeAllGrants(this.ws, this.clock.now());
  }

  /** Periodic clean-up: expired pending requests, cache entries, codes and tokens; dead grants; unused clients. */
  async cleanup(): Promise<{ rows: number; grants: number; clients: number }> {
    const now = this.clock.now();
    this.sweepPending(now);
    for (const [k, v] of this.cimdCache) if (v.expiresAt <= now) this.cimdCache.delete(k);
    const rows = await this.store.deleteExpired(this.ws, now);
    const purged = await this.store.purge(this.ws, {
      deadGrantsBefore: now - OAUTH_DEAD_GRANT_RETENTION_MS,
      clientsWithoutGrantBefore: now - OAUTH_UNUSED_CLIENT_TTL_MS,
    });
    return { rows, ...purged };
  }
}

export function createOAuthService(options: OAuthServiceOptions): OAuthService {
  return new OAuthService(options);
}
