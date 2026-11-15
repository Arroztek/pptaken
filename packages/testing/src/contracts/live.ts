// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract suite of the `LiveSessionStore` port, run through the core's live-session use cases (pairing lifetime,
// one-time secrets, pending devices, the two-remote limit, revocation, expiry) with a fake clock. Every adapter
// (in memory, SQLite, a future Postgres) must pass it.
import {
  createLiveSessions,
  DEFAULT_WORKSPACE_ID,
  isDomainError,
  LIVE_SESSION_TTL_MS,
  type LiveSessionStore,
  ownerPrincipal,
  PAIRING_TTL_MS,
  type Principal,
  sha256Hex,
  utf8Encode,
} from "@pptaken/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestIdGenerator, ManualClock, seededRandom } from "../memory.js";

export interface LiveStoreHarness {
  store: LiveSessionStore;
  cleanup?: () => Promise<void> | void;
}

const DECK = "01JD0000000000000000000DEC";
const agent: Principal = {
  actor: "agent",
  workspaceId: DEFAULT_WORKSPACE_ID,
  scopes: new Set(["decks:read", "decks:write"]),
};

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    return isDomainError(e) ? e.code : String(e);
  }
}

export function runLiveSessionContract(
  name: string,
  factory: () => LiveStoreHarness | Promise<LiveStoreHarness>,
): void {
  describe(`LiveSessionStore contract: ${name}`, () => {
    let harness: LiveStoreHarness | undefined;
    afterEach(async () => {
      await harness?.cleanup?.();
      harness = undefined;
    });

    async function setup() {
      harness = await factory();
      const clock = new ManualClock(Date.UTC(2026, 10, 15, 9));
      const live = createLiveSessions({
        store: harness.store,
        clock,
        ids: createTestIdGenerator(clock, 7),
        random: seededRandom(11),
      });
      const owner = ownerPrincipal();
      const { session } = await live.start(owner, { deckId: DECK, revision: 1 });
      return { live, clock, owner, session, store: harness.store };
    }

    it("only the owner starts a session; the deck's active one is reused and follows the revision", async () => {
      const { live, owner, session } = await setup();
      expect(await codeOf(live.start(agent, { deckId: DECK, revision: 1 }))).toBe(
        "FORBIDDEN_ACTOR",
      );
      const again = await live.start(owner, { deckId: DECK, revision: 3 });
      expect(again.created).toBe(false);
      expect(again.session.id).toBe(session.id);
      expect((await live.get(owner, session.id)).revision).toBe(3);
      expect((await live.active(owner, DECK))?.id).toBe(session.id);
      expect(session.expiresAt - session.startedAt).toBe(LIVE_SESSION_TTL_MS);
    });

    it("pairing secrets are 128-bit, one-time, valid for 2 minutes and stored hashed", async () => {
      const { live, owner, session, clock, store } = await setup();
      const pairing = await live.createPairing(owner, session.id);
      expect(pairing.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(pairing.expiresAt - clock.now()).toBe(PAIRING_TTL_MS);
      // Stored as a hash only: the hash redeems nothing, the store never sees the secret.
      expect(
        await codeOf(
          live.redeem({ secret: sha256Hex(utf8Encode(pairing.secret)).slice(0, 22), label: "x" }),
        ),
      ).toBe("NOT_FOUND");
      const r = await live.redeem({ secret: pairing.secret, label: "Android · Chrome" });
      expect(r.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.device).toMatchObject({
        status: "pending",
        label: "Android · Chrome",
        liveId: session.id,
      });
      expect(r.device.code).toMatch(/^[0-9]{2}$/);
      expect(r.device.credentialHash).toBe(sha256Hex(utf8Encode(r.credential)));
      expect((await store.getDeviceByCredential(r.device.credentialHash))?.id).toBe(r.device.id);
      // One-time.
      expect(await codeOf(live.redeem({ secret: pairing.secret, label: "x" }))).toBe("NOT_FOUND");
      // Lifetime.
      const late = await live.createPairing(owner, session.id);
      clock.advance(PAIRING_TTL_MS);
      expect(await codeOf(live.redeem({ secret: late.secret, label: "x" }))).toBe("NOT_FOUND");
      // A new code invalidates the previous unredeemed one.
      const a = await live.createPairing(owner, session.id);
      const b = await live.createPairing(owner, session.id);
      expect(await codeOf(live.redeem({ secret: a.secret, label: "x" }))).toBe("NOT_FOUND");
      expect(await codeOf(live.redeem({ secret: b.secret, label: "x" }))).toBeNull();
      // Malformed input.
      for (const secret of [
        "",
        "short",
        "a".repeat(23),
        "a".repeat(21) + "!",
        42 as unknown as string,
      ]) {
        expect(await codeOf(live.redeem({ secret, label: "x" }))).toBe("NOT_FOUND");
      }
    });

    it("devices start pending, need approval, and at most two are paired", async () => {
      const { live, owner, session } = await setup();
      const pair = async () =>
        live.redeem({
          secret: (await live.createPairing(owner, session.id)).secret,
          label: "Phone",
        });
      const one = await pair();
      const resolved = await live.resolveDevice(one.credential);
      expect(resolved?.device.status).toBe("pending");
      await live.approve(owner, session.id, one.device.id);
      expect((await live.resolveDevice(one.credential))?.device.status).toBe("approved");
      expect(await codeOf(live.approve(owner, session.id, one.device.id))).toBe("NOT_FOUND"); // not pending
      expect(await codeOf(live.approve(agent, session.id, one.device.id))).toBe("FORBIDDEN_ACTOR");
      const two = await pair();
      expect(await codeOf(pair())).toBe("LIMIT_EXCEEDED");
      expect((await live.devices(owner, session.id)).map((d) => d.id)).toEqual([
        one.device.id,
        two.device.id,
      ]);
      // Removing one frees a slot.
      expect(await live.revoke(owner, session.id, [two.device.id])).toEqual([two.device.id]);
      expect(await live.resolveDevice(two.credential)).toBeNull();
      expect(await codeOf(pair())).toBeNull();
    });

    it("kick revokes every device; ending or expiring the session invalidates credentials", async () => {
      const { live, owner, session, clock } = await setup();
      const pair = async () =>
        live.redeem({
          secret: (await live.createPairing(owner, session.id)).secret,
          label: "Phone",
        });
      const one = await pair();
      const two = await pair();
      expect((await live.revoke(owner, session.id, "all")).sort()).toEqual(
        [one.device.id, two.device.id].sort(),
      );
      expect(await live.resolveDevice(one.credential)).toBeNull();
      expect(await live.devices(owner, session.id)).toEqual([]);
      const three = await pair();
      expect(await live.resolveDevice(three.credential)).not.toBeNull();
      clock.advance(LIVE_SESSION_TTL_MS);
      expect(await live.resolveDevice(three.credential)).toBeNull();
      expect(await codeOf(live.get(owner, session.id))).toBe("NOT_FOUND");
      // A new session for the deck after expiry.
      const next = await live.start(owner, { deckId: DECK, revision: 1 });
      expect(next.created).toBe(true);
      const four = await live.redeem({
        secret: (await live.createPairing(owner, next.session.id)).secret,
        label: "P",
      });
      await live.end(owner, next.session.id);
      expect(await live.resolveDevice(four.credential)).toBeNull();
      expect(await live.active(owner, DECK)).toBeNull();
    });

    it("rejects malformed credentials without touching storage", async () => {
      const { live } = await setup();
      for (const c of [
        undefined,
        null,
        1,
        "",
        "x".repeat(42),
        "x".repeat(44),
        "a".repeat(42) + "+",
      ]) {
        expect(await live.resolveDevice(c)).toBeNull();
      }
    });
  });
}
