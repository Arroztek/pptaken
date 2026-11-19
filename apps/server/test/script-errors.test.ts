// SPDX-License-Identifier: AGPL-3.0-or-later
// Script error visibility (ADR-023) over HTTP: the owner-only report endpoint (session + CSRF + same-origin, small
// body, rate limits per IP and per deck, ignored for a wrong digest), the read and clear endpoints, the list badge,
// the content-url digest, the static checks on the approval screen, the presenter data state, and that hostile
// error text is stored and returned as inert JSON text.
import type { Principal } from "@pptaken/core";
import { afterEach, describe, expect, it } from "vitest";
import { SCRIPT_ERRORS_MAX_BODY_BYTES } from "../src/app.js";
import { createToken, type Harness, makeHarness, setupOwner } from "./helpers.js";

const agent: Principal = {
  actor: "agent",
  workspaceId: "default",
  scopes: new Set(["decks:read", "decks:write"]),
  tokenId: "tok",
};

const BROKEN = "var go = root.querySelector('.go'); go.id;";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function approvedDeck(script = BROKEN) {
  h = await makeHarness({ PPTAKEN_SCRIPTS: "owner" });
  const cookie = await setupOwner(h);
  const created = await h.server.services.core.createPresentation(agent, {
    title: "Qubits",
    slides: [
      { id: "intro", title: "Intro", html: "<p class='go'>x</p>", script },
      { id: "two", html: "<p>two</p>" },
    ],
  });
  const id = created.presentationId;
  const digest = created.scripts.digest as string;
  const res = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
    body: { digest },
    cookie,
  });
  expect(res.status).toBe(200);
  return { h, cookie, id, digest };
}

const error = (over: Record<string, unknown> = {}) => ({
  kind: "setup",
  slideId: "intro",
  name: "ReferenceError",
  message: "root is not defined",
  stack: "at slide intro, line 1:10",
  count: 1,
  ...over,
});

describe("POST /api/v1/decks/:id/script-errors", () => {
  it("stores the owner's reports for the approved digest and lists them", async () => {
    const { h, cookie, id, digest } = await approvedDeck();
    const res = await h.api("POST", `/api/v1/decks/${id}/script-errors`, {
      body: { digest, errors: [error(), error({ count: 2 })] },
      cookie,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1, dropped: 0 });
    const list = await h.api("GET", `/api/v1/decks/${id}/script-errors`, { cookie });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const body = await list.json();
    expect(body).toMatchObject({ status: "errors", state: "approved", digest, previous: [] });
    expect(body.approvedAt).toMatch(/^\d{4}-/);
    expect(body.current[0]).toMatchObject({
      slideId: "intro",
      slideTitle: "Intro",
      kind: "setup",
      count: 3,
      hint: "declare-root",
    });
    // The list badge.
    const decks = await (await h.api("GET", "/api/v1/decks", { cookie })).json();
    expect(decks.decks[0].scriptErrors).toBe(1);
  });

  it("ignores a report for another digest and stores nothing", async () => {
    const { h, cookie, id } = await approvedDeck();
    const res = await h.api("POST", `/api/v1/decks/${id}/script-errors`, {
      body: { digest: "b".repeat(64), errors: [error()] },
      cookie,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 0, ignored: "digest_mismatch" });
    const body = await (await h.api("GET", `/api/v1/decks/${id}/script-errors`, { cookie })).json();
    expect(body.status).toBe("no_errors");
  });

  it("needs the owner session, the CSRF header and a same-origin request; tokens are refused", async () => {
    const { h, cookie, id, digest } = await approvedDeck();
    const path = `/api/v1/decks/${id}/script-errors`;
    const payload = { digest, errors: [error()] };
    expect((await h.api("POST", path, { body: payload })).status).toBe(401);
    expect(
      (await h.api("POST", path, { body: payload, cookie, headers: { "X-PPTaken-CSRF": "" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await h.api("POST", path, {
          body: payload,
          cookie,
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.api("POST", path, {
          body: payload,
          cookie,
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    const { secret } = await createToken(h, cookie);
    const withToken = await h.api("POST", path, {
      body: payload,
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(withToken.status).toBe(401);
    expect(
      (await h.api("GET", path, { headers: { Authorization: `Bearer ${secret}` } })).status,
    ).toBe(401);
    const body = await (await h.api("GET", path, { cookie })).json();
    expect(body.current).toEqual([]);
  });

  it("validates the body strictly and limits its size", async () => {
    const { h, cookie, id, digest } = await approvedDeck();
    const path = `/api/v1/decks/${id}/script-errors`;
    for (const bad of [
      { errors: [] },
      { digest: "x", errors: [] },
      { digest, errors: "nope" },
      { digest, errors: [], extra: 1 },
      { digest, errors: Array.from({ length: 51 }, () => error()) },
    ]) {
      expect((await h.api("POST", path, { body: bad, cookie })).status, JSON.stringify(bad)).toBe(
        400,
      );
    }
    const huge = { digest, errors: [error({ message: "x".repeat(SCRIPT_ERRORS_MAX_BODY_BYTES) })] };
    expect((await h.api("POST", path, { body: huge, cookie })).status).toBe(413);
    expect((await h.api("POST", path, { raw: "{not json", cookie })).status).toBe(400);
  });

  it("rate limits per deck", async () => {
    const { h, cookie, id, digest } = await approvedDeck();
    const path = `/api/v1/decks/${id}/script-errors`;
    let limited = 0;
    for (let i = 0; i < 35; i++) {
      const r = await h.api("POST", path, { body: { digest, errors: [error()] }, cookie });
      if (r.status === 429) {
        limited++;
        expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
      }
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("keeps XSS-looking messages as inert JSON text", async () => {
    const { h, cookie, id, digest } = await approvedDeck();
    const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>\u202e";
    await h.api("POST", `/api/v1/decks/${id}/script-errors`, {
      body: { digest, errors: [error({ message: evil, name: "<b>X</b>" })] },
      cookie,
    });
    const res = await h.api("GET", `/api/v1/decks/${id}/script-errors`, { cookie });
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const body = await res.json();
    expect(body.current[0].message).toBe("<img src=x onerror=alert(1)><script>alert(2)</script>");
    expect(body.current[0].name).toBe("<b>X</b>");
  });

  it("DELETE clears them (owner, CSRF)", async () => {
    const { h, cookie, id, digest } = await approvedDeck();
    const path = `/api/v1/decks/${id}/script-errors`;
    await h.api("POST", path, { body: { digest, errors: [error()] }, cookie });
    expect(
      (await h.api("DELETE", path, { cookie, headers: { "X-PPTaken-CSRF": "" } })).status,
    ).toBe(403);
    expect((await h.api("DELETE", path)).status).toBe(401);
    expect((await h.api("DELETE", path, { cookie })).status).toBe(204);
    const body = await (await h.api("GET", path, { cookie })).json();
    expect(body.current).toEqual([]);
  });
});

describe("related surfaces", () => {
  it("content-url gives the owner's page the digest; the review lists static checks", async () => {
    const { h, cookie, id, digest } = await approvedDeck();
    const url = await (await h.api("GET", `/api/v1/decks/${id}/content-url`, { cookie })).json();
    expect(url).toMatchObject({ scripts: "running", digest });
    const review = await (await h.api("GET", `/api/v1/decks/${id}/scripts`, { cookie })).json();
    expect(review.checks).toEqual([
      expect.objectContaining({
        code: "SCRIPT_UNDECLARED_ROOT",
        slideId: "intro",
        path: "slides[0].script",
      }),
    ]);
  });

  it("presenter data says when scripts will not run, and why", async () => {
    h = await makeHarness({ PPTAKEN_SCRIPTS: "owner" });
    const cookie = await setupOwner(h);
    const created = await h.server.services.core.createPresentation(agent, {
      title: "Q",
      slides: [{ id: "a", html: "<p>a</p>", script: "slide.root.id;" }],
    });
    const data = await (
      await h.api("GET", `/api/v1/decks/${created.presentationId}/presenter`, { cookie })
    ).json();
    expect(data.scripts).toBe("pending");
  });
});
