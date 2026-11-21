// SPDX-License-Identifier: AGPL-3.0-or-later
// Public-link secrets (ADR-026): 128 random bits written as 22 base64url characters, looked up by a keyed hash and
// kept in a second, encrypted form so the owner's panel can show the link again.
//
// - The lookup key is HMAC-SHA256 under the `share-link-lookup` subkey of the instance secret: a stolen database
//   alone cannot be used to test guesses offline (not that 128 bits could be guessed), and the value is a stable
//   index for a single equality lookup.
// - The recoverable copy is AES-256-GCM under the `share-link-seal` subkey, with a random 96-bit nonce and the link id
//   as additional data, so a sealed value cannot be moved to another row.
// - Rotating the instance secret (`secret.key`) changes both subkeys: every existing link stops working and the panel
//   can no longer show it. That is the intended story: a rotation is a "turn everything off" button.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constantTimeEqual, deriveKey, hmacHex } from "./crypto.js";

/** 128 bits as unpadded base64url. */
export const SHARE_SECRET_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SEALED_PATTERN = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,80}$/;

/** The secret operations the core's share-link use cases need (the `ShareLinkSecrets` port). */
export interface ShareSecrets {
  /** A new secret: 16 bytes from the CSPRNG, base64url (22 characters). */
  generate(): string;
  /** The lookup key of a secret (64 hex characters). Works on any input, in time independent of its validity. */
  hash(secret: string): string;
  /** Constant-time comparison of two lookup keys. */
  matches(a: string, b: string): boolean;
  /** The recoverable copy of `secret`, bound to `linkId`. */
  seal(secret: string, linkId: string): string;
  /** The secret back from its sealed copy, or `null` when it cannot be opened (another key, another row, damage). */
  open(sealed: string, linkId: string): string | null;
}

/** Builds the share-link secret operations over the instance secret (HKDF subkeys, never the secret itself). */
export function createShareSecrets(instanceSecret: Uint8Array): ShareSecrets {
  const lookupKey = deriveKey(instanceSecret, "share-link-lookup");
  const sealKey = deriveKey(instanceSecret, "share-link-seal");
  return {
    generate: () => randomBytes(16).toString("base64url"),
    hash: (secret) => hmacHex(lookupKey, `share-link|${secret}`),
    matches: (a, b) => constantTimeEqual(a, b),
    seal(secret, linkId) {
      if (!SHARE_SECRET_PATTERN.test(secret)) throw new TypeError("not a share-link secret");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", sealKey, iv);
      cipher.setAAD(Buffer.from(`share-link|${linkId}`, "utf8"));
      const body = Buffer.concat([
        cipher.update(secret, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return `v1.${iv.toString("base64url")}.${body.toString("base64url")}`;
    },
    open(sealed, linkId) {
      if (typeof sealed !== "string" || !SEALED_PATTERN.test(sealed)) return null;
      const [, ivText, bodyText] = sealed.split(".") as [string, string, string];
      const iv = Buffer.from(ivText, "base64url");
      const body = Buffer.from(bodyText, "base64url");
      if (iv.length !== 12 || body.length < 17) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", sealKey, iv);
        decipher.setAAD(Buffer.from(`share-link|${linkId}`, "utf8"));
        decipher.setAuthTag(body.subarray(body.length - 16));
        const secret = Buffer.concat([
          decipher.update(body.subarray(0, body.length - 16)),
          decipher.final(),
        ]).toString("utf8");
        return SHARE_SECRET_PATTERN.test(secret) ? secret : null;
      } catch {
        return null;
      }
    },
  };
}
