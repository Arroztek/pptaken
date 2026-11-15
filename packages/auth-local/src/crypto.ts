// SPDX-License-Identifier: AGPL-3.0-or-later
// Small, boring crypto helpers on node:crypto. Every comparison of secret-derived values is constant-time.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** `n` random bytes as base64url without padding (32 bytes → 43 characters). */
export function randomBase64Url(n: number): string {
  return randomBytes(n).toString("base64url");
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacHex(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

export function hmacBase64Url(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("base64url");
}

/**
 * Constant-time string comparison. Both values are hashed first, so the comparison time does not depend on the
 * lengths or on where they differ.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Purposes of the keys derived from `secret.key`. Never reuse a purpose for two different uses. */
export type KeyPurpose =
  | "content-token"
  | "install-code"
  | "csrf"
  | "audience-identity"
  | "generic";

/** HKDF-SHA256 subkey of the instance secret for one purpose (32 bytes). */
export function deriveKey(secret: Uint8Array, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "pptaken/v1", `pptaken:${purpose}`, 32));
}
