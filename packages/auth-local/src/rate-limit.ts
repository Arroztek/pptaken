// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory token buckets (security §7) and the sign-in throttle (per IP and global, with an increasing delay
// after failures). Time comes from an injected clock, so tests drive it with a fake clock.

export interface RateClock {
  now(): number;
}

export interface RateDecision {
  ok: boolean;
  /** Milliseconds until the request would be allowed (0 when `ok`). */
  retryAfterMs: number;
}

export interface TokenBucketOptions {
  /** Maximum burst. */
  capacity: number;
  /** Tokens added per `intervalMs` (refilled continuously). */
  refill: number;
  intervalMs: number;
  clock: RateClock;
  /** Upper bound on tracked keys (memory guard); the oldest full buckets are dropped first. Default 10,000. */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** A set of token buckets, one per key (IP, token id…). */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMs: number;
  private readonly maxKeys: number;

  constructor(private readonly options: TokenBucketOptions) {
    if (options.capacity < 1 || options.refill <= 0 || options.intervalMs <= 0) {
      throw new RangeError("Invalid token bucket options");
    }
    this.perMs = options.refill / options.intervalMs;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  private bucket(key: string): Bucket {
    const now = this.options.clock.now();
    let b = this.buckets.get(key);
    if (b === undefined) {
      if (this.buckets.size >= this.maxKeys) this.evict(now);
      b = { tokens: this.options.capacity, at: now };
      this.buckets.set(key, b);
    } else {
      const elapsed = Math.max(0, now - b.at);
      b.tokens = Math.min(this.options.capacity, b.tokens + elapsed * this.perMs);
      b.at = now;
    }
    return b;
  }

  private evict(now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.at) * this.perMs >= this.options.capacity) this.buckets.delete(key);
    }
    // Still full of active keys: drop the oldest entries (Map keeps insertion order).
    while (this.buckets.size >= this.maxKeys) {
      const first = this.buckets.keys().next();
      if (first.done) break;
      this.buckets.delete(first.value);
    }
  }

  /** Takes `cost` tokens if available. */
  take(key: string, cost = 1): RateDecision {
    const b = this.bucket(key);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, retryAfterMs: 0 };
    }
    return { ok: false, retryAfterMs: Math.ceil((cost - b.tokens) / this.perMs) };
  }

  /** Whether `cost` tokens are available, without taking them. */
  peek(key: string, cost = 1): RateDecision {
    const b = this.bucket(key);
    if (b.tokens >= cost) return { ok: true, retryAfterMs: 0 };
    return { ok: false, retryAfterMs: Math.ceil((cost - b.tokens) / this.perMs) };
  }

  /** Number of tracked keys (tests, metrics). */
  get size(): number {
    return this.buckets.size;
  }
}

export interface SignInThrottleOptions {
  clock: RateClock;
  /** Attempts per IP per minute (default 5, security §7). */
  perIpPerMinute?: number;
  /** Failed attempts allowed instance-wide per 10 minutes before every IP is paused (default 50). */
  globalFailuresPer10Min?: number;
  /** Failures (per IP) before the increasing delay starts (default 3). */
  delayAfterFailures?: number;
  /** Cap of the increasing delay (default 15 minutes). */
  maxDelayMs?: number;
  /** Failures are forgotten after this long without a new failure (default 1 hour). */
  forgetAfterMs?: number;
}

interface FailureState {
  count: number;
  last: number;
}

/**
 * Sign-in and setup throttle. `check(ip)` before verifying the password (it consumes one attempt from the per-IP
 * bucket), then `fail(ip)` or `succeed(ip)`. After `delayAfterFailures` consecutive failures from an IP the next
 * attempt must wait 1 s, then 2 s, 4 s… up to `maxDelayMs`. The global bucket only counts failures, so the owner
 * can still sign in unless there is an ongoing, distributed guessing attack.
 */
export class SignInThrottle {
  private readonly perIp: TokenBucketLimiter;
  private readonly globalFailures: TokenBucketLimiter;
  private readonly failures = new Map<string, FailureState>();
  private readonly delayAfter: number;
  private readonly maxDelayMs: number;
  private readonly forgetAfterMs: number;

  constructor(private readonly options: SignInThrottleOptions) {
    const perIp = options.perIpPerMinute ?? 5;
    const global = options.globalFailuresPer10Min ?? 50;
    this.perIp = new TokenBucketLimiter({
      capacity: perIp,
      refill: perIp,
      intervalMs: 60_000,
      clock: options.clock,
    });
    this.globalFailures = new TokenBucketLimiter({
      capacity: global,
      refill: global,
      intervalMs: 600_000,
      clock: options.clock,
    });
    this.delayAfter = options.delayAfterFailures ?? 3;
    this.maxDelayMs = options.maxDelayMs ?? 15 * 60_000;
    this.forgetAfterMs = options.forgetAfterMs ?? 60 * 60_000;
  }

  /** Delay imposed after `count` consecutive failures. */
  delayFor(count: number): number {
    if (count < this.delayAfter) return 0;
    return Math.min(this.maxDelayMs, 1000 * 2 ** (count - this.delayAfter));
  }

  check(ip: string): RateDecision {
    const now = this.options.clock.now();
    const f = this.failures.get(ip);
    if (f !== undefined) {
      if (now - f.last > this.forgetAfterMs) this.failures.delete(ip);
      else {
        const until = f.last + this.delayFor(f.count);
        if (now < until) return { ok: false, retryAfterMs: until - now };
      }
    }
    const global = this.globalFailures.peek("*");
    if (!global.ok) return global;
    return this.perIp.take(ip);
  }

  fail(ip: string): void {
    const now = this.options.clock.now();
    const f = this.failures.get(ip);
    if (f === undefined || now - f.last > this.forgetAfterMs) {
      if (this.failures.size >= 10_000)
        this.failures.delete(this.failures.keys().next().value as string);
      this.failures.set(ip, { count: 1, last: now });
    } else {
      f.count++;
      f.last = now;
    }
    this.globalFailures.take("*");
  }

  succeed(ip: string): void {
    this.failures.delete(ip);
  }
}
