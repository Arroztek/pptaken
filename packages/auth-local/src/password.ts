// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner password: policy and hashing. Hashing uses scrypt from node:crypto (no native dependency). Node 22, the
// runtime of the container image, has no Argon2id in node:crypto (`crypto.argon2` appeared in Node 24.7), so
// scrypt with the OWASP-recommended parameters is the choice; the stored string carries its parameters, so a
// later switch to Argon2id can verify old hashes and rehash on the next sign-in.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isCommonPassword } from "./common-passwords.js";

export interface ScryptParams {
  /** log2 of the CPU/memory cost N. */
  ln: number;
  r: number;
  p: number;
}

/** OWASP Password Storage Cheat Sheet: N = 2^17, r = 8, p = 1 (128 MiB, ~0.3 s on a laptop). */
export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({ ln: 17, r: 8, p: 1 });

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const FORMAT =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{22,}={0,2})\$([A-Za-z0-9+/]{43,}={0,2})$/;

export const MIN_PASSWORD_LENGTH = 12;
/** Upper bound so that hashing cost does not depend on attacker-chosen huge inputs. */
export const MAX_PASSWORD_LENGTH = 1024;

function checkParams(params: ScryptParams): void {
  if (
    params.ln < 10 ||
    params.ln > 20 ||
    params.r < 1 ||
    params.r > 32 ||
    params.p < 1 ||
    params.p > 16
  ) {
    throw new RangeError("scrypt parameters out of the accepted range");
  }
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.ln;
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFC"),
      salt,
      KEY_LENGTH,
      { N, r: params.r, p: params.p, maxmem: 128 * N * params.r * params.p + 32 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Hashes a password with a fresh 128-bit salt: `$scrypt$ln=17,r=8,p=1$<salt b64>$<hash b64>`. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  checkParams(params);
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Verifies a password against a stored hash in constant time. A malformed hash never verifies. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const m = FORMAT.exec(stored);
  if (m === null) return false;
  const params = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  try {
    checkParams(params);
  } catch {
    return false;
  }
  const salt = Buffer.from(m[4] as string, "base64");
  const expected = Buffer.from(m[5] as string, "base64");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt, params);
  return timingSafeEqual(actual, expected);
}

/** True when the stored hash uses weaker parameters than `params` (rehash after a successful sign-in). */
export function needsRehash(stored: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): boolean {
  const m = FORMAT.exec(stored);
  if (m === null) return true;
  return Number(m[1]) < params.ln || Number(m[2]) < params.r || Number(m[3]) < params.p;
}

export type PasswordProblem = "too_short" | "too_long" | "common" | "repetitive";

export interface PasswordCheck {
  ok: boolean;
  problem?: PasswordProblem;
  /** Human-readable English explanation for the `hint` of a `VALIDATION_ERROR`. */
  hint?: string;
}

/** The password policy: at least 12 characters, at most 1024, not common, not a single repeated character. */
export function checkPasswordPolicy(password: unknown): PasswordCheck {
  if (typeof password !== "string") {
    return { ok: false, problem: "too_short", hint: "Use at least 12 characters." };
  }
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      problem: "too_short",
      hint: `Use at least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words make a strong, memorable password.`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      problem: "too_long",
      hint: `Use at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  if (new Set(password.toLowerCase()).size <= 2) {
    return {
      ok: false,
      problem: "repetitive",
      hint: "Avoid repeating the same characters. A few unrelated words make a strong, memorable password.",
    };
  }
  if (isCommonPassword(password)) {
    return {
      ok: false,
      problem: "common",
      hint: "This password is too common. A few unrelated words make a strong, memorable password.",
    };
  }
  return { ok: true };
}
