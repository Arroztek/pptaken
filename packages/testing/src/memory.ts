// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory implementations of every port. They are the reference behaviour of the contract suites and what the
// core's own tests run on. Not meant for production (no durability, everything in one process).
import {
  type AssetRecord,
  type AssetRepository,
  type AuditEntry,
  type AuditLog,
  type BlobInfo,
  type BlobPutOptions,
  type BlobPutResult,
  type BlobStore,
  type Clock,
  createUlidFactory,
  type DeckHeadUpdate,
  type DeckListQuery,
  type DeckRecord,
  type DeckRepository,
  type IdempotencyRecord,
  type IdempotencyRepository,
  type IdGenerator,
  limitExceeded,
  type Repositories,
  type RevisionRecord,
  type RevisionRepository,
  type RevisionSummary,
  type ScriptApprovalRecord,
  type ScriptApprovalRepository,
  type ScriptErrorRecord,
  type ScriptErrorRepository,
  sha256Hex,
  type UnitOfWork,
} from "@pptaken/core";

// ---------------------------------------------------------------------------------------------------------------
// Clock and ids

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  constructor(private current: number = Date.UTC(2026, 0, 1)) {}
  now(): number {
    return this.current;
  }
  set(ms: number): void {
    this.current = ms;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

/** Deterministic pseudo-random bytes (xorshift32). For tests only. */
export function seededRandom(seed = 1): (n: number) => Uint8Array {
  let state = seed >>> 0 || 1;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

/** Deterministic ULID generator over a clock and a seed: same seed and times, same ids. */
export function createTestIdGenerator(clock: Clock = new ManualClock(), seed = 1): IdGenerator {
  const next = createUlidFactory(() => clock.now(), seededRandom(seed));
  return { ulid: next };
}

// ---------------------------------------------------------------------------------------------------------------
// Storage

interface State {
  decks: Map<string, DeckRecord>;
  revisions: Map<string, RevisionRecord>;
  assets: Map<string, AssetRecord>;
  links: Map<string, { workspaceId: string; deckId: string; sha256: string; at: number }>;
  audit: Map<string, AuditEntry>;
  idempotency: Map<string, IdempotencyRecord>;
  scriptApprovals: Map<string, ScriptApprovalRecord>;
  scriptErrors: Map<string, ScriptErrorRecord>;
}

function emptyState(): State {
  return {
    decks: new Map(),
    revisions: new Map(),
    assets: new Map(),
    links: new Map(),
    audit: new Map(),
    idempotency: new Map(),
    scriptApprovals: new Map(),
    scriptErrors: new Map(),
  };
}

/** Copy-on-write snapshot: maps are copied, records are immutable once stored. */
function cloneState(s: State): State {
  return {
    decks: new Map(s.decks),
    revisions: new Map(s.revisions),
    assets: new Map(s.assets),
    links: new Map(s.links),
    audit: new Map(s.audit),
    idempotency: new Map(s.idempotency),
    scriptApprovals: new Map(s.scriptApprovals),
    scriptErrors: new Map(s.scriptErrors),
  };
}

const k = (...parts: (string | number)[]) => parts.join("\u0000");
const clone = <T>(value: T): T => structuredClone(value);

/** ASCII-only case folding: the portable guarantee (SQLite `LIKE` folds ASCII only). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

class DuplicateKeyError extends Error {
  constructor(what: string) {
    super(`Duplicate key: ${what}`);
    this.name = "DuplicateKeyError";
  }
}

type Exec = <T>(write: boolean, fn: (s: State) => T) => Promise<T>;

function repositories(exec: Exec): Repositories {
  const decks: DeckRepository = {
    insert: (deck) =>
      exec(true, (s) => {
        const key = k(deck.workspaceId, deck.id);
        if (s.decks.has(key)) throw new DuplicateKeyError(`deck ${deck.id}`);
        s.decks.set(key, clone(deck));
      }),
    get: (ws, id) => exec(false, (s) => clone(s.decks.get(k(ws, id)) ?? null)),
    updateHead: (ws, id, expected, head: DeckHeadUpdate) =>
      exec(true, (s) => {
        const deck = s.decks.get(k(ws, id));
        if (deck === undefined || deck.deletedAt !== null || deck.currentRevision !== expected) {
          return false;
        }
        s.decks.set(k(ws, id), { ...deck, ...clone(head) });
        return true;
      }),
    setDeletedAt: (ws, id, deletedAt) =>
      exec(true, (s) => {
        const deck = s.decks.get(k(ws, id));
        if (deck === undefined) return false;
        s.decks.set(k(ws, id), { ...deck, deletedAt });
        return true;
      }),
    delete: (ws, id) =>
      exec(true, (s) => {
        if (!s.decks.has(k(ws, id))) return false;
        const used =
          [...s.revisions.values()].some((r) => r.workspaceId === ws && r.deckId === id) ||
          [...s.links.values()].some((l) => l.workspaceId === ws && l.deckId === id) ||
          s.scriptApprovals.has(k(ws, id)) ||
          [...s.scriptErrors.values()].some((r) => r.workspaceId === ws && r.deckId === id);
        if (used) throw new Error("Foreign key constraint: the deck still has revisions or assets");
        s.decks.delete(k(ws, id));
        return true;
      }),
    list: (q: DeckListQuery) =>
      exec(false, (s) => {
        const needle = q.titleContains === undefined ? undefined : asciiLower(q.titleContains);
        const trash = q.trash ?? "exclude";
        return [...s.decks.values()]
          .filter(
            (d) =>
              d.workspaceId === q.workspaceId &&
              (trash === "only" ? d.deletedAt !== null : d.deletedAt === null) &&
              (q.beforeId === undefined || d.id < q.beforeId) &&
              (needle === undefined || asciiLower(d.title).includes(needle)),
          )
          .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
          .slice(0, q.limit)
          .map(clone);
      }),
    listTrashedBefore: (ws, before, limit) =>
      exec(false, (s) =>
        [...s.decks.values()]
          .filter((d) => d.workspaceId === ws && d.deletedAt !== null && d.deletedAt < before)
          .sort(
            (a, b) => (a.deletedAt as number) - (b.deletedAt as number) || (a.id < b.id ? -1 : 1),
          )
          .slice(0, limit)
          .map(clone),
      ),
  };

  const summary = (r: RevisionRecord): RevisionSummary => {
    const { document: _doc, ...rest } = r;
    return clone(rest);
  };
  const revisions: RevisionRepository = {
    insert: (r) =>
      exec(true, (s) => {
        const key = k(r.workspaceId, r.deckId, r.number);
        if (s.revisions.has(key)) throw new DuplicateKeyError(`revision ${r.deckId}/${r.number}`);
        if (!s.decks.has(k(r.workspaceId, r.deckId)))
          throw new Error("Foreign key constraint: deck");
        s.revisions.set(key, clone(r));
      }),
    get: (ws, deckId, n) => exec(false, (s) => clone(s.revisions.get(k(ws, deckId, n)) ?? null)),
    list: (ws, deckId, { limit, beforeNumber }) =>
      exec(false, (s) =>
        [...s.revisions.values()]
          .filter(
            (r) =>
              r.workspaceId === ws &&
              r.deckId === deckId &&
              (beforeNumber === undefined || r.number < beforeNumber),
          )
          .sort((a, b) => b.number - a.number)
          .slice(0, limit)
          .map(summary),
      ),
    listNumbers: (ws, deckId) =>
      exec(false, (s) =>
        [...s.revisions.values()]
          .filter((r) => r.workspaceId === ws && r.deckId === deckId)
          .map((r) => r.number)
          .sort((a, b) => a - b),
      ),
    deleteMany: (ws, deckId, numbers) =>
      exec(true, (s) => {
        let n = 0;
        for (const number of new Set(numbers)) if (s.revisions.delete(k(ws, deckId, number))) n++;
        return n;
      }),
    deleteAllForDeck: (ws, deckId) =>
      exec(true, (s) => {
        let n = 0;
        for (const [key, r] of s.revisions) {
          if (r.workspaceId === ws && r.deckId === deckId) {
            s.revisions.delete(key);
            n++;
          }
        }
        return n;
      }),
  };

  const assets: AssetRepository = {
    insertIfAbsent: (a) =>
      exec(true, (s) => {
        const key = k(a.workspaceId, a.sha256);
        if (s.assets.has(key)) return false;
        s.assets.set(key, clone(a));
        return true;
      }),
    get: (ws, sha) => exec(false, (s) => clone(s.assets.get(k(ws, sha)) ?? null)),
    link: (ws, deckId, sha, at) =>
      exec(true, (s) => {
        const key = k(ws, deckId, sha);
        if (s.links.has(key)) return false;
        if (!s.decks.has(k(ws, deckId)) || !s.assets.has(k(ws, sha))) {
          throw new Error("Foreign key constraint: deck or asset");
        }
        s.links.set(key, { workspaceId: ws, deckId, sha256: sha, at });
        return true;
      }),
    isLinked: (ws, deckId, sha) => exec(false, (s) => s.links.has(k(ws, deckId, sha))),
    listForDeck: (ws, deckId) =>
      exec(false, (s) =>
        [...s.links.values()]
          .filter((l) => l.workspaceId === ws && l.deckId === deckId)
          .map((l) => s.assets.get(k(ws, l.sha256)))
          .filter((a): a is AssetRecord => a !== undefined)
          .sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1))
          .map(clone),
      ),
    statsForDeck: (ws, deckId) =>
      exec(false, (s) => {
        let count = 0;
        let bytes = 0;
        for (const l of s.links.values()) {
          if (l.workspaceId !== ws || l.deckId !== deckId) continue;
          count++;
          bytes += s.assets.get(k(ws, l.sha256))?.bytes ?? 0;
        }
        return { count, bytes };
      }),
    unlinkAllForDeck: (ws, deckId) =>
      exec(true, (s) => {
        const out: string[] = [];
        for (const [key, l] of s.links) {
          if (l.workspaceId === ws && l.deckId === deckId) {
            s.links.delete(key);
            out.push(l.sha256);
          }
        }
        return out.sort();
      }),
    deleteIfUnlinked: (ws, sha) =>
      exec(true, (s) => {
        if (!s.assets.has(k(ws, sha))) return false;
        for (const l of s.links.values())
          if (l.workspaceId === ws && l.sha256 === sha) return false;
        s.assets.delete(k(ws, sha));
        return true;
      }),
    isReferencedAnywhere: (sha) =>
      exec(false, (s) => [...s.assets.values()].some((a) => a.sha256 === sha)),
  };

  const audit: AuditLog = {
    append: (e) =>
      exec(true, (s) => {
        const key = k(e.workspaceId, e.id);
        if (s.audit.has(key)) throw new DuplicateKeyError(`audit ${e.id}`);
        s.audit.set(key, clone(e));
      }),
    list: (ws, { limit, beforeId, target }) =>
      exec(false, (s) =>
        [...s.audit.values()]
          .filter(
            (e) =>
              e.workspaceId === ws &&
              (beforeId === undefined || e.id < beforeId) &&
              (target === undefined || e.target === target),
          )
          .sort((a, b) => (a.id < b.id ? 1 : -1))
          .slice(0, limit)
          .map(clone),
      ),
  };

  const idempotency: IdempotencyRepository = {
    get: (ws, key) => exec(false, (s) => clone(s.idempotency.get(k(ws, key)) ?? null)),
    insert: (r) =>
      exec(true, (s) => {
        const key = k(r.workspaceId, r.key);
        if (s.idempotency.has(key)) throw new DuplicateKeyError(`idempotency ${r.key}`);
        s.idempotency.set(key, clone(r));
      }),
    deleteForDeck: (ws, deckId) =>
      exec(true, (s) => {
        let n = 0;
        for (const [key, r] of s.idempotency) {
          if (r.workspaceId === ws && r.deckId === deckId) {
            s.idempotency.delete(key);
            n++;
          }
        }
        return n;
      }),
  };

  const scriptApprovals: ScriptApprovalRepository = {
    get: (ws, deckId) => exec(false, (s) => clone(s.scriptApprovals.get(k(ws, deckId)) ?? null)),
    set: (r) =>
      exec(true, (s) => {
        if (!s.decks.has(k(r.workspaceId, r.deckId))) throw new Error("Unknown deck");
        s.scriptApprovals.set(k(r.workspaceId, r.deckId), clone(r));
      }),
    delete: (ws, deckId) => exec(true, (s) => s.scriptApprovals.delete(k(ws, deckId))),
  };

  const errKey = (ws: string, deckId: string, digest: string, fp: string) =>
    k(ws, deckId, digest, fp);
  const scriptErrors: ScriptErrorRepository = {
    list: (ws, deckId) =>
      exec(false, (s) =>
        [...s.scriptErrors.values()]
          .filter((r) => r.workspaceId === ws && r.deckId === deckId)
          .sort((a, b) => b.lastSeen - a.lastSeen || (a.fingerprint < b.fingerprint ? -1 : 1))
          .map(clone),
      ),
    get: (ws, deckId, digest, fp) =>
      exec(false, (s) => clone(s.scriptErrors.get(errKey(ws, deckId, digest, fp)) ?? null)),
    put: (r) =>
      exec(true, (s) => {
        if (!s.decks.has(k(r.workspaceId, r.deckId))) throw new Error("Unknown deck");
        s.scriptErrors.set(errKey(r.workspaceId, r.deckId, r.digest, r.fingerprint), clone(r));
      }),
    deleteOne: (ws, deckId, digest, fp) =>
      exec(true, (s) => s.scriptErrors.delete(errKey(ws, deckId, digest, fp))),
    deleteForDeck: (ws, deckId) =>
      exec(true, (s) => {
        let n = 0;
        for (const [key, r] of s.scriptErrors) {
          if (r.workspaceId === ws && r.deckId === deckId) {
            s.scriptErrors.delete(key);
            n++;
          }
        }
        return n;
      }),
    deleteDigestsExcept: (ws, deckId, keep) =>
      exec(true, (s) => {
        let n = 0;
        for (const [key, r] of s.scriptErrors) {
          if (r.workspaceId === ws && r.deckId === deckId && !keep.includes(r.digest)) {
            s.scriptErrors.delete(key);
            n++;
          }
        }
        return n;
      }),
  };

  return { decks, revisions, assets, audit, idempotency, scriptApprovals, scriptErrors };
}

/**
 * In-memory {@link UnitOfWork}. Transactions run one at a time (a promise queue) on a copy-on-write snapshot that
 * replaces the committed state only when the work resolves, so a throwing transaction leaves no trace. Writes
 * outside a transaction are queued the same way (each one is its own transaction).
 */
export class MemoryUnitOfWork implements UnitOfWork {
  private state: State = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  readonly decks: DeckRepository;
  readonly revisions: RevisionRepository;
  readonly assets: AssetRepository;
  readonly audit: AuditLog;
  readonly idempotency: IdempotencyRepository;
  readonly scriptApprovals: ScriptApprovalRepository;
  readonly scriptErrors: ScriptErrorRepository;

  constructor() {
    const repos = repositories(async (write, fn) => {
      if (!write) return fn(this.state);
      return this.serialized(async () => {
        const draft = cloneState(this.state);
        const out = fn(draft);
        this.state = draft;
        return out;
      });
    });
    this.decks = repos.decks;
    this.revisions = repos.revisions;
    this.assets = repos.assets;
    this.audit = repos.audit;
    this.idempotency = repos.idempotency;
    this.scriptApprovals = repos.scriptApprovals;
    this.scriptErrors = repos.scriptErrors;
  }

  transaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const draft = cloneState(this.state);
      let open = true;
      const tx = repositories(async (_write, fn) => {
        if (!open) throw new Error("Transaction already finished");
        return fn(draft);
      });
      try {
        const out = await work(tx);
        this.state = draft;
        return out;
      } finally {
        open = false;
      }
    });
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Blobs

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** In-memory {@link BlobStore}. `put` of existing content refreshes its `createdAt` (like blob-fs's mtime). */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, { bytes: Uint8Array; createdAt: number }>();
  constructor(private readonly clock: Clock = { now: () => Date.now() }) {}

  async put(bytes: Uint8Array, options: BlobPutOptions = {}): Promise<BlobPutResult> {
    if (options.maxBytes !== undefined && bytes.length > options.maxBytes) {
      throw limitExceeded("Blob too large", options.maxBytes, bytes.length, { unit: "bytes" });
    }
    const sha256 = sha256Hex(bytes);
    this.blobs.set(sha256, { bytes: bytes.slice(), createdAt: this.clock.now() });
    return { sha256, bytes: bytes.length };
  }

  async putStream(
    chunks: AsyncIterable<Uint8Array>,
    options: BlobPutOptions = {},
  ): Promise<BlobPutResult> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks) {
      total += chunk.length;
      if (options.maxBytes !== undefined && total > options.maxBytes) {
        throw limitExceeded("Blob too large", options.maxBytes, total, { unit: "bytes" });
      }
      parts.push(chunk.slice());
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      all.set(p, off);
      off += p.length;
    }
    return this.put(all);
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    return this.blobs.get(sha256)?.bytes.slice() ?? null;
  }

  async getStream(sha256: string): Promise<AsyncIterable<Uint8Array> | null> {
    const bytes = await this.get(sha256);
    if (bytes === null) return null;
    return (async function* () {
      for (let off = 0; off < bytes.length; off += 64 * 1024)
        yield bytes.slice(off, off + 64 * 1024);
    })();
  }

  async has(sha256: string): Promise<boolean> {
    return SHA256_HEX.test(sha256) && this.blobs.has(sha256);
  }

  async delete(sha256: string): Promise<boolean> {
    return SHA256_HEX.test(sha256) && this.blobs.delete(sha256);
  }

  async *list(): AsyncIterable<BlobInfo> {
    for (const [sha256, b] of [...this.blobs]) {
      yield { sha256, bytes: b.bytes.length, createdAt: b.createdAt };
    }
  }

  /** Test helper: backdates a blob. */
  setCreatedAt(sha256: string, createdAt: number): void {
    const b = this.blobs.get(sha256);
    if (b !== undefined) b.createdAt = createdAt;
  }
}
