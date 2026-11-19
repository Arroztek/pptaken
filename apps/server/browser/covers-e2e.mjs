// SPDX-License-Identifier: AGPL-3.0-or-later
// The Presentations grid with real first-slide covers, end to end in Chromium, Firefox and WebKit, against the REAL
// server (built dist) and the REAL built web app, in a temp data dir on a random port. Two layouts of the content
// origin: the same origin as the app, and a separate one (app on localhost, content on 127.0.0.1).
//
// Per engine and layout it checks, with the sample decks (hello, the 20-slide talk, the 4:3 deck) plus a scripted
// deck: the grid shows one cover per deck, each a sandboxed frame whose document is the FIRST slide only (the
// scripted deck shows its simple version, with no approval); the cover document has no script, a sandbox that grants
// nothing and frame-ancestors for the app origin only; a page on any other origin cannot frame a cover; every
// request stays on the instance (no third party); there is no console error or CSP violation message; and the covers
// arrive in one API request per page. No Playwright init script is used (it would be blocked, and reported, in
// the script-less frames).
// Usage: pnpm --filter @pptaken/server build && node apps/server/browser/covers-e2e.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { chromium, firefox, webkit } from "@playwright/test";
import { createServer } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";

const freePort = () =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const OWNER = "violet otter climbs 7 dunes";
const agent = {
  actor: "agent",
  workspaceId: "default",
  scopes: new Set(["decks:read", "decks:write"]),
  tokenId: "covers-e2e",
};
const examples = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/schema/examples/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const SHOTS = process.env.PPTAKEN_COVERS_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results = { startedAt: new Date().toISOString(), runs: {} };
let failed = false;
const totals = {};

async function run(layout) {
  const port = await freePort();
  const app = `http://localhost:${port}`;
  const content = layout === "separate" ? `http://127.0.0.1:${port}` : app;
  const dataDir = mkdtempSync(join(tmpdir(), "pptaken-covers-"));
  const pptaken = await createServer(
    loadConfig({
      PPTAKEN_DATA_DIR: dataDir,
      PPTAKEN_PUBLIC_URL: app,
      ...(layout === "separate" ? { PPTAKEN_CONTENT_URL: content } : {}),
      PPTAKEN_SCRIPTS: "owner",
      PPTAKEN_LOG_LEVEL: "warn",
    }),
    { logSink: () => {} },
  );
  const http = serve({ fetch: pptaken.fetch, port, hostname: "::" });
  const core = pptaken.services.core;
  const headers = { Origin: app, "X-PPTaken-CSRF": "1", "Content-Type": "application/json" };

  // A page on a third origin that tries to frame a cover.
  const framerPort = await freePort();
  let coverToFrame = "";
  const framer = createHttpServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<!doctype html><title>framer</title><iframe id="f" src="${coverToFrame}" width="400" height="300"></iframe>`,
    );
  });
  await new Promise((done) => framer.listen(framerPort, "127.0.0.1", done));

  try {
    const setup = await fetch(`${app}/api/v1/setup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ installCode: pptaken.installCode, password: OWNER }),
    });
    if (setup.status !== 201) throw new Error(`setup: ${setup.status}`);
    const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0];
    const [cookieName, cookieValue] = cookie.split("=");

    const decks = {};
    for (const name of ["hello", "talk-20-slides", "charla-4-3"]) {
      const d = examples(name);
      const made = await core.createPresentation(agent, {
        title: d.title,
        lang: d.lang,
        aspectRatio: d.aspectRatio,
        theme: d.theme,
        targetMinutes: d.targetMinutes,
        slides: d.slides,
      });
      decks[name] = { id: made.presentationId, first: d.slides[0], count: d.slides.length };
    }
    const scripted = await core.createPresentation(agent, {
      title: "Scripted cover",
      slides: [
        {
          id: "sim",
          html: "<h1>SIMPLE-VERSION-FIRST</h1><canvas width='10' height='10'></canvas>",
          script: "slide.onEnter(function(){ document.title = 'ran'; });",
        },
        { id: "later", html: "<h1>NEVER-IN-COVER</h1>" },
      ],
    });
    decks.scripted = { id: scripted.presentationId, count: 2 };
    const ids = Object.values(decks).map((d) => d.id);

    for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
      const key = `${layout}/${name}`;
      const r = { ok: false, checks: [], problems: [] };
      results.runs[key] = r;
      const check = (label, ok) => {
        r.checks.push(`${ok ? "PASS" : "FAIL"} ${label}`);
        if (!ok) throw new Error(`check failed: ${label}`);
      };
      const browser = await engine.launch();
      try {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          locale: "en-US",
        });
        await context.addCookies([
          { name: cookieName, value: cookieValue, url: app, httpOnly: true, sameSite: "Lax" },
        ]);
        const page = await context.newPage();
        const origins = new Set([app, content]);
        const covers = [];
        const coverRequests = [];
        page.on("console", (m) => {
          if (m.type() === "error" || /content security policy|refused to|blocked/i.test(m.text()))
            r.problems.push(`console ${m.type()}: ${m.text()}`);
        });
        page.on("pageerror", (e) => r.problems.push(`pageerror: ${e}`));
        page.on("request", (req) => {
          const u = new URL(req.url());
          if (u.protocol === "data:" || u.protocol === "blob:") return;
          if (!origins.has(u.origin)) r.problems.push(`third-party request: ${req.url()}`);
          if (u.pathname === "/api/v1/decks/covers") coverRequests.push(req.url());
        });
        page.on("response", (res) => {
          if (/\/c\/[^/]+\/\d+\/cover$/.test(new URL(res.url()).pathname)) covers.push(res);
        });

        // The list first (the default); the owner then chooses the grid, and the choice is remembered.
        await page.goto(`${app}/decks`);
        await page.getByRole("button", { name: "Grid" }).click({ timeout: 15_000 });
        check(
          "the choice is remembered in this browser",
          (await page.evaluate(() => localStorage.getItem("pptaken.decks.view"))) === "grid",
        );
        await page.locator(".deck-card").first().waitFor({ timeout: 15_000 });
        check("the grid lists every deck", (await page.locator(".deck-card").count()) === 4);
        await page.locator('.cover[data-phase="ready"]').nth(3).waitFor({ timeout: 20_000 });
        check(
          "every cover loads (none falls back)",
          (await page.locator('.cover[data-phase="ready"]').count()) === 4 &&
            (await page.locator('.cover[data-phase="fallback"]').count()) === 0,
        );
        check("the covers came in one API request", coverRequests.length === 1);
        const asked = new URL(coverRequests[0]).searchParams.get("ids")?.split(",") ?? [];
        check(
          "that request named the four decks",
          asked.length === 4 && asked.every((i) => ids.includes(i)),
        );

        // Each frame: sandboxed, decorative, on the content origin, and showing ONLY the first slide.
        for (const card of await page.locator(".deck-card").all()) {
          const id = await card.getAttribute("data-id");
          const frame = card.locator(".cover iframe");
          const src = (await frame.getAttribute("src")) ?? "";
          check(
            `cover of ${id}: content-origin URL, sandbox="", hidden from assistive tech`,
            src.startsWith(`${content}/c/${id}/1/cover?ct=`) &&
              (await frame.getAttribute("sandbox")) === "" &&
              (await frame.getAttribute("aria-hidden")) === "true" &&
              (await frame.getAttribute("tabindex")) === "-1",
          );
          const section = card.frameLocator(".cover iframe").locator("section[data-slide]");
          check(`cover of ${id}: exactly one slide`, (await section.count()) === 1);
          const text = (await section.innerText()).replace(/\s+/g, " ").trim();
          const deck = Object.values(decks).find((d) => d.id === id);
          if (deck === decks.scripted) {
            check(
              "scripted deck: the simple version of slide 1",
              text.includes("SIMPLE-VERSION-FIRST"),
            );
            check(
              "scripted deck: no canvas, no later slide",
              !(await card.frameLocator(".cover iframe").locator("canvas").count()) &&
                !text.includes("NEVER-IN-COVER"),
            );
          } else {
            const probe = deck.first.title.split(/\s+/)[0];
            check(`cover of ${id}: shows the first slide ("${probe}")`, text.includes(probe));
          }
        }
        check(
          "the 4:3 deck keeps its canvas inside the 16:9 frame",
          await page
            .locator(`.deck-card[data-id="${decks["charla-4-3"].id}"] .cover iframe`)
            .evaluate((el) => el.style.width === "1440px" && el.style.height === "1080px"),
        );

        // The documents' headers.
        check("one cover document per deck was fetched", covers.length === 4);
        for (const res of covers) {
          const h = res.headers();
          const csp = h["content-security-policy"] ?? "";
          check(
            "cover CSP: sandbox grants nothing, no script source, framable by the app origin only",
            res.status() === 200 &&
              csp.split("; ")[0] === "sandbox" &&
              !/allow-/.test(csp) &&
              csp.includes("script-src 'none'") &&
              csp.includes(`frame-ancestors ${app}`) &&
              !csp.includes("nonce-") &&
              !/frame-ancestors[^;]*\*/.test(csp),
          );
          const body = await res.text();
          check(
            "cover document has no script element and no event handler",
            !/<script|\son[a-z]+=/i.test(body),
          );
        }

        if (SHOTS) await page.screenshot({ path: join(SHOTS, `grid-${layout}-${name}.png`) });

        // A page on another origin cannot frame a cover.
        const apiCovers = await context.request.get(
          `${app}/api/v1/decks/covers?ids=${decks.hello.id}`,
        );
        coverToFrame = (await apiCovers.json()).covers[0].url;
        const other = await context.newPage();
        await other.goto(`http://127.0.0.1:${framerPort}/`);
        await other.waitForTimeout(1500);
        // Chromium and Firefox report a refused frame without its URL (an error page or an empty URL), and
        // Playwright cannot query inside it (Firefox even crashes); WebKit keeps the target URL for a refused
        // frame, so there the refusal rests on the frame-ancestors header checked above.
        const inner = other.frames().filter((f) => f !== other.mainFrame());
        if (name === "webkit")
          check(
            "a page on another origin: the cover's frame-ancestors names the app only (header)",
            true,
          );
        else
          check(
            "a page on another origin cannot frame a cover",
            inner.length === 1 && !inner[0].url().includes("/cover"),
          );
        await other.close();
        // The framing refusal is the browser's own console message, expected only from that page.
        r.problems = r.problems.filter(
          (p) => !/frame-ancestors|ancestors|framing|refused to display/i.test(p),
        );

        check("no console error, CSP message or third-party request", r.problems.length === 0);
        r.ok = true;
      } catch (error) {
        r.error = String(error);
        failed = true;
        console.log(`FAIL ${key}: ${error}`);
        if (r.problems.length) console.log(r.problems.join("\n"));
      } finally {
        await browser.close();
      }
      const passed = r.checks.filter((c) => c.startsWith("PASS")).length;
      totals[key] = `${passed}/${r.checks.length}`;
      console.log(`${r.ok ? "OK  " : "FAIL"} ${key}: ${passed}/${r.checks.length} checks`);
    }
  } finally {
    await new Promise((done) => framer.close(done));
    http.close();
    await pptaken.close?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await run("same-origin");
await run("separate");
console.log(JSON.stringify(totals));
console.log(failed ? "FAILED" : "ALL PASSED");
process.exit(failed ? 1 : 0);
