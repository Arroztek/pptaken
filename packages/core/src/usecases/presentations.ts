// SPDX-License-Identifier: AGPL-3.0-or-later
// Presentation use cases: create, read, list, edit, trash, restore, purge.
import {
  type AspectRatio,
  DECK_SCHEMA_VERSION,
  type Deck,
  type GoogleFont,
  type Slide,
  type Theme,
  type VendoredScript,
} from "@pptaken/schema";
import {
  applySlideEdits,
  type CoreWarning,
  type OutlineItem,
  outlineOf,
  type SlideUpsert,
  sanitizeAndCheck,
  slideIdAllocator,
  validateDeck,
} from "../deck.js";
import { notFound, presentationNotFound, validationError } from "../errors.js";
import type { DeckRecord, Repositories } from "../ports.js";
import {
  type CallContext,
  type Principal,
  requireOwner,
  requireOwnerOrSystem,
  requireScope,
} from "../principal.js";
import { scriptsSummary } from "../scripts.js";
import { sha256Hex, utf8Encode } from "../sha256.js";
import { isUlid } from "../ulid.js";
import { commitRevision, type RevisionWriteResult, summaryOf } from "./commit.js";
import {
  actorRef,
  assertExpected,
  audit,
  type Ctx,
  decodeCursor,
  encodeCursor,
  loadLiveDeck,
  optionalLimit,
  requireObject,
  requireRevision,
  requireString,
  runRead,
  runWrite,
} from "./context.js";
import {
  linkVendoredAssets,
  probeEnvelope,
  type VendoredAsset,
  type VendorReportEntry,
  vendorDeckInput,
} from "./vendoring.js";

// ---------------------------------------------------------------------------------------------------------------
// Types

/** A theme as sent by an agent: `googleFonts` is vendored into `fontFaces` on write (ADR-022). */
export type ThemeInput = Theme & { googleFonts?: GoogleFont[] };

/** A slide as sent by an agent: `id` and `title` are optional. */
export type SlideInput = Omit<Slide, "id" | "title"> & { id?: string; title?: string };

export interface CreatePresentationInput {
  title: string;
  /** BCP-47 tag; defaults to the instance language (`CoreConfig.defaultLang`) when configured. */
  lang?: string;
  aspectRatio?: AspectRatio;
  theme?: ThemeInput;
  /** 1..maxSlides slides. Missing ids are generated (`slide-1`, `slide-2`…). */
  slides: SlideInput[];
  targetMinutes?: number;
  /**
   * Vendored scripts for author scripts (interactive mode, ADR-020): bundled ids, full references, or https CDN URLs
   * that the server vendors on write (ADR-022).
   */
  libs?: (string | VendoredScript)[];
  /** Deck-level script run once before the slide scripts (ADR-022). */
  script?: string;
  /** Internal (HTML import): warnings of an earlier stage, listed first. */
  extraWarnings?: CoreWarning[];
  /** Internal (HTML import): the audit action. */
  auditAction?: string;
  /** Repeating a call with the same key (same principal) returns the first result instead of creating again. */
  idempotencyKey?: string;
  /** Revision summary (default: "Created with N slides"). */
  summary?: string;
}

export interface CreatePresentationResult extends RevisionWriteResult {
  /** True when this is the stored result of an earlier call with the same idempotency key. */
  replayed: boolean;
}

export const INCLUDE_PARTS = ["outline", "theme", "slides", "notes"] as const;
export type IncludePart = (typeof INCLUDE_PARTS)[number];

export interface GetPresentationInput {
  presentationId: string;
  /** Parts to return; default `["outline"]`. */
  include?: IncludePart[];
  /** Restricts `slides` and `notes` to these ids. */
  slideIds?: string[];
  /** Read an older revision instead of the current one. */
  revision?: number;
}

/** A slide without its speaker notes (notes are only returned in `notes`). */
export type SlideView = Omit<Slide, "notes">;

export interface PresentationView {
  presentationId: string;
  title: string;
  lang: string | null;
  aspectRatio: AspectRatio;
  /** Revision these contents come from. */
  revision: number;
  /** Current revision of the presentation (differs from `revision` when an older one was requested). */
  currentRevision: number;
  slideCount: number;
  targetMinutes: number | null;
  createdAt: number;
  updatedAt: number;
  outline?: OutlineItem[];
  theme?: Theme | null;
  /** Vendored scripts of the author scripts (interactive mode), when the deck declares any. */
  libs?: VendoredScript[];
  slides?: SlideView[];
  notes?: { id: string; notes: string }[];
}

export interface ListPresentationsInput {
  /** Case-insensitive title substring. */
  query?: string;
  /** Page size, 1..100 (default 20). */
  limit?: number;
  cursor?: string;
  /** List the trash instead (owner only). */
  trashed?: boolean;
}

export interface PresentationSummary {
  presentationId: string;
  title: string;
  lang: string | null;
  revision: number;
  slideCount: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface Page<T> {
  items: T[];
  /** Pass it as `cursor` to get the next page; `null` on the last page. */
  nextCursor: string | null;
}

export interface UpdatePresentationInput {
  presentationId: string;
  expectedRevision: number;
  title?: string;
  /** `null` removes the language. */
  lang?: string | null;
  aspectRatio?: AspectRatio;
  /** Replaces the whole theme; `null` removes it. */
  theme?: ThemeInput | null;
  /** `null` removes the target. */
  targetMinutes?: number | null;
  /** Replaces the deck-level script (ADR-022); `null` removes it. */
  script?: string | null;
  /** Replaces the vendored script list (interactive mode); `null` removes it. */
  libs?: (string | VendoredScript)[] | null;
  /** New slide order; must contain exactly the current slide ids. */
  slideOrder?: string[];
  summary?: string;
}

export interface UpdateSlidesInput {
  presentationId: string;
  expectedRevision: number;
  /** Applied in order, before `remove`. */
  upsert?: SlideUpsert[];
  /** Slide ids to remove, applied after `upsert`. */
  remove?: string[];
  summary?: string;
}

export interface TrashResult {
  presentationId: string;
  trashed: true;
  /** Epoch ms until which the owner can restore it from the panel. */
  restorableUntil: number;
}

export interface PurgeResult {
  presentationId: string;
  purged: true;
  revisionsDeleted: number;
  assetsDeleted: number;
  blobsDeleted: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The shared tail of every edit: validate (before any network access), vendor external resources (ADR-022),
 * validate again, sanitize. Returns what `commitRevision` needs.
 */
async function vendorAndCheck(
  ctx: Ctx,
  principal: Principal,
  call: CallContext | undefined,
  deckId: string,
  next: unknown,
  current: Deck,
): Promise<{
  document: Deck;
  warnings: CoreWarning[];
  assets: VendoredAsset[];
  report: VendorReportEntry[];
}> {
  const max = ctx.config.limits.maxSlides;
  validateDeck(probeEnvelope(next), max);
  const vendored = await vendorDeckInput(ctx, principal, call, {
    deckId,
    input: next,
    previous: current,
  });
  const parsed = validateDeck(vendored.envelope, max);
  const linked = await ctx.store.assets.listForDeck(principal.workspaceId, deckId);
  const scripts = [
    ...linked.filter((a) => a.mediaType === "text/javascript").map((a) => a.sha256),
    ...vendored.scripts,
  ];
  const { deck, warnings } = sanitizeAndCheck(
    parsed,
    max,
    [...linked.map((a) => a.sha256), ...vendored.assets.map((a) => a.sha256)],
    scripts,
  );
  return {
    document: deck,
    warnings: [...vendored.warnings, ...warnings],
    assets: vendored.assets,
    report: vendored.report,
  };
}

async function loadRevisionDocument(
  repos: Repositories,
  ws: string,
  deckId: string,
  number: number,
): Promise<Deck> {
  const revision = await repos.revisions.get(ws, deckId, number);
  if (revision === null) {
    throw notFound(`Revision ${number} does not exist`, {
      path: "revision",
      hint: "Call `list_revisions` to see the revisions that are kept.",
    });
  }
  return revision.document;
}

function summaryView(deck: DeckRecord): PresentationSummary {
  return {
    presentationId: deck.id,
    title: deck.title,
    lang: deck.lang,
    revision: deck.currentRevision,
    slideCount: deck.slideCount,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
    deletedAt: deck.deletedAt,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Use cases

export async function createPresentation(
  ctx: Ctx,
  principal: Principal,
  rawInput: CreatePresentationInput,
  call?: CallContext,
): Promise<CreatePresentationResult> {
  return runWrite(ctx, principal, call, "presentation.create", null, async () => {
    requireScope(principal, "decks:write");
    const input = requireObject(rawInput) as unknown as CreatePresentationInput;
    const ws = principal.workspaceId;

    let idemKey: string | undefined;
    let requestHash = "";
    if (input.idempotencyKey !== undefined) {
      const key = requireString(input.idempotencyKey, "idempotencyKey", 200);
      idemKey = `${principal.actor}:${principal.tokenId ?? "-"}:${key}`;
      const { idempotencyKey: _ignored, ...request } = input;
      requestHash = sha256Hex(utf8Encode(canonicalJson(request)));
      const replay = await replayIdempotent(ctx.store, ws, idemKey, requestHash);
      if (replay !== null) return replay;
    }

    const slides: unknown = Array.isArray(input.slides)
      ? (() => {
          const ids = slideIdAllocator(
            input.slides.flatMap((s) =>
              typeof s === "object" && s !== null && typeof s.id === "string" ? [s.id] : [],
            ),
          );
          return input.slides.map((s) =>
            typeof s === "object" && s !== null && s.id === undefined ? { ...s, id: ids() } : s,
          );
        })()
      : input.slides;

    const envelope = withoutUndefined({
      schemaVersion: DECK_SCHEMA_VERSION,
      title: input.title,
      lang: input.lang ?? ctx.config.defaultLang,
      aspectRatio: input.aspectRatio,
      theme: input.theme,
      targetMinutes: input.targetMinutes,
      slides,
      libs: input.libs,
      script: input.script,
    });
    // Validate before any network access, then vendor external resources (ADR-022), then validate the result.
    validateDeck(probeEnvelope(envelope), ctx.config.limits.maxSlides);
    const id = ctx.ids.ulid();
    const vendored = await vendorDeckInput(ctx, principal, call, {
      deckId: id,
      input: envelope,
      previous: null,
    });
    const parsed = validateDeck(vendored.envelope, ctx.config.limits.maxSlides);
    const sanitized = sanitizeAndCheck(
      parsed,
      ctx.config.limits.maxSlides,
      vendored.assets.map((a) => a.sha256),
      vendored.scripts,
    );
    const deck = sanitized.deck;
    const warnings = [...(input.extraWarnings ?? []), ...vendored.warnings, ...sanitized.warnings];
    const summary = summaryOf(input.summary, `Created with ${deck.slides.length} slide(s)`);

    return ctx.store.transaction(async (tx) => {
      if (idemKey !== undefined) {
        const replay = await replayIdempotent(tx, ws, idemKey, requestHash);
        if (replay !== null) return replay;
      }
      const now = ctx.clock.now();
      await tx.decks.insert({
        workspaceId: ws,
        id,
        title: deck.title,
        lang: deck.lang ?? null,
        currentRevision: 1,
        slideCount: deck.slides.length,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        createdBy: actorRef(principal),
      });
      await linkVendoredAssets(ctx, tx, ws, id, vendored.assets, now);
      await tx.revisions.insert({
        workspaceId: ws,
        deckId: id,
        number: 1,
        document: deck,
        title: deck.title,
        slideCount: deck.slides.length,
        summary,
        createdAt: now,
        createdBy: actorRef(principal),
      });
      const scripts = scriptsSummary(deck, null);
      const result: CreatePresentationResult = {
        presentationId: id,
        revision: 1,
        slideCount: deck.slides.length,
        warnings,
        scripts,
        vendored: vendored.report,
        replayed: false,
      };
      if (idemKey !== undefined) {
        await tx.idempotency.insert({
          workspaceId: ws,
          key: idemKey,
          requestHash,
          deckId: id,
          result: JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
          createdAt: now,
        });
      }
      await audit(
        ctx,
        tx,
        principal,
        call,
        input.auditAction ?? "presentation.create",
        `deck:${id}`,
        "ok",
        {
          revision: 1,
          ...(vendored.report.length === 0 ? {} : { vendored: vendored.report.length }),
          ...(scripts.digest === null
            ? {}
            : { scriptsDigest: scripts.digest, scriptsState: "pending" }),
        },
      );
      return result;
    });
  });
}

async function replayIdempotent(
  repos: Repositories,
  ws: string,
  key: string,
  requestHash: string,
): Promise<CreatePresentationResult | null> {
  const record = await repos.idempotency.get(ws, key);
  if (record === null) return null;
  if (record.requestHash !== requestHash) {
    throw validationError("This idempotency key was already used for a different request", {
      path: "idempotencyKey",
      hint: "Use a new idempotency key for a new presentation, or resend exactly the same request.",
    });
  }
  return { ...(record.result as unknown as CreatePresentationResult), replayed: true };
}

export async function getPresentation(
  ctx: Ctx,
  principal: Principal,
  rawInput: GetPresentationInput,
  call?: CallContext,
): Promise<PresentationView> {
  return runRead(call, async () => {
    requireScope(principal, "decks:read");
    const input = requireObject(rawInput) as unknown as GetPresentationInput;
    const id = requireString(input.presentationId, "presentationId");
    if (!Array.isArray(input.include ?? [])) {
      throw validationError("include must be an array", { path: "include" });
    }
    const include = new Set<IncludePart>(input.include ?? ["outline"]);
    for (const [i, part] of [...include].entries()) {
      if (!(INCLUDE_PARTS as readonly string[]).includes(part)) {
        throw validationError(`Unknown include part "${String(part)}"`, {
          path: `include[${i}]`,
          hint: `Use any of: ${INCLUDE_PARTS.join(", ")}.`,
        });
      }
    }
    const deck = await loadLiveDeck(ctx.store, principal, id);
    const number =
      input.revision === undefined
        ? deck.currentRevision
        : requireRevision(input.revision, "revision");
    const doc = await loadRevisionDocument(ctx.store, principal.workspaceId, id, number);

    let selected = doc.slides;
    if (input.slideIds !== undefined) {
      if (!Array.isArray(input.slideIds)) {
        throw validationError("slideIds must be an array", { path: "slideIds" });
      }
      const byId = new Map(doc.slides.map((s) => [s.id, s]));
      input.slideIds.forEach((sid, i) => {
        if (!byId.has(sid)) {
          throw notFound(`No slide has id "${String(sid)}"`, {
            path: `slideIds[${i}]`,
            hint: 'Call `get_presentation` with include ["outline"] to see the slide ids.',
          });
        }
      });
      const wanted = new Set(input.slideIds);
      selected = doc.slides.filter((s) => wanted.has(s.id));
    }

    const view: PresentationView = {
      presentationId: id,
      title: doc.title,
      lang: doc.lang ?? null,
      aspectRatio: doc.aspectRatio,
      revision: number,
      currentRevision: deck.currentRevision,
      slideCount: doc.slides.length,
      targetMinutes: doc.targetMinutes ?? null,
      createdAt: deck.createdAt,
      updatedAt: deck.updatedAt,
    };
    if (include.has("outline")) view.outline = outlineOf(doc);
    if (doc.libs !== undefined && doc.libs.length > 0) view.libs = doc.libs.map((l) => ({ ...l }));
    if (include.has("theme")) view.theme = doc.theme ?? null;
    if (include.has("slides")) {
      view.slides = selected.map(({ notes: _notes, ...rest }) => rest);
    }
    if (include.has("notes")) {
      view.notes = selected.map((s) => ({ id: s.id, notes: s.notes ?? "" }));
    }
    return view;
  });
}

export async function listPresentations(
  ctx: Ctx,
  principal: Principal,
  rawInput: ListPresentationsInput = {},
  call?: CallContext,
): Promise<Page<PresentationSummary>> {
  return runRead(call, async () => {
    requireScope(principal, "decks:read");
    const input = requireObject(rawInput) as ListPresentationsInput;
    if (input.trashed === true) requireOwner(principal, "list the trash");
    const limit = optionalLimit(input.limit, 20, 100);
    const before = decodeCursor(input.cursor, "d");
    if (before !== undefined && !isUlid(before)) {
      throw validationError("Invalid cursor", { path: "cursor" });
    }
    if (
      input.query !== undefined &&
      (typeof input.query !== "string" || input.query.length > 200)
    ) {
      throw validationError("query must be a string of at most 200 characters", { path: "query" });
    }
    const query = input.query?.trim();
    const rows = await ctx.store.decks.list({
      workspaceId: principal.workspaceId,
      trash: input.trashed === true ? "only" : "exclude",
      limit: limit + 1,
      ...(query ? { titleContains: query } : {}),
      ...(before === undefined ? {} : { beforeId: before }),
    });
    const items = rows.slice(0, limit).map(summaryView);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor("d", last.presentationId) : null,
    };
  });
}

export async function updatePresentation(
  ctx: Ctx,
  principal: Principal,
  rawInput: UpdatePresentationInput,
  call?: CallContext,
): Promise<RevisionWriteResult> {
  const target = targetOf(rawInput);
  return runWrite(ctx, principal, call, "presentation.update", target, async () => {
    requireScope(principal, "decks:write");
    const input = requireObject(rawInput) as unknown as UpdatePresentationInput;
    const id = requireString(input.presentationId, "presentationId");
    const expected = requireRevision(input.expectedRevision, "expectedRevision");
    const ws = principal.workspaceId;
    const deck = await loadLiveDeck(ctx.store, principal, id);
    assertExpected(deck, expected);
    const current = await loadRevisionDocument(ctx.store, ws, id, expected);

    const next: Record<string, unknown> = { ...current };
    const changed: string[] = [];
    const set = (key: string, value: unknown) => {
      if (value === undefined) return;
      changed.push(key);
      if (value === null) delete next[key];
      else next[key] = value;
    };
    set("title", input.title);
    set("lang", input.lang);
    set("aspectRatio", input.aspectRatio);
    set("theme", input.theme);
    set("targetMinutes", input.targetMinutes);
    set("libs", input.libs);
    set("script", input.script);
    if (input.slideOrder !== undefined) {
      next.slides = reorder(current.slides, input.slideOrder);
      changed.push("slideOrder");
    }
    if (changed.length === 0) {
      throw validationError("Nothing to update", {
        hint: "Send at least one of title, lang, aspectRatio, theme, targetMinutes, libs, script or slideOrder. Use `update_slides` to edit slides.",
      });
    }
    const written = await vendorAndCheck(ctx, principal, call, id, next, current);
    return commitRevision(ctx, principal, call, {
      deckId: id,
      expectedRevision: expected,
      ...written,
      summary: summaryOf(input.summary, `Updated ${changed.join(", ")}`),
      action: "presentation.update",
      detail: { fields: changed },
    });
  });
}

function reorder(slides: readonly Slide[], order: unknown): Slide[] {
  const hint =
    "slideOrder must list every current slide id exactly once. Call `get_presentation` to see them.";
  if (!Array.isArray(order))
    throw validationError("slideOrder must be an array", { path: "slideOrder", hint });
  const byId = new Map(slides.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: Slide[] = [];
  order.forEach((id, i) => {
    const slide = typeof id === "string" ? byId.get(id) : undefined;
    if (slide === undefined || seen.has(id as string)) {
      throw validationError(
        slide === undefined
          ? `slideOrder[${i}]: unknown slide id`
          : `slideOrder[${i}]: duplicate id`,
        { path: `slideOrder[${i}]`, hint },
      );
    }
    seen.add(id as string);
    out.push(slide);
  });
  if (out.length !== slides.length) {
    const missing = slides.filter((s) => !seen.has(s.id)).map((s) => s.id);
    throw validationError(`slideOrder is missing ${missing.length} slide id(s)`, {
      path: "slideOrder",
      hint,
      details: { missing: missing.slice(0, 20) },
    });
  }
  return out;
}

export async function updateSlides(
  ctx: Ctx,
  principal: Principal,
  rawInput: UpdateSlidesInput,
  call?: CallContext,
): Promise<RevisionWriteResult> {
  const target = targetOf(rawInput);
  return runWrite(ctx, principal, call, "presentation.update_slides", target, async () => {
    requireScope(principal, "decks:write");
    const input = requireObject(rawInput) as unknown as UpdateSlidesInput;
    const id = requireString(input.presentationId, "presentationId");
    const expected = requireRevision(input.expectedRevision, "expectedRevision");
    const upserts = input.upsert ?? [];
    const removals = input.remove ?? [];
    if (!Array.isArray(upserts))
      throw validationError("upsert must be an array", { path: "upsert" });
    if (!Array.isArray(removals))
      throw validationError("remove must be an array", { path: "remove" });
    if (upserts.length === 0 && removals.length === 0) {
      throw validationError("Nothing to update", {
        hint: "Send `upsert` (slides to insert or edit) and/or `remove` (slide ids).",
      });
    }
    const ws = principal.workspaceId;
    const deck = await loadLiveDeck(ctx.store, principal, id);
    assertExpected(deck, expected);
    const current = await loadRevisionDocument(ctx.store, ws, id, expected);
    const edit = applySlideEdits(current.slides, upserts, removals);
    const written = await vendorAndCheck(
      ctx,
      principal,
      call,
      id,
      { ...current, slides: edit.slides },
      current,
    );
    const parts: string[] = [];
    if (edit.inserted.length > 0) parts.push(`inserted ${edit.inserted.join(", ")}`);
    if (edit.updated.length > 0) parts.push(`edited ${edit.updated.join(", ")}`);
    if (edit.removed.length > 0) parts.push(`removed ${edit.removed.join(", ")}`);
    return commitRevision(ctx, principal, call, {
      deckId: id,
      expectedRevision: expected,
      ...written,
      summary: summaryOf(input.summary, `Slides: ${parts.join("; ")}`),
      action: "presentation.update_slides",
      detail: {
        inserted: edit.inserted.length,
        updated: edit.updated.length,
        removed: edit.removed.length,
      },
    });
  });
}

function targetOf(input: unknown): string | null {
  const id = (input as { presentationId?: unknown } | null)?.presentationId;
  return typeof id === "string" && id.length <= 64 ? `deck:${id}` : null;
}

export async function trashPresentation(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string },
  call?: CallContext,
): Promise<TrashResult> {
  return runWrite(ctx, principal, call, "presentation.trash", targetOf(rawInput), async () => {
    requireScope(principal, "decks:write");
    const id = requireString(requireObject(rawInput).presentationId, "presentationId");
    return ctx.store.transaction(async (tx) => {
      await loadLiveDeck(tx, principal, id);
      const now = ctx.clock.now();
      await tx.decks.setDeletedAt(principal.workspaceId, id, now);
      await audit(ctx, tx, principal, call, "presentation.trash", `deck:${id}`, "ok");
      return {
        presentationId: id,
        trashed: true as const,
        restorableUntil: now + ctx.config.trashRetentionMs,
      };
    });
  });
}

/** Human only. Restores a presentation from the trash. */
export async function restorePresentation(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string },
  call?: CallContext,
): Promise<PresentationSummary> {
  return runWrite(ctx, principal, call, "presentation.restore", targetOf(rawInput), async () => {
    requireScope(principal, "decks:write");
    requireOwner(principal, "restore a presentation from the trash");
    const id = requireString(requireObject(rawInput).presentationId, "presentationId");
    return ctx.store.transaction(async (tx) => {
      const deck = await tx.decks.get(principal.workspaceId, id);
      if (deck === null || deck.deletedAt === null) {
        throw notFound(`Presentation "${id}" is not in the trash`, {
          path: "presentationId",
          hint: "Only presentations in the trash can be restored. List the trash to see them.",
        });
      }
      await tx.decks.setDeletedAt(principal.workspaceId, id, null);
      await audit(ctx, tx, principal, call, "presentation.restore", `deck:${id}`, "ok");
      return summaryView({ ...deck, deletedAt: null });
    });
  });
}

/** Human only. Permanently deletes a presentation that is in the trash, its revisions and unused assets. */
export async function purgePresentation(
  ctx: Ctx,
  principal: Principal,
  rawInput: { presentationId: string },
  call?: CallContext,
): Promise<PurgeResult> {
  return runWrite(ctx, principal, call, "presentation.purge", targetOf(rawInput), async () => {
    requireScope(principal, "decks:write");
    requireOwner(principal, "delete a presentation permanently");
    const id = requireString(requireObject(rawInput).presentationId, "presentationId");
    const deck = await ctx.store.decks.get(principal.workspaceId, id);
    if (deck === null) throw presentationNotFound(id);
    if (deck.deletedAt === null) {
      throw validationError("Only presentations in the trash can be deleted permanently", {
        path: "presentationId",
        hint: "Move the presentation to the trash first.",
      });
    }
    return purgeDeck(ctx, principal, call, id, "presentation.purge");
  });
}

/** Shared by `purgePresentation` and `purgeExpiredTrash`. */
export async function purgeDeck(
  ctx: Ctx,
  principal: Principal,
  call: CallContext | undefined,
  id: string,
  action: string,
): Promise<PurgeResult> {
  const ws = principal.workspaceId;
  const { revisionsDeleted, deletedAssets } = await ctx.store.transaction(async (tx) => {
    const deck = await tx.decks.get(ws, id);
    if (deck === null) throw presentationNotFound(id);
    const revisionsDeleted = await tx.revisions.deleteAllForDeck(ws, id);
    const linked = await tx.assets.unlinkAllForDeck(ws, id);
    const deletedAssets: string[] = [];
    for (const sha of linked) {
      if (await tx.assets.deleteIfUnlinked(ws, sha)) deletedAssets.push(sha);
    }
    await tx.idempotency.deleteForDeck(ws, id);
    await tx.scriptApprovals.delete(ws, id);
    await tx.decks.delete(ws, id);
    await audit(ctx, tx, principal, call, action, `deck:${id}`, "ok", {
      revisionsDeleted,
      assetsDeleted: deletedAssets.length,
    });
    return { revisionsDeleted, deletedAssets };
  });
  // Blobs are outside the transaction: delete the ones no workspace references any more (best effort; the
  // orphan collector catches anything left behind).
  let blobsDeleted = 0;
  for (const sha of deletedAssets) {
    try {
      if (!(await ctx.store.assets.isReferencedAnywhere(sha)) && (await ctx.blobs.delete(sha))) {
        blobsDeleted++;
      }
    } catch {
      // Left for collectOrphanBlobs.
    }
  }
  return {
    presentationId: id,
    purged: true,
    revisionsDeleted,
    assetsDeleted: deletedAssets.length,
    blobsDeleted,
  };
}

/** Owner or system job. Permanently deletes presentations whose trash retention has expired. */
export async function purgeExpiredTrash(
  ctx: Ctx,
  principal: Principal,
  rawInput: { limit?: number } = {},
  call?: CallContext,
): Promise<{ purged: string[] }> {
  return runWrite(ctx, principal, call, "maintenance.purge_expired_trash", null, async () => {
    requireOwnerOrSystem(principal, "purge the trash");
    const limit = optionalLimit(requireObject(rawInput).limit, 100, 1000);
    const cutoff = ctx.clock.now() - ctx.config.trashRetentionMs;
    const expired = await ctx.store.decks.listTrashedBefore(principal.workspaceId, cutoff, limit);
    const purged: string[] = [];
    for (const deck of expired) {
      await purgeDeck(ctx, principal, call, deck.id, "presentation.purge_expired");
      purged.push(deck.id);
    }
    return { purged };
  });
}

export type { CoreWarning, OutlineItem, SlideUpsert };
