// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract suites of the Clock and IdGenerator ports.
import { type Clock, type IdGenerator, isUlid, ulidTime } from "@pptaken/core";
import { describe, expect, it } from "vitest";

export function runIdGeneratorContract(name: string, factory: (clock: Clock) => IdGenerator): void {
  describe(`${name}: IdGenerator contract`, () => {
    it("returns canonical ULIDs carrying the clock time", () => {
      const ids = factory({ now: () => 1_700_000_000_123 });
      const id = ids.ulid();
      expect(isUlid(id)).toBe(true);
      expect(ulidTime(id)).toBe(1_700_000_000_123);
    });

    it("is unique and strictly increasing within the same millisecond", () => {
      const ids = factory({ now: () => 1_700_000_000_000 });
      const list = Array.from({ length: 2000 }, () => ids.ulid());
      expect(new Set(list).size).toBe(list.length);
      for (let i = 1; i < list.length; i++)
        expect((list[i] as string) > (list[i - 1] as string)).toBe(true);
    });

    it("stays increasing when the clock goes backwards", () => {
      let now = 1_700_000_000_500;
      const ids = factory({ now: () => now });
      const a = ids.ulid();
      now -= 100;
      const b = ids.ulid();
      expect(b > a).toBe(true);
    });
  });
}

export function runClockContract(name: string, factory: () => Clock): void {
  describe(`${name}: Clock contract`, () => {
    it("returns integer epoch milliseconds", () => {
      const now = factory().now();
      expect(Number.isSafeInteger(now)).toBe(true);
      expect(now).toBeGreaterThan(0);
    });
  });
}
