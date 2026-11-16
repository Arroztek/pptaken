// SPDX-License-Identifier: AGPL-3.0-or-later
// Maintenance commands run inside the container: `pptaken reset-password` and `pptaken backup <dir>`.
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import {
  AuthError,
  createLocalAuth,
  createOAuthService,
  loadOrCreateSecretKey,
} from "@pptaken/auth-local";
import { createUlidGenerator } from "@pptaken/core";
import {
  createSqliteAuthStore,
  createSqliteOAuthStore,
  openSqliteStorage,
} from "@pptaken/storage-sqlite";
import type { ServerConfig } from "./config.js";

/** Reads one line from stdin; on a terminal the typed characters are not echoed. */
async function readSecretLine(prompt: string): Promise<string> {
  const tty = process.stdin.isTTY === true;
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: tty });
  if (tty) process.stderr.write(prompt);
  muted = tty;
  try {
    const line = await new Promise<string>((resolveLine, reject) => {
      rl.once("line", resolveLine);
      rl.once("close", () => reject(new Error("No password given on standard input")));
    });
    if (tty) process.stderr.write("\n");
    return line;
  } finally {
    rl.close();
  }
}

export async function resetPassword(config: ServerConfig): Promise<number> {
  const db = join(config.dataDir, "pptaken.db");
  if (!existsSync(db)) {
    process.stderr.write(`No database at ${db}. Check PPTAKEN_DATA_DIR.\n`);
    return 1;
  }
  const password = await readSecretLine("New owner password (at least 12 characters): ");
  if (process.stdin.isTTY === true) {
    const again = await readSecretLine("Repeat it: ");
    if (again !== password) {
      process.stderr.write("The passwords do not match. Nothing changed.\n");
      return 1;
    }
  }
  const secret = loadOrCreateSecretKey({
    dataDir: config.dataDir,
    value: config.secretKey,
    file: config.secretKeyFile,
  });
  const storage = openSqliteStorage({ filename: db });
  try {
    const ids = createUlidGenerator((n) => new Uint8Array(randomBytes(n)));
    // A reset always disconnects every OAuth application too (ADR-0018): whoever needed a reset may have lost
    // control of the account. The issuer is irrelevant for revocation.
    const oauth = createOAuthService({ store: createSqliteOAuthStore(storage), ids, issuer: null });
    const auth = createLocalAuth({
      store: createSqliteAuthStore(storage),
      secret: secret.key,
      ids,
      oauth,
    });
    const disconnected = await auth.resetPassword(password);
    process.stderr.write(
      `Password changed. Every session was signed out and ${disconnected} connected application(s) were disconnected.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof AuthError) {
      process.stderr.write(`${error.message}${error.hint ? `: ${error.hint}` : ""}\n`);
      return 1;
    }
    throw error;
  } finally {
    await storage.close();
  }
}

/**
 * Writes `<target>/pptaken.db` (a consistent online copy, SQLite `VACUUM INTO`) and `<target>/blobs/` (a copy of
 * the content-addressed blobs). The target directory must not exist. The instance secret is not copied: nothing
 * stored depends on it (password hashes and token hashes do not; content tokens are short-lived).
 */
export async function backup(config: ServerConfig, target: string | undefined): Promise<number> {
  if (target === undefined || target === "") {
    process.stderr.write("Usage: pptaken backup <new directory>\n");
    return 1;
  }
  const dir = resolve(target);
  if (existsSync(dir)) {
    process.stderr.write(`${dir} already exists. Choose a new directory.\n`);
    return 1;
  }
  const db = join(config.dataDir, "pptaken.db");
  if (!existsSync(db)) {
    process.stderr.write(`No database at ${db}. Check PPTAKEN_DATA_DIR.\n`);
    return 1;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const storage = openSqliteStorage({ filename: db });
  try {
    await storage.backup(join(dir, "pptaken.db"));
  } finally {
    await storage.close();
  }
  const blobs = join(config.dataDir, "blobs");
  if (existsSync(join(blobs, "sha256"))) {
    // Blobs are immutable and written atomically (temp file + rename), so a plain copy is consistent; skip temp files.
    cpSync(join(blobs, "sha256"), join(dir, "blobs", "sha256"), { recursive: true });
  }
  process.stderr.write(`Backup written to ${dir} (pptaken.db and blobs/).\n`);
  return 0;
}
