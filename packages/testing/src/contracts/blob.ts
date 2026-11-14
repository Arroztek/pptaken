// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract suite of the BlobStore port.
import { type BlobStore, isDomainError, sha256Hex } from "@pptaken/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface BlobHarness {
  store: BlobStore;
  cleanup?: () => Promise<void> | void;
}

export type BlobFactory = () => Promise<BlobHarness> | BlobHarness;

const enc = (text: string) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

async function* chunks(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of stream) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function listAll(store: BlobStore) {
  const out = [];
  for await (const b of store.list()) out.push(b);
  return out.sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
}

export function runBlobStoreContract(name: string, factory: BlobFactory): void {
  describe(`${name}: BlobStore contract`, () => {
    let harness: BlobHarness | undefined;
    beforeEach(async () => {
      harness = await factory();
    });
    afterEach(async () => {
      await harness?.cleanup?.();
      harness = undefined;
    });
    const store = () => {
      if (harness === undefined) throw new Error("Blob harness not ready");
      return harness.store;
    };

    it("stores content under its SHA-256 and reads it back", async () => {
      const bytes = enc("hello blob");
      const put = await store().put(bytes);
      expect(put).toEqual({ sha256: sha256Hex(bytes), bytes: bytes.length });
      expect(await store().has(put.sha256)).toBe(true);
      expect(await store().get(put.sha256)).toEqual(bytes);
    });

    it("deduplicates identical content", async () => {
      const a = await store().put(enc("same"));
      const b = await store().put(enc("same"));
      expect(b.sha256).toBe(a.sha256);
      const listed = await listAll(store());
      expect(listed.map((x) => x.sha256)).toEqual([a.sha256]);
      expect(listed[0]?.bytes).toBe(4);
      expect(typeof listed[0]?.createdAt).toBe("number");
    });

    it("does not alias caller buffers", async () => {
      const bytes = enc("abc");
      const put = await store().put(bytes);
      bytes[0] = 0x7a;
      const read = await store().get(put.sha256);
      expect(read).toEqual(enc("abc"));
      if (read !== null) read[1] = 0x7a;
      expect(await store().get(put.sha256)).toEqual(enc("abc"));
    });

    it("handles empty and large blobs", async () => {
      const empty = await store().put(new Uint8Array(0));
      expect(empty.bytes).toBe(0);
      expect(await store().get(empty.sha256)).toEqual(new Uint8Array(0));
      const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
      const put = await store().put(big);
      expect(put.sha256).toBe(sha256Hex(big));
      expect(await store().get(put.sha256)).toEqual(big);
    });

    it("deletes", async () => {
      const put = await store().put(enc("bye"));
      expect(await store().delete(put.sha256)).toBe(true);
      expect(await store().has(put.sha256)).toBe(false);
      expect(await store().get(put.sha256)).toBeNull();
      expect(await store().delete(put.sha256)).toBe(false);
    });

    it("treats unknown and malformed keys as absent (no path traversal)", async () => {
      const keys = [
        "0".repeat(64),
        "../../etc/passwd",
        "..\\..\\windows\\win.ini",
        "A".repeat(64),
        "abc",
        `${"a".repeat(64)}/../x`,
        "",
      ];
      for (const key of keys) {
        expect(await store().get(key)).toBeNull();
        expect(await store().has(key)).toBe(false);
        expect(await store().delete(key)).toBe(false);
        expect(await store().getStream(key)).toBeNull();
      }
    });

    it("enforces maxBytes and stores nothing when it is exceeded", async () => {
      const bytes = enc("0123456789");
      const failure = await store()
        .put(bytes, { maxBytes: 5 })
        .catch((e: unknown) => e);
      expect(isDomainError(failure) && failure.code).toBe("LIMIT_EXCEEDED");
      expect(await store().has(sha256Hex(bytes))).toBe(false);
      const streamFailure = await store()
        .putStream(chunks(enc("01234"), enc("56789")), { maxBytes: 7 })
        .catch((e: unknown) => e);
      expect(isDomainError(streamFailure) && streamFailure.code).toBe("LIMIT_EXCEEDED");
      expect(await listAll(store())).toEqual([]);
    });

    it("streams in and out", async () => {
      const parts = [enc("stream "), enc("in "), enc("parts")];
      const put = await store().putStream(chunks(...parts));
      const whole = enc("stream in parts");
      expect(put).toEqual({ sha256: sha256Hex(whole), bytes: whole.length });
      const stream = await store().getStream(put.sha256);
      if (stream === null) throw new Error("missing");
      expect(await collect(stream)).toEqual(whole);
    });

    it("survives concurrent writes of the same content", async () => {
      const bytes = new Uint8Array(256 * 1024).fill(9);
      const results = await Promise.all([1, 2, 3, 4].map(() => store().put(bytes)));
      expect(new Set(results.map((r) => r.sha256)).size).toBe(1);
      expect(await store().get(sha256Hex(bytes))).toEqual(bytes);
      expect(await listAll(store())).toHaveLength(1);
    });
  });
}
