// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { debounce, describeWhen, formatDate } from "./format";

const now = Date.parse("2026-11-14T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

describe("describeWhen", () => {
  it("uses relative time for the last week", () => {
    expect(describeWhen(ago(2), "en", now)).toEqual({ kind: "relative", text: "2 seconds ago" });
    expect(describeWhen(ago(0), "en", now).text).toBe("1 second ago");
    expect(describeWhen(ago(5 * 60), "en", now).text).toBe("5 minutes ago");
    expect(describeWhen(ago(2 * 3600), "en", now).text).toBe("2 hours ago");
    expect(describeWhen(ago(26 * 3600), "en", now).text).toBe("yesterday");
    expect(describeWhen(ago(2 * 3600), "es", now).text).toBe("hace 2 horas");
  });

  it("switches to a short date after a week", () => {
    const when = describeWhen("2026-11-02T09:00:00Z", "en", now);
    expect(when).toEqual({ kind: "date", text: "Nov 2" });
    expect(formatDate("2025-03-09T09:00:00Z", "en", now)).toBe("Mar 9, 2025");
    expect(describeWhen("2026-11-02T09:00:00Z", "es", now).text).toMatch(/^2 nov/);
  });

  it("treats future timestamps (clock skew) as just now", () => {
    expect(describeWhen(ago(-30), "en", now).text).toBe("1 second ago");
  });
});

describe("debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once with the last arguments, and can be cancelled", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const run = debounce(fn, 100);
    run("a");
    run("b");
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith("b");
    run("c");
    run.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
