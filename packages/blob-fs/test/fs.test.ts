// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentPrincipal,
  createTestCore,
  makeSlideInputs,
  pngBytes,
  runBlobStoreContract,
} from "@pptaken/testing";
import { describe, expect, it } from "vitest";
import { openFsBlobStore } from "../src/index.js";

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), "pptaken-blob-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

runBlobStoreContract("blob-fs", async () => {
  const tmp = tempRoot();
  const store = await openFsBlobStore({ root: join(tmp.dir, "blobs") });
  return { store, cleanup: tmp.remove };
});

describe("blob-fs specifics", () => {
  it("lays blobs out by hash prefix and leaves no temporary files", async () => {
    const tmp = tempRoot();
    try {
      const store = await openFsBlobStore({ root: tmp.dir });
      const { sha256 } = await store.put(Uint8Array.of(1, 2, 3));
      expect(existsSync(join(tmp.dir, "sha256", sha256.slice(0, 2), sha256))).toBe(true);
      await store.putStream(
        (async function* () {
          yield Uint8Array.of(4);
          yield Uint8Array.of(5);
        })(),
      );
      await store.put(Uint8Array.of(9), { maxBytes: 0 }).catch(() => undefined);
      expect(readdirSync(join(tmp.dir, "tmp"))).toEqual([]);
    } finally {
      tmp.remove();
    }
  });

  it("uses owner-only permissions where the OS supports them", async () => {
    if (process.platform === "win32") return;
    const tmp = tempRoot();
    try {
      const store = await openFsBlobStore({ root: join(tmp.dir, "b") });
      const { sha256 } = await store.put(Uint8Array.of(7));
      expect(statSync(join(tmp.dir, "b")).mode & 0o777).toBe(0o700);
      expect(statSync(join(tmp.dir, "b", "sha256", sha256.slice(0, 2), sha256)).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      tmp.remove();
    }
  });

  it("enforces the store-wide size limit", async () => {
    const tmp = tempRoot();
    try {
      const store = await openFsBlobStore({ root: tmp.dir, maxBlobBytes: 4 });
      await expect(store.put(Uint8Array.of(1, 2, 3, 4, 5))).rejects.toMatchObject({
        code: "LIMIT_EXCEEDED",
      });
      await expect(
        store.put(Uint8Array.of(1, 2, 3, 4, 5), { maxBytes: 100 }),
      ).rejects.toMatchObject({
        code: "LIMIT_EXCEEDED",
      });
      expect((await store.put(Uint8Array.of(1, 2, 3, 4))).bytes).toBe(4);
    } finally {
      tmp.remove();
    }
  });

  it("ignores foreign files and sweeps stale temporary files at open", async () => {
    const tmp = tempRoot();
    try {
      const store = await openFsBlobStore({ root: tmp.dir });
      const { sha256 } = await store.put(Uint8Array.of(1));
      writeFileSync(join(tmp.dir, "sha256", sha256.slice(0, 2), "notes.txt"), "x");
      writeFileSync(join(tmp.dir, "sha256", "README"), "x");
      const stale = join(tmp.dir, "tmp", "old.part");
      writeFileSync(stale, "partial");
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(stale, old, old);
      writeFileSync(join(tmp.dir, "tmp", "fresh.part"), "partial");
      const listed = [];
      for await (const b of store.list()) listed.push(b.sha256);
      expect(listed).toEqual([sha256]);
      await openFsBlobStore({ root: tmp.dir });
      expect(readdirSync(join(tmp.dir, "tmp"))).toEqual(["fresh.part"]);
    } finally {
      tmp.remove();
    }
  });

  it("refreshes the modification time when existing content is put again", async () => {
    const tmp = tempRoot();
    try {
      const store = await openFsBlobStore({ root: tmp.dir });
      const { sha256 } = await store.put(Uint8Array.of(1, 2));
      const path = join(tmp.dir, "sha256", sha256.slice(0, 2), sha256);
      const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
      utimesSync(path, old, old);
      await store.put(Uint8Array.of(1, 2));
      expect(statSync(path).mtimeMs).toBeGreaterThan(old.getTime() + 1000);
    } finally {
      tmp.remove();
    }
  });

  it("works as the core's blob store", async () => {
    const tmp = tempRoot();
    try {
      const blobs = await openFsBlobStore({ root: tmp.dir });
      const t = createTestCore({ blobs });
      const agent = agentPrincipal();
      const { presentationId } = await t.core.createPresentation(agent, {
        title: "x",
        slides: makeSlideInputs(1),
      });
      const bytes = pngBytes(20, 10);
      const added = await t.core.addAsset(agent, { presentationId, bytes, mediaType: "image/png" });
      const got = await t.core.getAsset(agent, { ref: added.ref });
      expect(got.content).toEqual(bytes);
      expect(got.asset).toMatchObject({ width: 20, height: 10 });
    } finally {
      tmp.remove();
    }
  });
});
