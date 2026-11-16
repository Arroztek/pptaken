// SPDX-License-Identifier: AGPL-3.0-or-later
// Output helpers: escaping and number formatting. Every value written into HTML comes through here.

/** Escapes text for an HTML text node or a double-quoted attribute; drops characters HTML cannot carry. */
export function esc(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) continue;
    if (code === 0xfffe || code === 0xffff || (code >= 0xd800 && code <= 0xdfff)) continue;
    switch (ch) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** A number with at most two decimals. */
export function num(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

export function px(v: number): string {
  return `${num(v)}px`;
}

/** Joins CSS declarations into a `style` attribute value (already safe: built from numbers and fixed words). */
export function style(decls: (string | null | undefined | false)[]): string {
  return decls.filter((d): d is string => typeof d === "string" && d !== "").join(";");
}

/** Plain text clipped to `max` UTF-16 code units, whitespace collapsed. */
export function clipText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Escapes Markdown so speaker notes read back as the plain text PowerPoint had. */
export function escapeMarkdown(line: string): string {
  let out = line.replace(/([\\`*_{}[\]<>#|~])/g, "\\$1");
  out = out.replace(/^(\s*)(\d+)([.)])(\s|$)/, "$1$2\\$3$4");
  out = out.replace(/^(\s*)([-+=])/, "$1\\$2");
  return out;
}
