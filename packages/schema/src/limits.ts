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
  /** Author script of one slide (interactive mode, ADR-020). */
  maxSlideScript: 128 * 1024,
  /** Sum of every slide's author script. */
  maxDeckScripts: 1024 * 1024,
  /** Vendored scripts (`libs`) per deck. */
  maxLibs: 16,
  /** Deck-level shared script (ADR-022), run once before the slide scripts; counts toward `maxDeckScripts`. */
  maxDeckScript: 512 * 1024,
  /** Vendored font faces (`theme.fontFaces`, ADR-022). */
  maxFontFaces: 96,
  /** Google Fonts families requested with `theme.googleFonts` (an input convenience, ADR-022). */
  maxGoogleFonts: 8,
  /** Provenance entries of vendored resources (`vendored`, ADR-022). */
  maxVendored: 300,
} as const;

/**
 * Vendored assets bundled with PPTaken (interactive mode, ADR-020). A deck's `libs` is a list of **vendored script
 * assets**: a label, the SHA-256 of the stored file and the URL it came from. The general mechanism (next phase) is
 * ingest-time vendoring: the server fetches a CDN script once, stores it as a content-addressed asset and records
 * it here-like in the deck. These bundled entries are the first ones; an agent may also name them by id
 * (`"uplot@1"`), which the schema expands to the full reference. `sha256` is the hex SHA-256 of the JavaScript
 * file: the player build refuses a file that does not match, and it is part of the scripts digest.
 */
export const LIB_CATALOG = {
  "uplot@1": {
    name: "uPlot",
    version: "1.6.32",
    license: "MIT",
    homepage: "https://github.com/leeoniya/uPlot",
    /** Where the bundled file was vendored from (provenance; never fetched by viewers). */
    source: "https://registry.npmjs.org/uplot/-/uplot-1.6.32.tgz#dist/uPlot.iife.min.js",
    /** Global defined by the library. */
    global: "uPlot",
    sha256: "19c8d4c6ad88929a79f4ae49d6f7161566dfd0ba3d15cc495e974f787eb78f1f",
    /** SHA-256 of the library's stylesheet, inserted as a `<style>` element. */
    cssSha256: "df630c6a8d6f8eeaff264b50f73ce5b114f646ffd9a0bb74f049b0a00135fa04",
    description: "Small, fast canvas charts for lines, areas, bars and time series.",
  },
} as const;

export type LibId = keyof typeof LIB_CATALOG;

/** Ids of the vendored libraries, for validation. */
export const LIB_IDS = Object.keys(LIB_CATALOG) as LibId[];

/**
 * Fonts bundled with the player (see docs/foundation/05-visual-identity.md §7). Since ADR-022 this is no longer a
 * closed list of what a deck may use: any other family works once it is vendored into `theme.fontFaces` (from a
 * stylesheet URL such as Google Fonts, an `@font-face` with an https `src`, or `theme.googleFonts`).
 */
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
