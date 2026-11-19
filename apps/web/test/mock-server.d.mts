// SPDX-License-Identifier: AGPL-3.0-or-later
// Types for mock-server.mjs (plain Node, no build step), used by the Playwright tests.

export const INSTALL_CODE: string;
export const OWNER_PASSWORD: string;
export const STRICT_CSP: string;

export interface MockDeck {
  id: string;
  title: string;
  lang: string;
  slideCount: number;
  revision: number;
  updatedAt: string;
  createdBy: "owner" | "agent";
  scripts?: "none" | "pending" | "approved";
  vendored?: unknown[];
}

/** The approval-screen data of a deck (ADR-021), as GET /api/v1/decks/:id/scripts returns it. */
export interface MockReview {
  presentationId: string;
  revision: number;
  enabled: boolean;
  state: "none" | "pending" | "approved";
  digest: string | null;
  approvedDigest: string | null;
  approvedAt: string | null;
  slides: string[];
  libs: { name: string; version?: string; sha256: string; source?: string }[];
  chars: number;
  capability: { contentOrigin: string; separateSiteContent: boolean; freezeWarning: boolean };
  sources: { slideId: string; index: number; source: string; sha256: string; bytes: number }[];
  warnings: { code: string; message: string; path: string | null; name: string | null }[];
  /** ADR-024 trust lineage. */
  approvalMode?: "owner" | "auto" | null;
  ownerApproved?: boolean;
  newLibs?: { name: string; sha256: string; source?: string | null }[];
  previousRevision?: number | null;
  previous?: unknown;
  autoApproveUpdates?: boolean;
}

export interface MockToken {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  hash: string;
}

export interface MockApp {
  id: string;
  clientId: string;
  clientKind: "cimd" | "dcr" | null;
  clientName: string | null;
  redirectHost: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export interface MockOAuthRequest {
  id: string;
  client: { id: string; kind: "cimd" | "dcr"; name: string | null; idHost: string | null };
  redirectUri: string;
  redirectHost: string;
  redirectKind: "claude" | "loopback" | "web";
  scopes: string[];
  expiresAt: string;
}

export interface MockLogEntry {
  method: string;
  path: string;
  csrf: string | string[] | null;
  origin: string | null;
}

export interface MockStateOptions {
  /** Ingest-time vendoring switch reported by GET /decks/:id (ADR-022), default "on". */
  vendorFetch?: "on" | "off";
  /** Give deck_001 a sample list of vendored resources. */
  vendored?: boolean;
  installed?: boolean;
  password?: string;
  https?: boolean;
  /** A number of generated decks, or explicit decks. */
  decks?: number | MockDeck[];
  pageSize?: number;
  /** Delay after the first token is created before connect/status reports a connected agent. */
  connectDelayMs?: number;
  loginLimit?: number;
  retryAfter?: number;
  csp?: string;
  /** A number of generated connected applications, or explicit ones. */
  apps?: number | MockApp[];
  /** A number of generated pending consent requests, or explicit ones. */
  oauthRequests?: number | MockOAuthRequest[];
  /** PPTAKEN_SCRIPTS=owner (default true). */
  scriptsEnabled?: boolean;
  contentOrigin?: "same-origin" | "same-site" | "separate-site";
  /** A presenter password already set. */
  presenterPassword?: string | null;
  /** Script errors of deck_002 (ADR-023). Default "none". */
  scriptErrors?: "none" | "errors" | "previous";
  /** Adds the static check findings (ADR-023) to the reviews. */
  scriptChecks?: boolean;
  /** A number of generated presentations already in the trash. */
  trashed?: number;
  /** The owner setting "Allow interactive updates automatically" (ADR-024), default true. */
  autoApproveUpdates?: boolean;
  /** deck_002 (approved) was last updated by the agent and allowed automatically. */
  autoApproved?: boolean;
  /** deck_001 (pending) waits because of a new outside library after an earlier approval. */
  newLib?: boolean;
}

export interface MockState {
  installed: boolean;
  password: string | null;
  https: boolean;
  decks: MockDeck[];
  pageSize: number;
  connectDelayMs: number;
  loginLimit: number;
  retryAfter: number;
  sessions: Set<string>;
  tokens: MockToken[];
  apps: MockApp[];
  oauthRequests: MockOAuthRequest[];
  firstTokenAt: number | null;
  loginAttempts: number[];
  csp: string;
  log: MockLogEntry[];
  exports: { id: string; format: string; notes: string | null }[];
  imports: number[];
  scriptsEnabled: boolean;
  contentOrigin: string;
  reviews: Map<string, MockReview>;
  presenterPassword: string | null;
  scriptErrors: "none" | "errors" | "previous";
  scriptChecks: boolean;
  clearedErrors: Set<string>;
  trash: (MockDeck & { deletedAt: string })[];
  purged: string[];
  approvals: number;
  autoApproveUpdates: boolean;
}

export interface MockServer {
  url: string;
  state: MockState;
  close(): Promise<void>;
}

export function makeDecks(n: number, now?: number): MockDeck[];
export function makeReview(
  deck: MockDeck,
  options?: { version?: number; enabled?: boolean; contentOrigin?: string; staleDigest?: string },
): MockReview;
export function makeApps(n: number, now?: number): MockApp[];
export function makeOAuthRequests(n: number, now?: number): MockOAuthRequest[];
export function createState(options?: MockStateOptions): MockState;
export function startMockServer(
  options?: MockStateOptions & { port?: number; dist?: string },
): Promise<MockServer>;
export function vendoredSample(now?: number): unknown[];
/** An agent edit of a deck's interactive code, through the mock's mirror of the trust-lineage rule. */
export function agentEdit(
  state: MockState,
  deckId: string,
  options?: { newLibrary?: boolean },
): MockReview;
