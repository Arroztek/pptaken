// SPDX-License-Identifier: AGPL-3.0-or-later
// Ports: the interfaces the core needs from the outside world. Adapters (storage-sqlite, blob-fs, the in-memory
// implementations in @pptaken/testing, a future storage-postgres or blob-s3) implement them and must pass the
// contract suites of @pptaken/testing.
//
// Conventions for every port:
// - all methods are async (a Postgres or S3 adapter needs it);
// - every repository method takes the `workspaceId` explicitly: it is the multi-tenancy seam;
// - timestamps are epoch milliseconds (integers);
// - records are plain data; implementations must return copies, never live internal state;
// - repositories do not check permissions or business rules: the use cases do.

import type { Deck } from "@pptaken/schema";
import type { Actor } from "./principal.js";

/** Who created something: the actor kind plus the token used, if any. */
export interface ActorRef {
  actor: Actor;
  tokenId: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Records

/** A presentation's head row. The content lives in its revisions. */
export interface DeckRecord {
  workspaceId: string;
  /** ULID. */
  id: string;
  title: string;
  lang: string | null;
  /** Number of the latest revision (the one shown). Revisions are numbered from 1 without gaps at creation. */
  currentRevision: number;
  slideCount: number;
  createdAt: number;
  updatedAt: number;
  /** When it was moved to the trash; `null` when it is not in the trash. */
  deletedAt: number | null;
  createdBy: ActorRef;
}

/** Immutable snapshot of a presentation. */
export interface RevisionRecord {
  workspaceId: string;
  deckId: string;
  number: number;
  /** The sanitized and validated deck envelope. */
  document: Deck;
  title: string;
  slideCount: number;
  /** Short human-readable description of the change. */
  summary: string;
  createdAt: number;
  createdBy: ActorRef;
}

/** A revision without its document, for listings. */
export type RevisionSummary = Omit<RevisionRecord, "document">;

/** Metadata of an uploaded image. The bytes live in the {@link BlobStore} under the same SHA-256. */
export interface AssetRecord {
  workspaceId: string;
  /** SHA-256 of the content, 64 lowercase hex characters. */
  sha256: string;
  mediaType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  createdAt: number;
}

export type AuditResult = "ok" | "denied" | "error";

/** One audit log entry (security T18: who did what, with which token, from where, and how it ended). */
export interface AuditEntry {
  workspaceId: string;
  /** ULID. */
  id: string;
  at: number;
  actor: Actor;
  tokenId: string | null;
  /** Use case name, e.g. `presentation.create`. */
  action: string;
  /** Affected object, e.g. `deck:01J…` or `asset:<sha256>`. */
  target: string | null;
  ip: string | null;
  result: AuditResult;
  /** Small JSON-safe facts (revision number, error code). Never content or secrets. */
  detail: Record<string, unknown> | null;
}

/** Stored outcome of an idempotent create, keyed by workspace and a principal-scoped key. */
export interface IdempotencyRecord {
  workspaceId: string;
  key: string;
  /** SHA-256 of the canonical request, to detect a key reused with a different request. */
  requestHash: string;
  deckId: string;
  /** JSON-safe result returned to the first caller, replayed as-is. */
  result: Record<string, unknown>;
  createdAt: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Repositories

export interface DeckListQuery {
  workspaceId: string;
  /** Case-insensitive substring of the title (ASCII case folding is the portable guarantee). */
  titleContains?: string;
  /** `exclude` (default): live decks only. `only`: decks in the trash only. */
  trash?: "exclude" | "only";
  /** Maximum items to return (1..1000). */
  limit: number;
  /** Return decks whose id is strictly lower than this one (ids are ULIDs, so newest first). */
  beforeId?: string;
}

export interface DeckHeadUpdate {
  currentRevision: number;
  title: string;
  lang: string | null;
  slideCount: number;
  updatedAt: number;
}

export interface DeckRepository {
  /** Inserts a new deck. Throws if the id already exists in the workspace. */
  insert(deck: DeckRecord): Promise<void>;
  /** Returns the deck, including one in the trash, or `null`. */
  get(workspaceId: string, id: string): Promise<DeckRecord | null>;
  /**
   * Compare-and-set of the head: updates the deck only if its `currentRevision` equals `expectedRevision` and it
   * is not in the trash. Returns false otherwise (the use case then reports the conflict).
   */
  updateHead(
    workspaceId: string,
    id: string,
    expectedRevision: number,
    head: DeckHeadUpdate,
  ): Promise<boolean>;
  /** Sets or clears `deletedAt` (trash). Returns false if the deck does not exist. */
  setDeletedAt(workspaceId: string, id: string, deletedAt: number | null): Promise<boolean>;
  /** Deletes the deck row permanently. Its revisions and asset links must be deleted first. */
  delete(workspaceId: string, id: string): Promise<boolean>;
  /** Newest first (descending id). */
  list(query: DeckListQuery): Promise<DeckRecord[]>;
  /** Decks in the trash since before `deletedBefore`, oldest first. */
  listTrashedBefore(
    workspaceId: string,
    deletedBefore: number,
    limit: number,
  ): Promise<DeckRecord[]>;
}

export interface RevisionRepository {
  /** Inserts a revision. Throws if `(workspaceId, deckId, number)` already exists. */
  insert(revision: RevisionRecord): Promise<void>;
  get(workspaceId: string, deckId: string, number: number): Promise<RevisionRecord | null>;
  /** Newest first, without documents. `beforeNumber` paginates. */
  list(
    workspaceId: string,
    deckId: string,
    options: { limit: number; beforeNumber?: number },
  ): Promise<RevisionSummary[]>;
  /** Every revision number of the deck, ascending. */
  listNumbers(workspaceId: string, deckId: string): Promise<number[]>;
  /** Deletes the given revisions; returns how many were deleted. */
  deleteMany(workspaceId: string, deckId: string, numbers: readonly number[]): Promise<number>;
  /** Deletes every revision of the deck; returns how many were deleted. */
  deleteAllForDeck(workspaceId: string, deckId: string): Promise<number>;
}

export interface AssetRepository {
  /** Inserts the asset if `(workspaceId, sha256)` does not exist; returns false when it already existed. */
  insertIfAbsent(asset: AssetRecord): Promise<boolean>;
  get(workspaceId: string, sha256: string): Promise<AssetRecord | null>;
  /** Links an asset to a deck (idempotent). Returns false when the link already existed. */
  link(workspaceId: string, deckId: string, sha256: string, at: number): Promise<boolean>;
  isLinked(workspaceId: string, deckId: string, sha256: string): Promise<boolean>;
  /** Assets linked to the deck, ordered by sha256. */
  listForDeck(workspaceId: string, deckId: string): Promise<AssetRecord[]>;
  /** Count and total bytes of the assets linked to the deck. */
  statsForDeck(workspaceId: string, deckId: string): Promise<{ count: number; bytes: number }>;
  /** Removes every link of the deck; returns the sha256 of the assets that were linked. */
  unlinkAllForDeck(workspaceId: string, deckId: string): Promise<string[]>;
  /** Deletes the asset row if no deck links it. Returns true when it was deleted. */
  deleteIfUnlinked(workspaceId: string, sha256: string): Promise<boolean>;
  /** True if any workspace has an asset row with this hash (blobs are shared across workspaces). */
  isReferencedAnywhere(sha256: string): Promise<boolean>;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  /** Newest first. */
  list(
    workspaceId: string,
    options: { limit: number; beforeId?: string; target?: string },
  ): Promise<AuditEntry[]>;
}

/**
 * The owner's approval of a deck's author scripts (interactive mode, ADR-020): the digest the owner approved.
 * The current state is derived by comparing it with the digest of the current revision, so it never goes stale.
 */
export interface ScriptApprovalRecord {
  workspaceId: string;
  deckId: string;
  /** 64 lowercase hex characters (see `scriptsDigest`). */
  digest: string;
  approvedAt: number;
  /** The owner for an explicit approval; the writer whose edit continued the lineage for an automatic one. */
  approvedBy: ActorRef;
  /**
   * Trust lineage (ADR-024). `owner`: the owner approved exactly `digest` with a click. `auto`: `digest` continued a
   * lineage the owner started (an edit of already-approved code, no new library) while automatic updates were on.
   */
  mode: ApprovalMode;
  /** The last digest the owner approved with a click in this lineage (guest contexts only run this one). */
  ownerDigest: string;
  /** Libraries approved anywhere in this lineage, as `"<sha256> <source>"` keys (see `libKey`). */
  trustedLibs: string[];
  /** For `auto`: the revision whose (approved) code this one replaced, for "Review changes". */
  previousRevision: number | null;
}

/** How the current approval of a deck was given (ADR-024). */
export type ApprovalMode = "owner" | "auto";

export interface ScriptApprovalRepository {
  get(workspaceId: string, deckId: string): Promise<ScriptApprovalRecord | null>;
  /** Inserts or replaces the approval of the deck. */
  set(record: ScriptApprovalRecord): Promise<void>;
  /** Removes the approval; returns true when there was one. */
  delete(workspaceId: string, deckId: string): Promise<boolean>;
}

/** Where an author-script failure happened (ADR-023). */
export type ScriptErrorKind = "setup" | "handler" | "rejection" | "script-load" | "watchdog";

/**
 * One distinct author-script failure reported by the owner's player for one scripts digest (ADR-023). Every text
 * field comes from code running in the sandboxed frame: it is UNTRUSTED, already bounded and stripped of control
 * and bidi characters by the use case, and must only ever be displayed as plain text.
 */
export interface ScriptErrorRecord {
  workspaceId: string;
  deckId: string;
  /** The scripts digest the page was served with (equal to the approved digest at report time). */
  digest: string;
  /** SHA-256 (hex) of kind, slide, name and message: the dedupe key within a digest. */
  fingerprint: string;
  kind: ScriptErrorKind;
  /** A slide id of the deck, or `deck` for the deck-level script and unattributed errors. */
  slideId: string;
  name: string;
  message: string;
  stack: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface ScriptErrorRepository {
  /** Every record of the deck (all digests), most recently seen first. */
  list(workspaceId: string, deckId: string): Promise<ScriptErrorRecord[]>;
  get(
    workspaceId: string,
    deckId: string,
    digest: string,
    fingerprint: string,
  ): Promise<ScriptErrorRecord | null>;
  /** Inserts or replaces the record with the same (workspace, deck, digest, fingerprint). */
  put(record: ScriptErrorRecord): Promise<void>;
  /** Deletes one record; returns true when it existed. */
  deleteOne(
    workspaceId: string,
    deckId: string,
    digest: string,
    fingerprint: string,
  ): Promise<boolean>;
  /** Deletes every record of the deck; returns how many were deleted. */
  deleteForDeck(workspaceId: string, deckId: string): Promise<number>;
  /** Deletes the records of every digest not in `keep`; returns how many were deleted. */
  deleteDigestsExcept(
    workspaceId: string,
    deckId: string,
    keep: readonly string[],
  ): Promise<number>;
}

export interface IdempotencyRepository {
  get(workspaceId: string, key: string): Promise<IdempotencyRecord | null>;
  /** Inserts the record. Throws if the key already exists. */
  insert(record: IdempotencyRecord): Promise<void>;
  /** Deletes every record pointing to the deck (used by permanent deletion). */
  deleteForDeck(workspaceId: string, deckId: string): Promise<number>;
}

/** Every repository, bound to one transaction (or to autocommit outside a transaction). */
export interface Repositories {
  readonly decks: DeckRepository;
  readonly revisions: RevisionRepository;
  readonly assets: AssetRepository;
  readonly audit: AuditLog;
  readonly idempotency: IdempotencyRepository;
  readonly scriptApprovals: ScriptApprovalRepository;
  readonly scriptErrors: ScriptErrorRepository;
}

/**
 * Transaction boundary. `transaction(work)` runs `work` with repositories bound to one atomic unit: if `work`
 * throws, nothing it wrote is visible afterwards; if it resolves, everything is committed. Transactions are
 * serializable with respect to each other (SQLite: `BEGIN IMMEDIATE`; in memory: one at a time with copy-on-write).
 *
 * The repositories on the unit itself run outside any transaction (each call autocommits). Do not start a
 * transaction from inside another one, and do no slow I/O (blob writes, network) inside `work`.
 */
export interface UnitOfWork extends Repositories {
  transaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------------------------------------------
// Blobs

export interface BlobPutResult {
  /** SHA-256 of the content, 64 lowercase hex characters. */
  sha256: string;
  bytes: number;
}

export interface BlobInfo {
  sha256: string;
  bytes: number;
  /** When the blob was written (epoch ms), used by the garbage collector's grace period. */
  createdAt: number;
}

export interface BlobPutOptions {
  /** Abort and store nothing if the content is larger (throws a `LIMIT_EXCEEDED` DomainError). */
  maxBytes?: number;
}

/**
 * Content-addressed binary storage. Writes are atomic (a reader never sees a partial blob) and idempotent
 * (putting the same bytes twice stores one copy). Keys are SHA-256 hex digests; any other key is rejected or
 * reported as absent, never resolved to a path.
 */
export interface BlobStore {
  put(bytes: Uint8Array, options?: BlobPutOptions): Promise<BlobPutResult>;
  /** Streaming write: the hash is computed while writing. */
  putStream(chunks: AsyncIterable<Uint8Array>, options?: BlobPutOptions): Promise<BlobPutResult>;
  get(sha256: string): Promise<Uint8Array | null>;
  /** Streaming read; `null` if absent. */
  getStream(sha256: string): Promise<AsyncIterable<Uint8Array> | null>;
  has(sha256: string): Promise<boolean>;
  /** Returns true if something was deleted. */
  delete(sha256: string): Promise<boolean>;
  list(): AsyncIterable<BlobInfo>;
}

// ---------------------------------------------------------------------------------------------------------------
// Converters

/** Limits a converter must respect (the core's own, so its output is not refused afterwards). */
export interface ConverterLimits {
  maxSlides: number;
  maxAssetBytes: number;
  maxAssetsPerDeck: number;
  maxAssetBytesPerDeck: number;
  maxImagePixels: number;
}

/** What a PowerPoint converter returns. Every field is untrusted and checked again by the core. */
export interface PptxConversionOutput {
  /** A `pptaken.deck` envelope. */
  deck: unknown;
  assets: { sha256?: string; mediaType: string; bytes: Uint8Array }[];
  warnings: { code: string; message: string; slide?: number; feature?: string }[];
}

/**
 * Converts a PowerPoint file. Implementations must not touch storage, must run hostile input in isolation (time
 * and memory limits) and must throw only `DomainError` (`VALIDATION_ERROR`, `UNSUPPORTED_MEDIA`, `LIMIT_EXCEEDED`)
 * for files that cannot be imported. `@pptaken/import-pptx` provides one; the server wires it.
 */
export type PptxConverter = (
  bytes: Uint8Array,
  limits: ConverterLimits,
) => Promise<PptxConversionOutput>;

// ---------------------------------------------------------------------------------------------------------------
// Ingest-time vendoring (ADR-022)

/** What a vendored resource is used as; it selects the size cap and the content check. */
export type VendorKind = "script" | "stylesheet" | "font" | "image";

/**
 * Error classes of a vendor fetch. `blocked-address`: the URL (or a redirect) points to a private, loopback,
 * link-local, metadata or otherwise non-public address, a non-https URL, a port other than 443 or credentials;
 * `not-allowed-host`: the operator's allow/deny lists refuse the host; `too-large`: over the per-kind cap or the
 * write's budget; `timeout`: the request or the write's deadline passed; `bad-type`: the content is not what the
 * kind requires (checked by magic bytes and structure, never by the header alone); `http-error`: a non-2xx answer
 * or too many redirects; `rate-limited`: too many fetches by this actor; `disabled`: the operator turned vendoring
 * off; `fetch-failed`: any other network failure.
 */
export type VendorErrorCode =
  | "blocked-address"
  | "not-allowed-host"
  | "too-large"
  | "timeout"
  | "bad-type"
  | "http-error"
  | "rate-limited"
  | "disabled"
  | "fetch-failed";

export interface VendorFetchRequest {
  url: string;
  kind: VendorKind;
  /** The presentation being written (audit, rate limiting). */
  deckId: string;
  actor: ActorRef;
  /** Epoch ms after which the fetch must give up (`timeout`). */
  deadline: number;
}

export interface VendorFetchResult {
  /** The requested URL. */
  url: string;
  /** The URL that answered, after redirects. */
  finalUrl: string;
  /** Redirect targets followed, in order. */
  redirects: string[];
  bytes: Uint8Array;
  /** The declared `Content-Type`, informational only. */
  contentType: string | null;
}

/**
 * Fetches one external resource for ingest-time vendoring. Implementations must be SSRF-safe on every hop (https
 * only, public unicast addresses, connection pinned to the checked address), bounded (redirects, size per kind,
 * time, concurrency, rate per actor) and must throw only errors with a {@link VendorErrorCode} `code` (see
 * `VendorError` in `vendor.ts`). The server provides one (`apps/server/src/vendor-fetch.ts`); tests inject fakes.
 */
export interface VendorFetcher {
  /** False when the operator turned vendoring off: writes with external URLs are refused. */
  readonly enabled: boolean;
  fetch(request: VendorFetchRequest): Promise<VendorFetchResult>;
}

// ---------------------------------------------------------------------------------------------------------------
// Time and identifiers

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

export interface IdGenerator {
  /** A new ULID, monotonic within the same millisecond. */
  ulid(): string;
}
