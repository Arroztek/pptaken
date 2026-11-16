// SPDX-License-Identifier: AGPL-3.0-or-later
// Font substitution: PowerPoint fonts are mapped to the closest family of the bundled catalog by category. Line
// breaks can change with a different font; the importer reports every substitution once.
import { FONT_CATALOG, type FontName } from "@pptaken/schema";

type Generic = "sans-serif" | "serif" | "monospace";

const SERIF: FontName = "Source Serif 4";
const MONO: FontName = "JetBrains Mono";

/** Lower-cased PowerPoint family name -> catalog font. */
const MAP: Record<string, FontName> = {
  // Sans (neutral grotesque / humanist)
  calibri: "Inter",
  "calibri light": "Inter",
  arial: "Inter",
  "arial narrow": "Inter",
  "arial nova": "Inter",
  helvetica: "Inter",
  "helvetica neue": "Inter",
  "segoe ui": "Inter",
  "segoe ui light": "Inter",
  "segoe ui semibold": "Inter",
  "segoe ui semilight": "Inter",
  verdana: "Inter",
  tahoma: "Inter",
  aptos: "Inter",
  "aptos display": "Inter",
  "aptos narrow": "Inter",
  roboto: "Inter",
  "open sans": "Inter",
  lato: "Inter",
  "source sans pro": "Inter",
  "noto sans": "Inter",
  "sf pro": "Inter",
  "sf pro display": "Inter",
  "trebuchet ms": "IBM Plex Sans",
  "gill sans": "IBM Plex Sans",
  "gill sans mt": "IBM Plex Sans",
  "franklin gothic book": "IBM Plex Sans",
  "franklin gothic medium": "IBM Plex Sans",
  corbel: "IBM Plex Sans",
  candara: "IBM Plex Sans",
  "ibm plex sans": "IBM Plex Sans",
  // Geometric / display sans
  "century gothic": "Space Grotesk",
  futura: "Space Grotesk",
  avenir: "Space Grotesk",
  "avenir next": "Space Grotesk",
  "avenir next lt pro": "Space Grotesk",
  montserrat: "Space Grotesk",
  poppins: "Space Grotesk",
  "tw cen mt": "Space Grotesk",
  "space grotesk": "Space Grotesk",
  impact: "Bricolage Grotesque",
  bahnschrift: "Bricolage Grotesque",
  "bricolage grotesque": "Bricolage Grotesque",
  rockwell: "Fraunces",
  "rockwell extra bold": "Fraunces",
  fraunces: "Fraunces",
  // Serif
  "times new roman": SERIF,
  times: SERIF,
  georgia: SERIF,
  cambria: SERIF,
  garamond: SERIF,
  "book antiqua": SERIF,
  "palatino linotype": SERIF,
  palatino: SERIF,
  constantia: SERIF,
  baskerville: SERIF,
  "baskerville old face": SERIF,
  "bookman old style": SERIF,
  "century schoolbook": SERIF,
  merriweather: SERIF,
  "playfair display": "Fraunces",
  "source serif 4": SERIF,
  "source serif pro": SERIF,
  // Monospace
  consolas: MONO,
  "courier new": MONO,
  courier: MONO,
  "lucida console": MONO,
  "lucida sans typewriter": MONO,
  menlo: MONO,
  monaco: MONO,
  "cascadia code": MONO,
  "cascadia mono": MONO,
  "source code pro": MONO,
  "jetbrains mono": MONO,
  "ibm plex mono": "IBM Plex Mono",
  // Readability
  "atkinson hyperlegible": "Atkinson Hyperlegible",
};

const GENERIC: Record<FontName, Generic> = {
  Inter: "sans-serif",
  "IBM Plex Sans": "sans-serif",
  "Bricolage Grotesque": "sans-serif",
  "Space Grotesk": "sans-serif",
  "Source Serif 4": "serif",
  Fraunces: "serif",
  "JetBrains Mono": "monospace",
  "IBM Plex Mono": "monospace",
  "Atkinson Hyperlegible": "sans-serif",
};

/**
 * Size compensation for common narrow sources: the replacement is set slightly smaller so lines break about where
 * they did. Rough ratios of average character widths (source / replacement), estimated, not measured per glyph.
 */
const WIDTH: Record<string, number> = {
  calibri: 0.88,
  "calibri light": 0.87,
  arial: 0.95,
  "arial narrow": 0.8,
  helvetica: 0.95,
  "helvetica neue": 0.95,
  "segoe ui": 0.94,
  "segoe ui light": 0.93,
  "segoe ui semibold": 0.95,
  aptos: 0.94,
  "aptos display": 0.94,
  "aptos narrow": 0.82,
  tahoma: 0.92,
  "times new roman": 0.92,
  times: 0.92,
  garamond: 0.88,
  cambria: 0.96,
  consolas: 0.92,
  "lucida console": 1,
  "franklin gothic book": 0.94,
  "gill sans mt": 0.93,
  corbel: 0.92,
  candara: 0.94,
};

export interface FontChoice {
  font: FontName;
  /** True when the source name is not the catalog font itself (a substitution to report). */
  substituted: boolean;
  /** Font-size factor that compensates the width difference (1 when unknown). */
  scale: number;
}

/** Maps a PowerPoint typeface to the catalog. Unknown names fall back by a rough category guess, else Inter. */
export function mapFont(typeface: string): FontChoice {
  const key = typeface.trim().toLowerCase();
  const exact = (FONT_CATALOG as readonly string[]).find((f) => f.toLowerCase() === key);
  if (exact !== undefined) return { font: exact as FontName, substituted: false, scale: 1 };
  const scale = WIDTH[key] ?? 1;
  const mapped = MAP[key];
  if (mapped !== undefined) return { font: mapped, substituted: true, scale };
  if (/mono|code|console|courier|typewriter/.test(key))
    return { font: MONO, substituted: true, scale };
  if (/serif|roman|times|garamond|book|antiqua|schoolbook/.test(key) && !/sans/.test(key)) {
    return { font: SERIF, substituted: true, scale };
  }
  return { font: "Inter", substituted: true, scale };
}

export function genericOf(font: FontName): Generic {
  return GENERIC[font];
}

/** The CSS `font-family` value written by the importer (exact form, so it can be rewritten later). */
export function fontFamilyCss(font: FontName): string {
  return `'${font}',${genericOf(font)}`;
}
