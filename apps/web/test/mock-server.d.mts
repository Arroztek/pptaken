// SPDX-License-Identifier: AGPL-3.0-or-later
// Types for mock-server.mjs (plain Node, no build step), used by the Playwright tests.

export const INSTALL_CODE: string;
export const OWNER_PASSWORD: string;
export const STRICT_CSP: string;

export interface MockDeck {
  id: string;
  title: string;
  lang: string;
  slideCount: number;
  revision: number;
  updatedAt: string;
  createdBy: "owner" | "agent";
}

export interface MockToken {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  hash: string;
}

export interface MockLogEntry {
  method: string;
  path: string;
  csrf: string | string[] | null;
  origin: string | null;
}

export interface MockStateOptions {
  installed?: boolean;
  password?: string;
  https?: boolean;
  /** A number of generated decks, or explicit decks. */
  decks?: number | MockDeck[];
  pageSize?: number;
  /** Delay after the first token is created before connect/status reports a connected agent. */
  connectDelayMs?: number;
  loginLimit?: number;
  retryAfter?: number;
  csp?: string;
}

export interface MockState {
  installed: boolean;
  password: string | null;
  https: boolean;
  decks: MockDeck[];
  pageSize: number;
  connectDelayMs: number;
  loginLimit: number;
  retryAfter: number;
  sessions: Set<string>;
  tokens: MockToken[];
  firstTokenAt: number | null;
  loginAttempts: number[];
  csp: string;
  log: MockLogEntry[];
  exports: { id: string; format: string; notes: string | null }[];
  imports: number[];
}

export interface MockServer {
  url: string;
  state: MockState;
  close(): Promise<void>;
}

export function makeDecks(n: number, now?: number): MockDeck[];
export function createState(options?: MockStateOptions): MockState;
export function startMockServer(
  options?: MockStateOptions & { port?: number; dist?: string },
): Promise<MockServer>;
