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
// Time and identifiers

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

export interface IdGenerator {
  /** A new ULID, monotonic within the same millisecond. */
  ulid(): string;
}
