// SPDX-License-Identifier: AGPL-3.0-or-later
// Ingest-time vendoring and the HTML importer through the server (ADR-022): MCP tools, content route, asset route,
// panel API, operator switch. The real fetcher runs over a fake network (browser/fake-cdn.mjs).
import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT, fakeCdn, LIB_SOURCE, URLS } from "../browser/fake-cdn.mjs";
import { ConfigError, loadConfig } from "../src/config.js";
import {
  createToken,
  type Harness,
  listen,
  makeHarness,
  mcpClient,
  ORIGIN,
  setupOwner,
} from "./helpers.js";

let h: Harness | undefined;
let closeHttp: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeHttp?.();
  closeHttp = undefined;
  await h?.cleanup();
  h = undefined;
});

async function start(env: Record<string, string> = { PPTAKEN_SCRIPTS: "owner" }) {
  const cdn = fakeCdn();
  h = await makeHarness(env, { vendorNetwork: { resolve: cdn.resolve, transport: cdn.transport } });
  const cookie = await setupOwner(h);
  const { secret } = await createToken(h, cookie, {
    name: "agent",
    scopes: ["decks:read", "decks:write"],
  });
  const http = await listen(h.server);
  closeHttp = http.close;
  const { call } = await mcpClient(http.base, secret);
  return { h, cookie, call, cdn };
}

describe("configuration", () => {
  it("defaults to on and validates the switch and host lists", () => {
    expect(loadConfig({}).vendorFetch).toBe(true);
    expect(loadConfig({ PPTAKEN_VENDOR_FETCH: "off" }).vendorFetch).toBe(false);
    expect(() => loadConfig({ PPTAKEN_VENDOR_FETCH: "maybe" })).toThrow(ConfigError);
    expect(
      loadConfig({ PPTAKEN_VENDOR_ALLOW_HOSTS: "cdn.jsdelivr.net, *.gstatic.com" })
        .vendorAllowHosts,
    ).toEqual(["cdn.jsdelivr.net", "gstatic.com"]);
    expect(() => loadConfig({ PPTAKEN_VENDOR_DENY_HOSTS: "bad host" })).toThrow(ConfigError);
  });
});

describe("import_html_deck over MCP", () => {
  it("imports an artifact, vendors every resource, and reports it", async () => {
    const { call, cdn, h, cookie } = await start();
    const r = await call("import_html_deck", { html: ARTIFACT });
    expect(r.isError).toBe(false);
    expect(r.body.heuristic).toBe("slide-class");
    expect(r.body.slide_count).toBe(2);
    expect(r.body.interactive.status).toBe("pending_owner_approval");
    expect(r.body.interactive.approve_url).toMatch(/\/decks\/[0-9A-Z]{26}\/approve$/);
    const kinds = (r.body.vendored as { kind: string; status: string }[]).map(
      (v) => `${v.kind}:${v.status}`,
    );
    expect(kinds.sort()).toEqual([
      "font:vendored",
      "image:vendored",
      "script:vendored",
      "stylesheet:vendored",
    ]);
    expect(cdn.requests).toEqual(
      expect.arrayContaining([URLS.css2, URLS.font, URLS.libRange, URLS.libPinned, URLS.image]),
    );
    const lib = r.body.interactive.libs[0];
    expect(lib).toMatchObject({
      name: "mini-chart",
      version: "1.2.3",
      source: URLS.libRange,
      finalUrl: URLS.libPinned,
    });

    // Panel: provenance and switch; the approval screen shows the deck script.
    const id = r.body.presentation_id as string;
    const detail = await (await h.api("GET", `/api/v1/decks/${id}`, { cookie })).json();
    expect(detail.vendorFetch).toBe("on");
    expect(detail.vendored.find((v: { kind: string }) => v.kind === "script").redirects).toEqual([
      URLS.libPinned,
    ]);
    const review = await (await h.api("GET", `/api/v1/decks/${id}/scripts`, { cookie })).json();
    expect(review.deckScript).toBe(true);
    expect(review.deckSource.source).toContain("function draw()");
    expect(review.libs[0].bytes).toBe(Buffer.byteLength(LIB_SOURCE));
  });

  it("serves the vendored font, never the vendored script, from the asset route", async () => {
    const { call, h, cookie } = await start();
    const r = await call("import_html_deck", { html: ARTIFACT });
    const id = r.body.presentation_id as string;
    const { url } = await (
      await h.api("GET", `/api/v1/decks/${id}/content-url`, { cookie })
    ).json();
    const doc = await h.server.app.request(String(url).replace(/^https?:\/\/[^/]+/, ORIGIN));
    const html = await doc.text();
    expect(doc.headers.get("content-security-policy")).toContain(
      "font-src http://localhost:8080/c/asset/",
    );
    const face =
      /@font-face\{font-family:"Vendored Mono";[^}]*src:url\(([^)]+)\) format\("woff2"\)/.exec(
        html,
      );
    expect(face).not.toBeNull();
    const font = await h.server.app.request((face?.[1] ?? "").replace(/^https?:\/\/[^/]+/, ORIGIN));
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("access-control-allow-origin")).toBe("*");
    const libSha = r.body.interactive.libs[0].sha256 as string;
    const assetBase = (face?.[1] ?? "").replace(/[0-9a-f]{64}$/, "");
    const js = await h.server.app.request(
      `${assetBase}${libSha}`.replace(/^https?:\/\/[^/]+/, ORIGIN),
    );
    expect(js.status).toBe(404);
    // The static document contains no third-party URL at all.
    expect(html).not.toMatch(/googleapis|gstatic|jsdelivr|images\.example/);
  });

  it("the scripted document inlines the escaped library, then the deck script, after approval", async () => {
    const { call, h, cookie } = await start();
    const r = await call("import_html_deck", { html: ARTIFACT });
    const id = r.body.presentation_id as string;
    const ok = await h.api("POST", `/api/v1/decks/${id}/scripts/approve`, {
      cookie,
      body: { digest: r.body.interactive.digest },
    });
    expect(ok.status).toBe(200);
    const content = await (
      await h.api("GET", `/api/v1/decks/${id}/content-url`, { cookie })
    ).json();
    expect(content.scripts).toBe("running");
    const doc = await h.server.app.request(
      String(content.url).replace(/^https?:\/\/[^/]+/, ORIGIN),
    );
    const html = await doc.text();
    expect(html).toContain("<\\/script><\\u0073cript>alert(1)<\\/script>");
    expect(html.indexOf("root.MiniChart")).toBeLessThan(html.indexOf("function draw()"));
    expect(html.match(/<\/script>/g)?.length).toBe(html.match(/<script[ >]/g)?.length);
  });

  it("add_asset accepts an https URL; blocked addresses are refused", async () => {
    const { call } = await start();
    const created = await call("create_presentation", {
      title: "A",
      slides: [{ html: "<p>x</p>" }],
    });
    const id = created.body.presentation_id;
    const ok = await call("add_asset", { presentation_id: id, source: { url: URLS.image } });
    expect(ok.isError).toBe(false);
    expect(ok.body.media_type).toBe("image/png");
    const bad = await call("add_asset", {
      presentation_id: id,
      source: { url: "https://127.0.0.1/x.png" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.body.code).toBe("FETCH_BLOCKED");
    expect(bad.body.path).toBe("source.url");
  });

  it("create_presentation with google_fonts and a CDN lib URL", async () => {
    const { call } = await start();
    const r = await call("create_presentation", {
      title: "G",
      theme: { google_fonts: [{ family: "Vendored Mono", weights: [400] }] },
      libs: [URLS.libRange],
      slides: [{ html: "<p style=\"font-family:'Vendored Mono'\">x</p>", script: "MiniChart;" }],
    });
    expect(r.isError).toBe(false);
    expect(r.body.warnings.filter((w: { code: string }) => w.code.startsWith("VENDOR"))).toEqual(
      [],
    );
    const read = await call("get_presentation", {
      presentation_id: r.body.presentation_id,
      include: ["theme"],
    });
    expect(read.body.theme.fontFaces[0].family).toBe("Vendored Mono");
    expect(read.body.libs[0].finalUrl).toBe(URLS.libPinned);
  });

  it("whoami and the guide describe vendoring", async () => {
    const { call } = await start();
    const who = await call("whoami");
    expect(who.body.vendoring.enabled).toBe(true);
    expect(who.body.vendoring.max_urls_per_write).toBe(100);
    const guide = await call("get_authoring_guide");
    expect(guide.body.guide).toContain("## External resources (vendored)");
    expect(guide.body.guide).toContain("import_html_deck");
    expect(guide.body.guide).not.toContain(
      "Vendoring other libraries from a CDN URL is not available yet",
    );
  });
});

describe("operator switch off", () => {
  it("refuses writes with external resources with a clear message and shows it in the panel", async () => {
    const { call, h, cookie, cdn } = await start({ PPTAKEN_VENDOR_FETCH: "off" });
    const r = await call("import_html_deck", { html: ARTIFACT });
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe("FETCH_BLOCKED");
    expect(r.body.message).toMatch(/turned vendoring off/);
    expect(cdn.requests).toEqual([]);
    const plain = await call("create_presentation", { title: "P", slides: [{ html: "<p>x</p>" }] });
    const detail = await (
      await h.api("GET", `/api/v1/decks/${plain.body.presentation_id}`, { cookie })
    ).json();
    expect(detail.vendorFetch).toBe("off");
    const who = await call("whoami");
    expect(who.body.vendoring.enabled).toBe(false);
  });
});
