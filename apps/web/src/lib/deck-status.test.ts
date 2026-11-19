// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { codeChanges, deckStatus } from "./deck-status";

const base = {
  digest: "a".repeat(64),
  enabled: true,
  state: "approved" as const,
  approvedDigest: "a".repeat(64),
  newLibs: [],
  approvalMode: "owner" as const,
};
const err = { current: [{} as never] };

describe("deckStatus", () => {
  it("is Ready without interactive parts, whatever else", () => {
    expect(deckStatus(null, null).kind).toBe("ready");
    expect(deckStatus({ ...base, digest: null }, null).kind).toBe("ready");
  });

  it("says off when the instance does not run interactive parts", () => {
    expect(deckStatus({ ...base, enabled: false }, err).kind).toBe("off");
  });

  it("asks for the owner's OK and says why", () => {
    const pending = { ...base, state: "pending" as const };
    expect(deckStatus({ ...pending, approvedDigest: null }, null)).toMatchObject({
      kind: "needsOk",
      reason: "first",
    });
    expect(
      deckStatus(
        {
          ...pending,
          approvedDigest: "b".repeat(64),
          newLibs: [
            { name: "x", sha256: "c", version: null, source: null, finalUrl: null, bytes: null },
          ],
        },
        null,
      ),
    ).toMatchObject({ kind: "needsOk", reason: "newLib" });
    expect(deckStatus({ ...pending, approvedDigest: "b".repeat(64) }, null)).toMatchObject({
      kind: "needsOk",
      reason: "changed",
    });
  });

  it("reports problems only for allowed code, and automatic updates", () => {
    expect(deckStatus(base, err)).toMatchObject({ kind: "problems", problems: 1 });
    expect(deckStatus({ ...base, approvalMode: "auto" }, { current: [] })).toMatchObject({
      kind: "interactive",
      auto: true,
    });
  });
});

describe("codeChanges", () => {
  it("pairs code by slide and keeps only what changed, in deck order", () => {
    const before = {
      sources: [
        { slideId: "a", index: 0, source: "x" },
        { slideId: "b", index: 2, source: "y" },
      ],
      deckSource: null,
    };
    const now = {
      sources: [
        { slideId: "b", index: 2, source: "y2" },
        { slideId: "a", index: 0, source: "x" },
        { slideId: "c", index: 3, source: "z" },
      ],
      deckSource: { source: "d" },
    };
    expect(codeChanges(before, now)).toEqual([
      { key: "deck", index: -1, before: null, now: "d" },
      { key: "b", index: 2, before: "y", now: "y2" },
      { key: "c", index: 3, before: null, now: "z" },
    ]);
  });
});
