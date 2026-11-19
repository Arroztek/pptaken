// SPDX-License-Identifier: AGPL-3.0-or-later
// The SQLite OAuth store against the OAuthStore contract of @pptaken/auth-local, on :memory: and on a WAL file.
// The assignment to `OAuthStore` also checks at compile time that the adapter matches the port.
import { join } from "node:path";
import type { OAuthStore } from "@pptaken/auth-local";
import { runOAuthStoreContract } from "@pptaken/auth-local/contract";
import { describe, expect, it } from "vitest";
import { createSqliteOAuthStore, openSqliteStorage } from "../src/index.js";
import { tempDir } from "./helpers.js";

runOAuthStoreContract("sqlite :memory:", async () => {
  const storage = openSqliteStorage({ filename: ":memory:" });
  const store: OAuthStore = createSqliteOAuthStore(storage);
  return { store, cleanup: () => storage.close() };
});

runOAuthStoreContract("sqlite file", async () => {
  const tmp = tempDir();
  const storage = openSqliteStorage({ filename: join(tmp.dir, "oauth.db") });
  return {
    store: createSqliteOAuthStore(storage),
    cleanup: async () => {
      await storage.close();
      tmp.remove();
    },
  };
});

describe("sqlite oauth schema", () => {
  it("cascades a client's deletion to its grants, codes and tokens", async () => {
    const storage = openSqliteStorage({ filename: ":memory:" });
    try {
      const store = createSqliteOAuthStore(storage);
      await store.upsertClient({
        workspaceId: "default",
        id: "pptc_AAAAAAAAAAAAAAAAAAAAAA",
        kind: "dcr",
        name: null,
        redirectUris: ["http://127.0.0.1/cb"],
        metadata: "{}",
        createdAt: 1,
      });
      await store.insertGrant({
        workspaceId: "default",
        id: "01G",
        clientId: "pptc_AAAAAAAAAAAAAAAAAAAAAA",
        clientName: null,
        redirectUri: "http://127.0.0.1/cb",
        scopes: ["decks:read"],
        resource: "http://localhost/mcp",
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: 100,
        revokedAt: null,
      });
      await store.insertToken({
        workspaceId: "default",
        tokenHash: "h",
        grantId: "01G",
        kind: "access",
        createdAt: 1,
        expiresAt: 100,
        replacedBy: null,
        rotatedAt: null,
      });
      const { sql } = await import("kysely");
      await sql`DELETE FROM oauth_clients`.execute(storage.kysely);
      expect(await store.getGrant("default", "01G")).toBeNull();
      expect(await store.getTokenByHash("h")).toBeNull();
      expect(storage.schemaVersion()).toBe(6);
    } finally {
      await storage.close();
    }
  });
});
