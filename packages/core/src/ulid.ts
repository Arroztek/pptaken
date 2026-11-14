// SPDX-License-Identifier: AGPL-3.0-or-later
// ULID (https://github.com/ulid/spec): 48-bit millisecond timestamp + 80 random bits, Crockford base32, 26 chars.
// Implemented here (about 60 lines) instead of adding a dependency; the random source is injected so the core
// stays free of platform APIs.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;

/** Matches a canonical ULID (uppercase Crockford base32, first character 0-7). */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/** Fills and returns `n` random bytes. Production: `(n) => crypto.getRandomValues(new Uint8Array(n))`. */
export type RandomSource = (n: number) => Uint8Array;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME)
    throw new RangeError("ULID time out of range");
  let out = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** 80 bits as 16 base32 digits (5 bits each), most significant first. */
function encodeRandom(digits: number[]): string {
  return digits.map((d) => ALPHABET[d]).join("");
}

function randomDigits(random: RandomSource): number[] {
  const bytes = random(10);
  if (bytes.length < 10) throw new RangeError("Random source returned too few bytes");
  // 80 bits -> 16 groups of 5 bits.
  const digits: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < 10; i++) {
    acc = (acc << 8) | (bytes[i] as number);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      digits.push((acc >> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  return digits;
}

/** Adds one to the random part; returns false on overflow. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i] as number;
    if (d < 31) {
      digits[i] = d + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/**
 * Creates a ULID factory that is monotonic within the same millisecond (and when the clock goes backwards, it
 * keeps using the last timestamp), so ids sort in creation order inside one process.
 */
export function createUlidFactory(now: () => number, random: RandomSource): () => string {
  let lastTime = Number.NEGATIVE_INFINITY;
  let lastDigits: number[] = [];
  return () => {
    let time = now();
    if (time <= lastTime) {
      time = lastTime;
      if (!increment(lastDigits)) {
        // 2^80 ids in one millisecond: move to the next millisecond rather than repeat an id.
        time = lastTime + 1;
        lastDigits = randomDigits(random);
      }
    } else {
      lastDigits = randomDigits(random);
    }
    lastTime = time;
    return encodeTime(time) + encodeRandom(lastDigits);
  };
}

/** Decodes the timestamp (epoch ms) of a ULID. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new RangeError("Not a ULID");
  let t = 0;
  for (let i = 0; i < 10; i++) t = t * 32 + ALPHABET.indexOf(id[i] as string);
  return t;
}
