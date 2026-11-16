// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract suite of the `OAuthStore` port. Every adapter must pass it (import from a Vitest test file):
//   import { runOAuthStoreContract } from "@pptaken/auth-local/contract";
//   runOAuthStoreContract("sqlite", async () => ({ store: createSqliteOAuthStore(storage), cleanup }));
import { describe, expect, it } from "vitest";
import type {
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthGrantRecord,
  OAuthStore,
  OAuthTokenRecord,
} from "./oauth-store.js";

export interface OAuthStoreHarness {
  store: OAuthStore;
  cleanup?: () => Promise<void> | void;
}

const WS = "default";
const client = (id = "pptc_AAAAAAAAAAAAAAAAAAAAAA", createdAt = 1): OAuthClientRecord => ({
  workspaceId: WS,
  id,
  kind: "dcr",
  name: "Claude",
  redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  metadata: '{"client_name":"Claude"}',
  createdAt,
});
const grant = (id: string, clientId: string, over: Partial<OAuthGrantRecord> = {}) =>
  ({
    workspaceId: WS,
    id,
    clientId,
    clientName: "Claude",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    scopes: ["decks:read", "decks:write"],
    resource: "https://slides.example.com/mcp",
    createdAt: 10,
    lastUsedAt: null,
    expiresAt: 1_000,
    revokedAt: null,
    ...over,
  }) satisfies OAuthGrantRecord;
const code = (hash: string, grantId: string, clientId: string): OAuthCodeRecord => ({
  workspaceId: WS,
  codeHash: hash,
  grantId,
  clientId,
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  codeChallenge: "c".repeat(43),
  resource: "https://slides.example.com/mcp",
  scopes: ["decks:read"],
  createdAt: 10,
  expiresAt: 70,
  usedAt: null,
});
const token = (
  hash: string,
  grantId: string,
  kind: "access" | "refresh",
  expiresAt = 5_000,
): OAuthTokenRecord => ({
  workspaceId: WS,
  tokenHash: hash,
  grantId,
  kind,
  createdAt: 10,
  expiresAt,
  replacedBy: null,
  rotatedAt: null,
});

export function runOAuthStoreContract(
  name: string,
  factory: () => Promise<OAuthStoreHarness>,
): void {
  describe(`OAuthStore contract: ${name}`, () => {
    const withStore = (fn: (store: OAuthStore) => Promise<void>) => async () => {
      const h = await factory();
      try {
        await fn(h.store);
      } finally {
        await h.cleanup?.();
      }
    };

    it(
      "upserts clients and counts the ones without a grant",
      withStore(async (s) => {
        expect(await s.getClient(WS, "pptc_AAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
        await s.upsertClient(client());
        await s.upsertClient({ ...client(), name: "Renamed" });
        await s.upsertClient(client("https://app.example/cimd.json"));
        expect(await s.getClient(WS, "pptc_AAAAAAAAAAAAAAAAAAAAAA")).toMatchObject({
          name: "Renamed",
          kind: "dcr",
          redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        });
        expect(await s.countClientsWithoutGrant(WS)).toBe(2);
        await s.insertGrant(grant("01G1", "pptc_AAAAAAAAAAAAAAAAAAAAAA"));
        expect(await s.countClientsWithoutGrant(WS)).toBe(1);
        expect(await s.countClientsWithoutGrant("other")).toBe(0);
      }),
    );

    it(
      "stores grants, lists newest first, updates and revokes them with their secrets",
      withStore(async (s) => {
        await s.upsertClient(client());
        const cid = "pptc_AAAAAAAAAAAAAAAAAAAAAA";
        await s.insertGrant(grant("01G1", cid));
        await s.insertGrant(grant("01G2", cid));
        await expect(s.insertGrant(grant("01G3", "pptc_missingmissingmiss"))).rejects.toThrow();
        expect((await s.listGrants(WS)).map((g) => g.id)).toEqual(["01G2", "01G1"]);
        await s.updateGrant(WS, "01G1", { lastUsedAt: 50, expiresAt: 9_000 });
        expect(await s.getGrant(WS, "01G1")).toMatchObject({ lastUsedAt: 50, expiresAt: 9_000 });
        expect((await s.getGrant(WS, "01G1"))?.scopes).toEqual(["decks:read", "decks:write"]);
        await s.insertCode(code("ch1", "01G1", cid));
        await s.insertToken(token("th1", "01G1", "access"));
        await s.insertToken(token("th2", "01G2", "refresh"));
        await expect(s.insertToken(token("th3", "01NOPE", "access"))).rejects.toThrow();
        expect(await s.revokeGrant(WS, "01G1", 60)).toBe(true);
        expect(await s.revokeGrant(WS, "01G1", 70)).toBe(true);
        expect(await s.revokeGrant(WS, "missing", 70)).toBe(false);
        expect((await s.getGrant(WS, "01G1"))?.revokedAt).toBe(60);
        expect(await s.getTokenByHash("th1")).toBeNull();
        expect(await s.consumeCode("ch1", 80)).toBeNull();
        expect(await s.getTokenByHash("th2")).not.toBeNull();
        expect(await s.revokeAllGrants(WS, 90)).toBe(1);
        expect(await s.getTokenByHash("th2")).toBeNull();
        expect((await s.getGrant(WS, "01G2"))?.revokedAt).toBe(90);
      }),
    );

    it(
      "consumes a code exactly once",
      withStore(async (s) => {
        await s.upsertClient(client());
        await s.insertGrant(grant("01G1", client().id));
        await s.insertCode(code("ch1", "01G1", client().id));
        await expect(s.insertCode(code("ch1", "01G1", client().id))).rejects.toThrow();
        const first = await s.consumeCode("ch1", 20);
        expect(first?.firstUse).toBe(true);
        expect(first?.code).toMatchObject({
          grantId: "01G1",
          usedAt: null,
          scopes: ["decks:read"],
        });
        const second = await s.consumeCode("ch1", 30);
        expect(second?.firstUse).toBe(false);
        expect(second?.code.usedAt).toBe(20);
        expect(await s.consumeCode("nope", 30)).toBeNull();
      }),
    );

    it(
      "rotates a refresh token only once",
      withStore(async (s) => {
        await s.upsertClient(client());
        await s.insertGrant(grant("01G1", client().id));
        await s.insertToken(token("r1", "01G1", "refresh"));
        await s.insertToken(token("a1", "01G1", "access"));
        expect(await s.rotateRefreshToken("r1", token("r2", "01G1", "refresh"), 40)).toBe(true);
        expect(await s.rotateRefreshToken("r1", token("r3", "01G1", "refresh"), 41)).toBe(false);
        expect(await s.rotateRefreshToken("a1", token("r4", "01G1", "refresh"), 41)).toBe(false);
        expect(await s.getTokenByHash("r3")).toBeNull();
        expect(await s.getTokenByHash("r1")).toMatchObject({ replacedBy: "r2", rotatedAt: 40 });
        expect(await s.getTokenByHash("r2")).toMatchObject({ replacedBy: null, kind: "refresh" });
        await s.deleteToken("a1");
        expect(await s.getTokenByHash("a1")).toBeNull();
      }),
    );

    it(
      "deletes expired codes and tokens, purges dead grants and unused clients",
      withStore(async (s) => {
        await s.upsertClient(client());
        await s.upsertClient(client("pptc_BBBBBBBBBBBBBBBBBBBBBB", 500));
        await s.upsertClient(client("pptc_CCCCCCCCCCCCCCCCCCCCCC", 5));
        const cid = client().id;
        await s.insertGrant(grant("01LIVE", cid, { expiresAt: 10_000 }));
        await s.insertGrant(grant("01DEAD", "pptc_CCCCCCCCCCCCCCCCCCCCCC", { expiresAt: 100 }));
        await s.insertGrant(grant("01REV", cid, { revokedAt: 150, expiresAt: 10_000 }));
        await s.insertCode(code("old", "01LIVE", cid));
        await s.insertToken(token("t-old", "01LIVE", "access", 100));
        await s.insertToken(token("t-new", "01LIVE", "access", 9_000));
        expect(await s.deleteExpired(WS, 200)).toBe(2);
        expect(await s.getTokenByHash("t-new")).not.toBeNull();
        const purged = await s.purge(WS, {
          deadGrantsBefore: 200,
          clientsWithoutGrantBefore: 300,
        });
        expect(purged).toEqual({ grants: 2, clients: 1 });
        expect((await s.listGrants(WS)).map((g) => g.id)).toEqual(["01LIVE"]);
        expect(await s.getClient(WS, "pptc_CCCCCCCCCCCCCCCCCCCCCC")).toBeNull();
        expect(await s.getClient(WS, "pptc_BBBBBBBBBBBBBBBBBBBBBB")).not.toBeNull(); // too recent
        expect(await s.getClient(WS, cid)).not.toBeNull(); // has a live grant
      }),
    );
  });
}
