// SPDX-License-Identifier: AGPL-3.0-or-later
// Export and import end to end on real SQLite + blob-fs: a deck with images created through MCP is exported in both
// formats from one instance and imported into a second, fresh instance.
import { createHash } from "node:crypto";
import { ownerPrincipal } from "@pptaken/core";
import { readArchive, writeArchive, writeZip } from "@pptaken/export";
import type { Deck } from "@pptaken/schema";
import { gifBytes, pngBytes } from "@pptaken/testing";
import { afterEach, describe, expect, it } from "vitest";
import { contentDisposition } from "../src/routes-export.js";
import {
  createToken,
  type Harness,
  listen,
  makeHarness,
  mcpClient,
  ORIGIN,
  setupOwner,
  talkArgs,
} from "./helpers.js";

const harnesses: Harness[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function harness(env: Record<string, string> = {}) {
  const h = await makeHarness(env);
  harnesses.push(h);
  const cookie = await setupOwner(h);
  return { h, cookie };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const png = pngBytes(64, 48);
const gif = gifBytes(10, 10);

/** Creates the 20-slide talk through MCP and puts two images on slides. */
async function talkWithImages(h: Harness, cookie: string) {
  const { secret } = await createToken(h, cookie);
  const live = await listen(h.server);
  stops.push(live.close);
  const { client, call } = await mcpClient(live.base, secret);
  const created = await call("create_presentation", talkArgs());
  const id = created.body.presentation_id as string;
  for (const [bytes, type] of [
    [png, "image/png"],
    [gif, "image/gif"],
  ] as const) {
    const r = await call("add_asset", {
      presentation_id: id,
      filename: "x",
      source: { base64: Buffer.from(bytes).toString("base64"), media_type: type },
    });
    expect(r.isError, r.text).toBe(false);
  }
  const edited = await call("update_slides", {
    presentation_id: id,
    expected_revision: 1,
    upsert: [
      {
        id: "agenda",
        html: `<h2>Agenda</h2><img src="asset:${sha(png)}" alt="" width="64" height="48">`,
      },
      { id: "risks", css: `[data-slide="risks"] h2{background:url(asset:${sha(gif)})}` },
    ],
  });
  expect(edited.isError, edited.text).toBe(false);
  await client.close();
  return { id, secret };
}

function download(h: Harness, path: string, cookie?: string, headers: Record<string, string> = {}) {
  return h.server.app.request(`${ORIGIN}${path}`, {
    headers: { ...(cookie === undefined ? {} : { Cookie: cookie }), ...headers },
  });
}

function upload(
  h: Harness,
  body: Uint8Array,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  return h.server.app.request(`${ORIGIN}/api/v1/decks/import`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "X-PPTaken-CSRF": "1",
      "Content-Type": "application/zip",
      ...(cookie === undefined ? {} : { Cookie: cookie }),
      ...headers,
    },
    body,
  });
}

describe("export and import", () => {
  it("round-trips a deck with images into a fresh instance", async () => {
    const a = await harness();
    const { id } = await talkWithImages(a.h, a.cookie);
    const source = await a.h.server.services.core.getRevision(ownerPrincipal(), {
      presentationId: id,
      revision: 2,
    });
    const note = source.document.slides[0]?.notes as string;
    expect(note.length).toBeGreaterThan(10);

    // HTML: a download, no notes by default, images and fonts inlined, nothing external.
    let res = await download(a.h, `/api/v1/decks/${id}/export?format=html`, a.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="how-a-talk-gets-taken-care-of.html"; filename*=UTF-8''How%20a%20talk%20gets%20taken%20care%20of.html`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const html = await res.text();
    expect(html).not.toContain(note.slice(0, 30));
    expect(html).toContain(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    expect(html).toContain("data:image/gif;base64,");
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(res.headers.get("x-pptaken-notes")).toBe("0");

    // HTML with notes on request.
    res = await download(a.h, `/api/v1/decks/${id}/export?format=html&notes=1`, a.cookie);
    expect(await res.text()).toContain(JSON.stringify(note).slice(1, 30));

    // .pkn: notes included by default; notes=0 strips them.
    res = await download(a.h, `/api/v1/decks/${id}/export?format=pptaken`, a.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(
      'filename="how-a-talk-gets-taken-care-of.pkn"',
    );
    const archive = new Uint8Array(await res.arrayBuffer());
    const read = readArchive(archive);
    expect(read.manifest).toMatchObject({
      format: "pptaken.archive",
      formatVersion: 1,
      notes: true,
      generator: "pptaken 0.1.0",
    });
    expect(read.assets.map((x) => x.sha256).sort()).toEqual([sha(png), sha(gif)].sort());
    expect(read.deck).toEqual(source.document);
    const stripped = readArchive(
      new Uint8Array(
        await (
          await download(a.h, `/api/v1/decks/${id}/export?format=pptaken&notes=0`, a.cookie)
        ).arrayBuffer(),
      ),
    );
    expect(JSON.stringify(stripped.deck)).not.toContain(note.slice(0, 30));
    // An older revision.
    res = await download(a.h, `/api/v1/decks/${id}/export?format=pptaken&revision=1`, a.cookie);
    expect(res.headers.get("x-pptaken-revision")).toBe("1");

    // Import into a second, fresh instance.
    const b = await harness();
    res = await upload(b.h, archive, b.cookie);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      deck: {
        title: "How a talk gets taken care of",
        lang: "en",
        slideCount: 20,
        revision: 1,
        createdBy: "owner",
      },
      assetCount: 2,
      warnings: [],
    });
    const imported = await b.h.server.services.core.getRevision(ownerPrincipal(), {
      presentationId: body.deck.id,
      revision: 1,
    });
    expect(imported.document).toEqual(source.document);
    const assets = await b.h.server.services.core.listAssets(ownerPrincipal(), {
      presentationId: body.deck.id,
    });
    expect(assets.map((x) => x.sha256).sort()).toEqual([sha(png), sha(gif)].sort());
    // Listed in the panel; importing again creates a second deck that shares the assets (deduplicated).
    res = await upload(b.h, archive, b.cookie);
    expect(res.status).toBe(201);
    const list = await b.h.api("GET", "/api/v1/decks", { cookie: b.cookie }).then((r) => r.json());
    expect(list.decks).toHaveLength(2);
    await expect(
      b.h.server.services.storage.assets.get("default", sha(png)),
    ).resolves.toMatchObject({ bytes: png.length });

    // The audit log has both actions; logs never hold the archive or the notes.
    const auditA = await a.h.server.services.core.listAuditLog(ownerPrincipal(), {
      target: `deck:${id}`,
    });
    expect(auditA.items.map((e) => e.action)).toContain("presentation.export");
    expect(b.h.logs.join("\n")).not.toContain(note.slice(0, 30));
  });

  it("refuses hostile or invalid archives with clear errors", async () => {
    const { h, cookie } = await harness();
    const deck: Deck = {
      schemaVersion: 1,
      title: "x",
      aspectRatio: "16:9",
      slides: [{ id: "a", title: "", html: "<p>a</p>" }],
    };
    const good = writeArchive({ deck, assets: [], generator: "test" }).bytes;
    const cases: [string, Uint8Array, RegExp][] = [
      ["not a zip", new TextEncoder().encode("hello"), /not a ZIP/],
      ["zip slip", writeZipUnsafe("../../evil.json"), /Unsafe entry name|Unexpected entry/],
      [
        "unexpected entry",
        writeZip([{ name: "evil.sh", data: new Uint8Array(3) }]),
        /Unexpected entry/,
      ],
      [
        "no manifest",
        writeZip([{ name: "deck.json", data: new TextEncoder().encode("{}") }]),
        /manifest\.json is missing/,
      ],
      [
        "future version",
        writeZip([
          {
            name: "manifest.json",
            data: new TextEncoder().encode(
              JSON.stringify({ format: "pptaken.archive", formatVersion: 9 }),
            ),
          },
          { name: "deck.json", data: new TextEncoder().encode("{}") },
        ]),
        /format version 9/,
      ],
    ];
    for (const [label, bytes, message] of cases) {
      const res = await upload(h, bytes, cookie);
      expect(res.status, label).toBe(400);
      const body = await res.json();
      expect(body.error.code, label).toBe("VALIDATION_ERROR");
      expect(body.error.message, label).toMatch(message);
    }
    // A valid archive with an invalid deck: the core's validation error.
    const badDeck = writeArchive({
      deck: { ...deck, slides: [] } as never,
      assets: [],
      generator: "t",
    }).bytes;
    let res = await upload(h, badDeck, cookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/slides/);
    // Hostile HTML is re-sanitized, not refused.
    const hostile = writeArchive({
      deck: {
        ...deck,
        slides: [{ id: "a", title: "", html: '<p onclick="x()">a</p><script>alert(1)</script>' }],
      },
      assets: [],
      generator: "t",
    }).bytes;
    res = await upload(h, hostile, cookie);
    expect(res.status).toBe(201);
    const imported = await res.json();
    expect(imported.warnings.map((w: { code: string }) => w.code)).toContain("REMOVED_ELEMENT");
    const rev = await h.server.services.core.getRevision(ownerPrincipal(), {
      presentationId: imported.deck.id,
      revision: 1,
    });
    expect(rev.document.slides[0]?.html).not.toMatch(/script|onclick/);
    // Wrong content type, empty body.
    res = await upload(h, good, cookie, { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
    res = await upload(h, new Uint8Array(), cookie);
    expect(res.status).toBe(400);
  });

  it("applies the import size limit before reading and rate-limits imports", async () => {
    const { h, cookie } = await harness({ PPTAKEN_MAX_IMPORT_MB: "1" });
    let res = await upload(h, new Uint8Array(1024 * 1024 + 1), cookie);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    for (let i = 0; i < 10; i++) await upload(h, new Uint8Array(10), cookie);
    res = await upload(h, new Uint8Array(10), cookie);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("is owner-session only, CSRF-protected, and hides missing or trashed decks", async () => {
    const { h, cookie } = await harness();
    const { id, secret } = await talkWithImages(h, cookie);
    const good = writeArchive({
      deck: {
        schemaVersion: 1,
        title: "x",
        aspectRatio: "16:9",
        slides: [{ id: "a", title: "", html: "<p>a</p>" }],
      },
      assets: [],
      generator: "t",
    }).bytes;
    // No session, or an agent token: 401.
    expect((await download(h, `/api/v1/decks/${id}/export?format=html`)).status).toBe(401);
    const bearer = { Authorization: `Bearer ${secret}` };
    expect(
      (await download(h, `/api/v1/decks/${id}/export?format=pptaken`, undefined, bearer)).status,
    ).toBe(401);
    expect((await upload(h, good, undefined, bearer)).status).toBe(401);
    // Import without the CSRF header or from another origin: 403.
    expect((await upload(h, good, cookie, { "X-PPTaken-CSRF": "" })).status).toBe(403);
    expect((await upload(h, good, cookie, { Origin: "https://evil.example" })).status).toBe(403);
    // Parameters.
    expect((await download(h, `/api/v1/decks/${id}/export?format=pdf`, cookie)).status).toBe(400);
    expect(
      (await download(h, `/api/v1/decks/${id}/export?format=html&notes=yes`, cookie)).status,
    ).toBe(400);
    expect(
      (await download(h, `/api/v1/decks/${id}/export?format=html&revision=-1`, cookie)).status,
    ).toBe(400);
    expect(
      (await download(h, `/api/v1/decks/${id}/export?format=html&revision=99`, cookie)).status,
    ).toBe(404);
    expect(
      (await download(h, "/api/v1/decks/01J0000000000000000000000X/export?format=html", cookie))
        .status,
    ).toBe(404);
    expect((await download(h, "/api/v1/decks/nope/export?format=html", cookie)).status).toBe(404);
    // Trashed: NOT_FOUND.
    await h.server.services.core.trashPresentation(ownerPrincipal(), { presentationId: id });
    const res = await download(h, `/api/v1/decks/${id}/export?format=html`, cookie);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    // Other API routes are not affected by this router (they still get the JSON-only rule and body limit).
    const other = await h.api("POST", "/api/v1/tokens", { cookie, raw: "x".repeat(70 * 1024) });
    expect(other.status).toBe(413);
  });
});

describe("contentDisposition", () => {
  it("cannot be used for header injection", () => {
    expect(contentDisposition("a.html", 'x"\r\nSet-Cookie: a=b;.html')).toBe(
      `attachment; filename="a.html"; filename*=UTF-8''x%22%0D%0ASet-Cookie%3A%20a%3Db%3B.html`,
    );
    expect(() => contentDisposition('a"b', "x")).toThrow(TypeError);
  });
});

/** A ZIP whose single entry has an unsafe name (the writer refuses to make one, so patch the bytes). */
function writeZipUnsafe(name: string): Uint8Array {
  const placeholder = "x".repeat(name.length);
  const zip = writeZip([{ name: placeholder, data: new Uint8Array(3) }]);
  const text = Buffer.from(zip);
  let at = text.indexOf(placeholder);
  while (at >= 0) {
    text.write(name, at, "latin1");
    at = text.indexOf(placeholder, at + 1);
  }
  return new Uint8Array(text);
}
