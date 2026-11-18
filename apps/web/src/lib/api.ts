// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed client for the panel HTTP API (docs/spec/http-api.md). Every response is validated before use.
import {
  arrayOf,
  bool,
  count,
  type Guard,
  type Infer,
  isoDate,
  nullable,
  object,
  oneOf,
  optionalNull,
  parse,
  ShapeError,
  str,
} from "./validate";

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "SETUP_REQUIRED",
  "ALREADY_SETUP",
  "RATE_LIMITED",
  "INTERNAL",
] as const;

/** Contract codes plus three client-side ones: no connection, a malformed answer, anything else. */
export type ErrorCode = (typeof ERROR_CODES)[number] | "NETWORK" | "BAD_RESPONSE" | "UNKNOWN";

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly hint: string | null = null,
    /** Seconds to wait, from Retry-After (RATE_LIMITED only). */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Parse Retry-After: delta-seconds or an HTTP date. Returns whole seconds >= 1, or null. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.max(1, Number.parseInt(trimmed, 10));
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(1, Math.ceil((at - now) / 1000));
}

const errorBody = object({
  error: object({ code: str, message: str, hint: optionalNull(str) }),
});

function codeFromStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "INTERNAL" : "UNKNOWN";
  }
}

/** Build an ApiError from a non-2xx response body. Unknown codes fall back to the HTTP status. */
export function toApiError(status: number, body: unknown, retryAfter: string | null): ApiError {
  let code: ErrorCode = codeFromStatus(status);
  let message = `HTTP ${status}`;
  let hint: string | null = null;
  try {
    const parsed = parse(errorBody, body).error;
    if ((ERROR_CODES as readonly string[]).includes(parsed.code)) code = parsed.code as ErrorCode;
    message = parsed.message;
    hint = parsed.hint;
  } catch {
    // Not the documented error envelope (e.g. a proxy error page): keep the status-based code.
  }
  return new ApiError(
    code,
    status,
    message,
    hint,
    code === "RATE_LIMITED" ? parseRetryAfter(retryAfter) : null,
  );
}

// ------------------------------------------------------------------ shapes

export const SCOPES = ["decks:read", "decks:write", "quiz:draft"] as const;
export const SCRIPTS_STATES = ["none", "pending", "approved"] as const;

const setupStatus = object({ installed: bool, publicUrl: str, https: bool, version: str });
const ownerResponse = object({ owner: object({ id: str }) });
const token = object({
  id: str,
  name: str,
  scopes: arrayOf(str),
  createdAt: isoDate,
  expiresAt: nullable(isoDate),
});
const tokenListItem = object({
  id: str,
  name: str,
  scopes: arrayOf(str),
  createdAt: isoDate,
  expiresAt: nullable(isoDate),
  lastUsedAt: optionalNull(isoDate),
  revokedAt: optionalNull(isoDate),
});
const SECRET_RE = /^ppt_[A-Za-z0-9_-]{43}$/;
const secret: Guard<string> = (v, p) => {
  const s = str(v, p);
  if (!SECRET_RE.test(s)) throw new ShapeError(p, "ppt_ + 43 base64url characters");
  return s;
};
const createdToken = object({ token, secret });
const tokenList = object({ tokens: arrayOf(tokenListItem) });
const connectStatus = object({
  mcpUrl: str,
  agentConnected: bool,
  lastCallAt: nullable(isoDate),
  lastTool: nullable(str),
  clientName: nullable(str),
});
const deckSummary = object({
  id: str,
  title: str,
  lang: nullable(str),
  slideCount: count,
  revision: count,
  updatedAt: isoDate,
  createdBy: oneOf(["owner", "agent"] as const),
  /** Trust state of the current revision's author scripts (ADR-020); absent from older servers. */
  scripts: optionalNull(oneOf(SCRIPTS_STATES)),
});
const deckPage = object({ decks: arrayOf(deckSummary), nextCursor: nullable(str) });
export const VENDOR_KINDS = ["script", "stylesheet", "font", "image"] as const;
/** Provenance of one vendored external resource (ADR-022). URLs are shown as text, never followed. */
const vendoredResource = object({
  kind: oneOf(VENDOR_KINDS),
  url: str,
  status: oneOf(["vendored", "failed"] as const),
  finalUrl: optionalNull(str),
  redirects: optionalNull(arrayOf(str)),
  sha256: optionalNull(str),
  bytes: optionalNull(count),
  mediaType: optionalNull(str),
  fetchedAt: count,
  error: optionalNull(str),
  via: optionalNull(str),
});
export type VendoredResource = Infer<typeof vendoredResource>;
const deckDetail = object({
  id: str,
  title: str,
  lang: nullable(str),
  slideCount: count,
  revision: count,
  updatedAt: isoDate,
  createdBy: oneOf(["owner", "agent"] as const),
  scripts: optionalNull(oneOf(SCRIPTS_STATES)),
  urls: object({ present: str }),
  /** Ingest-time vendoring switch (ADR-022); absent from older servers. */
  vendorFetch: optionalNull(oneOf(["on", "off"] as const)),
  /** Provenance of the current revision's vendored resources (ADR-022). */
  vendored: optionalNull(arrayOf(vendoredResource)),
});

// Interactive mode: the approval screen (ADR-021).
const DIGEST_RE = /^[0-9a-f]{64}$/;
const digest: Guard<string> = (v, p) => {
  const s = str(v, p);
  if (!DIGEST_RE.test(s)) throw new ShapeError(p, "64 lowercase hex characters");
  return s;
};
const vendoredScript = object({
  name: str,
  version: optionalNull(str),
  sha256: digest,
  source: optionalNull(str),
  /** ADR-022: the URL that answered after redirects, and the stored size. */
  finalUrl: optionalNull(str),
  bytes: optionalNull(count),
});
const scriptSource = object({
  slideId: str,
  index: count,
  source: str,
  sha256: digest,
  bytes: count,
});
const scriptWarning = object({
  code: str,
  message: str,
  path: optionalNull(str),
  name: optionalNull(str),
});
const statusShape = {
  presentationId: str,
  revision: count,
  /** The instance switch (PPTAKEN_SCRIPTS=owner). */
  enabled: bool,
  state: oneOf(SCRIPTS_STATES),
  digest: nullable(digest),
  approvedDigest: nullable(digest),
  approvedAt: nullable(isoDate),
  slides: arrayOf(str),
  /** A deck-level script exists (ADR-022); absent from older servers. */
  deckScript: optionalNull(bool),
  libs: arrayOf(vendoredScript),
  chars: count,
  capability: object({
    contentOrigin: oneOf(["same-origin", "same-site", "separate-site"] as const),
    separateSiteContent: bool,
    freezeWarning: bool,
  }),
};
const scriptsStatus = object(statusShape);
const scriptsReview = object({
  ...statusShape,
  sources: arrayOf(scriptSource),
  deckSource: optionalNull(object({ source: str, sha256: digest, bytes: count })),
  warnings: arrayOf(scriptWarning),
  presenterPassword: object({ set: bool }),
});
const presenterPasswordStatus = object({ set: bool });
const presenterPasswordSet = object({ set: bool, change: oneOf(["set", "changed"] as const) });
const importWarning = object({
  code: str,
  message: str,
  path: optionalNull(str),
  slideId: optionalNull(str),
  /** What was affected (`chart`, `font:Calibri`...), for PowerPoint imports. */
  name: optionalNull(str),
});
const importResult = object({
  deck: object({ id: str, title: str }),
  assetCount: count,
  warnings: arrayOf(importWarning),
});

const oauthRequest = object({
  id: str,
  client: object({
    id: str,
    kind: oneOf(["cimd", "dcr"] as const),
    name: nullable(str),
    idHost: nullable(str),
  }),
  redirectUri: str,
  redirectHost: str,
  redirectKind: oneOf(["claude", "loopback", "web"] as const),
  scopes: arrayOf(str),
  expiresAt: isoDate,
});
const oauthDecision = object({ redirectUrl: str });
const connectedApp = object({
  id: str,
  clientId: str,
  clientKind: nullable(oneOf(["cimd", "dcr"] as const)),
  clientName: nullable(str),
  redirectHost: str,
  scopes: arrayOf(str),
  createdAt: isoDate,
  lastUsedAt: nullable(isoDate),
  expiresAt: isoDate,
});
const connectedApps = object({ apps: arrayOf(connectedApp) });
const passwordChanged = object({ disconnectedApps: count });

export type SetupStatus = Infer<typeof setupStatus>;
export type OAuthRequest = Infer<typeof oauthRequest>;
export type ConnectedApp = Infer<typeof connectedApp>;
export type Token = Infer<typeof token>;
export type TokenListItem = Infer<typeof tokenListItem>;
export type CreatedToken = Infer<typeof createdToken>;
export type ConnectStatus = Infer<typeof connectStatus>;
export type DeckSummary = Infer<typeof deckSummary>;
export type DeckPage = Infer<typeof deckPage>;
export type DeckDetail = Infer<typeof deckDetail>;
export type ScriptsStatus = Infer<typeof scriptsStatus>;
export type ScriptsReview = Infer<typeof scriptsReview>;
export type ScriptSource = Infer<typeof scriptSource>;
export type VendoredScript = Infer<typeof vendoredScript>;
export type ScriptWarning = Infer<typeof scriptWarning>;
export type ImportResult = Infer<typeof importResult>;
export type ImportWarning = Infer<typeof importWarning>;
export type ExportFormat = "html" | "pptaken";

/** Largest archive the server accepts by default (PPTAKEN_MAX_IMPORT_MB). */
export const MAX_IMPORT_MB = 100;

/** What an import uploads: a PPTaken archive or a PowerPoint file. */
export type ImportKind = "archive" | "pptx";

export const PPTX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const IMPORT_TARGETS: Record<ImportKind, { path: string; type: string }> = {
  archive: { path: "/decks/import", type: "application/zip" },
  pptx: { path: "/decks/import-pptx", type: PPTX_MEDIA_TYPE },
};

/** Upload progress: bytes sent (`fraction` 0..1), then the server's work (`fraction` null). */
export interface ImportProgress {
  phase: "upload" | "process";
  fraction: number | null;
}

/** The parts of XMLHttpRequest the uploader uses (a fake in unit tests). */
export interface UploadRequest {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  getResponseHeader(name: string): string | null;
  send(body: Blob): void;
  readonly status: number;
  readonly responseText: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  upload: {
    onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null;
    onload: (() => void) | null;
  };
}

/**
 * Uploads an import with upload progress (fetch cannot report it). Same contract as the API client: CSRF header,
 * same-origin cookies, validated response, `ApiError` on failure.
 */
export function uploadImport(
  file: Blob,
  kind: ImportKind,
  onProgress: (progress: ImportProgress) => void = () => {},
  makeRequest: () => UploadRequest = () => new XMLHttpRequest() as unknown as UploadRequest,
  base = "/api/v1",
): Promise<ImportResult> {
  const target = IMPORT_TARGETS[kind];
  return new Promise((resolve, reject) => {
    const xhr = makeRequest();
    xhr.open("POST", `${base}${target.path}`);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", target.type);
    xhr.setRequestHeader("X-PPTaken-CSRF", "1");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress({ phase: "upload", fraction: Math.min(1, e.loaded / e.total) });
      }
    };
    xhr.upload.onload = () => onProgress({ phase: "process", fraction: null });
    xhr.onerror = () => reject(new ApiError("NETWORK", 0, "Network error"));
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        json = null;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(toApiError(xhr.status, json, xhr.getResponseHeader("Retry-After")));
        return;
      }
      try {
        resolve(parse(importResult, json));
      } catch (e) {
        reject(
          new ApiError("BAD_RESPONSE", xhr.status, e instanceof Error ? e.message : "Bad response"),
        );
      }
    };
    onProgress({ phase: "upload", fraction: 0 });
    xhr.send(file);
  });
}

/**
 * Same-origin URL of an export download, used as a plain `<a href download>` (the session cookie goes along).
 * HTML leaves the speaker notes out unless asked; the .pkn archive keeps them.
 */
export function exportUrl(
  id: string,
  format: ExportFormat,
  notes: boolean,
  base = "/api/v1",
): string {
  const query = new URLSearchParams({ format, notes: notes ? "1" : "0" });
  return `${base}/decks/${encodeURIComponent(id)}/export?${query.toString()}`;
}
export type Session = "signed-in" | "signed-out" | "setup-required";

// ------------------------------------------------------------------ client

type Method = "GET" | "POST" | "DELETE";
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClient {
  setupStatus(): Promise<SetupStatus>;
  setup(installCode: string, password: string): Promise<{ ownerId: string }>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  session(): Promise<Session>;
  createToken(name: string, scopes?: readonly string[]): Promise<CreatedToken>;
  listTokens(): Promise<TokenListItem[]>;
  revokeToken(id: string): Promise<void>;
  connectStatus(): Promise<ConnectStatus>;
  listDecks(params?: { cursor?: string | null; q?: string }): Promise<DeckPage>;
  /** Uploads a .pkn archive as the raw body (application/zip); the server creates a new presentation. */
  importDeck(file: Blob): Promise<ImportResult>;
  /** Uploads a PowerPoint .pptx as the raw body; the server converts it into a new presentation. */
  importPptx(file: Blob): Promise<ImportResult>;
  /** A pending OAuth connection request (the consent page). */
  oauthRequest(id: string): Promise<OAuthRequest>;
  /** Approves (with the scopes kept) or denies it; returns where to send the browser. */
  decideOAuthRequest(
    id: string,
    decision: "approve" | "deny",
    scopes?: readonly string[],
  ): Promise<string>;
  listConnectedApps(): Promise<ConnectedApp[]>;
  disconnectApp(id: string): Promise<void>;
  changePassword(input: {
    currentPassword: string;
    newPassword: string;
    disconnectApps: boolean;
  }): Promise<{ disconnectedApps: number }>;
  /** One presentation (the deck page header). */
  getDeck(id: string): Promise<DeckDetail>;
  /** The approval screen: status, every script's source, libraries, warnings, capability. */
  scriptsReview(id: string): Promise<ScriptsReview>;
  /**
   * Approves the scripts the owner reviewed. `digest` is the one shown: if the deck changed meanwhile the server
   * answers 409 and nothing is approved.
   */
  approveScripts(id: string, digest: string): Promise<ScriptsStatus>;
  revokeScripts(id: string): Promise<ScriptsStatus>;
  presenterPassword(): Promise<{ set: boolean }>;
  setPresenterPassword(password: string): Promise<{ set: boolean; change: "set" | "changed" }>;
  removePresenterPassword(): Promise<void>;
}

export function createApi(
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
  base = "/api/v1",
): ApiClient {
  async function request<T>(
    method: Method,
    path: string,
    guard: Guard<T> | null,
    body?: unknown,
    raw?: { body: Blob; type: string },
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (raw !== undefined) headers["Content-Type"] = raw.type;
    else if (body !== undefined) headers["Content-Type"] = "application/json";
    // CSRF: every state-changing request carries the header; the browser adds Origin.
    if (method !== "GET") headers["X-PPTaken-CSRF"] = "1";
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        body: raw !== undefined ? raw.body : body === undefined ? null : JSON.stringify(body),
      });
    } catch (cause) {
      throw new ApiError("NETWORK", 0, cause instanceof Error ? cause.message : "Network error");
    }
    const text = await response.text().catch(() => "");
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!response.ok) throw toApiError(response.status, json, response.headers.get("Retry-After"));
    if (guard === null) return undefined as T;
    try {
      return parse(guard, json);
    } catch (e) {
      throw new ApiError(
        "BAD_RESPONSE",
        response.status,
        e instanceof Error ? e.message : "Bad response",
      );
    }
  }

  return {
    setupStatus: () => request("GET", "/setup/status", setupStatus),
    async setup(installCode, password) {
      const r = await request("POST", "/setup", ownerResponse, { installCode, password });
      return { ownerId: r.owner.id };
    },
    async login(password) {
      await request("POST", "/auth/login", null, { password });
    },
    async logout() {
      await request("POST", "/auth/logout", null);
    },
    async session() {
      try {
        await request("GET", "/auth/me", object({ owner: object({ id: str }) }));
        return "signed-in";
      } catch (e) {
        if (e instanceof ApiError && e.code === "UNAUTHENTICATED") return "signed-out";
        if (e instanceof ApiError && e.code === "SETUP_REQUIRED") return "setup-required";
        throw e;
      }
    },
    createToken: (name, scopes) =>
      request("POST", "/tokens", createdToken, scopes ? { name, scopes: [...scopes] } : { name }),
    async listTokens() {
      return (await request("GET", "/tokens", tokenList)).tokens;
    },
    async revokeToken(id) {
      await request("DELETE", `/tokens/${encodeURIComponent(id)}`, null);
    },
    connectStatus: () => request("GET", "/connect/status", connectStatus),
    listDecks(params = {}) {
      const query = new URLSearchParams();
      if (params.cursor) query.set("cursor", params.cursor);
      if (params.q) query.set("q", params.q);
      const qs = query.toString();
      return request("GET", `/decks${qs ? `?${qs}` : ""}`, deckPage);
    },
    oauthRequest: (id) => request("GET", `/oauth/requests/${encodeURIComponent(id)}`, oauthRequest),
    async decideOAuthRequest(id, decision, scopes) {
      const body = scopes === undefined ? { decision } : { decision, scopes: [...scopes] };
      const r = await request(
        "POST",
        `/oauth/requests/${encodeURIComponent(id)}`,
        oauthDecision,
        body,
      );
      return r.redirectUrl;
    },
    async listConnectedApps() {
      return (await request("GET", "/oauth/apps", connectedApps)).apps;
    },
    async disconnectApp(id) {
      await request("DELETE", `/oauth/apps/${encodeURIComponent(id)}`, null);
    },
    changePassword: (input) => request("POST", "/auth/password", passwordChanged, input),
    getDeck: (id) => request("GET", `/decks/${encodeURIComponent(id)}`, deckDetail),
    scriptsReview: (id) =>
      request("GET", `/decks/${encodeURIComponent(id)}/scripts`, scriptsReview),
    approveScripts: (id, value) =>
      request("POST", `/decks/${encodeURIComponent(id)}/scripts/approve`, scriptsStatus, {
        digest: value,
      }),
    revokeScripts: (id) =>
      request("POST", `/decks/${encodeURIComponent(id)}/scripts/revoke`, scriptsStatus),
    presenterPassword: () => request("GET", "/presenter/password", presenterPasswordStatus),
    setPresenterPassword: (password) =>
      request("POST", "/presenter/password", presenterPasswordSet, { password }),
    async removePresenterPassword() {
      await request("DELETE", "/presenter/password", null);
    },
    importDeck: (file) =>
      request("POST", "/decks/import", importResult, undefined, {
        body: file,
        type: "application/zip",
      }),
    importPptx: (file) =>
      request("POST", "/decks/import-pptx", importResult, undefined, {
        body: file,
        type: PPTX_MEDIA_TYPE,
      }),
  };
}

export const api = createApi();
