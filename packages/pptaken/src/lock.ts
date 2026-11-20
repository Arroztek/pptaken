// SPDX-License-Identifier: AGPL-3.0-or-later
// One running PPTaken per data folder: a second `npx pptaken` in another terminal would otherwise start on the next
// free port against the same database. The lock file holds the process id and the address; a lock whose process
// is gone is stale and replaced.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = "pptaken.lock";

export interface LockInfo {
  pid: number;
  url: string;
  startedAt: string;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock of another live PPTaken process using this folder, or null. */
export function readLiveLock(dataDir: string, alive = isProcessAlive): LockInfo | null {
  let info: LockInfo;
  try {
    info = JSON.parse(readFileSync(join(dataDir, LOCK_FILE), "utf8")) as LockInfo;
  } catch {
    return null;
  }
  if (typeof info?.pid !== "number" || info.pid === process.pid) return null;
  return alive(info.pid) ? info : null;
}

export function writeLock(dataDir: string, url: string): () => void {
  const path = join(dataDir, LOCK_FILE);
  const info: LockInfo = { pid: process.pid, url, startedAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  return () => {
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
      if (current.pid === process.pid) rmSync(path, { force: true });
    } catch {
      // Already gone.
    }
  };
}
