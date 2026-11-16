// SPDX-License-Identifier: AGPL-3.0-or-later
// PowerPoint import end to end on real SQLite + blob-fs, with the real converter in its isolated worker: upload ->
// the deck exists -> converter and sanitizer warnings are surfaced -> the image is served from the content origin.
import type { PptxConverter } from "@pptaken/core";
import { ownerPrincipal } from "@pptaken/core";
import { pngBytes } from "@pptaken/testing";
import { buildPptx, inch, ph, picture } from "@pptaken/testing/pptx";
import { afterEach, describe, expect, it } from "vitest";
import { createPptxConverter } from "../src/pptx.js";
import { type Harness, makeHarness, ORIGIN, setupOwner } from "./helpers.js";

const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function harness(env: Record<string, string> = {}, convertPptx?: PptxConverter) {
  const h = await makeHarness(env, convertPptx === undefined ? {} : { convertPptx });
  harnesses.push(h);
  const cookie = await setupOwner(h);
  return { h, cookie };
}

function upload(
  h: Harness,
  body: Uint8Array,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  return h.server.app.request(`${ORIGIN}/api/v1/decks/import-pptx`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "X-PPTaken-CSRF": "1",
      "Content-Type": PPTX_TYPE,
      ...(cookie === undefined ? {} : { Cookie: cookie }),
      ...headers,
    },
    body,
  });
}

const png = pngBytes(32, 24);

function sample(): Uint8Array {
  return buildPptx({
    title: "Imported talk",
    media: { "image1.png": png },
    slides: [
      {
        shapes:
          ph(2, "title", null, ["Welcome"]) +
          picture(4, "rId2", { x: inch(1), y: inch(2), w: inch(2), h: inch(1.5) }, "Team photo"),
        rels: [{ id: "rId2", type: "image", target: "../media/image1.png" }],
        notes: "Remember to *smile*",
      },
      {
        shapes:
          ph(2, "title", null, ["Numbers"]) +
          `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="${inch(4)}" cy="${inch(3)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>`,
      },
    ],
  });
}

describe("POST /api/v1/decks/import-pptx", () => {
  it("creates a deck from a .pptx, reports warnings and serves its image", async () => {
    // The real isolated converter, wrapped to append markup the sanitizer must remove (proves its warnings surface).
    const real = createPptxConverter({ timeoutMs: 30_000 });
    const wrapped: PptxConverter = async (bytes, limits) => {
      const out = await real(bytes, limits);
      const deck = out.deck as { slides: { html: string }[] };
      const first = deck.slides[0];
      if (first !== undefined) first.html += '<p onclick="alert(1)">x</p>';
      return out;
    };
    const { h, cookie } = await harness({}, wrapped);
    const res = await upload(h, sample(), cookie);
    expect(res.status, await res.clone().text()).toBe(201);
    const body = await res.json();
    expect(body.deck).toMatchObject({
      title: "Imported talk",
      slideCount: 2,
      revision: 1,
      createdBy: "owner",
    });
    expect(body.assetCount).toBe(1);
    const codes = body.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain("PPTX_FEATURE_DROPPED");
    expect(codes).toContain("REMOVED_ATTRIBUTE");
    expect(body.warnings).toContainEqual(
      expect.objectContaining({
        code: "PPTX_FEATURE_DROPPED",
        slideId: "slide-2",
        path: "slides[1]",
        name: "chart",
      }),
    );

    // The deck is in the list and holds the notes and the image.
    const list = await (await h.api("GET", "/api/v1/decks", { cookie })).json();
    expect(list.decks.map((d: { id: string }) => d.id)).toContain(body.deck.id);
    const revision = await h.server.services.core.getRevision(ownerPrincipal(), {
      presentationId: body.deck.id,
      revision: 1,
    });
    expect(revision.document.slides[0]?.notes).toBe("Remember to \\*smile\\*");
    expect(revision.document.slides[0]?.html).not.toContain("onclick");

    // The content document references the asset and the content origin serves it.
    const { url } = await (
      await h.api("GET", `/api/v1/decks/${body.deck.id}/content-url`, { cookie })
    ).json();
    const doc = await (await h.server.app.request(url)).text();
    const assetUrl = /src="(http:\/\/localhost:8080\/c\/asset\/[^"]+)"/.exec(doc)?.[1] as string;
    expect(assetUrl).toBeDefined();
    const img = await h.server.app.request(assetUrl);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(png);

    const audit = await h.server.services.core.listAuditLog(ownerPrincipal(), {
      target: `deck:${body.deck.id}`,
    });
    expect(audit.items[0]).toMatchObject({ action: "presentation.import_pptx", result: "ok" });
  });

  it("explains files it cannot import", async () => {
    const { h, cookie } = await harness();
    const legacy = new Uint8Array(4096);
    legacy.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
    legacy.set(Buffer.from("PowerPoint Document", "utf16le"), 1024);
    let res = await upload(h, legacy, cookie);
    expect(res.status).toBe(400);
    let body = await res.json();
    expect(body.error.message).toMatch(/97-2003/);
    expect(body.error.hint).toMatch(/save it as \.pptx/);

    res = await upload(h, new TextEncoder().encode("not a presentation"), cookie);
    expect(res.status).toBe(400);
    body = await res.json();
    expect(body.error.message).toMatch(/not a \.pptx/);

    res = await upload(h, sample(), cookie, { "Content-Type": "text/plain" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/must be a \.pptx/);
  });

  it("requires the owner session and the CSRF header, and limits the size", async () => {
    const { h, cookie } = await harness({ PPTAKEN_MAX_IMPORT_MB: "1" });
    expect((await upload(h, sample())).status).toBe(401);
    expect((await upload(h, sample(), cookie, { "X-PPTaken-CSRF": "" })).status).toBe(403);
    expect((await upload(h, sample(), cookie, { Origin: "https://evil.example" })).status).toBe(
      403,
    );
    const big = new Uint8Array(2 * 1024 * 1024);
    big.set([0x50, 0x4b, 3, 4]);
    const res = await upload(h, big, cookie);
    expect(res.status).toBe(413);
  });

  it("rate-limits imports per IP", async () => {
    const { h, cookie } = await harness();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await upload(h, new TextEncoder().encode("x"), cookie)).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
