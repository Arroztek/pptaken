// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure deck operations: validation with agent-friendly errors, sanitizing, slide edits, outline.
import {
  checkDeckScripts,
  type ImportWarningCode,
  type Warning as SanitizerWarning,
  type ScriptCheckCode,
  sanitizeDeck,
} from "@pptaken/sanitizer";
import { type Deck, hasScripts, LIB_CATALOG, LIMITS, parseDeck, type Slide } from "@pptaken/schema";
import { limitExceeded, validationError } from "./errors.js";

/** Codes the core adds to the sanitizer's warning codes (vendoring and HTML import: ADR-022). */
export type CoreWarningCode =
  | SanitizerWarning["code"]
  | "UNKNOWN_ASSET_REF"
  | "VENDOR_FAILED"
  | "VENDOR_UNSUPPORTED"
  | "VENDOR_ES_MODULE"
  | "VENDOR_FONTS_TRIMMED"
  | "VENDOR_STYLESHEET_SKIPPED"
  | "VENDOR_RELATIVE_URL"
  | ImportWarningCode
  | ScriptCheckCode;

/** A non-fatal problem: the write succeeded, but something was removed or looks wrong. */
export interface CoreWarning {
  code: CoreWarningCode;
  message: string;
  /** Location in the stored deck, e.g. `slides[3].html` or `theme.css`. */
  path?: string;
  /** Id of the slide the warning is about, when it is about a slide. */
  slideId?: string;
  /** Removed element, attribute, property or at-rule (already made safe by the sanitizer). */
  name?: string;
}

const SLIDE_PATH = /^slides\[(\d+)\]/;

function hintForIssue(path: string, message: string): string {
  const tooBig = /too big|<=|at most|maximum/i.test(message);
  if (/^slides\[\d+\]\.html$/.test(path) && tooBig) {
    return `\`${path}\` exceeds ${LIMITS.maxSlideHtml / 1024} KB. Split the slide or move images to \`add_asset\`.`;
  }
  if (/\.css$/.test(path) && tooBig) {
    return `\`${path}\` exceeds ${LIMITS.maxSlideCss / 1024} KB. Move shared rules to theme.css or simplify the CSS.`;
  }
  if (/\.id$/.test(path)) {
    return "Slide ids must be unique and use 1 to 40 characters from a-z, 0-9 and '-'. Omit `id` to have one generated.";
  }
  if (/(?:^|\.)script$/.test(path)) {
    return `\`${path}\` must be an inline classic script of at most ${LIMITS.maxSlideScript / 1024} KB per slide (${LIMITS.maxDeckScript / 1024} KB for the deck script; all scripts together at most ${LIMITS.maxDeckScripts / 1024} KB), without "<script", "</script" or "<!--" (write "<\\/script>" inside strings). Load libraries with \`libs\` (a CDN URL is vendored).`;
  }
  if (/^libs/.test(path)) {
    return "`libs` lists scripts in load order: a bundled id, an https CDN URL (vendored on write) or { name, sha256, source } of a script already stored for this presentation, each at most once.";
  }
  if (/fontFaces/.test(path)) {
    return "`theme.fontFaces` is filled by the server when it vendors fonts. To add fonts, send `theme.googleFonts`, a stylesheet URL (`@import url(https://…)`) or an `@font-face` with an https `src`.";
  }
  if (/fonts/.test(path)) {
    return "`theme.fonts` names bundled fonts only. For any other family use `theme.googleFonts` or a stylesheet/@font-face URL: it is vendored (see `get_authoring_guide`).";
  }
  return `Fix \`${path || "(root)"}\`: ${message}. Call \`get_authoring_guide\` for the format.`;
}

/**
 * Validates an untrusted deck envelope. Throws `VALIDATION_ERROR` (first issue in `path`, every issue in
 * `details.issues`) or `LIMIT_EXCEEDED` (too many slides).
 */
export function validateDeck(input: unknown, maxSlides: number, pathPrefix = ""): Deck {
  const slides = (input as { slides?: unknown } | null)?.slides;
  if (Array.isArray(slides) && slides.length > maxSlides) {
    throw limitExceeded("Too many slides", maxSlides, slides.length, {
      path: `${pathPrefix}slides`,
      hint: `A presentation can have at most ${maxSlides} slides. Split it into several presentations.`,
    });
  }
  const result = parseDeck(input);
  if (result.ok) return result.deck;
  const issues = result.issues.slice(0, 20);
  const first = issues[0] ?? { path: "", message: "Invalid deck" };
  const more = result.issues.length > 1 ? ` (and ${result.issues.length - 1} more issue(s))` : "";
  throw validationError(`${first.path || "deck"}: ${first.message}${more}`, {
    path: `${pathPrefix}${first.path}`,
    hint: hintForIssue(first.path, first.message),
    details: { issues },
  });
}

/** Lists `asset:<hex>` references in a slide's HTML and CSS. */
export function assetRefsOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/asset:([0-9a-f]{16,64})/g)) out.push(match[1] as string);
  return out;
}

/**
 * Sanitizes a validated deck and validates the result again (the stored document always satisfies the schema).
 * `knownAssets` (sha256 values linked to the deck) enables `UNKNOWN_ASSET_REF` warnings.
 */
export function sanitizeAndCheck(
  deck: Deck,
  maxSlides: number,
  knownAssets?: readonly string[],
  knownScripts: readonly string[] = [],
): { deck: Deck; warnings: CoreWarning[] } {
  // Decks with author scripts or libraries use the interactive profile (ADR-020); the static fallback served to
  // everyone else is re-sanitized with the safe profile at serve time.
  checkVendoredScripts(
    deck,
    knownScripts.length === 0
      ? KNOWN_VENDORED_SCRIPTS
      : new Set([...KNOWN_VENDORED_SCRIPTS, ...knownScripts]),
  );
  const sanitized = sanitizeDeck(deck, { profile: hasScripts(deck) ? "interactive" : "safe" });
  const clean = validateDeck(sanitized.deck, maxSlides);
  const warnings: CoreWarning[] = sanitized.warnings.map((w) => toCoreWarning(w, clean));
  if (knownAssets !== undefined) {
    const theme = clean.theme?.css ?? "";
    const check = (text: string, path: string, slideId?: string) => {
      for (const ref of new Set(assetRefsOf(text))) {
        if (!knownAssets.some((sha) => sha.startsWith(ref))) {
          const warning: CoreWarning = {
            code: "UNKNOWN_ASSET_REF",
            message: `asset:${ref} is not an asset of this presentation; it will not display`,
            path,
          };
          if (slideId !== undefined) warning.slideId = slideId;
          warnings.push(warning);
        }
      }
    };
    check(theme, "theme.css");
    (clean.theme?.fontFaces ?? []).forEach((face, i) =>
      check(face.src, `theme.fontFaces[${i}].src`),
    );
    clean.slides.forEach((slide, i) => {
      check(slide.html, `slides[${i}].html`, slide.id);
      if (slide.css !== undefined) check(slide.css, `slides[${i}].css`, slide.id);
    });
  }
  warnings.push(...scriptWarnings(clean));
  return { deck: clean, warnings };
}

/**
 * Static check of the author scripts (ADR-023): syntax errors, a bare `root`, blocked APIs. Non-fatal warnings with
 * stable codes, so the agent can fix the script before the owner ever presents it. Never blocks a write.
 */
export function scriptWarnings(deck: Deck): CoreWarning[] {
  if (deck.script === undefined && !deck.slides.some((s) => s.script !== undefined)) return [];
  return checkDeckScripts(deck).map((issue) => {
    const w: CoreWarning = { code: issue.code, message: issue.message, path: issue.path };
    if (issue.slideId !== undefined) w.slideId = issue.slideId;
    if (issue.name !== undefined) w.name = issue.name;
    return w;
  });
}

/** SHA-256 of the bundled vendored scripts (ADR-020). */
const KNOWN_VENDORED_SCRIPTS: ReadonlySet<string> = new Set(
  Object.values(LIB_CATALOG).map((lib) => lib.sha256),
);

/**
 * Every vendored script a deck references must be stored on the instance, or the scripted document could not be
 * built: the bundled set plus the script assets vendored for this presentation (ADR-022), passed as `known`.
 */
export function checkVendoredScripts(
  deck: Pick<Deck, "libs">,
  known: ReadonlySet<string> = KNOWN_VENDORED_SCRIPTS,
): void {
  (deck.libs ?? []).forEach((lib, i) => {
    if (!known.has(lib.sha256)) {
      throw validationError(
        `libs[${i}]: this vendored script is not stored for this presentation`,
        {
          path: `libs[${i}].sha256`,
          hint: 'Send the library as an https CDN URL in libs (the server vendors it), or a bundled id such as "uplot@1".',
        },
      );
    }
  });
}

function toCoreWarning(w: SanitizerWarning, deck: Deck): CoreWarning {
  const out: CoreWarning = { code: w.code, message: w.message };
  if (w.path !== undefined) {
    out.path = w.path;
    const m = SLIDE_PATH.exec(w.path);
    const slide = m === null ? undefined : deck.slides[Number(m[1])];
    if (slide !== undefined) out.slideId = slide.id;
  }
  if (w.name !== undefined) out.name = w.name;
  return out;
}

/** Generates slide ids `slide-1`, `slide-2`… that are not in `taken`. */
export function slideIdAllocator(taken: Iterable<string>): () => string {
  const used = new Set(taken);
  let n = 1;
  return () => {
    while (used.has(`slide-${n}`)) n++;
    const id = `slide-${n}`;
    used.add(id);
    return id;
  };
}

/** Number of reveal steps of a slide, counted like the player (`docs/spec/player.md` "Steps"). */
export function countSteps(html: string): number {
  const numbered = new Set<number>();
  let unnumbered = 0;
  for (const tag of html.matchAll(/<[A-Za-z][^>]*>/g)) {
    for (const attr of tag[0].matchAll(/\sdata-step="(\d*)"/g)) {
      const value = attr[1] as string;
      if (value === "") unnumbered++;
      else numbered.add(Number(value));
    }
  }
  return Math.min(255, numbered.size + unnumbered);
}

export interface OutlineItem {
  id: string;
  title: string;
  section?: string;
  steps: number;
  hasNotes: boolean;
}

export function outlineOf(deck: Deck): OutlineItem[] {
  return deck.slides.map((slide) => {
    const item: OutlineItem = {
      id: slide.id,
      title: slide.title,
      steps: countSteps(slide.html),
      hasNotes: slide.notes !== undefined && slide.notes.trim() !== "",
    };
    if (slide.section !== undefined) item.section = slide.section;
    return item;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Slide edits

/** One entry of `updateSlides.upsert`. `null` clears an optional field. */
export interface SlideUpsert {
  /** Existing id: replace only the fields sent. Missing or new id: insert a slide. */
  id?: string;
  /** Where to insert (or move) the slide: after this slide id, or at the `start`/`end` (default `end`). */
  after?: string;
  title?: string;
  html?: string;
  css?: string | null;
  notes?: string | null;
  section?: string | null;
  durationHintSec?: number | null;
  /** Author script of the slide (interactive mode, ADR-020); `null` removes it. */
  script?: string | null;
}

const OPTIONAL_FIELDS = ["css", "notes", "section", "durationHintSec", "script"] as const;

/**
 * Applies upserts (in order) and then removals to a copy of `slides`. Throws `VALIDATION_ERROR` for references
 * to unknown slides and for new slides without `html`. Field values are validated later by {@link validateDeck}.
 */
export function applySlideEdits(
  slides: readonly Slide[],
  upserts: readonly SlideUpsert[],
  removals: readonly string[],
): { slides: Slide[]; inserted: string[]; updated: string[]; removed: string[] } {
  const list: Slide[] = slides.map((s) => ({ ...s }));
  const nextId = slideIdAllocator([
    ...list.map((s) => s.id),
    ...upserts.flatMap((u) => (u.id === undefined ? [] : [u.id])),
  ]);
  const inserted: string[] = [];
  const updated: string[] = [];

  upserts.forEach((upsert, i) => {
    const path = `upsert[${i}]`;
    if (typeof upsert !== "object" || upsert === null) {
      throw validationError(`${path} must be an object`, { path });
    }
    const index = upsert.id === undefined ? -1 : list.findIndex((s) => s.id === upsert.id);
    let slide: Slide;
    if (index >= 0) {
      slide = list[index] as Slide;
      if (upsert.after !== undefined) list.splice(index, 1);
    } else {
      if (typeof upsert.html !== "string") {
        throw validationError(`${path}.html is required to insert a new slide`, {
          path: `${path}.html`,
          hint:
            upsert.id === undefined
              ? "Send `html` to insert a slide, or send the `id` of an existing slide to edit it."
              : `No slide has id "${upsert.id}", so this inserts a new slide and needs \`html\`. Call \`get_presentation\` to see the current ids.`,
        });
      }
      slide = { id: upsert.id ?? nextId(), title: "", html: upsert.html };
    }
    if (upsert.title !== undefined) slide.title = upsert.title;
    if (upsert.html !== undefined) slide.html = upsert.html;
    for (const field of OPTIONAL_FIELDS) {
      const value = upsert[field];
      if (value === null) delete slide[field];
      else if (value !== undefined) (slide as unknown as Record<string, unknown>)[field] = value;
    }
    if (index < 0 || upsert.after !== undefined) {
      const after = upsert.after ?? "end";
      if (after === "start") list.unshift(slide);
      else if (after === "end") list.push(slide);
      else {
        const anchor = list.findIndex((s) => s.id === after);
        if (anchor < 0) {
          throw validationError(`${path}.after: no slide has id "${after}"`, {
            path: `${path}.after`,
            hint: 'Use an existing slide id, "start" or "end". Call `get_presentation` to see the current ids.',
          });
        }
        list.splice(anchor + 1, 0, slide);
      }
    }
    if (index >= 0) updated.push(slide.id);
    else inserted.push(slide.id);
  });

  const removed: string[] = [];
  removals.forEach((id, i) => {
    const index = list.findIndex((s) => s.id === id);
    if (index < 0) {
      throw validationError(`remove[${i}]: no slide has id "${id}"`, {
        path: `remove[${i}]`,
        hint: "Call `get_presentation` to see the current slide ids.",
      });
    }
    list.splice(index, 1);
    removed.push(id);
  });
  const fresh = new Set(inserted);
  return {
    slides: list,
    inserted,
    updated: [...new Set(updated)].filter((id) => !fresh.has(id)),
    removed,
  };
}
