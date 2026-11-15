// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory reference implementation of the core's `LiveSessionStore` port (live sessions, pairing secrets, device
// credentials). Returns copies, never live internal state.
import type {
  DeviceRecord,
  LiveSessionRecord,
  LiveSessionStore,
  PairingRecord,
} from "@pptaken/core";

export class MemoryLiveSessionStore implements LiveSessionStore {
  private readonly sessions: LiveSessionRecord[] = [];
  private readonly pairings: PairingRecord[] = [];
  private readonly devices: DeviceRecord[] = [];

  async insertSession(session: LiveSessionRecord): Promise<void> {
    if (this.sessions.some((s) => s.workspaceId === session.workspaceId && s.id === session.id)) {
      throw new Error("duplicate live session");
    }
    this.sessions.push({ ...session });
  }

  async getSession(workspaceId: string, id: string): Promise<LiveSessionRecord | null> {
    const s = this.sessions.find((x) => x.workspaceId === workspaceId && x.id === id);
    return s ? { ...s } : null;
  }

  async findActiveSession(
    workspaceId: string,
    deckId: string,
    now: number,
  ): Promise<LiveSessionRecord | null> {
    const list = this.sessions
      .filter(
        (s) =>
          s.workspaceId === workspaceId &&
          s.deckId === deckId &&
          s.endedAt === null &&
          s.expiresAt > now,
      )
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    return list[0] ? { ...list[0] } : null;
  }

  async setSessionRevision(workspaceId: string, id: string, revision: number): Promise<void> {
    const s = this.sessions.find((x) => x.workspaceId === workspaceId && x.id === id);
    if (s) s.revision = revision;
  }

  async endSession(workspaceId: string, id: string, at: number): Promise<boolean> {
    const s = this.sessions.find((x) => x.workspaceId === workspaceId && x.id === id);
    if (!s || s.endedAt !== null) return false;
    s.endedAt = at;
    return true;
  }

  async replacePairing(pairing: PairingRecord): Promise<void> {
    for (let i = this.pairings.length - 1; i >= 0; i--) {
      const p = this.pairings[i] as PairingRecord;
      if (
        p.workspaceId === pairing.workspaceId &&
        p.liveId === pairing.liveId &&
        p.redeemedAt === null
      ) {
        this.pairings.splice(i, 1);
      }
    }
    this.pairings.push({ ...pairing });
  }

  async redeemPairing(secretHash: string, now: number): Promise<PairingRecord | null> {
    const p = this.pairings.find(
      (x) => x.secretHash === secretHash && x.redeemedAt === null && x.expiresAt > now,
    );
    if (!p) return null;
    p.redeemedAt = now;
    return { ...p };
  }

  async insertDeviceIfBelow(device: DeviceRecord, max: number): Promise<boolean> {
    const count = this.devices.filter(
      (d) =>
        d.workspaceId === device.workspaceId && d.liveId === device.liveId && d.revokedAt === null,
    ).length;
    if (count >= max) return false;
    if (this.devices.some((d) => d.credentialHash === device.credentialHash)) {
      throw new Error("duplicate credential");
    }
    this.devices.push({ ...device });
    return true;
  }

  async getDeviceByCredential(credentialHash: string): Promise<DeviceRecord | null> {
    const d = this.devices.find((x) => x.credentialHash === credentialHash);
    return d ? { ...d } : null;
  }

  async listDevices(workspaceId: string, liveId: string): Promise<DeviceRecord[]> {
    return this.devices
      .filter((d) => d.workspaceId === workspaceId && d.liveId === liveId && d.revokedAt === null)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((d) => ({ ...d }));
  }

  async approveDevice(
    workspaceId: string,
    liveId: string,
    id: string,
    at: number,
  ): Promise<boolean> {
    const d = this.devices.find(
      (x) =>
        x.workspaceId === workspaceId &&
        x.liveId === liveId &&
        x.id === id &&
        x.revokedAt === null &&
        x.status === "pending",
    );
    if (!d) return false;
    d.status = "approved";
    d.approvedAt = at;
    return true;
  }

  async revokeDevices(
    workspaceId: string,
    liveId: string,
    ids: readonly string[] | null,
    at: number,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const d of this.devices) {
      if (d.workspaceId !== workspaceId || d.liveId !== liveId || d.revokedAt !== null) continue;
      if (ids !== null && !ids.includes(d.id)) continue;
      d.revokedAt = at;
      out.push(d.id);
    }
    return out;
  }
}
