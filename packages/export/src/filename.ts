// SPDX-License-Identifier: AGPL-3.0-or-later
// File names derived from an untrusted deck title. Two forms: an ASCII slug (safe everywhere, used as the plain
// `filename` and by `exportHtml`) and a Unicode name for RFC 6266 `filename*`. Neither can contain a path
// separator, a quote, a control character or a name Windows reserves.

import { isUnsafeChar } from "./text.js";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** `My Talk: Ünïcode!` -> `my-talk-unicode`. Empty or symbol-only titles give `presentation`. */
export function slugify(title: string, max = 60): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, max)
    .replace(/^-+|-+$/g, "");
  return slug === "" || WINDOWS_RESERVED.test(slug) ? "presentation" : slug;
}

/**
 * A readable Unicode file name stem: letters, digits, spaces, `-`, `_`, `.` and `,` only (everything else becomes
 * a space), whitespace collapsed, no leading or trailing dots or spaces. Falls back to the slug.
 */
export function unicodeStem(title: string, max = 80): string {
  let out = "";
  for (const ch of title.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0;
    if (isUnsafeChar(code)) out += " ";
    else if (/[\p{L}\p{N} _.,-]/u.test(ch)) out += ch;
    else out += " ";
  }
  const stem = [...out.replace(/\s+/g, " ").trim()]
    .slice(0, max)
    .join("")
    .replace(/^[. ]+|[. ]+$/g, "");
  return stem === "" || WINDOWS_RESERVED.test(stem) ? slugify(title) : stem;
}

/** ASCII and Unicode file names for a deck title and an extension such as `.html` or `.pkn`. */
export function exportFilenames(
  title: string,
  extension: string,
): { ascii: string; unicode: string } {
  if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw new TypeError("invalid extension");
  return { ascii: `${slugify(title)}${extension}`, unicode: `${unicodeStem(title)}${extension}` };
}
