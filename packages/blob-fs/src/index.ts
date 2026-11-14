// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/blob-fs: the core's BlobStore port on the local file system.
//
// Layout under `root` (one volume, so renames are atomic):
//   sha256/<first 2 hex>/<64 hex>   blobs, immutable, mode 0600
//   tmp/<random>.part               writes in progress, renamed into place when complete
// Keys are validated against /^[0-9a-f]{64}$/ before any path is built, so no key can address anything else.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, readdir, readFile, rename, rm, stat, unlink, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type BlobInfo,
  type BlobPutOptions,
  type BlobPutResult,
  type BlobStore,
  limitExceeded,
} from "@pptaken/core";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PREFIX = /^[0-9a-f]{2}$/;

export interface FsBlobStoreOptions {
  /** Root directory (created with mode 0700 if missing). */
  root: string;
  /** Store-wide size limit applied to every write, in addition to the per-call `maxBytes`. */
  maxBlobBytes?: number;
  /** Temporary files older than this are deleted at open (crash leftovers). Default 1 hour. */
  staleTempMs?: number;
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function view(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** File-system {@link BlobStore}: content-addressed, atomic writes, owner-only permissions where supported. */
export class FsBlobStore implements BlobStore {
  readonly root: string;
  private readonly blobsDir: string;
  private readonly tmpDir: string;
  private readonly maxBlobBytes: number | undefined;

  private constructor(options: FsBlobStoreOptions) {
    this.root = resolve(options.root);
    this.blobsDir = join(this.root, "sha256");
    this.tmpDir = join(this.root, "tmp");
    this.maxBlobBytes = options.maxBlobBytes;
  }

  /** Creates the directories if needed and removes stale temporary files. */
  static async open(options: FsBlobStoreOptions): Promise<FsBlobStore> {
    const store = new FsBlobStore(options);
    for (const dir of [store.root, store.blobsDir, store.tmpDir])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    await store.sweepTemp(options.staleTempMs ?? 60 * 60 * 1000);
    return store;
  }

  private pathOf(sha256: string): string {
    return join(this.blobsDir, sha256.slice(0, 2), sha256);
  }

  private limit(options: BlobPutOptions): number | undefined {
    const limits = [options.maxBytes, this.maxBlobBytes].filter(
      (n): n is number => n !== undefined,
    );
    return limits.length === 0 ? undefined : Math.min(...limits);
  }

  async put(bytes: Uint8Array, options: BlobPutOptions = {}): Promise<BlobPutResult> {
    const max = this.limit(options);
    if (max !== undefined && bytes.length > max) {
      throw limitExceeded("Blob too large", max, bytes.length, { unit: "bytes" });
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (await this.touch(this.pathOf(sha256))) return { sha256, bytes: bytes.length };
    return this.putStream(
      (async function* () {
        yield bytes;
      })(),
      options,
    );
  }

  async putStream(
    chunks: AsyncIterable<Uint8Array>,
    options: BlobPutOptions = {},
  ): Promise<BlobPutResult> {
    const max = this.limit(options);
    const temp = join(this.tmpDir, `${randomBytes(12).toString("hex")}.part`);
    const hash = createHash("sha256");
    let total = 0;
    const handle = await open(temp, "wx", 0o600);
    let moved = false;
    try {
      for await (const chunk of chunks) {
        total += chunk.length;
        if (max !== undefined && total > max) {
          throw limitExceeded("Blob too large", max, total, { unit: "bytes" });
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      const sha256 = hash.digest("hex");
      const target = this.pathOf(sha256);
      if (await this.touch(target)) return { sha256, bytes: total };
      mkdirSync(join(this.blobsDir, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
      try {
        await rename(temp, target);
        moved = true;
      } catch (error) {
        // A concurrent writer may have put the same content first (Windows refuses to replace an open file).
        if (!(await this.touch(target))) throw error;
      }
      return { sha256, bytes: total };
    } finally {
      await handle.close().catch(() => undefined);
      if (!moved) await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  /** Refreshes the modification time of an existing blob (the garbage collector's grace period); false if absent. */
  private async touch(path: string): Promise<boolean> {
    try {
      const now = new Date();
      await utimes(path, now, now);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    try {
      return view(await readFile(this.pathOf(sha256)));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async getStream(sha256: string): Promise<AsyncIterable<Uint8Array> | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.pathOf(sha256), "r");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    return (async function* () {
      try {
        for (;;) {
          const buffer = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) return;
          yield view(buffer.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    })();
  }

  async has(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    try {
      return (await stat(this.pathOf(sha256))).isFile();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async delete(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) return false;
    try {
      await unlink(this.pathOf(sha256));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async *list(): AsyncIterable<BlobInfo> {
    const prefixes = (await readdir(this.blobsDir)).filter((p) => PREFIX.test(p)).sort();
    for (const prefix of prefixes) {
      let names: string[];
      try {
        names = await readdir(join(this.blobsDir, prefix));
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const name of names.sort()) {
        if (!SHA256_HEX.test(name) || !name.startsWith(prefix)) continue;
        try {
          const info = await stat(join(this.blobsDir, prefix, name));
          if (info.isFile())
            yield { sha256: name, bytes: info.size, createdAt: Math.floor(info.mtimeMs) };
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    }
  }

  /** Deletes temporary files older than `olderThanMs`; returns how many were deleted. */
  async sweepTemp(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    let n = 0;
    for (const name of await readdir(this.tmpDir)) {
      const path = join(this.tmpDir, name);
      try {
        if ((await stat(path)).mtimeMs <= cutoff) {
          await rm(path, { force: true });
          n++;
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return n;
  }
}

/** Opens a {@link FsBlobStore}. */
export function openFsBlobStore(options: FsBlobStoreOptions): Promise<FsBlobStore> {
  return FsBlobStore.open(options);
}
