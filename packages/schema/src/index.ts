// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { FONT_CATALOG, LIB_CATALOG, LIB_IDS, LIMITS, type LibId } from "./limits.js";

export {
  FONT_CATALOG,
  type FontName,
  LIB_CATALOG,
  LIB_IDS,
  LIMITS,
  type LibId,
} from "./limits.js";

/** Version of the deck envelope. Bump only on breaking changes (see ADR-001 §9). */
export const DECK_SCHEMA_VERSION = 1;

/** Supported aspect ratios and the logical canvas each one is drawn on. */
export const ASPECT_RATIOS = {
  "16:9": { width: 1920, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
} as const;

export type AspectRatio = keyof typeof ASPECT_RATIOS;

/** Reference to an uploaded asset, used inside slide HTML/CSS as `asset:<id>`. */
export const ASSET_REF_PATTERN = /^asset:[0-9a-f]{16,64}$/;
export const assetRefSchema = z
  .string()
  .regex(ASSET_REF_PATTERN, "Expected `asset:` followed by 16 to 64 lowercase hex characters");

/** Stable slide identifier, preserved across edits. */
export const slideIdSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/, "Use 1 to 40 characters from a-z, 0-9 and '-'");

/** BCP-47 language tag (simplified): `en`, `es`, `pt-BR`, `zh-Hant-TW`. */
export const langSchema = z
  .string()
  .regex(
    /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
    "Expected a BCP-47 language tag such as `en` or `es-PE`",
  );

/**
 * Why an author script text cannot be embedded as an inline classic script, or `null` when it can. The text goes
 * into a `<script>` element whose SHA-256 is listed in the CSP, so it must not be able to end or re-open that
 * element (`</script`, `<script`, `<!--`), and it must survive HTML parsing unchanged (no NUL, no lone
 * surrogates). Line breaks are normalized to LF by the builder before hashing, as the HTML parser does.
 */
export function scriptProblem(text: string): string | null {
  if (/<\/?script|<!--/i.test(text)) {
    return 'Scripts must not contain "<script", "</script" or "<!--" (inside a string, write "<\\/script>")';
  }
  if (text.includes("\u0000")) return "Scripts must not contain NUL characters";
  if (LONE_SURROGATE.test(text)) return "Scripts must not contain lone surrogate characters";
  return null;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** An author script (interactive mode, ADR-020): an inline classic script, run only after owner approval. */
export const scriptSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxSlideScript)
  .superRefine((text, ctx) => {
    const problem = scriptProblem(text);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

/** SHA-256 in lowercase hex: the key of a vendored asset on the instance. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A vendored script asset (ADR-020): a script stored on the instance, referenced by the SHA-256 of its bytes,
 * with a human label and the URL it was vendored from (provenance only: viewers never contact it). The approval
 * screen shows the label, the source and the hash; the digest binds the hash and the source.
 */
export const vendoredScriptSchema = z.strictObject({
  /** Label, e.g. `uPlot` or `d3`. */
  name: z
    .string()
    .regex(/^[A-Za-z0-9@/._+-]{1,80}$/, "Use 1 to 80 characters A-Z a-z 0-9 @ / . _ + -"),
  version: z
    .string()
    .regex(/^[A-Za-z0-9._+-]{1,40}$/)
    .optional(),
  /** SHA-256 (hex) of the stored script file. */
  sha256: z.string().regex(SHA256_HEX_PATTERN, "Expected 64 lowercase hex characters"),
  /** Where it was vendored from (an https URL, or the bundled package it came in). */
  source: z
    .string()
    .max(2048)
    .regex(/^https:\/\/[^\s"'<>]+$/, "Expected an https URL")
    .optional(),
});
export type VendoredScript = z.infer<typeof vendoredScriptSchema>;

/** A bundled script id (`"uplot@1"`) expanded to its vendored reference. */
export function bundledScript(id: LibId): VendoredScript {
  const lib = LIB_CATALOG[id];
  return { name: lib.name, version: lib.version, sha256: lib.sha256, source: lib.source };
}

const libSchema = z.union([
  z.enum(LIB_IDS).transform((id) => bundledScript(id)),
  vendoredScriptSchema,
]);

export const slideSchema = z.strictObject({
  id: slideIdSchema,
  /** Shown in the overview and the speaker view. */
  title: z.string().max(LIMITS.maxTitleLength).default(""),
  /** Canvas content. `data-step="n"` marks revealable steps. Untrusted: sanitized and sandboxed. */
  html: z.string().max(LIMITS.maxSlideHtml),
  /** CSS scoped to this slide. */
  css: z.string().max(LIMITS.maxSlideCss).optional(),
  /** Speaker notes in Markdown. Never shown to the audience or on public links. */
  notes: z.string().max(LIMITS.maxNotes).optional(),
  /** Groups slides in the overview and the per-section clock. */
  section: z.string().max(LIMITS.maxSectionLength).optional(),
  /** Planned duration of this slide, for the speaker clock. */
  durationHintSec: z.int().min(1).max(LIMITS.maxDurationHintSec).optional(),
  /**
   * Author script of the slide (interactive mode, ADR-020). Runs only in the owner's session, after the owner
   * approved the deck's scripts digest; everywhere else the slide is shown without it (static fallback).
   */
  script: scriptSchema.optional(),
});

export const themeSchema = z.strictObject({
  /** CSS shared by all slides. */
  css: z.string().max(LIMITS.maxThemeCss).optional(),
  /** Fonts from the bundled catalog, used by name. */
  fonts: z
    .array(z.enum(FONT_CATALOG))
    .max(LIMITS.maxThemeFonts)
    .refine((fonts) => new Set(fonts).size === fonts.length, "Fonts must be unique")
    .optional(),
});

export const deckSchema = z
  .strictObject({
    schemaVersion: z.literal(DECK_SCHEMA_VERSION),
    title: z.string().min(1).max(LIMITS.maxTitleLength),
    lang: langSchema.optional(),
    aspectRatio: z.enum(["16:9", "4:3"]).default("16:9"),
    theme: themeSchema.optional(),
    /** Target length of the talk, for the speaker clock. */
    targetMinutes: z.int().min(1).max(LIMITS.maxTargetMinutes).optional(),
    slides: z.array(slideSchema).min(1).max(LIMITS.maxSlides),
    /**
     * Vendored scripts loaded before the author scripts, in order (interactive mode, ADR-020). Each one is a
     * reference to a script stored on the instance (by SHA-256); a bundled id such as `"uplot@1"` expands to it.
     */
    libs: z
      .array(libSchema)
      .max(LIMITS.maxLibs)
      .refine(
        (libs) => new Set(libs.map((l) => l.sha256)).size === libs.length,
        "Vendored scripts must be unique",
      )
      .optional(),
  })
  .superRefine((deck, ctx) => {
    const seen = new Set<string>();
    let scriptChars = 0;
    deck.slides.forEach((slide, index) => {
      scriptChars += slide.script?.length ?? 0;
      if (seen.has(slide.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate slide id "${slide.id}"`,
          path: ["slides", index, "id"],
        });
      }
      seen.add(slide.id);
    });
    if (scriptChars > LIMITS.maxDeckScripts) {
      ctx.addIssue({
        code: "custom",
        message: `Scripts of all slides together exceed ${LIMITS.maxDeckScripts} characters`,
        path: ["slides"],
      });
    }
  });

/** True when the deck declares author scripts or libraries (interactive mode). */
export function hasScripts(deck: Pick<Deck, "slides" | "libs">): boolean {
  return (deck.libs?.length ?? 0) > 0 || deck.slides.some((s) => s.script !== undefined);
}

export type Slide = z.infer<typeof slideSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type Deck = z.infer<typeof deckSchema>;
/** Input shape (before defaults are applied), e.g. what an agent sends. */
export type DeckInput = z.input<typeof deckSchema>;

export type ParseResult =
  | { ok: true; deck: Deck }
  | { ok: false; issues: { path: string; message: string }[] };

/** Validates untrusted input and returns a flat, agent-friendly list of issues. */
export function parseDeck(input: unknown): ParseResult {
  const result = deckSchema.safeParse(input);
  if (result.success) return { ok: true, deck: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.reduce<string>(
        (acc, part) =>
          typeof part === "number"
            ? `${acc}[${part}]`
            : acc
              ? `${acc}.${String(part)}`
              : String(part),
        "",
      ),
      message: issue.message,
    })),
  };
}

/** Logical canvas size of a deck, in CSS pixels. */
export function canvasSize(aspectRatio: AspectRatio): { width: number; height: number } {
  return ASPECT_RATIOS[aspectRatio];
}

/** JSON Schema (draft 2020-12) of the deck envelope. Uniqueness of slide ids is enforced by `parseDeck` only. */
export function deckJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(deckSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
}
