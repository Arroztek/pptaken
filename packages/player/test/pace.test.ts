// SPDX-License-Identifier: Apache-2.0
// Presenter clock and pace: pure functions driven by a fake clock.

import { describe, expect, it } from "vitest";
import { pace } from "../dist/index.js";

const {
  attribute,
  buildPlan,
  clockElapsed,
  clockIdle,
  clockPause,
  clockStart,
  clockToggle,
  formatClock,
  hasPace,
  paceAt,
  sectionReport,
  slideTimes,
} = pace;

/** A fake clock: `now()` and `advance(sec)`. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (sec: number) => (t += sec * 1000) };
}

describe("clock", () => {
  it("counts only while running", () => {
    const f = fakeClock();
    let c = clockIdle();
    f.advance(10);
    expect(clockElapsed(c, f.now())).toBe(0);
    c = clockStart(c, f.now());
    f.advance(30);
    expect(clockElapsed(c, f.now())).toBe(30_000);
    c = clockPause(c, f.now());
    f.advance(100);
    expect(clockElapsed(c, f.now())).toBe(30_000);
    c = clockToggle(c, f.now());
    expect(c.running).toBe(true);
    f.advance(5);
    expect(clockElapsed(c, f.now())).toBe(35_000);
    c = clockToggle(c, f.now());
    expect(c.running).toBe(false);
    expect(clockElapsed(clockIdle(), f.now())).toBe(0);
  });

  it("is idempotent and never negative", () => {
    const f = fakeClock();
    const c = clockStart(clockIdle(), f.now());
    expect(clockStart(c, f.now() + 5000)).toBe(c);
    expect(clockPause(clockIdle(), f.now())).toEqual(clockIdle());
    expect(clockElapsed(c, f.now() - 5000)).toBe(0);
  });

  it("formats", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(59.9)).toBe("0:59");
    expect(formatClock(61)).toBe("1:01");
    expect(formatClock(3600 + 62)).toBe("1:01:02");
    expect(formatClock(-75)).toBe("-1:15");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });
});

describe("time per slide", () => {
  it("attributes clock time to the slide shown while it ran", () => {
    const f = fakeClock();
    let c = clockStart(clockIdle(), f.now());
    let t = slideTimes(3, 0);
    f.advance(20);
    t = attribute(t, clockElapsed(c, f.now()), 1);
    f.advance(15);
    c = clockPause(c, f.now());
    f.advance(1000); // paused: not counted
    t = attribute(t, clockElapsed(c, f.now()), 2);
    c = clockStart(c, f.now());
    f.advance(7);
    t = attribute(t, clockElapsed(c, f.now()), 2);
    expect(t.perSlide).toEqual([20_000, 15_000, 7_000]);
  });

  it("ignores out-of-range slides and time going backwards", () => {
    let t = slideTimes(2, 5);
    t = attribute(t, 1000, 0);
    expect(t.perSlide).toEqual([0, 0]);
    t = attribute(t, 500, 0);
    expect(t.perSlide).toEqual([0, 0]);
    expect(t.mark).toBe(1000);
  });
});

describe("plan and pace", () => {
  const slides = [
    { section: "Intro", durationHintSec: 60 },
    { section: "Intro", durationHintSec: 60 },
    { section: "Body", durationHintSec: 120 },
    { section: "Body", durationHintSec: 120 },
    { section: "End", durationHintSec: 60 },
  ];

  it("builds sections from runs of the same section", () => {
    const plan = buildPlan(slides);
    expect(plan.sections).toEqual([
      { name: "Intro", first: 0, last: 1, plannedSec: 120 },
      { name: "Body", first: 2, last: 3, plannedSec: 240 },
      { name: "End", first: 4, last: 4, plannedSec: 60 },
    ]);
    expect(plan.totalSec).toBe(420);
    expect(hasPace(plan)).toBe(true);
  });

  it("shares the target between slides without hints", () => {
    const plan = buildPlan([{ durationHintSec: 120 }, {}, {}, { section: "x" }], 10);
    expect(plan.perSlideSec).toEqual([120, 160, 160, 160]);
    expect(plan.totalSec).toBe(600);
    expect(plan.sections.map((s) => s.name)).toEqual([null, "x"]);
  });

  it("has no pace without hints or target", () => {
    const plan = buildPlan([{ section: "a" }, { section: "a", durationHintSec: 30 }]);
    expect(hasPace(plan)).toBe(false);
    expect(plan.totalSec).toBeNull();
    expect(plan.sections[0]?.plannedSec).toBeNull();
    expect(paceAt(plan, 0, 10)).toBeNull();
    expect(buildPlan([], 10).totalSec).toBe(600);
    expect(hasPace(buildPlan([]))).toBe(false);
  });

  it("is on time inside the current slide's window, behind after it, ahead before it", () => {
    const plan = buildPlan(slides);
    expect(paceAt(plan, 0, 0)).toEqual({ status: "on-time", deltaSec: 0, windowSec: [0, 60] });
    expect(paceAt(plan, 0, 90)).toMatchObject({ status: "behind", deltaSec: 30 });
    expect(paceAt(plan, 2, 100)).toMatchObject({ status: "ahead", deltaSec: -20 });
    expect(paceAt(plan, 2, 200)).toMatchObject({ status: "on-time", windowSec: [120, 240] });
    expect(paceAt(plan, 4, 500)).toMatchObject({ status: "behind", deltaSec: 80 });
    expect(paceAt(plan, 9, 0)).toBeNull();
  });

  it("reports planned vs actual per section with a fake clock", () => {
    const plan = buildPlan(slides);
    const f = fakeClock();
    const c = clockStart(clockIdle(), f.now());
    let t = slideTimes(slides.length, 0);
    const go = (sec: number, slide: number) => {
      f.advance(sec);
      t = attribute(t, clockElapsed(c, f.now()), slide);
    };
    go(50, 1); // intro slide 1: 50 s
    go(100, 2); // intro slide 2: 100 s -> intro 150 s, planned 120 s
    go(90, 2); // body slide 1 so far: 90 s
    const report = sectionReport(plan, t.perSlide, 2);
    expect(report.map((r) => [r.name, r.state, r.actualSec, r.status])).toEqual([
      ["Intro", "done", 150, "behind"],
      ["Body", "current", 90, "on-time"],
      ["End", "upcoming", 0, null],
    ]);
    // 240 s elapsed, the end of slide 3's planned window [120, 240]: still on time.
    expect(paceAt(plan, 2, clockElapsed(c, f.now()) / 1000)).toMatchObject({
      status: "on-time",
      deltaSec: 0,
    });
    expect(paceAt(plan, 2, 241)).toMatchObject({ status: "behind", deltaSec: 1 });
    go(200, 4); // body slide 1 total 290 s > 240 planned
    const later = sectionReport(plan, t.perSlide, 4);
    expect(later[1]).toMatchObject({ state: "done", actualSec: 290, status: "behind" });
    expect(later[2]).toMatchObject({ state: "current", status: "on-time" });
  });

  it("marks a fast section as ahead", () => {
    const plan = buildPlan(slides);
    const report = sectionReport(plan, [30_000, 30_000, 0, 0, 0], 2);
    expect(report[0]).toMatchObject({ state: "done", actualSec: 60, status: "ahead" });
  });
});
