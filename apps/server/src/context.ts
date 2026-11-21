// SPDX-License-Identifier: AGPL-3.0-or-later
// What every route module receives from the composition root.
import type {
  LocalAuth,
  OAuthService,
  SignInThrottle,
  TokenBucketLimiter,
} from "@pptaken/auth-local";
import type { Core, LiveSessions } from "@pptaken/core";
import type { RealtimeHub } from "@pptaken/realtime";
import type { SqliteStorage } from "@pptaken/storage-sqlite";
import type { ServerConfig } from "./config.js";
import type { Logger } from "./logger.js";

export interface AppVariables {
  requestId: string;
  ip: string;
}

export interface AppEnv {
  Variables: AppVariables;
}

export interface Clock {
  now(): number;
}

export interface Services {
  config: ServerConfig;
  core: Core;
  auth: LocalAuth;
  /** The OAuth authorization server (ADR-0018); `oauth.enabled` is false without an https PPTAKEN_PUBLIC_URL. */
  oauth: OAuthService;
  storage: SqliteStorage;
  logger: Logger;
  clock: Clock;
  /** HKDF subkey for content tokens. */
  contentKey: Buffer;
  /** HKDF subkey for screen tickets (the player page's socket credential). */
  liveKey: Buffer;
  /** HKDF subkey for presenter-password unlock tokens (ADR-021). */
  unlockKey: Buffer;
  /** TESTS ONLY: the test-only guest route (ADR-021) and its deck-only view grant are honoured. */
  testRoutes?: boolean;
  /** ULIDs (audit entries written by the HTTP layer). */
  ids: { ulid(): string };
  /** Live sessions, pairing and device credentials (core use cases on the SQLite store). */
  live: LiveSessions;
  /** In-memory pub/sub of the live sessions (remote control). */
  hub: RealtimeHub;
  limits: {
    signIn: SignInThrottle;
    /** Every /api request per IP (DoS guard). */
    apiPerIp: TokenBucketLimiter;
    /** Failed MCP authentications per IP. */
    mcpAuthFailuresPerIp: TokenBucketLimiter;
    /** Every /mcp request per token. */
    mcpRequestsPerToken: TokenBucketLimiter;
    /** Tool calls per token (120/min) and writes per token (20/min), security §7. */
    mcpCallsPerToken: TokenBucketLimiter;
    mcpWritesPerToken: TokenBucketLimiter;
    /** Pairing attempts per IP (10/min). */
    pairPerIp: TokenBucketLimiter;
    /** OAuth endpoints (authorize, token, revoke) per IP. */
    oauthPerIp: TokenBucketLimiter;
    /** Dynamic client registrations per IP (10/hour, security §7). */
    dcrPerIp: TokenBucketLimiter;
    /** Failed pairing attempts, instance-wide (key "all"): a global cap on guessing. */
    pairFailures: TokenBucketLimiter;
    /**
     * Presenter password unlock (ADR-021): 5 attempts per minute per IP, increasing delay after 3 failures, and a
     * global failure cap that pauses every IP during a distributed guessing attack.
     */
    presenterUnlock: SignInThrottle;
    /** Failed unlocks per deck (10 per 10 minutes): a cap that does not depend on the attacker's IPs. */
    presenterUnlockPerDeck: TokenBucketLimiter;
    /** Script error reports (ADR-023) per IP and per deck: 30 per minute each. */
    scriptErrorsPerIp: TokenBucketLimiter;
    scriptErrorsPerDeck: TokenBucketLimiter;
    /** Public links (ADR-026): link pages (`/s/*`) per IP, 300 per minute (an audience may share one NAT). */
    sharePagesPerIp: TokenBucketLimiter;
    /** Failed link lookups per IP (20 per 10 minutes) and instance-wide (key "all", 300 per 10 minutes). */
    shareFailuresPerIp: TokenBucketLimiter;
    shareFailures: TokenBucketLimiter;
    /** Guest calls per link (content URLs, presenter data, openings): 1200 per minute. */
    sharePerLink: TokenBucketLimiter;
  };
}
