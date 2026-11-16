// SPDX-License-Identifier: AGPL-3.0-or-later
// Character classes shared by the ZIP reader, the archive manifest and the filename helpers. Written as code point
// checks (no regular-expression escapes) so the rules are easy to audit.

/** C0/C1 controls, zero-width characters and bidirectional overrides/isolates: never allowed in names. */
export function isUnsafeChar(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

export function hasUnsafeChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (isUnsafeChar(text.charCodeAt(i))) return true;
  return false;
}

/** Replaces unsafe characters with `?` and shortens the text, for error messages that echo hostile input. */
export function printable(text: string, max = 80): string {
  let out = "";
  for (let i = 0; i < text.length && out.length <= max; i++) {
    const code = text.charCodeAt(i);
    out += isUnsafeChar(code) ? "?" : text[i];
  }
  return out.length > max ? `${out.slice(0, max)}...` : out;
}
