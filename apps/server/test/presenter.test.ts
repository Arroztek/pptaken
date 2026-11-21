// SPDX-License-Identifier: AGPL-3.0-or-later
// Presenter view (F3): the presenter data API and page. Speaker notes are rendered to safe HTML and only ever
// leave the server here, for the owner session (T7).
import { afterEach, describe, expect, it } from "vitest";
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
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
  await h?.cleanup();
  h = undefined;
});

const NOTE =
  "Say **hello** <script>alert('notes')</script> [link](javascript:alert(1)) SECRET-NOTE-42";

async function deckWithNotes(harness: Harness, cookie: string): Promise<string> {
  const live = await listen(harness.server);
  stop = live.close;
  const { secret } = await createToken(harness, cookie);
  const { call, client } = await mcpClient(live.base, secret);
  const created = await call("create_presentation", {
    title: "Notes deck",
    target_minutes: 10,
    slides: [
      {
        id: "intro",
        title: "Intro",
        html: "<p>one</p>",
        notes: NOTE,
        section: "Start",
        duration_hint_sec: 60,
      },
      { id: "two", title: "Two", html: '<p data-step="1">two</p>', section: "Start" },
      { id: "end", title: "End", html: "<p>end</p>", notes: "- a\n- b" },
    ],
  });
  await client.close();
  expect(created.isError).toBe(false);
  return created.body.presentation_id as string;
}

describe("presenter data API", () => {
  it("returns titles, sections, hints and rendered notes to the owner only", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const id = await deckWithNotes(h, cookie);

    expect((await h.api("GET", `/api/v1/decks/${id}/presenter`)).status).toBe(401);
    const res = await h.api("GET", `/api/v1/decks/${id}/presenter`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = await res.json();
    expect(data).toMatchObject({
      title: "Notes deck",
      targetMinutes: 10,
      aspectRatio: "16:9",
      revision: 1,
    });
    expect(data.slides.map((s: { id: string }) => s.id)).toEqual(["intro", "two", "end"]);
    const [intro, two, end] = data.slides;
    expect(intro).toMatchObject({ title: "Intro", section: "Start", durationHintSec: 60 });
    expect(intro.notesHtml).toContain("<strong>hello</strong>");
    expect(intro.notesHtml).toContain("&lt;script&gt;");
    expect(intro.notesHtml).not.toContain("<script");
    expect(intro.notesHtml).not.toContain("<a");
    expect(intro.notesHtml).toContain("[link](javascript:alert(1))");
    expect(two.notesHtml).toBe("");
    expect(end.notesHtml).toBe("<ul><li>a</li><li>b</li></ul>");
    // Only presenter fields: never slide HTML or CSS.
    for (const s of data.slides) {
      expect(Object.keys(s).sort()).toEqual(expect.arrayContaining(["id", "title", "notesHtml"]));
      expect(s).not.toHaveProperty("html");
      expect(s).not.toHaveProperty("css");
    }

    expect(
      (await h.api("GET", "/api/v1/decks/01HZZZZZZZZZZZZZZZZZZZZZZZ/presenter", { cookie })).status,
    ).toBe(404);
    expect((await h.api("GET", "/api/v1/decks/nope/presenter", { cookie })).status).toBe(404);
  });

  it("keeps notes off the content route and off the content origin", async () => {
    h = await makeHarness({
      PPTAKEN_PUBLIC_URL: ORIGIN,
      PPTAKEN_CONTENT_URL: "http://content.localhost:8080",
    });
    const cookie = await setupOwner(h);
    const id = await deckWithNotes(h, cookie);
    const { url } = await (
      await h.api("GET", `/api/v1/decks/${id}/content-url`, { cookie })
    ).json();
    expect(url).toMatch(/^http:\/\/content\.localhost:8080\/c\//);
    const doc = await h.server.app.request(url);
    expect(doc.status).toBe(200);
    const html = await doc.text();
    expect(html).not.toContain("SECRET-NOTE-42");
    expect(html).not.toContain("hello</strong>");
    // The presenter API and page do not exist on the content origin, with or without the cookie.
    for (const path of [
      `/api/v1/decks/${id}/presenter`,
      `/p/${id}/presenter`,
      `/c/${id}/presenter`,
    ]) {
      const r = await h.server.app.request(`http://content.localhost:8080${path}`, {
        headers: { Cookie: cookie },
      });
      expect(r.status, path).toBe(404);
      expect(await r.text(), path).not.toContain("SECRET-NOTE-42");
    }
  });

  it("is rate limited like the panel API", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    let last = 0;
    for (let i = 0; i < 320; i++) {
      last = (await h.api("GET", "/api/v1/decks/01HZZZZZZZZZZZZZZZZZZZZZZZ/presenter", { cookie }))
        .status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe("presenter page", () => {
  it("requires the owner session, carries a strict CSP and serves its modules and fonts", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const r0 = await h.server.app.request(`${ORIGIN}/p/01HZZZZZZZZZZZZZZZZZZZZZZZ/presenter`);
    expect(r0.status).toBe(302);
    expect(r0.headers.get("location")).toBe("/login");
    const id = await deckWithNotes(h, cookie);
    const page = await h.server.app.request(`${ORIGIN}/p/${id}/presenter`, {
      headers: { Cookie: cookie },
    });
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    const body = await page.text();
    expect(body).toContain('src="/_player/presenter-page.js"');
    expect(body).not.toContain("SECRET-NOTE-42");
    expect(
      (
        await h.server.app.request(`${ORIGIN}/p/01HZZZZZZZZZZZZZZZZZZZZZZZ/presenter`, {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(404);

    for (const file of [
      "presenter.js",
      "presenter-data.js",
      "sync.js",
      "pace.js",
      "i18n.js",
      "presenter-page.js",
    ]) {
      const r = await h.server.app.request(`${ORIGIN}/_player/${file}`);
      expect(r.status, file).toBe(200);
      expect(r.headers.get("content-type"), file).toContain("text/javascript");
    }
    const css = await (await h.server.app.request(`${ORIGIN}/_player/presenter.css`)).text();
    expect(css).toContain('font-family:"Inter"');
    expect(css).toContain('font-family:"JetBrains Mono"');
    expect(css).not.toContain("Bricolage");
    const font = /url\((\/_player\/fonts\/inter\/[a-z0-9-]+\.woff2)\)/.exec(css)?.[1] as string;
    const f = await h.server.app.request(`${ORIGIN}${font}`);
    expect(f.status).toBe(200);
    expect(f.headers.get("content-type")).toBe("font/woff2");
    for (const bad of [
      "/_player/fonts/bricolage-grotesque/bricolage-grotesque-latin-opsz-wght.woff2",
      "/_player/fonts/inter/..%2F..%2Fpackage.json",
      "/_player/fonts/inter/OFL.txt",
      "/_player/notes.js",
      "/_player/builder.js",
    ]) {
      expect((await h.server.app.request(`${ORIGIN}${bad}`)).status, bad).toBe(404);
    }
  });

  it("player and presenter pages show the presentation loader before any script, with styles from the page CSS", async () => {
    h = await makeHarness();
    const cookie = await setupOwner(h);
    const id = await deckWithNotes(h, cookie);
    for (const path of [`/p/${id}`, `/p/${id}/presenter`]) {
      const html = await (
        await h.server.app.request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } })
      ).text();
      expect(html, path).toContain(
        '<div id="pptaken-loader" class="pptaken-loader" role="status" aria-live="polite">',
      );
      expect(html, path).toContain(
        '<span class="pptaken-loader__label" data-loader-label>Loading…</span>',
      );
      // The status line stays empty and hidden until there is something to say (slow, error, hint).
      expect(html, path).toContain('<p id="status" role="status" hidden></p>');
      expect(html, path).not.toContain("style=");
    }
    for (const file of ["page.css", "presenter.css"]) {
      const css = await (await h.server.app.request(`${ORIGIN}/_player/${file}`)).text();
      expect(css, file).toContain(".pptaken-loader[hidden]{display:none}");
      expect(css, file).toContain("@media (prefers-reduced-motion:reduce)");
    }
    // The page scripts hide it on ready and on every error, and translate its label.
    for (const file of ["page.js", "presenter-page.js"]) {
      const js = await (await h.server.app.request(`${ORIGIN}/_player/${file}`)).text();
      expect(js, file).toContain('document.getElementById("pptaken-loader")');
      expect(js, file).toContain("loaderLabel.textContent = t.loading");
    }
  });
});
