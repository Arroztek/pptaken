// SPDX-License-Identifier: AGPL-3.0-or-later
// The instance secret (`secret.key`, 256 bits): generated at first start in the data directory with mode 0600,
// or injected through the environment (a hex/base64 value, or a file such as a Docker secret). Subkeys for each
// purpose are derived with HKDF (see crypto.ts `deriveKey`).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SECRET_KEY_FILE = "secret.key";
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const B64_32 = /^[A-Za-z0-9+/_-]{43}=?$/;

export class SecretKeyError extends Error {
  override readonly name = "SecretKeyError";
}

/** Parses a 256-bit key written as 64 hex characters or 43/44 base64(url) characters. */
export function parseSecretKey(text: string): Buffer {
  const value = text.trim();
  if (HEX_64.test(value)) return Buffer.from(value, "hex");
  if (B64_32.test(value)) {
    const bytes = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (bytes.length === 32) return bytes;
  }
  throw new SecretKeyError(
    "The secret key must be 256 bits written as 64 hex characters (or 43 base64 characters)",
  );
}

export interface LoadSecretKeyOptions {
  dataDir: string;
  /** Key value from the environment (`PPTAKEN_SECRET_KEY`). Wins over the file. */
  value?: string | undefined;
  /** Path of a file holding the key (`PPTAKEN_SECRET_KEY_FILE`, e.g. a Docker secret). */
  file?: string | undefined;
}

export interface LoadedSecretKey {
  key: Buffer;
  source: "env" | "file" | "data-dir" | "generated";
}

/**
 * Loads the instance secret, generating `<dataDir>/secret.key` (mode 0600, exclusive create) on first start.
 * Never logs or returns the key in any form other than the buffer.
 */
export function loadOrCreateSecretKey(options: LoadSecretKeyOptions): LoadedSecretKey {
  if (options.value !== undefined && options.value !== "") {
    return { key: parseSecretKey(options.value), source: "env" };
  }
  if (options.file !== undefined && options.file !== "") {
    return { key: parseSecretKey(readFileSync(options.file, "utf8")), source: "file" };
  }
  const path = join(options.dataDir, SECRET_KEY_FILE);
  if (existsSync(path)) {
    const stat = statSync(path);
    if (!stat.isFile()) throw new SecretKeyError(`${path} is not a regular file`);
    return { key: parseSecretKey(readFileSync(path, "utf8")), source: "data-dir" };
  }
  const key = randomBytes(32);
  // `wx`: fail if another process created it meanwhile instead of overwriting a key in use.
  writeFileSync(path, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort (Windows ignores POSIX modes).
  }
  return { key, source: "generated" };
}
