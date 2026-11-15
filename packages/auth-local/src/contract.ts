// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract suite of the `AuthStore` port. Every adapter must pass it (import from a Vitest test file):
//   import { runAuthStoreContract } from "@pptaken/auth-local/contract";
//   runAuthStoreContract("sqlite", async () => ({ store: createSqliteAuthStore(storage), cleanup }));
import { describe, expect, it } from "vitest";
import type { ApiTokenRecord, AuthStore, OwnerRecord } from "./store.js";

export interface AuthStoreHarness {
  store: AuthStore;
  cleanup?: () => Promise<void> | void;
}

const WS = "default";
const owner = (id = "01OWNER"): OwnerRecord => ({
  workspaceId: WS,
  id,
  passwordHash: "$scrypt$x",
  createdAt: 1,
  updatedAt: 1,
});
const token = (id: string, hash: string): ApiTokenRecord => ({
  workspaceId: WS,
  id,
  name: `t-${id}`,
  tokenHash: hash,
  scopes: ["decks:read"],
  createdAt: 10,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
});

export function runAuthStoreContract(name: string, factory: () => Promise<AuthStoreHarness>): void {
  describe(`AuthStore contract: ${name}`, () => {
    const withStore = (fn: (store: AuthStore) => Promise<void>) => async () => {
      const h = await factory();
      try {
        await fn(h.store);
      } finally {
        await h.cleanup?.();
      }
    };

    it(
      "setup consumes the install code exactly once and never creates a second owner",
      withStore(async (s) => {
        expect(await s.getOwner(WS)).toBeNull();
        expect(await s.completeSetup(owner(), "h1")).toBe("code_mismatch");
        await s.putSetting(WS, "install_code", "h1", 1);
        expect(await s.completeSetup(owner(), "h2")).toBe("code_mismatch");
        expect(await s.completeSetup(owner(), "h1")).toBe("ok");
        expect(await s.getSetting(WS, "install_code")).toBeNull();
        expect((await s.getOwner(WS))?.id).toBe("01OWNER");
        await s.putSetting(WS, "install_code", "h3", 2);
        expect(await s.completeSetup(owner("01OTHER"), "h3")).toBe("already_setup");
        expect((await s.getOwner(WS))?.id).toBe("01OWNER");
      }),
    );

    it(
      "updates the password",
      withStore(async (s) => {
        await s.putSetting(WS, "install_code", "h", 1);
        await s.completeSetup(owner(), "h");
        expect(await s.setOwnerPassword(WS, "01OWNER", "$scrypt$y", 5)).toBe(true);
        expect(await s.setOwnerPassword(WS, "nobody", "$scrypt$z", 6)).toBe(false);
        expect(await s.getOwner(WS)).toMatchObject({ passwordHash: "$scrypt$y", updatedAt: 5 });
      }),
    );

    it(
      "stores settings by key",
      withStore(async (s) => {
        await s.putSetting(WS, "a", "1", 1);
        await s.putSetting(WS, "a", "2", 2);
        expect(await s.getSetting(WS, "a")).toBe("2");
        await s.deleteSetting(WS, "a");
        expect(await s.getSetting(WS, "a")).toBeNull();
      }),
    );

    it(
      "creates, touches, expires and deletes sessions",
      withStore(async (s) => {
        await s.putSetting(WS, "install_code", "h", 1);
        await s.completeSetup(owner(), "h");
        const base = { workspaceId: WS, ownerId: "01OWNER", createdAt: 1, lastSeenAt: 1 };
        await s.insertSession({ ...base, idHash: "s1", expiresAt: 100 });
        await s.insertSession({ ...base, idHash: "s2", expiresAt: 200 });
        await s.insertSession({ ...base, idHash: "s3", expiresAt: 300 });
        await s.touchSession(WS, "s1", 50, 1000);
        expect(await s.getSession(WS, "s1")).toMatchObject({ lastSeenAt: 50, expiresAt: 1000 });
        expect(await s.deleteExpiredSessions(WS, 200)).toBe(1); // s2
        expect(await s.getSession(WS, "s2")).toBeNull();
        expect(await s.deleteSession(WS, "s1")).toBe(true);
        expect(await s.deleteSession(WS, "s1")).toBe(false);
        expect(await s.deleteAllSessions(WS)).toBe(1);
        expect(await s.getSession(WS, "s3")).toBeNull();
      }),
    );

    it(
      "stores tokens by hash, lists newest first, revokes once and touches",
      withStore(async (s) => {
        await s.insertToken(token("01A", "ha"));
        await s.insertToken(token("01B", "hb"));
        await expect(s.insertToken(token("01C", "ha"))).rejects.toThrow();
        expect((await s.getTokenByHash("hb"))?.id).toBe("01B");
        expect(await s.getTokenByHash("nope")).toBeNull();
        expect((await s.listTokens(WS)).map((t) => t.id)).toEqual(["01B", "01A"]);
        expect(await s.revokeToken(WS, "01A", 20)).toBe(true);
        expect(await s.revokeToken(WS, "01A", 30)).toBe(true);
        expect((await s.getTokenByHash("ha"))?.revokedAt).toBe(20);
        expect(await s.revokeToken(WS, "missing", 30)).toBe(false);
        await s.touchToken(WS, "01B", 40);
        expect((await s.getTokenByHash("hb"))?.lastUsedAt).toBe(40);
        expect((await s.getTokenByHash("hb"))?.scopes).toEqual(["decks:read"]);
      }),
    );

    it(
      "records the last MCP call",
      withStore(async (s) => {
        expect(await s.getMcpActivity(WS)).toBeNull();
        const a = { workspaceId: WS, lastTool: "whoami", clientName: "c", tokenId: "01A" };
        await s.recordMcpActivity({ ...a, lastCallAt: 1 });
        await s.recordMcpActivity({ ...a, lastCallAt: 2, lastTool: "create_presentation" });
        expect(await s.getMcpActivity(WS)).toEqual({
          ...a,
          lastCallAt: 2,
          lastTool: "create_presentation",
        });
      }),
    );
  });
}
