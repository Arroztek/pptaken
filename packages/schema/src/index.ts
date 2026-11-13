// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { FONT_CATALOG, LIMITS } from "./limits.js";

export { FONT_CATALOG, type FontName, LIMITS } from "./limits.js";

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
  })
  .superRefine((deck, ctx) => {
    const seen = new Set<string>();
    deck.slides.forEach((slide, index) => {
      if (seen.has(slide.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate slide id "${slide.id}"`,
          path: ["slides", index, "id"],
        });
      }
      seen.add(slide.id);
    });
  });

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
