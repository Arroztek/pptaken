// SPDX-License-Identifier: Apache-2.0

/** Hard limits of the `pptaken.deck` format. String limits count UTF-16 code units, not bytes. */
export const LIMITS = {
  maxSlides: 200,
  maxTitleLength: 200,
  maxSectionLength: 100,
  maxSlideHtml: 256 * 1024,
  maxSlideCss: 64 * 1024,
  maxThemeCss: 64 * 1024,
  maxNotes: 16 * 1024,
  maxThemeFonts: 4,
  maxDurationHintSec: 3600,
  maxTargetMinutes: 600,
} as const;

/** Closed catalog of fonts bundled with the player (see docs/foundation/05-visual-identity.md §7). */
export const FONT_CATALOG = [
  "Inter",
  "IBM Plex Sans",
  "Bricolage Grotesque",
  "Space Grotesk",
  "Source Serif 4",
  "Fraunces",
  "JetBrains Mono",
  "IBM Plex Mono",
  "Atkinson Hyperlegible",
] as const;

export type FontName = (typeof FONT_CATALOG)[number];
