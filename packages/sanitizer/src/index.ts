// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/sanitizer: barrier 1 of the content trust model (ADR-001). Allowlist-based sanitizing of untrusted
// slide HTML, inline SVG and CSS. Barriers 2 and 3 (sandboxed iframe, no-network CSP) must stay in place: this
// package reduces risk, it does not replace isolation.

import type { Deck, Slide } from "@pptaken/schema";
import { type CssResult, sanitizeCss } from "./css.js";
import { type HtmlResult, sanitizeSlideHtml } from "./html.js";
import type { Warning } from "./warnings.js";

export { type CssOptions, type CssResult, sanitizeCss } from "./css.js";
export { type HtmlOptions, type HtmlResult, sanitizeSlideHtml } from "./html.js";
export * as policy from "./policy.js";
export { SANITIZER_LIMITS } from "./policy.js";
export {
  MAX_WARNINGS_PER_FIELD,
  WARNING_CODES,
  type Warning,
  type WarningCode,
} from "./warnings.js";

const SLIDE_ID = /^[a-z0-9-]{1,40}$/;

export interface DeckOptions {
  /**
   * Builds the CSS scope selector of a slide from its id. Default: `[data-slide="<id>"]`, which must match the
   * attribute the player puts on the element that contains the slide.
   */
  slideScope?: (slideId: string) => string;
}

export interface DeckResult {
  deck: Deck;
  warnings: Warning[];
}

/** Default scope selector of a slide: `[data-slide="<id>"]`. */
export function defaultSlideScope(slideId: string): string {
  return `[data-slide="${slideId}"]`;
}

/**
 * Sanitizes every untrusted field of a validated deck: each slide's `html` and `css` (scoped to the slide) and
 * the theme CSS (not scoped). Returns a new deck; the input is not modified. Never throws on hostile content.
 * Warnings carry a `path` such as `slides[3].html`, `slides[3].css` or `theme.css`.
 */
export function sanitizeDeck(deck: Deck, options: DeckOptions = {}): DeckResult {
  const scopeOf = options.slideScope ?? defaultSlideScope;
  const warnings: Warning[] = [];
  const slides = deck.slides.map((slide, index): Slide => {
    const base = `slides[${index}]`;
    const out: Slide = { ...slide };
    const html: HtmlResult = sanitizeSlideHtml(slide.html, { path: `${base}.html` });
    out.html = html.html;
    warnings.push(...html.warnings);
    if (slide.css !== undefined) {
      if (!SLIDE_ID.test(slide.id)) {
        // The id is interpolated into a selector: refuse anything outside the schema's id alphabet.
        out.css = "";
        warnings.push({
          code: "INTERNAL_ERROR",
          message: "Slide id is not valid, so its CSS cannot be scoped and was removed",
          path: `${base}.css`,
        });
      } else {
        const css: CssResult = sanitizeCss(slide.css, {
          scope: scopeOf(slide.id),
          path: `${base}.css`,
        });
        out.css = css.css;
        warnings.push(...css.warnings);
      }
    }
    return out;
  });
  const result: Deck = { ...deck, slides };
  if (deck.theme !== undefined) {
    result.theme = { ...deck.theme };
    if (deck.theme.css !== undefined) {
      const css: CssResult = sanitizeCss(deck.theme.css, { path: "theme.css" });
      result.theme.css = css.css;
      warnings.push(...css.warnings);
    }
  }
  return { deck: result, warnings };
}
