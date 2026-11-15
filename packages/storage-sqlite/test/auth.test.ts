// SPDX-License-Identifier: AGPL-3.0-or-later
// The SQLite auth store against the AuthStore contract of @pptaken/auth-local, on :memory: and on a WAL file.
// The assignment to `AuthStore` also checks at compile time that the adapter matches the port.
import { join } from "node:path";
import type { AuthStore } from "@pptaken/auth-local";
import { runAuthStoreContract } from "@pptaken/auth-local/contract";
import { describe, expect, it } from "vitest";
import { createSqliteAuthStore, openSqliteStorage } from "../src/index.js";
import { tempDir } from "./helpers.js";

runAuthStoreContract("sqlite :memory:", async () => {
  const storage = openSqliteStorage({ filename: ":memory:" });
  const store: AuthStore = createSqliteAuthStore(storage);
  return { store, cleanup: () => storage.close() };
});

runAuthStoreContract("sqlite file", async () => {
  const tmp = tempDir();
  const storage = openSqliteStorage({ filename: join(tmp.dir, "auth.db") });
  return {
    store: createSqliteAuthStore(storage),
    cleanup: async () => {
      await storage.close();
      tmp.remove();
    },
  };
});

describe("sqlite auth store", () => {
  it("survives a reopen and keeps the single-owner constraint in the schema", async () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, "auth.db");
      const a = openSqliteStorage({ filename: file });
      const store = createSqliteAuthStore(a);
      await store.putSetting("default", "install_code", "h", 1);
      const owner = {
        workspaceId: "default",
        id: "01A",
        passwordHash: "x",
        createdAt: 1,
        updatedAt: 1,
      };
      expect(await store.completeSetup(owner, "h")).toBe("ok");
      await a.close();
      const b = openSqliteStorage({ filename: file });
      expect((await createSqliteAuthStore(b).getOwner("default"))?.id).toBe("01A");
      const { sql } = await import("kysely");
      await expect(
        sql`INSERT INTO auth_owner (workspace_id, id, password_hash, created_at, updated_at) VALUES ('default', '01B', 'y', 1, 1)`.execute(
          b.kysely,
        ),
      ).rejects.toThrow();
      await b.close();
    } finally {
      tmp.remove();
    }
  });
});
