// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Format version of the deck envelope. Bump only on breaking changes. */
export const DECK_FORMAT_VERSION = 1;

/** Placeholder slide shape. The real format lands in phase F1 (see docs/foundation/07). */
export const slideSchema = z.object({
  id: z.string().min(1).max(64),
  html: z.string().max(200_000),
  notes: z.string().max(20_000).optional(),
});

export const deckSchema = z.object({
  format: z.literal(DECK_FORMAT_VERSION),
  title: z.string().min(1).max(200),
  slides: z.array(slideSchema).min(1).max(500),
});

export type Slide = z.infer<typeof slideSchema>;
export type Deck = z.infer<typeof deckSchema>;
