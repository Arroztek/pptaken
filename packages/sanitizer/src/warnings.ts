// SPDX-License-Identifier: AGPL-3.0-or-later

/** Stable machine-readable codes of sanitizer warnings. Never rename a code: agents and tests depend on them. */
export const WARNING_CODES = [
  /** An element was removed together with its content (script, iframe, form, math, unknown SVG...). */
  "REMOVED_ELEMENT",
  /** An element that is not allowed but harmless was removed and its children were kept. */
  "UNWRAPPED_ELEMENT",
  /** An attribute was removed (event handler, unknown attribute, unsafe value). */
  "REMOVED_ATTRIBUTE",
  /** A CSS rule or at-rule was removed (`@import`, `@font-face`, a selector that escapes the slide...). */
  "REMOVED_CSS_RULE",
  /** A CSS declaration was removed (unknown property or unsafe value). */
  "REMOVED_CSS_PROPERTY",
  /** A font family neither bundled nor vendored (`theme.fontFaces`) was removed from a `font-family`/`font` value. */
  "REMOVED_FONT_FAMILY",
  /** A URL was removed: only `asset:<hex>` references (and `#id` fragments in SVG paint) are allowed. */
  "REMOVED_URL",
  /** An `img`/`image` source is not a valid `asset:<hex>` reference, so the element was removed. */
  "INVALID_ASSET_REF",
  /** The input exceeds the size limit of its field; the whole field was replaced by an empty value. */
  "INPUT_TOO_LARGE",
  /** An internal complexity limit (nesting depth, node count...) was exceeded; the whole field was emptied. */
  "LIMIT_EXCEEDED",
  /** Re-parsing the sanitized output did not converge (mutation-XSS defense); the whole field was emptied. */
  "UNSTABLE_OUTPUT",
  /** Unexpected internal error; the whole field was emptied (fail closed). */
  "INTERNAL_ERROR",
  /** More warnings were produced than are reported; the count is in the message. */
  "TOO_MANY_WARNINGS",
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

export interface Warning {
  /** Stable code, see {@link WARNING_CODES}. */
  code: WarningCode;
  /** Human-readable explanation, safe to show to an agent or a person. */
  message: string;
  /** Location in the deck, e.g. `slides[3].html` or `theme.css` (only set by `sanitizeDeck` or the `path` option). */
  path?: string;
  /** Name of the removed element, attribute, property or at-rule (truncated, control characters replaced). */
  name?: string;
}

/** Maximum warnings reported per sanitized field; the rest are summarized by one `TOO_MANY_WARNINGS`. */
export const MAX_WARNINGS_PER_FIELD = 100;

const MAX_NAME_LENGTH = 40;

/**
 * Makes untrusted text safe to echo in a warning: control and format characters are replaced, whitespace is
 * collapsed and the result is truncated. Warnings must never carry the hostile payload verbatim.
 */
export function safeSnippet(text: string, max = MAX_NAME_LENGTH): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0) || (cp >= 0x200b && cp <= 0x200f)) {
      out += out.endsWith(" ") ? "" : " ";
    } else if (cp >= 0x202a && cp <= 0x202e) {
      out += "?";
    } else {
      out += ch;
    }
    if (out.length > max) return `${out.slice(0, max)}…`;
  }
  return out;
}

/** Collects warnings for one field, deduplicated and capped. */
export class WarningCollector {
  readonly list: Warning[] = [];
  private readonly seen = new Set<string>();
  private overflow = 0;

  constructor(private readonly path?: string) {}

  add(code: WarningCode, message: string, name?: string): void {
    const safeName = name === undefined ? undefined : safeSnippet(name);
    const key = `${code}\u0000${message}\u0000${safeName ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.list.length >= MAX_WARNINGS_PER_FIELD) {
      this.overflow++;
      return;
    }
    const warning: Warning = { code, message };
    if (this.path !== undefined) warning.path = this.path;
    if (safeName !== undefined) warning.name = safeName;
    this.list.push(warning);
  }

  /** Copies the warnings of another collector into this one (used to merge re-sanitizing passes). */
  merge(other: WarningCollector): void {
    for (const w of other.list) this.add(w.code, w.message, w.name);
    this.overflow += other.overflow;
  }

  /** Drops every warning collected so far (used when a whole field fails closed). */
  reset(): void {
    this.list.length = 0;
    this.seen.clear();
    this.overflow = 0;
  }

  result(): Warning[] {
    if (this.overflow === 0) return [...this.list];
    const summary: Warning = {
      code: "TOO_MANY_WARNINGS",
      message: `${this.overflow} more distinct warning(s) were not reported`,
    };
    if (this.path !== undefined) summary.path = this.path;
    return [...this.list, summary];
  }
}
