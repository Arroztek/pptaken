// SPDX-License-Identifier: Apache-2.0
// Small pure helpers with an injected clock: a single token bucket (per connection and message kind: navigation
// 10/s, pointer 30/s) and the reconnect backoff (250 ms .. 5 s with jitter).

/** A token bucket: `capacity` burst, refilled at `perSecond`. Excess is refused (the caller drops it silently). */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    now: number,
  ) {
    if (capacity < 1 || perSecond <= 0) throw new RangeError("invalid bucket");
    this.tokens = capacity;
    this.at = now;
  }

  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.at);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.perSecond) / 1000);
    this.at = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Per-connection rates of the remote protocol (security §7). */
export const RATES = {
  /** cmd and goto from a remote. */
  nav: { capacity: 10, perSecond: 10 },
  /** pointer and pointer-off from a remote. */
  pointer: { capacity: 30, perSecond: 30 },
  /** state from the screen (a held key repeats fast; the newest state wins anyway). */
  state: { capacity: 40, perSecond: 40 },
  /** ping from anyone. */
  ping: { capacity: 3, perSecond: 1 },
} as const;

export const BACKOFF_MIN_MS = 250;
export const BACKOFF_MAX_MS = 5000;

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential from 250 ms, capped at 5 s, with jitter in
 * `[50 %, 100 %]` of the step so that many clients do not reconnect in lockstep. `random` is in `[0, 1)`.
 */
export function backoffDelay(attempt: number, random: number): number {
  const step = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
  const r = Math.min(Math.max(random, 0), 0.999999);
  return Math.max(BACKOFF_MIN_MS, Math.round(step * (0.5 + r * 0.5)));
}

/** App-level keepalive: a ping every 10 s; two missed pongs mean the connection is dead. */
export const PING_INTERVAL_MS = 10_000;
export const PING_MISSES = 2;
/** The server closes a socket that has not authenticated within this time. */
export const AUTH_TIMEOUT_MS = 5000;
