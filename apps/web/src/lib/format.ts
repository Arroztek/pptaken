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
