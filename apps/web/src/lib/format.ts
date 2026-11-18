// SPDX-License-Identifier: AGPL-3.0-or-later
// Locale-aware formatting helpers. Pure: pass `now` explicitly in tests.

export type When = { kind: "relative"; text: string } | { kind: "date"; text: string };

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "2 minutes ago", "yesterday" for the last week; a short date ("Nov 2", or "Nov 2, 2025" in another year)
 * after that. Future timestamps (clock skew) read as the smallest past value.
 */
export function describeWhen(iso: string, locale: string, now: number = Date.now()): When {
  const at = Date.parse(iso);
  const seconds = Math.max(1, Math.round((now - at) / 1000));
  if (seconds < 7 * DAY) {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (seconds < MINUTE) return { kind: "relative", text: rtf.format(-seconds, "second") };
    if (seconds < HOUR)
      return { kind: "relative", text: rtf.format(-Math.floor(seconds / MINUTE), "minute") };
    if (seconds < DAY)
      return { kind: "relative", text: rtf.format(-Math.floor(seconds / HOUR), "hour") };
    return { kind: "relative", text: rtf.format(-Math.floor(seconds / DAY), "day") };
  }
  return { kind: "date", text: formatDate(iso, locale, now) };
}

export function formatDate(iso: string, locale: string, now: number = Date.now()): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

/** A byte size: "812 B", "12.4 kB", "1.2 MB" (decimal units, locale digits). */
export function formatBytes(bytes: number, locale: string): string {
  const nf = (n: number, digits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
  if (bytes < 1000) return `${nf(bytes, 0)} B`;
  if (bytes < 1_000_000) return `${nf(bytes / 1000, 1)} kB`;
  return `${nf(bytes / 1_000_000, 1)} MB`;
}

/** The short form of a SHA-256 fingerprint for people: first 8 and last 8 hex characters. */
export function shortDigest(digest: string): string {
  return digest.length <= 20 ? digest : `${digest.slice(0, 8)}…${digest.slice(-8)}`;
}

/** Debounce for search boxes. Returns the wrapped function and a cancel handle. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  run.cancel = () => clearTimeout(timer);
  return run;
}
