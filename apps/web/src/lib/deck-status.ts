// SPDX-License-Identifier: AGPL-3.0-or-later
// The deck page's single status line (UX pass 2026-11): one plain label and at most one action. Pure, so the
// rules are unit-tested: ready, ready with interactive parts, needs your OK (and why), had problems, or off.
import type { ScriptErrors, ScriptsReview } from "./api";

export type DeckStatusKind = "ready" | "interactive" | "needsOk" | "problems" | "off";
/** Why the owner's OK is needed: first time, a new outside piece, or the owner asked to check every change. */
export type NeedsOkReason = "first" | "newLib" | "changed";

export interface DeckStatus {
  kind: DeckStatusKind;
  reason: NeedsOkReason | null;
  /** True when Claude's latest edit was allowed automatically (ADR-024). */
  auto: boolean;
  /** Distinct problems reported for the current code. */
  problems: number;
}

type ReviewFacts = Pick<
  ScriptsReview,
  "digest" | "enabled" | "state" | "approvedDigest" | "newLibs" | "approvalMode"
>;

export function deckStatus(
  review: ReviewFacts | null,
  errors: Pick<ScriptErrors, "current"> | null,
): DeckStatus {
  const none: DeckStatus = { kind: "ready", reason: null, auto: false, problems: 0 };
  if (review === null || review.digest === null) return none;
  if (!review.enabled) return { ...none, kind: "off" };
  if (review.state !== "approved") {
    const reason: NeedsOkReason =
      review.approvedDigest === null
        ? "first"
        : (review.newLibs ?? []).length > 0
          ? "newLib"
          : "changed";
    return { ...none, kind: "needsOk", reason };
  }
  const problems = errors?.current.length ?? 0;
  const auto = review.approvalMode === "auto";
  return { kind: problems > 0 ? "problems" : "interactive", reason: null, auto, problems };
}

/** Pairs the code of two versions by slide (and the deck-level code) for "Review changes". */
export interface CodePair {
  key: string;
  index: number;
  before: string | null;
  now: string | null;
}

export function codeChanges(
  before: {
    sources: { slideId: string; index: number; source: string }[];
    deckSource?: { source: string } | null;
  },
  now: {
    sources: { slideId: string; index: number; source: string }[];
    deckSource?: { source: string } | null;
  },
): CodePair[] {
  const pairs = new Map<string, CodePair>();
  const add = (key: string, index: number, side: "before" | "now", source: string) => {
    const pair = pairs.get(key) ?? { key, index, before: null, now: null };
    pair[side] = source;
    pair.index = Math.min(pair.index, index);
    pairs.set(key, pair);
  };
  if (before.deckSource) add("deck", -1, "before", before.deckSource.source);
  if (now.deckSource) add("deck", -1, "now", now.deckSource.source);
  for (const s of before.sources) add(s.slideId, s.index, "before", s.source);
  for (const s of now.sources) add(s.slideId, s.index, "now", s.source);
  return [...pairs.values()].filter((p) => p.before !== p.now).sort((a, b) => a.index - b.index);
}
