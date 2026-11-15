// SPDX-License-Identifier: Apache-2.0
// Presenter clock and pace: pure functions over plain data. Time is passed in (`now` in milliseconds), so the
// logic is tested with a fake clock and the presenter view only adds a timer that re-renders.
//
// - Clock: start, pause, reset; elapsed time counts only while running.
// - Time per slide: the clock's elapsed time is attributed to the slide that was shown while it ran.
// - Plan: each slide's planned seconds come from `durationHintSec`; slides without a hint share what is left of
//   `targetMinutes` (if any). Sections are runs of consecutive slides with the same `section`.
// - Pace: on time while the elapsed time is inside the planned window of the current slide (between the planned
//   start and end of that slide); behind after it, ahead before it.

export interface ClockState {
  running: boolean;
  /** `now` when the clock was last started (meaningful while running). */
  startedAt: number;
  /** Milliseconds counted before the last start. */
  accumulated: number;
}

export const clockIdle = (): ClockState => ({ running: false, startedAt: 0, accumulated: 0 });

export function clockElapsed(clock: ClockState, now: number): number {
  return clock.accumulated + (clock.running ? Math.max(now - clock.startedAt, 0) : 0);
}

export function clockStart(clock: ClockState, now: number): ClockState {
  return clock.running ? clock : { running: true, startedAt: now, accumulated: clock.accumulated };
}

export function clockPause(clock: ClockState, now: number): ClockState {
  return clock.running
    ? { running: false, startedAt: 0, accumulated: clockElapsed(clock, now) }
    : clock;
}

/** Start/pause (the `t` key). */
export function clockToggle(clock: ClockState, now: number): ClockState {
  return clock.running ? clockPause(clock, now) : clockStart(clock, now);
}

// ---------------------------------------------------------------------------------------------------------------
// Time per slide

export interface SlideTimes {
  /** Milliseconds spent on each slide while the clock ran. */
  perSlide: number[];
  /** Slide shown since `mark`. */
  slide: number;
  /** Clock elapsed time already attributed. */
  mark: number;
}

export const slideTimes = (count: number, slide = 0): SlideTimes => ({
  perSlide: new Array<number>(Math.max(count, 0)).fill(0),
  slide,
  mark: 0,
});

/**
 * Attributes the clock time since the last call to the slide shown until now, and records the new slide. Call it
 * on every slide change and before reading the times. `elapsed` is `clockElapsed(...)` now.
 */
export function attribute(times: SlideTimes, elapsed: number, slide: number): SlideTimes {
  const delta = Math.max(elapsed - times.mark, 0);
  const perSlide = times.perSlide.slice();
  if (delta > 0 && times.slide >= 0 && times.slide < perSlide.length) {
    perSlide[times.slide] = (perSlide[times.slide] ?? 0) + delta;
  }
  return { perSlide, slide, mark: Math.max(elapsed, times.mark) };
}

// ---------------------------------------------------------------------------------------------------------------
// Plan

export interface PlanSlide {
  section?: string | undefined;
  durationHintSec?: number | undefined;
}

export interface SectionPlan {
  /** Section name, or `null` for slides without one. */
  name: string | null;
  first: number;
  last: number;
  /** Planned seconds, or `null` when a slide of the section has no plan. */
  plannedSec: number | null;
}

export interface Plan {
  /** Planned seconds of each slide, or `null` when unknown. */
  perSlideSec: (number | null)[];
  sections: SectionPlan[];
  /** Planned total: the target if set, else the sum of the slides' plans if all are known. */
  totalSec: number | null;
}

const validSec = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function buildPlan(slides: readonly PlanSlide[], targetMinutes?: number): Plan {
  const target = validSec(targetMinutes) ? targetMinutes * 60 : null;
  let hinted = 0;
  let unhinted = 0;
  for (const s of slides) {
    if (validSec(s.durationHintSec)) hinted += s.durationHintSec;
    else unhinted += 1;
  }
  const share =
    target !== null && unhinted > 0 && target > hinted ? (target - hinted) / unhinted : null;
  const perSlideSec = slides.map((s) => (validSec(s.durationHintSec) ? s.durationHintSec : share));
  const sections: SectionPlan[] = [];
  slides.forEach((s, i) => {
    const name = typeof s.section === "string" && s.section !== "" ? s.section : null;
    const plan = perSlideSec[i] ?? null;
    const last = sections[sections.length - 1];
    if (last && last.name === name) {
      last.last = i;
      last.plannedSec = last.plannedSec === null || plan === null ? null : last.plannedSec + plan;
    } else {
      sections.push({ name, first: i, last: i, plannedSec: plan });
    }
  });
  const known = perSlideSec.every((p) => p !== null);
  const sum = perSlideSec.reduce<number>((a, p) => a + (p ?? 0), 0);
  return { perSlideSec, sections, totalSec: target ?? (known && slides.length > 0 ? sum : null) };
}

/** Whether the plan can say anything about pace (every slide has a planned time). */
export const hasPace = (plan: Plan): boolean =>
  plan.perSlideSec.length > 0 && plan.perSlideSec.every((p) => p !== null);

// ---------------------------------------------------------------------------------------------------------------
// Pace

export type PaceStatus = "ahead" | "behind" | "on-time";

export interface Pace {
  status: PaceStatus;
  /** Seconds behind (positive) or ahead (negative) of the planned window of the current slide; 0 inside it. */
  deltaSec: number;
  /** Planned start and end of the current slide, in seconds from the start of the talk. */
  windowSec: [number, number];
}

export function paceAt(plan: Plan, slide: number, elapsedSec: number): Pace | null {
  if (!hasPace(plan) || slide < 0 || slide >= plan.perSlideSec.length) return null;
  let start = 0;
  for (let i = 0; i < slide; i++) start += plan.perSlideSec[i] ?? 0;
  const end = start + (plan.perSlideSec[slide] ?? 0);
  const deltaSec =
    elapsedSec < start ? elapsedSec - start : elapsedSec > end ? elapsedSec - end : 0;
  const status: PaceStatus = deltaSec > 0 ? "behind" : deltaSec < 0 ? "ahead" : "on-time";
  return { status, deltaSec, windowSec: [start, end] };
}

export interface SectionReport {
  name: string | null;
  first: number;
  last: number;
  plannedSec: number | null;
  actualSec: number;
  /** `done`: entirely before the current slide; `current`: holds it; `upcoming`: after it. */
  state: "done" | "current" | "upcoming";
  /** Done: over (behind) or under (ahead) plan. Current: behind once over plan, else on time. */
  status: PaceStatus | null;
}

/** Planned vs actual time of every section. `perSlideMs` from `SlideTimes.perSlide`. */
export function sectionReport(
  plan: Plan,
  perSlideMs: readonly number[],
  slide: number,
): SectionReport[] {
  return plan.sections.map((s) => {
    let ms = 0;
    for (let i = s.first; i <= s.last; i++) ms += perSlideMs[i] ?? 0;
    const actualSec = ms / 1000;
    const state = slide > s.last ? "done" : slide >= s.first ? "current" : "upcoming";
    let status: PaceStatus | null = null;
    if (s.plannedSec !== null && state === "done")
      status = actualSec > s.plannedSec ? "behind" : actualSec < s.plannedSec ? "ahead" : "on-time";
    if (s.plannedSec !== null && state === "current")
      status = actualSec > s.plannedSec ? "behind" : "on-time";
    return { ...s, actualSec, state, status };
  });
}

/** `m:ss` (or `h:mm:ss`) of a number of seconds, rounded down; negative values get a minus sign. */
export function formatClock(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const total = Math.floor(Math.abs(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, "0")}:${ss}` : `${sign}${m}:${ss}`;
}
