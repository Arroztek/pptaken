// SPDX-License-Identifier: AGPL-3.0-or-later
// ADR-026: public-link secrets. 128 CSPRNG bits as 22 base64url characters; a keyed lookup hash; an AES-256-GCM
// sealed copy bound to the link id; a rotated instance secret opens nothing and matches nothing.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createShareSecrets, SHARE_SECRET_PATTERN } from "../src/share-secrets.js";

const key = randomBytes(32);
const secrets = createShareSecrets(key);

describe("share-link secrets", () => {
  it("are 22 base64url characters carrying 128 random bits", () => {
    const seen = new Set<string>();
    const bitCounts = new Array(128).fill(0) as number[];
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const s = secrets.generate();
      expect(s).toMatch(SHARE_SECRET_PATTERN);
      seen.add(s);
      const bytes = Buffer.from(s, "base64url");
      expect(bytes).toHaveLength(16);
      for (let b = 0; b < 128; b++) {
        if ((bytes[b >> 3] as number) & (1 << (b & 7))) bitCounts[b] = (bitCounts[b] as number) + 1;
      }
    }
    expect(seen.size).toBe(N);
    // Every bit position is set about half the time (a broken generator fails this by far).
    for (const count of bitCounts) {
      expect(count).toBeGreaterThan(N * 0.4);
      expect(count).toBeLessThan(N * 0.6);
    }
  });

  it("hash: stable, keyed, 64 hex characters, compared in constant time", () => {
    const s = secrets.generate();
    const h = secrets.hash(s);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.hash(s)).toBe(h);
    expect(secrets.hash(secrets.generate())).not.toBe(h);
    expect(createShareSecrets(randomBytes(32)).hash(s)).not.toBe(h);
    expect(secrets.matches(h, h)).toBe(true);
    expect(secrets.matches(h, secrets.hash("x"))).toBe(false);
    // Any input hashes (the guest route hashes a decoy for malformed secrets).
    expect(secrets.hash("")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("seal/open: round trip, bound to the link id, refuses tampering and another key", () => {
    const s = secrets.generate();
    const sealed = secrets.seal(s, "01J0000000000000000000000A");
    expect(sealed).not.toContain(s);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(secrets.open(sealed, "01J0000000000000000000000A")).toBe(s);
    // Two seals of the same secret differ (random nonce).
    expect(secrets.seal(s, "01J0000000000000000000000A")).not.toBe(sealed);
    expect(secrets.open(sealed, "01J0000000000000000000000B")).toBeNull();
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}${sealed.slice(-1)}`;
    expect(secrets.open(flipped, "01J0000000000000000000000A")).toBeNull();
    expect(secrets.open("garbage", "01J0000000000000000000000A")).toBeNull();
    // Key rotation: the panel can no longer show the link.
    expect(
      createShareSecrets(randomBytes(32)).open(sealed, "01J0000000000000000000000A"),
    ).toBeNull();
    expect(() => secrets.seal("not a secret", "x")).toThrow();
  });
});
