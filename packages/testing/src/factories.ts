// SPDX-License-Identifier: AGPL-3.0-or-later
// Data factories for tests. Every factory returns a fresh object; pass overrides for the fields that matter.
import {
  type AssetRecord,
  type AuditEntry,
  type BlobStore,
  type Clock,
  type Core,
  type CoreConfigInput,
  createCore,
  type DeckRecord,
  type IdGenerator,
  ownerPrincipal,
  type PptxConverter,
  type Principal,
  type RevisionRecord,
  SCOPES,
  type Scope,
  type SlideInput,
  sha256Hex,
  type UnitOfWork,
  type VendorFetcher,
} from "@pptaken/core";
import { DECK_SCHEMA_VERSION, type Deck, type Slide } from "@pptaken/schema";
import { createTestIdGenerator, ManualClock, MemoryBlobStore, MemoryUnitOfWork } from "./memory.js";

export const TEST_WORKSPACE = "default";

/** `n` slides with ids `s1`â€¦ and a little HTML each (one numbered step). */
export function makeSlides(n: number, prefix = "s"): Slide[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    title: `Slide ${i + 1}`,
    html: `<h1>Slide ${i + 1}</h1><p data-step="1">Point</p>`,
    notes: `Notes ${i + 1}`,
  }));
}

/** Slides as an agent sends them (no ids). */
export function makeSlideInputs(n: number): SlideInput[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `Slide ${i + 1}`,
    html: `<h1>Slide ${i + 1}</h1>`,
  }));
}

export function makeDeck(overrides: Partial<Deck> = {}): Deck {
  return {
    schemaVersion: DECK_SCHEMA_VERSION,
    title: "Test deck",
    aspectRatio: "16:9",
    slides: makeSlides(3),
    ...overrides,
  };
}

let counter = 0;
/** A valid-looking ULID that sorts after every previous one returned by this function. */
export function nextTestUlid(): string {
  counter++;
  return `01JD${counter.toString().padStart(22, "0")}`;
}

export function makeDeckRecord(overrides: Partial<DeckRecord> = {}): DeckRecord {
  return {
    workspaceId: TEST_WORKSPACE,
    id: nextTestUlid(),
    title: "Test deck",
    lang: "en",
    currentRevision: 1,
    slideCount: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    createdBy: { actor: "agent", tokenId: "tok_1" },
    ...overrides,
  };
}

export function makeRevisionRecord(
  deck: Pick<DeckRecord, "workspaceId" | "id">,
  overrides: Partial<RevisionRecord> = {},
): RevisionRecord {
  const document = overrides.document ?? makeDeck();
  return {
    workspaceId: deck.workspaceId,
    deckId: deck.id,
    number: 1,
    document,
    title: document.title,
    slideCount: document.slides.length,
    summary: "Created",
    createdAt: 1_700_000_000_000,
    createdBy: { actor: "agent", tokenId: "tok_1" },
    ...overrides,
  };
}

export function makeAssetRecord(overrides: Partial<AssetRecord> = {}): AssetRecord {
  const sha256 = overrides.sha256 ?? sha256Hex(Uint8Array.of(counter++));
  return {
    workspaceId: TEST_WORKSPACE,
    sha256,
    mediaType: "image/png",
    bytes: 1234,
    width: 40,
    height: 30,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    workspaceId: TEST_WORKSPACE,
    id: nextTestUlid(),
    at: 1_700_000_000_000,
    actor: "agent",
    tokenId: "tok_1",
    action: "presentation.create",
    target: "deck:x",
    ip: "203.0.113.7",
    result: "ok",
    detail: { revision: 1 },
    ...overrides,
  };
}

/** An agent principal with the default token scopes (`decks:read`, `decks:write`, `quiz:draft`). */
export function agentPrincipal(
  scopes: readonly Scope[] = ["decks:read", "decks:write", "quiz:draft"],
  workspaceId = TEST_WORKSPACE,
): Principal {
  return { actor: "agent", workspaceId, scopes: new Set(scopes), tokenId: "tok_agent" };
}

export { ownerPrincipal, SCOPES };

/** A core wired to in-memory ports, with handles to each of them. */
export interface TestCore {
  core: Core;
  store: UnitOfWork;
  blobs: MemoryBlobStore;
  clock: ManualClock;
  ids: IdGenerator;
}

export function createTestCore(
  options: {
    config?: CoreConfigInput;
    store?: UnitOfWork;
    blobs?: BlobStore;
    clock?: Clock;
    /** Seed of the deterministic id generator; give each core sharing a database its own seed. */
    seed?: number;
    /** PowerPoint converter for `importPptx`. */
    convertPptx?: PptxConverter;
    /** Ingest-time vendoring fetcher (ADR-022); tests pass a fake network. */
    vendor?: VendorFetcher;
  } = {},
): TestCore {
  const clock = (options.clock as ManualClock | undefined) ?? new ManualClock();
  const store = options.store ?? new MemoryUnitOfWork();
  const blobs = (options.blobs as MemoryBlobStore | undefined) ?? new MemoryBlobStore(clock);
  const ids = createTestIdGenerator(clock, options.seed ?? 1);
  const core = createCore({
    store,
    blobs,
    clock,
    ids,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.convertPptx === undefined ? {} : { convertPptx: options.convertPptx }),
    ...(options.vendor === undefined ? {} : { vendor: options.vendor }),
  });
  return { core, store, blobs, clock, ids };
}
