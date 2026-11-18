// SPDX-License-Identifier: AGPL-3.0-or-later
// Ingest-time vendoring (ADR-022), core side: the orchestration over a fake fetcher (no network).

import { readFileSync } from "node:fs";
import {
  type AuditEntry,
  libLabelOf,
  looksLikeModule,
  ownerPrincipal,
  type Principal,
  scriptsDigest,
  sniffFont,
  VendorError,
  type VendorFetcher,
  type VendorFetchRequest,
} from "@pptaken/core";
import { agentPrincipal, createTestCore, pngBytes } from "@pptaken/testing";
import { describe, expect, it } from "vitest";

const enc = (text: string) => new TextEncoder().encode(text);

/** A structurally valid WOFF2 header (the core checks the container, not the glyphs). */
export function woff2(seed = 0, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set(enc("wOF2"), 0);
  b.set([0, 1, 0, 0], 4);
  new DataView(b.buffer).setUint32(8, size);
  new DataView(b.buffer).setUint16(12, 1);
  b[size - 1] = seed;
  return b;
}

type Route =
  | { status?: "ok"; bytes: Uint8Array; finalUrl?: string; redirects?: string[] }
  | VendorError;

/** A fake fetcher: a URL → response map, recording every request. */
function fakeFetcher(routes: Record<string, Route>, enabled = true) {
  const calls: VendorFetchRequest[] = [];
  const fetcher: VendorFetcher = {
    enabled,
    async fetch(request) {
      calls.push(request);
      const route = routes[request.url];
      if (route === undefined) throw new VendorError("http-error", "The server answered HTTP 404");
      if (route instanceof VendorError) throw route;
      return {
        url: request.url,
        finalUrl: route.finalUrl ?? request.url,
        redirects: route.redirects ?? [],
        bytes: route.bytes,
        contentType: null,
      };
    },
  };
  return { fetcher, calls };
}

const CSS2 = "https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap";
const LATIN = "https://fonts.gstatic.com/s/lora/v1/latin.woff2";
const LATIN_EXT = "https://fonts.gstatic.com/s/lora/v1/latin-ext.woff2";
const CYRILLIC = "https://fonts.gstatic.com/s/lora/v1/cyrillic.woff2";
/** Real-looking Google Fonts css2 output: one face per subset with unicode-range. */
const GOOGLE_CSS = `/* cyrillic */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url(${CYRILLIC}) format('woff2');
  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
/* latin-ext */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url(${LATIN_EXT}) format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
/* latin */
@font-face {
  font-family: 'Lora';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url(${LATIN}) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
`;
const CHART = "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js";
const CHART_FINAL = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
const IMG = "https://images.example.org/photo.png";

function standardRoutes(): Record<string, Route> {
  return {
    [CSS2]: { bytes: enc(GOOGLE_CSS) },
    [LATIN]: { bytes: woff2(1) },
    [LATIN_EXT]: { bytes: woff2(2) },
    [CYRILLIC]: { bytes: woff2(3) },
    [CHART]: {
      bytes: enc("(function(g){g.Chart=function(){};})(this);"),
      finalUrl: CHART_FINAL,
      redirects: [CHART_FINAL],
    },
    [IMG]: { bytes: pngBytes() },
  };
}

const agent: Principal = agentPrincipal();
const owner = ownerPrincipal();

describe("vendoring on write (ADR-022)", () => {
  it("vendors Google Fonts CSS with its unicode-range subsets into theme.fontFaces", async () => {
    const { fetcher, calls } = fakeFetcher(standardRoutes());
    const { core } = createTestCore({ vendor: fetcher });
    const r = await core.createPresentation(agent, {
      title: "Fonts",
      theme: { css: `@import url("${CSS2}");.t{font-family:'Lora',serif}` },
      slides: [{ html: '<p class="t">Hola</p>' }],
    });
    expect(r.warnings.filter((w) => w.code.startsWith("VENDOR"))).toEqual([]);
    expect(calls.map((c) => c.url).sort()).toEqual([CSS2, CYRILLIC, LATIN, LATIN_EXT].sort());
    const view = await core.getPresentation(agent, {
      presentationId: r.presentationId,
      include: ["theme", "slides"],
    });
    const faces = view.theme?.fontFaces ?? [];
    expect(faces).toHaveLength(3);
    for (const face of faces) {
      expect(face.family).toBe("Lora");
      expect(face.src).toMatch(/^asset:[0-9a-f]{64}$/);
      expect(face.format).toBe("woff2");
      expect(face.weight).toBe("400 700");
      expect(face.unicodeRange).toMatch(/^U\+/);
    }
    // The @import is gone, the family survives the sanitizer, no URL is left.
    expect(view.theme?.css).not.toMatch(/https?:|@import/);
    expect(view.theme?.css).toContain("Lora");
    expect(r.vendored.filter((v) => v.status === "vendored")).toHaveLength(4);
  });

  it("theme.googleFonts builds the css2 URL and is not stored", async () => {
    const url = "https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap";
    const { fetcher, calls } = fakeFetcher({
      ...standardRoutes(),
      [url]: { bytes: enc(GOOGLE_CSS) },
    });
    const { core } = createTestCore({ vendor: fetcher });
    const r = await core.createPresentation(agent, {
      title: "G",
      theme: { googleFonts: [{ family: "Lora", weights: [700, 400] }] },
      slides: [{ html: "<p style=\"font-family:'Lora'\">x</p>" }],
    });
    expect(calls[0]?.url).toBe(url);
    const rev = await core.getRevision(owner, { presentationId: r.presentationId, revision: 1 });
    expect(rev.document.theme).not.toHaveProperty("googleFonts");
    expect(rev.document.theme?.fontFaces?.length).toBe(3);
    expect(rev.document.slides[0]?.html).toContain("Lora");
  });

  it("rewrites images in img src, srcset, style and CSS url() to stored assets", async () => {
    const { fetcher } = fakeFetcher(standardRoutes());
    const { core } = createTestCore({ vendor: fetcher });
    const r = await core.createPresentation(agent, {
      title: "Img",
      theme: { css: `.bg{background:url(${IMG}) center/cover}` },
      slides: [
        {
          html: `<img alt="a" srcset="${IMG} 2x"><div style="background-image:url('${IMG}')"></div>`,
        },
      ],
    });
    const rev = await core.getRevision(owner, { presentationId: r.presentationId, revision: 1 });
    const doc = rev.document;
    expect(doc.slides[0]?.html).not.toContain("https:");
    expect(doc.slides[0]?.html).toMatch(/<img [^>]*src="asset:[0-9a-f]{64}"/);
    expect(doc.theme?.css).toMatch(/url\(asset:[0-9a-f]{64}\)/);
    const assets = await core.listAssets(agent, { presentationId: r.presentationId });
    expect(assets.map((a) => a.mediaType)).toEqual(["image/png"]);
    expect(doc.vendored?.[0]).toMatchObject({ kind: "image", url: IMG, status: "vendored" });
  });

  it("CDN scripts become libs with provenance, enter the digest and stay pending", async () => {
    const { fetcher } = fakeFetcher(standardRoutes());
    const { core } = createTestCore({ vendor: fetcher, config: { scriptsEnabled: true } });
    const r = await core.createPresentation(agent, {
      title: "Chart",
      libs: [CHART],
      slides: [{ html: "<canvas></canvas>", script: "new Chart();" }],
    });
    expect(r.scripts.state).toBe("pending");
    const lib = r.scripts.libs[0];
    expect(lib).toMatchObject({
      name: "chart.js",
      version: "4.4.1",
      source: CHART,
      finalUrl: CHART_FINAL,
    });
    expect(lib?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const rev = await core.getRevision(owner, { presentationId: r.presentationId, revision: 1 });
    expect(rev.document.vendored?.find((v) => v.kind === "script")?.redirects).toEqual([
      CHART_FINAL,
    ]);
  });

  it("the digest changes when the vendored script bytes change", async () => {
    const a = fakeFetcher(standardRoutes());
    const b = fakeFetcher({
      ...standardRoutes(),
      [CHART]: { bytes: enc("window.Chart=function(){evil()};") },
    });
    const one = createTestCore({ vendor: a.fetcher, config: { scriptsEnabled: true } });
    const two = createTestCore({ vendor: b.fetcher, config: { scriptsEnabled: true } });
    const input = { title: "C", libs: [CHART], slides: [{ html: "<p>x</p>", script: "1;" }] };
    const r1 = await one.core.createPresentation(agent, input);
    const r2 = await two.core.createPresentation(agent, input);
    expect(r1.scripts.digest).not.toBe(r2.scripts.digest);
  });

  it("an approved deck goes back to pending when a re-vendored script differs", async () => {
    const routes = standardRoutes();
    const { fetcher } = fakeFetcher(routes);
    const { core } = createTestCore({ vendor: fetcher, config: { scriptsEnabled: true } });
    const r = await core.createPresentation(agent, {
      title: "C",
      libs: [CHART],
      slides: [{ html: "<p>x</p>" }],
    });
    const st = await core.approveScripts(owner, {
      presentationId: r.presentationId,
      digest: r.scripts.digest ?? "",
    });
    expect(st.state).toBe("approved");
    // The agent switches to another build URL whose bytes differ.
    const other = "https://unpkg.com/chart.js@4.4.2/dist/chart.umd.js";
    routes[other] = { bytes: enc("window.Chart=2;") };
    const u = await core.updatePresentation(agent, {
      presentationId: r.presentationId,
      expectedRevision: 1,
      libs: [other],
    });
    expect(u.scripts.state).toBe("pending");
    expect(u.scripts.libs[0]).toMatchObject({ name: "chart.js", version: "4.4.2" });
  });

  it("does not fetch again a URL already vendored for the deck (persistent cache)", async () => {
    const { fetcher, calls } = fakeFetcher(standardRoutes());
    const { core } = createTestCore({ vendor: fetcher });
    const r = await core.createPresentation(agent, {
      title: "Cache",
      slides: [{ id: "a", html: `<img alt="" src="${IMG}">` }],
    });
    expect(calls).toHaveLength(1);
    const u = await core.updateSlides(agent, {
      presentationId: r.presentationId,
      expectedRevision: 1,
      upsert: [{ id: "b", html: `<img alt="" src="${IMG}"><p>again</p>` }],
    });
    expect(calls).toHaveLength(1);
    expect(u.vendored).toEqual([expect.objectContaining({ url: IMG, status: "reused" })]);
  });

  it("drops what cannot be vendored with VENDOR_FAILED and keeps the write", async () => {
    const routes: Record<string, Route> = {
      ...standardRoutes(),
      "https://169.254.169.254/latest/meta-data": new VendorError(
        "blocked-address",
        "private address",
      ),
      "https://example.org/fake.png": { bytes: enc("<!doctype html><html>login</html>") },
      "https://example.org/pic.svg": {
        bytes: enc('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'),
      },
      "https://example.org/esm.js": { bytes: enc("export default function x(){}") },
    };
    const { fetcher } = fakeFetcher(routes);
    const { core, store } = createTestCore({ vendor: fetcher });
    const r = await core.createPresentation(agent, {
      title: "Bad",
      libs: ["https://example.org/esm.js"],
      slides: [
        {
          html: '<img alt="" src="https://169.254.169.254/latest/meta-data"><img alt="" src="https://example.org/fake.png"><img alt="" src="https://example.org/pic.svg"><img alt="" src="http://plain.example/x.png">',
        },
      ],
    });
    const failed = r.vendored.filter((v) => v.status === "failed");
    expect(failed.map((f) => f.error).sort()).toEqual(
      ["bad-type", "bad-type", "bad-type", "blocked-address", "blocked-address"].sort(),
    );
    expect(r.warnings.filter((w) => w.code === "VENDOR_FAILED")).toHaveLength(5);
    expect(failed.find((f) => f.url.endsWith(".svg"))?.message).toMatch(/SVG/);
    expect(failed.find((f) => f.url.endsWith("esm.js"))?.message).toMatch(/ES module/);
    const rev = await core.getRevision(owner, { presentationId: r.presentationId, revision: 1 });
    expect(rev.document.libs ?? []).toEqual([]);
    expect(rev.document.slides[0]?.html).not.toMatch(/https?:/);
    // Every fetch attempt is audited; the SSRF attempt as `denied`.
    const audit: AuditEntry[] = await store.audit.list(owner.workspaceId, { limit: 50 });
    const fetches = audit.filter((e) => e.action === "vendor.fetch");
    expect(fetches.some((e) => e.result === "denied" && e.detail?.code === "blocked-address")).toBe(
      true,
    );
    expect(fetches.some((e) => e.result === "error" && e.detail?.code === "bad-type")).toBe(true);
  });

  it("refuses a write with external URLs when the operator switched vendoring off", async () => {
    const { fetcher, calls } = fakeFetcher(standardRoutes(), false);
    const { core } = createTestCore({ vendor: fetcher });
    await expect(
      core.createPresentation(agent, {
        title: "Off",
        slides: [{ html: `<img alt="" src="${IMG}">` }],
      }),
    ).rejects.toMatchObject({ code: "FETCH_BLOCKED" });
    expect(calls).toHaveLength(0);
    // Decks without external resources are unaffected.
    await expect(
      core.createPresentation(agent, { title: "Ok", slides: [{ html: "<p>x</p>" }] }),
    ).resolves.toBeTruthy();
  });

  it("validates the deck before any network access", async () => {
    const { fetcher, calls } = fakeFetcher(standardRoutes());
    const { core } = createTestCore({ vendor: fetcher });
    await expect(
      core.createPresentation(agent, {
        title: "",
        slides: [{ html: `<img alt="" src="${IMG}">` }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toHaveLength(0);
  });

  it("caps the URLs of one write and keeps Latin font subsets first", async () => {
    const { fetcher, calls } = fakeFetcher(standardRoutes());
    const { core } = createTestCore({ vendor: fetcher, config: { vendor: { maxUrls: 3 } } });
    const r = await core.createPresentation(agent, {
      title: "Cap",
      theme: { css: `@import url(${CSS2});` },
      slides: [{ html: "<p>x</p>" }],
    });
    expect(r.warnings.some((w) => w.code === "VENDOR_FONTS_TRIMMED")).toBe(true);
    const fonts = calls.filter((c) => c.kind === "font").map((c) => c.url);
    expect(fonts.sort()).toEqual([LATIN, LATIN_EXT].sort());
  });

  it("follows nested @import up to the depth limit and survives an @import loop", async () => {
    const a = "https://css.example/a.css";
    const b = "https://css.example/b.css";
    const { fetcher, calls } = fakeFetcher({
      [a]: { bytes: enc(`@import url(b.css);.a{color:red}`) },
      [b]: { bytes: enc(`@import url(a.css);.b{color:blue}`) },
    });
    const { core } = createTestCore({ vendor: fetcher });
    const r = await core.createPresentation(agent, {
      title: "Loop",
      theme: { css: `@import url(${a});` },
      slides: [{ html: "<p>x</p>" }],
    });
    expect(calls.map((c) => c.url)).toEqual([a, b]);
    const rev = await core.getRevision(owner, { presentationId: r.presentationId, revision: 1 });
    expect(rev.document.theme?.css).toContain(".a{color:red}");
    expect(rev.document.theme?.css).toContain(".b{color:blue}");
  });

  it("refuses a font file with appended junk and an unrelated file served as a font", async () => {
    const junk = new Uint8Array([...woff2(), 1, 2, 3, 4]);
    expect(sniffFont(junk).ok).toBe(false);
    expect(sniffFont(woff2()).ok).toBe(true);
    const face = (url: string) => `@font-face{font-family:'X';src:url(${url}) format('woff2')}`;
    const { fetcher } = fakeFetcher({
      "https://f.example/junk.woff2": { bytes: junk },
      "https://f.example/png.woff2": { bytes: pngBytes() },
    });
    const { core } = createTestCore({ vendor: fetcher });
    const r = await core.createPresentation(agent, {
      title: "F",
      theme: { css: face("https://f.example/junk.woff2") + face("https://f.example/png.woff2") },
      slides: [{ html: "<p>x</p>" }],
    });
    expect(r.vendored.every((v) => v.status === "failed" && v.error === "bad-type")).toBe(true);
  });

  it("warns about unsupported embeds and ES module imports in scripts", async () => {
    const { fetcher } = fakeFetcher(standardRoutes());
    const { core } = createTestCore({ vendor: fetcher });
    const r = await core.createPresentation(agent, {
      title: "U",
      slides: [
        {
          html: '<iframe src="https://maps.example/embed"></iframe><video src="https://v.example/a.mp4"></video>',
          script: 'import("https://esm.sh/d3").then(()=>{});',
        },
      ],
    });
    const codes = r.warnings.map((w) => w.code);
    expect(codes.filter((c) => c === "VENDOR_UNSUPPORTED")).toHaveLength(2);
    expect(codes).toContain("VENDOR_ES_MODULE");
  });

  it("without a fetcher wired, external references are left to the sanitizer", async () => {
    const { core } = createTestCore();
    const r = await core.createPresentation(agent, {
      title: "Legacy",
      libs: [CHART],
      slides: [{ html: `<img alt="" src="${IMG}">` }],
    });
    expect(r.warnings.map((w) => w.code)).toContain("VENDOR_FAILED");
    expect(r.scripts.libs).toEqual([]);
  });

  it("add_asset by URL stores a vendored image", async () => {
    const { fetcher } = fakeFetcher(standardRoutes());
    const { core } = createTestCore({ vendor: fetcher });
    const d = await core.createPresentation(agent, { title: "A", slides: [{ html: "<p>x</p>" }] });
    const a = await core.addAssetFromUrl(agent, { presentationId: d.presentationId, url: IMG });
    expect(a.mediaType).toBe("image/png");
    await expect(
      core.addAssetFromUrl(agent, {
        presentationId: d.presentationId,
        url: "https://example.org/none.png",
      }),
    ).rejects.toMatchObject({ code: "FETCH_FAILED" });
  });
});

describe("scripts digest with a deck script (ADR-022)", () => {
  const slides = [{ id: "a", title: "", html: "<p>a</p>", script: "1;" }];
  it("keeps the digest of decks without a deck script and changes with it", () => {
    const base = scriptsDigest({ slides });
    const withDeck = scriptsDigest({ slides, script: "window.x=1;" });
    expect(withDeck).not.toBe(base);
    expect(scriptsDigest({ slides, script: "window.x=2;" })).not.toBe(withDeck);
    expect(scriptsDigest({ slides: [{ id: "a", title: "", html: "" }], script: "x" })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe("helpers", () => {
  it("labels CDN libraries", () => {
    expect(libLabelOf(CHART, CHART_FINAL)).toEqual({ name: "chart.js", version: "4.4.1" });
    expect(libLabelOf("https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js")).toEqual({
      name: "d3",
      version: "7.8.5",
    });
    expect(libLabelOf("https://unpkg.com/@observablehq/plot@0.6.11/dist/plot.umd.min.js")).toEqual({
      name: "@observablehq/plot",
      version: "0.6.11",
    });
    expect(libLabelOf("https://example.org/js/widget.min.js")).toEqual({ name: "widget" });
  });

  it("detects ES modules but not UMD bundles", () => {
    expect(looksLikeModule("export default 1")).toBe(true);
    expect(looksLikeModule('import x from "y";')).toBe(true);
    expect(looksLikeModule("!function(e){e.a=1}(this);var s='export default';")).toBe(false);
    expect(looksLikeModule('(function(){ import("x") })()')).toBe(false);
  });
});

describe("importHtml (ADR-022)", () => {
  const read = (name: string) =>
    readFileSync(new URL(`../../sanitizer/test/fixtures/${name}`, import.meta.url), "utf8");
  const SOURCE_SERIF =
    "https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;700&display=swap";
  const CHART_PINNED = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";

  it("imports the Chart.js artifact: slides, vendored lib and fonts, deck script pending approval", async () => {
    const { fetcher, calls } = fakeFetcher({
      ...standardRoutes(),
      [SOURCE_SERIF]: { bytes: enc(GOOGLE_CSS) },
      [CHART_PINNED]: { bytes: enc("(function(g){g.Chart=function(){};})(this);") },
    });
    const { core } = createTestCore({ vendor: fetcher, config: { scriptsEnabled: true } });
    const r = await core.importHtml(agent, { html: read("artifact-chart-widget.html") });
    expect(r.heuristic).toBe("sections");
    expect(r.slideCount).toBe(3);
    expect(r.scripts.state).toBe("pending");
    expect(r.scripts.deckScript).toBe(true);
    expect(r.scripts.libs.map((l) => l.name)).toEqual(["chart.js"]);
    expect(calls.map((c) => c.kind).sort()).toEqual([
      "font",
      "font",
      "font",
      "script",
      "stylesheet",
    ]);
    const rev = await core.getRevision(owner, { presentationId: r.presentationId, revision: 1 });
    expect(rev.document.lang).toBe("es");
    expect(rev.document.script).toContain("new Chart(");
    expect(rev.document.slides[2]?.html).toContain('type="range"');
    expect(rev.document.theme?.fontFaces?.[0]?.family).toBe("Lora");
    expect(rev.summary).toMatch(/Imported from HTML \(sections/);
  });

  it("imports the static artifact: image vendored, navigation warning", async () => {
    const css2 =
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;600&display=swap";
    const { fetcher } = fakeFetcher({
      ...standardRoutes(),
      [css2]: { bytes: enc(GOOGLE_CSS) },
      "https://images.example.org/bloch-sphere.png": { bytes: pngBytes() },
    });
    const { core } = createTestCore({ vendor: fetcher });
    const r = await core.importHtml(agent, { html: read("artifact-static-fonts.html") });
    expect(r.slideCount).toBe(3);
    expect(r.warnings.map((w) => w.code)).toContain("IMPORT_NAVIGATION_HANDLERS");
    const rev = await core.getRevision(owner, { presentationId: r.presentationId, revision: 1 });
    expect(rev.document.slides[1]?.html).toMatch(/src="asset:[0-9a-f]{64}"/);
  });

  it("refuses a JSX artifact with a clear error", async () => {
    const { core } = createTestCore();
    await expect(
      core.importHtml(agent, {
        html: '<script type="text/babel">const A=()=><b/>;</script><div id="root"></div>',
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "JSX_UNSUPPORTED" } });
  });
});

describe("library provenance cannot be spoofed (ADR-022 self-review)", () => {
  it("replaces an agent-supplied source with the deck's own vendoring record", async () => {
    const evil = "https://evil.example/payload.js";
    const { fetcher } = fakeFetcher({ [evil]: { bytes: enc("window.x=1;") } });
    const { core } = createTestCore({ vendor: fetcher, config: { scriptsEnabled: true } });
    const r = await core.createPresentation(agent, {
      title: "S",
      libs: [evil],
      slides: [{ html: "<p>x</p>" }],
    });
    const sha = r.scripts.libs[0]?.sha256 ?? "";
    const u = await core.updatePresentation(agent, {
      presentationId: r.presentationId,
      expectedRevision: 1,
      libs: [
        {
          name: "chart.js",
          version: "4.4.1",
          sha256: sha,
          source: "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
        },
      ],
    });
    expect(u.scripts.libs[0]).toMatchObject({ name: "chart.js", sha256: sha, source: evil });
  });
});
