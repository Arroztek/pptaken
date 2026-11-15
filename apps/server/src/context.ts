// SPDX-License-Identifier: AGPL-3.0-or-later
// What every route module receives from the composition root.
import type { LocalAuth, SignInThrottle, TokenBucketLimiter } from "@pptaken/auth-local";
import type { Core } from "@pptaken/core";
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
  storage: SqliteStorage;
  logger: Logger;
  clock: Clock;
  /** HKDF subkey for content tokens. */
  contentKey: Buffer;
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
  };
}
