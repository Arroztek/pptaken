// SPDX-License-Identifier: AGPL-3.0-or-later
// Input schemas of the MCP tools (architecture §5.3). Flat, snake_case, with descriptions and examples. They are
// advertised in `tools/list` as JSON Schema and enforced by the tool handlers themselves (so that a failure is a
// structured VALIDATION_ERROR with `path` and `hint`, not the SDK's plain-text message). The core validates again.
import {
  FONT_CATALOG,
  fontFaceSchema,
  googleFontSchema,
  LIB_IDS,
  LIMITS,
  vendoredScriptSchema,
} from "@pptaken/schema";
import { z } from "zod";

const presentationId = z
  .string()
  .min(1)
  .max(64)
  .describe("Id returned by create_presentation or list_presentations.");

const expectedRevision = z
  .int()
  .min(1)
  .describe(
    "The revision you last read (get_presentation `revision`). The call fails with REVISION_CONFLICT if someone changed the presentation since.",
  );

const slideId = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/, "Use 1 to 40 characters from a-z, 0-9 and '-'")
  .describe(
    "Stable slide id, [a-z0-9-]{1,40}. Generated if missing; keep it to edit the slide later.",
  );

const lang = z
  .string()
  .regex(
    /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
    "Expected a BCP-47 language tag such as `en` or `es-PE`",
  )
  .describe('BCP-47 language tag, e.g. "en" or "es-PE".');

const theme = z
  .strictObject({
    css: z
      .string()
      .max(LIMITS.maxThemeCss)
      .optional()
      .describe(
        "CSS shared by all slides (classes you reuse). Max 64 KB. @import url(https://…) and url(https://…) are vendored.",
      ),
    fonts: z
      .array(z.enum(FONT_CATALOG))
      .max(LIMITS.maxThemeFonts)
      .optional()
      .describe(
        "Bundled font families the deck uses (max 4). Any other family: use google_fonts or a stylesheet URL.",
      ),
    google_fonts: z
      .array(googleFontSchema)
      .max(LIMITS.maxGoogleFonts)
      .optional()
      .describe(
        'Families to vendor from Google Fonts, e.g. [{ "family": "Lora", "weights": [400, 700] }]. The server downloads them once and stores them; then use the family name in CSS.',
      ),
    font_faces: z
      .array(fontFaceSchema)
      .max(LIMITS.maxFontFaces)
      .optional()
      .describe("Vendored font faces as get_presentation returns them; send them back unchanged."),
  })
  .describe("Theme shared by all slides.");

const script = z
  .string()
  .min(1)
  .max(LIMITS.maxSlideScript)
  .describe(
    "Interactive mode: the slide's JavaScript, run only after the owner approves it (see the guide). Max 128 KB.",
  );

const libs = z
  .array(
    z.union([
      z.enum(LIB_IDS),
      z
        .string()
        .max(2048)
        .regex(/^https:\/\/\S+$/, "Expected an https URL"),
      vendoredScriptSchema,
    ]),
  )
  .max(LIMITS.maxLibs)
  .describe(
    "Interactive mode: scripts loaded before the deck and slide scripts, in order: an https CDN URL of a classic (UMD/IIFE) build, which the server downloads once and stores (vendoring); a bundled id (see the guide); or { name, version, sha256, source } as get_presentation returns it.",
  );

const deckScript = z
  .string()
  .min(1)
  .max(LIMITS.maxDeckScript)
  .describe(
    "Interactive mode: deck-level JavaScript run once in the global scope, after libs and before the slide scripts, only after the owner approves it. Max 512 KB.",
  );

const slide = z.strictObject({
  id: slideId.optional(),
  title: z
    .string()
    .max(LIMITS.maxTitleLength)
    .optional()
    .describe("Short slide title for the overview and the speaker view."),
  html: z
    .string()
    .max(LIMITS.maxSlideHtml)
    .describe(
      'Slide content for the fixed canvas (1920×1080 px for 16:9). data-step="n" marks elements revealed on click. Max 256 KB.',
    ),
  css: z
    .string()
    .max(LIMITS.maxSlideCss)
    .optional()
    .describe("CSS scoped to this slide. Max 64 KB."),
  notes: z
    .string()
    .max(LIMITS.maxNotes)
    .optional()
    .describe("Speaker notes in Markdown. Never shown to the audience. Max 16 KB."),
  section: z
    .string()
    .max(LIMITS.maxSectionLength)
    .optional()
    .describe('Groups slides in the overview, e.g. "Intro".'),
  duration_hint_sec: z
    .int()
    .min(1)
    .max(LIMITS.maxDurationHintSec)
    .optional()
    .describe("Planned seconds for this slide (speaker clock)."),
  script: script.optional(),
});

export const createPresentationInput = z.strictObject({
  title: z.string().min(1).max(LIMITS.maxTitleLength).describe("Presentation title."),
  lang: lang.optional(),
  aspect_ratio: z
    .enum(["16:9", "4:3"])
    .optional()
    .describe('"16:9" (default, 1920×1080 canvas) or "4:3" (1440×1080).'),
  theme: theme.optional(),
  libs: libs.optional(),
  script: deckScript.optional(),
  slides: z
    .array(slide)
    .min(1)
    .max(LIMITS.maxSlides)
    .describe("All the slides, in order (1 to 200)."),
  target_minutes: z
    .int()
    .min(1)
    .max(LIMITS.maxTargetMinutes)
    .optional()
    .describe("Target length of the talk in minutes."),
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Any unique string. Repeating the call with the same key returns the first result instead of creating a duplicate.",
    ),
});

export const listPresentationsInput = z.strictObject({
  query: z.string().max(200).optional().describe("Case-insensitive text to find in titles."),
  cursor: z.string().max(200).optional().describe("`next_cursor` from the previous page."),
  limit: z.int().min(1).max(100).optional().describe("Page size, 1 to 100 (default 20)."),
});

export const INCLUDE_VALUES = ["outline", "theme", "slides", "notes"] as const;

export const getPresentationInput = z.strictObject({
  presentation_id: presentationId,
  include: z
    .array(z.enum(INCLUDE_VALUES))
    .max(4)
    .optional()
    .describe(
      'Parts to return. Default ["outline"] (ids, titles, steps). "slides" returns html/css (large: combine with slide_ids), "notes" the speaker notes, "theme" the theme.',
    ),
  slide_ids: z
    .array(z.string().max(40))
    .max(LIMITS.maxSlides)
    .optional()
    .describe('Limit "slides" and "notes" to these slide ids.'),
});

export const updatePresentationInput = z.strictObject({
  presentation_id: presentationId,
  expected_revision: expectedRevision,
  title: z.string().min(1).max(LIMITS.maxTitleLength).optional(),
  lang: lang.nullable().optional().describe("BCP-47 tag; null removes it."),
  aspect_ratio: z.enum(["16:9", "4:3"]).optional(),
  theme: theme.nullable().optional().describe("Replaces the whole theme; null removes it."),
  target_minutes: z.int().min(1).max(LIMITS.maxTargetMinutes).nullable().optional(),
  libs: libs.nullable().optional(),
  script: deckScript.nullable().optional(),
  slide_order: z
    .array(z.string().max(40))
    .max(LIMITS.maxSlides)
    .optional()
    .describe("New order: exactly the current slide ids, each once."),
});

const upsert = z.strictObject({
  id: slideId
    .optional()
    .describe("Existing id: change only the fields sent. New or missing id: insert a new slide."),
  after: z
    .string()
    .max(40)
    .optional()
    .describe(
      'Insert or move after this slide id, or "start" / "end" (default "end" for new slides).',
    ),
  title: z.string().max(LIMITS.maxTitleLength).optional(),
  html: z.string().max(LIMITS.maxSlideHtml).optional(),
  css: z
    .string()
    .max(LIMITS.maxSlideCss)
    .nullable()
    .optional()
    .describe("null removes the slide CSS."),
  notes: z.string().max(LIMITS.maxNotes).nullable().optional().describe("null removes the notes."),
  section: z.string().max(LIMITS.maxSectionLength).nullable().optional(),
  duration_hint_sec: z.int().min(1).max(LIMITS.maxDurationHintSec).nullable().optional(),
  script: script.nullable().optional(),
});

export const updateSlidesInput = z.strictObject({
  presentation_id: presentationId,
  expected_revision: expectedRevision,
  upsert: z
    .array(upsert)
    .max(LIMITS.maxSlides)
    .optional()
    .describe("Slides to insert or edit, applied in order. A new slide needs `html`."),
  remove: z
    .array(z.string().max(40))
    .max(LIMITS.maxSlides)
    .optional()
    .describe("Slide ids to remove (applied after upsert)."),
});

export const deletePresentationInput = z.strictObject({ presentation_id: presentationId });

export const addAssetInput = z.strictObject({
  presentation_id: presentationId,
  filename: z.string().max(255).optional().describe('Informational, e.g. "logo.png".'),
  source: z
    .strictObject({
      base64: z
        .string()
        .max(1_500_000)
        .optional()
        .describe("File content in base64, at most 1 MB once decoded."),
      media_type: z
        .string()
        .max(100)
        .optional()
        .describe(
          "image/png, image/jpeg, image/webp, image/avif or image/gif (checked against the content).",
        ),
      url: z
        .string()
        .max(2048)
        .optional()
        .describe(
          "An https URL of the image instead of base64: the server downloads it once and stores it (at most 8 MB).",
        ),
    })
    .describe("The image: { base64, media_type } or { url }."),
});

export const importHtmlDeckInput = z.strictObject({
  html: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024)
    .describe(
      "The complete HTML document of the artifact (<!doctype html>…</html>), as is: CDN scripts, Google Fonts links, stylesheets and https images are vendored. Max 2 MB.",
    ),
  title: z.string().min(1).max(LIMITS.maxTitleLength).optional().describe("Overrides <title>."),
  lang: lang.optional(),
  aspect_ratio: z.enum(["16:9", "4:3"]).optional().describe('"16:9" (default) or "4:3".'),
  split: z
    .enum(["auto", "slides", "headings", "single"])
    .optional()
    .describe(
      'How to split the body into slides. "auto" (default) tries in order: elements with data-slide, elements with class "slide", sibling <section>s, then <h1>/<h2> boundaries, else one slide.',
    ),
  idempotency_key: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Repeating the call with the same key returns the first result."),
});

export const presentationLinksInput = z.strictObject({ presentation_id: presentationId });

export const emptyInput = z.strictObject({});

export type CreatePresentationArgs = z.infer<typeof createPresentationInput>;
export type ListPresentationsArgs = z.infer<typeof listPresentationsInput>;
export type GetPresentationArgs = z.infer<typeof getPresentationInput>;
export type UpdatePresentationArgs = z.infer<typeof updatePresentationInput>;
export type UpdateSlidesArgs = z.infer<typeof updateSlidesInput>;
export type AddAssetArgs = z.infer<typeof addAssetInput>;
export type ImportHtmlDeckArgs = z.infer<typeof importHtmlDeckInput>;
