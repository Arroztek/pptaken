// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline presenting (F3): the offline document API (owner only, notes removed, images inlined, no-network CSP
// first), the service worker script and its headers, and the player/presenter page CSP.
import { RUNTIME_SHA256 } from "@pptaken/player";
import { afterEach, describe, expect, it } from "vitest";
import {
  createToken,
  type Harness,
  listen,
  makeHarness,
  mcpClient,
  setupOwner,
} from "./helpers.js";

let h: Harness | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
  await h?.cleanup();
  h = undefined;
});

/** A minimal valid PNG (signature, IHDR, IDAT, IEND); the core checks the header only. */
function png(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082",
      "hex",
    ),
  );
}

async function deck(harness: Harness, cookie: string): Promise<string> {
  const live = await listen(harness.server);
  stop = live.close;
  const { secret } = await createToken(harness, cookie);
  const { call, client } = await mcpClient(live.base, secret);
  const created = await call("create_presentation", {
    title: "Offline deck",
    slides: [
      { id: "a", html: "<p>one</p>", notes: "SECRET-NOTE-77" },
      { id: "b", html: "<p>two</p>" },
    ],
  });
  const id = created.body.presentation_id as string;
  const asset = await call("add_asset", {
    presentation_id: id,
    source: { base64: Buffer.from(png()).toString("base64"), media_type: "image/png" },
  });
  expect(asset.isError, asset.text).toBe(false);
  await call("update_slides", {
    presentation_id: id,
    expected_revision: 1,
    upsert: [{ id: "b", html: `<img src="${asset.body.ref}" alt="x" width="1" height="1">` }],
  });
  await client.close();
  return id;
}

describe("offline document API", () => {
  it("serves the owner a self-contained document of the current revision", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const id = await deck(h, cookie);

    expect((await h.api("GET", `/api/v1/decks/${id}/offline`)).status).toBe(401);
    expect(
      (await h.api("GET", "/api/v1/decks/01J9Z8Y7X6W5V4T3S2R1Q0P9N8/offline", { cookie })).status,
    ).toBe(404);
    const res = await h.api("GET", `/api/v1/decks/${id}/offline`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as { id: string; revision: number; html: string };
    expect(body.id).toBe(id);
    expect(body.revision).toBe(2);
    expect(body.html).toMatch(
      /^<!doctype html>\n<html[^>]*>\n<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-[^']+'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'/,
    );
    expect(body.html).toContain('src="data:image/png;base64,');
    expect(body.html).not.toContain("asset:");
    expect(body.html).not.toContain("SECRET-NOTE-77");
    expect(body.html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});

describe("service worker and page CSP", () => {
  it("serves the worker with its build id and a fetch-only CSP", async () => {
    h = await makeHarness();
    const res = await h.api("GET", "/p/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; connect-src 'self'; frame-ancestors 'none'",
    );
    const source = await res.text();
    expect(source).not.toContain("__PPTAKEN_BUILD__");
    expect(source).toMatch(/const BUILD_PLACEHOLDER = "[0-9a-f]{16}";/);
    expect(source).not.toMatch(/skipWaiting|clients\.claim/);
  });

  it("player and presenter pages allow only the runtime hash and data: fonts in addition", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const id = await deck(h, cookie);
    for (const path of [`/p/${id}`, `/p/${id}/presenter`]) {
      const res = await h.api("GET", path, { cookie });
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain(`script-src 'self' 'sha256-${RUNTIME_SHA256}'`);
      expect(csp).toContain("font-src 'self' data:");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-eval");
    }
    // The web app's pages keep the plain app CSP.
    const home = await h.api("GET", "/");
    expect(home.headers.get("content-security-policy") ?? "").not.toContain("sha256-");
  });

  it("serves the offline modules of the player", async () => {
    h = await makeHarness();
    for (const f of ["offline.js", "offline-cache.js", "offline-client.js"]) {
      const res = await h.api("GET", `/_player/${f}`);
      expect(res.status, f).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
    }
  });
});
