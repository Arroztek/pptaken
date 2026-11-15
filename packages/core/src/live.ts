// SPDX-License-Identifier: AGPL-3.0-or-later
// Live sessions and remote pairing (phase F4, ADR-0017, security §5).
//
// - A live session is a presentation being presented: deck, revision, start and a hard 12 h expiry. Only the owner
//   creates one. The screen (the player page) stays authoritative for {slide, step, black}; that state lives in the
//   in-memory hub, not here.
// - Pairing: the owner asks for a one-time 128-bit secret valid for 2 minutes (shown as a QR code). The phone
//   redeems it once for a 256-bit DEVICE CREDENTIAL, created PENDING with a random two-digit code. Every device must
//   be approved by the owner. At most 2 devices per session. Secrets and credentials are stored only as SHA-256.
// - A device credential is scoped to one session and expires with it (end or 12 h). Kicking revokes every device.
//
// Zero I/O: storage is the `LiveSessionStore` port, randomness and time are injected.

import { DomainError, validationError } from "./errors.js";
import type { AuditLog, Clock, IdGenerator } from "./ports.js";
import { type CallContext, type Principal, requireOwner } from "./principal.js";
import { sha256Hex, utf8Encode } from "./sha256.js";
import { isUlid, type RandomSource } from "./ulid.js";

export const LIVE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const PAIRING_TTL_MS = 2 * 60 * 1000;
export const MAX_REMOTES = 2;
/** Pairing secret: 16 random bytes as base64url (22 characters). */
export const PAIRING_SECRET_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Device credential: 32 random bytes as base64url (43 characters). */
export const DEVICE_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type DeviceStatus = "pending" | "approved";

export interface LiveSessionRecord {
  workspaceId: string;
  /** ULID. */
  id: string;
  deckId: string;
  /** The revision the screen loaded most recently. */
  revision: number;
  startedAt: number;
  /** Hard end: `startedAt + 12 h`. */
  expiresAt: number;
  endedAt: number | null;
}

export interface PairingRecord {
  workspaceId: string;
  liveId: string;
  /** SHA-256 hex of the secret. */
  secretHash: string;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
}

export interface DeviceRecord {
  workspaceId: string;
  /** ULID. */
  id: string;
  liveId: string;
  /** SHA-256 hex of the credential. */
  credentialHash: string;
  label: string;
  /** Two digits, shown on the phone and in the approval prompt. */
  code: string;
  status: DeviceStatus;
  createdAt: number;
  approvedAt: number | null;
  revokedAt: number | null;
  expiresAt: number;
}

/** Storage port of live sessions, pairing secrets and device credentials. */
export interface LiveSessionStore {
  insertSession(session: LiveSessionRecord): Promise<void>;
  getSession(workspaceId: string, id: string): Promise<LiveSessionRecord | null>;
  /** The newest session of the deck that has not ended nor expired at `now`. */
  findActiveSession(
    workspaceId: string,
    deckId: string,
    now: number,
  ): Promise<LiveSessionRecord | null>;
  setSessionRevision(workspaceId: string, id: string, revision: number): Promise<void>;
  /** Sets `endedAt` if not ended yet. Returns false when the session does not exist or had ended. */
  endSession(workspaceId: string, id: string, at: number): Promise<boolean>;

  /** Inserts a pairing secret and deletes the session's other unredeemed ones (one live code at a time). */
  replacePairing(pairing: PairingRecord): Promise<void>;
  /**
   * Atomically marks the pairing with this hash redeemed, if it exists, is not redeemed and has not expired at
   * `now`. Returns it, or `null` (unknown, used or expired: indistinguishable on purpose).
   */
  redeemPairing(secretHash: string, now: number): Promise<PairingRecord | null>;

  /**
   * Inserts the device only while the session has fewer than `max` devices that are not revoked (one atomic step).
   * Returns false when the limit is reached.
   */
  insertDeviceIfBelow(device: DeviceRecord, max: number): Promise<boolean>;
  getDeviceByCredential(credentialHash: string): Promise<DeviceRecord | null>;
  /** Devices of the session that are not revoked, oldest first. */
  listDevices(workspaceId: string, liveId: string): Promise<DeviceRecord[]>;
  /** Approves a pending, unrevoked device. Returns false otherwise. */
  approveDevice(workspaceId: string, liveId: string, id: string, at: number): Promise<boolean>;
  /** Revokes the given devices (or all with `null`); returns the ids revoked now. */
  revokeDevices(
    workspaceId: string,
    liveId: string,
    ids: readonly string[] | null,
    at: number,
  ): Promise<string[]>;
}

export interface LiveDeps {
  store: LiveSessionStore;
  clock: Clock;
  ids: IdGenerator;
  random: RandomSource;
  /** Audit log (pairing, approval, revocation, end). Optional. */
  audit?: AuditLog;
}

export interface PairResult {
  device: DeviceRecord;
  /** The device credential (shown once, to the phone). */
  credential: string;
  session: LiveSessionRecord;
}

export interface ResolvedDevice {
  device: DeviceRecord;
  session: LiveSessionRecord;
}

export interface LiveSessions {
  /** Owner. Returns the deck's active session (updating its revision) or starts a new one. */
  start(
    p: Principal,
    input: { deckId: string; revision: number },
    call?: CallContext,
  ): Promise<{ session: LiveSessionRecord; created: boolean }>;
  /** Owner. The deck's active session, or `null`. */
  active(p: Principal, deckId: string): Promise<LiveSessionRecord | null>;
  /** Owner. An active session by id (`NOT_FOUND` if unknown, ended or expired). */
  get(p: Principal, liveId: string): Promise<LiveSessionRecord>;
  /** Owner. A new one-time pairing secret (2 minutes); older unredeemed ones stop working. */
  createPairing(
    p: Principal,
    liveId: string,
  ): Promise<{ secret: string; expiresAt: number; session: LiveSessionRecord }>;
  /**
   * No principal: the secret is the authorization. Redeems it once and creates a PENDING device. Throws
   * `NOT_FOUND` (bad, used or expired secret; ended session) or `LIMIT_EXCEEDED` (two devices already).
   */
  redeem(input: { secret: string; label: string }, call?: CallContext): Promise<PairResult>;
  /** A valid device credential (not revoked, not expired, session active), or `null`. */
  resolveDevice(credential: unknown): Promise<ResolvedDevice | null>;
  /** Owner. Devices of an active session. */
  devices(p: Principal, liveId: string): Promise<DeviceRecord[]>;
  /** Owner. Approves a pending device (`NOT_FOUND` otherwise). */
  approve(p: Principal, liveId: string, deviceId: string, call?: CallContext): Promise<void>;
  /** Owner. Revokes devices (`"all"`: kick). Returns the revoked ids. */
  revoke(
    p: Principal,
    liveId: string,
    deviceIds: readonly string[] | "all",
    call?: CallContext,
  ): Promise<string[]>;
  /** Owner. Ends the session (every device credential stops working). */
  end(p: Principal, liveId: string, call?: CallContext): Promise<void>;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding. */
export function base64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      BASE64URL.charAt((n >> 18) & 63) +
      BASE64URL.charAt((n >> 12) & 63) +
      BASE64URL.charAt((n >> 6) & 63) +
      BASE64URL.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += BASE64URL.charAt((n >> 18) & 63) + BASE64URL.charAt((n >> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out +=
      BASE64URL.charAt((n >> 18) & 63) +
      BASE64URL.charAt((n >> 12) & 63) +
      BASE64URL.charAt((n >> 6) & 63);
  }
  return out;
}

const notFound = (what: string) =>
  new DomainError("NOT_FOUND", `${what} not found`, {
    hint: "Start presenting again to get a new live session or pairing code.",
  });

/** Two uniformly random digits (rejection sampling over one byte). */
function twoDigits(random: RandomSource): string {
  for (;;) {
    const b = random(1)[0] as number;
    if (b < 200) return String(b % 100).padStart(2, "0");
  }
}

export function createLiveSessions(deps: LiveDeps): LiveSessions {
  const { store, clock, ids, random } = deps;

  const audit = async (
    p: { workspaceId: string; actor: Principal["actor"] },
    action: string,
    target: string,
    call: CallContext | undefined,
    detail: Record<string, unknown> | null = null,
  ): Promise<void> => {
    if (!deps.audit) return;
    try {
      await deps.audit.append({
        workspaceId: p.workspaceId,
        id: ids.ulid(),
        at: clock.now(),
        actor: p.actor,
        tokenId: null,
        action,
        target,
        ip: call?.ip ?? null,
        result: "ok",
        detail,
      });
    } catch {
      // Auditing must not break presenting.
    }
  };

  const isActive = (s: LiveSessionRecord | null, now: number): s is LiveSessionRecord =>
    s !== null && s.endedAt === null && s.expiresAt > now;

  const activeOrThrow = async (p: Principal, liveId: string): Promise<LiveSessionRecord> => {
    requireOwner(p, "control a live session");
    if (typeof liveId !== "string" || !isUlid(liveId)) throw notFound("Live session");
    const s = await store.getSession(p.workspaceId, liveId);
    if (!isActive(s, clock.now())) throw notFound("Live session");
    return s;
  };

  return {
    async start(p, input, call) {
      requireOwner(p, "start a live session");
      if (!isUlid(input.deckId)) throw validationError("Invalid deck id", { path: "deckId" });
      if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
        throw validationError("Invalid revision", { path: "revision" });
      }
      const now = clock.now();
      const existing = await store.findActiveSession(p.workspaceId, input.deckId, now);
      if (existing) {
        if (existing.revision !== input.revision) {
          await store.setSessionRevision(p.workspaceId, existing.id, input.revision);
        }
        return { session: { ...existing, revision: input.revision }, created: false };
      }
      const session: LiveSessionRecord = {
        workspaceId: p.workspaceId,
        id: ids.ulid(),
        deckId: input.deckId,
        revision: input.revision,
        startedAt: now,
        expiresAt: now + LIVE_SESSION_TTL_MS,
        endedAt: null,
      };
      await store.insertSession(session);
      await audit(p, "live.start", `live:${session.id}`, call, { deckId: input.deckId });
      return { session, created: true };
    },

    async active(p, deckId) {
      requireOwner(p, "read a live session");
      if (!isUlid(deckId)) return null;
      return store.findActiveSession(p.workspaceId, deckId, clock.now());
    },

    get: activeOrThrow,

    async createPairing(p, liveId) {
      const session = await activeOrThrow(p, liveId);
      const now = clock.now();
      const secret = base64Url(random(16));
      const expiresAt = Math.min(now + PAIRING_TTL_MS, session.expiresAt);
      await store.replacePairing({
        workspaceId: p.workspaceId,
        liveId,
        secretHash: sha256Hex(utf8Encode(secret)),
        createdAt: now,
        expiresAt,
        redeemedAt: null,
      });
      return { secret, expiresAt, session };
    },

    async redeem(input, call) {
      if (typeof input.secret !== "string" || !PAIRING_SECRET_PATTERN.test(input.secret)) {
        throw notFound("Pairing code");
      }
      const now = clock.now();
      const pairing = await store.redeemPairing(sha256Hex(utf8Encode(input.secret)), now);
      if (!pairing) throw notFound("Pairing code");
      const session = await store.getSession(pairing.workspaceId, pairing.liveId);
      if (!isActive(session, now)) throw notFound("Live session");
      const credential = base64Url(random(32));
      const device: DeviceRecord = {
        workspaceId: session.workspaceId,
        id: ids.ulid(),
        liveId: session.id,
        credentialHash: sha256Hex(utf8Encode(credential)),
        label: input.label,
        code: twoDigits(random),
        status: "pending",
        createdAt: now,
        approvedAt: null,
        revokedAt: null,
        expiresAt: Math.min(session.expiresAt, now + LIVE_SESSION_TTL_MS),
      };
      if (!(await store.insertDeviceIfBelow(device, MAX_REMOTES))) {
        throw new DomainError("LIMIT_EXCEEDED", `At most ${MAX_REMOTES} remotes per presentation`, {
          hint: "Remove a paired remote on the laptop, then scan a new code.",
          details: { limit: MAX_REMOTES },
        });
      }
      await audit(
        { workspaceId: session.workspaceId, actor: "system" },
        "live.pair",
        `device:${device.id}`,
        call,
        {
          liveId: session.id,
        },
      );
      return { device, credential, session };
    },

    async resolveDevice(credential) {
      if (typeof credential !== "string" || !DEVICE_CREDENTIAL_PATTERN.test(credential))
        return null;
      const device = await store.getDeviceByCredential(sha256Hex(utf8Encode(credential)));
      const now = clock.now();
      if (!device || device.revokedAt !== null || device.expiresAt <= now) return null;
      const session = await store.getSession(device.workspaceId, device.liveId);
      if (!isActive(session, now)) return null;
      return { device, session };
    },

    async devices(p, liveId) {
      await activeOrThrow(p, liveId);
      return store.listDevices(p.workspaceId, liveId);
    },

    async approve(p, liveId, deviceId, call) {
      await activeOrThrow(p, liveId);
      if (
        !isUlid(deviceId) ||
        !(await store.approveDevice(p.workspaceId, liveId, deviceId, clock.now()))
      ) {
        throw notFound("Pending device");
      }
      await audit(p, "live.approve", `device:${deviceId}`, call, { liveId });
    },

    async revoke(p, liveId, deviceIds, call) {
      await activeOrThrow(p, liveId);
      const list = deviceIds === "all" ? null : deviceIds.filter((id) => isUlid(id));
      if (list !== null && list.length === 0) return [];
      const revoked = await store.revokeDevices(p.workspaceId, liveId, list, clock.now());
      if (revoked.length > 0) {
        await audit(p, deviceIds === "all" ? "live.kick" : "live.revoke", `live:${liveId}`, call, {
          devices: revoked.length,
        });
      }
      return revoked;
    },

    async end(p, liveId, call) {
      await activeOrThrow(p, liveId);
      const now = clock.now();
      await store.revokeDevices(p.workspaceId, liveId, null, now);
      await store.endSession(p.workspaceId, liveId, now);
      await audit(p, "live.end", `live:${liveId}`, call);
    },
  };
}
