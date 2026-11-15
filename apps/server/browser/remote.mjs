// SPDX-License-Identifier: AGPL-3.0-or-later
// Remote control (F4) end to end on the real server, two browser contexts per engine (Chromium, Firefox, WebKit):
// a laptop (owner session, the player page) and a phone (no cookies, the /r page).
//
//   pair (QR never shown by default; R opens it; the QR encodes <origin>/r#<secret>; the fragment is stripped),
//   approve with Enter after checking the two-digit code, every slide and step from the phone, prev/first/last,
//   black screen, a burst of 12 taps converging, latency click -> slide (< 150 ms p50 on loopback), laser pixel
//   position on 16:9 and 4:3 decks at several viewports (hidden under black, in the overview and after 1.5 s),
//   the server stopped while the screen keeps navigating (then both reconnect and converge), the phone offline and
//   back, kick (K), notes shown on the phone and absent from every socket frame and from /c/, no console errors.
//
// Usage: pnpm --filter @pptaken/server build && node apps/server/browser/remote.mjs
//        PPTAKEN_ENGINES=webkit node apps/server/browser/remote.mjs   (one engine)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { chromium, firefox, webkit } from "@playwright/test";
import { ownerPrincipal } from "@pptaken/core";
import { encodeQR } from "qr";
import { createServer } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";

const ENGINES = { chromium, firefox, webkit };
const selected = (process.env.PPTAKEN_ENGINES ?? "chromium,firefox,webkit").split(",");
const PASSWORD = "violet otter climbs 7 dunes";
const NOTE_4x3 = "FOUR-BY-THREE-PRIVATE-NOTE";

const freePort = () =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const app = `http://localhost:${port}`;
const content = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "pptaken-remote-"));
const results = { startedAt: new Date().toISOString(), engines: {} };
let failed = false;

const pptaken = await createServer(
  loadConfig({
    PPTAKEN_DATA_DIR: dataDir,
    PPTAKEN_PUBLIC_URL: app,
    PPTAKEN_CONTENT_URL: content,
    PPTAKEN_WEB_DIR: join(dataDir, "no-web"),
    PPTAKEN_LOG_LEVEL: "warn",
  }),
  { logSink: () => {} },
);

// A server that can be stopped for real: every TCP socket (upgraded ones included) is destroyed.
let http = null;
let detach = null;
const sockets = new Set();
const server = {
  start: () =>
    new Promise((resolve) => {
      if (http) return resolve();
      http = serve({ fetch: pptaken.fetch, port, hostname: "::" }, () => resolve());
      http.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
      detach = pptaken.attach(http);
    }),
  stop: () =>
    new Promise((resolve) => {
      if (!http) return resolve();
      const h = http;
      http = null;
      detach?.();
      for (const s of sockets) s.destroy();
      h.close(() => resolve());
    }),
};
await server.start();

const talk = JSON.parse(
  readFileSync(
    new URL("../../../packages/schema/examples/talk-20-slides.json", import.meta.url),
    "utf8",
  ),
);
/** A phrase of the first slide's notes that must reach the phone and nothing else. */
const NOTE = /[A-Za-z][A-Za-z ,']{24,}/
  .exec(talk.slides[0].notes ?? "")?.[0]
  ?.trim()
  .slice(0, 24);
if (!NOTE) throw new Error("the example deck's first slide has no notes");

const owner = ownerPrincipal();
const talkDeck = await pptaken.services.core.createPresentation(owner, {
  title: talk.title,
  lang: talk.lang,
  theme: talk.theme,
  targetMinutes: talk.targetMinutes,
  slides: talk.slides,
});
const fourThree = await pptaken.services.core.createPresentation(owner, {
  title: "Four by three",
  aspectRatio: "4:3",
  slides: [
    { id: "a", html: "<h1>A</h1>", notes: NOTE_4x3 },
    { id: "b", html: "<h1>B</h1>" },
  ],
});

const headers = { Origin: app, "X-PPTaken-CSRF": "1", "Content-Type": "application/json" };
const setup = await fetch(`${app}/api/v1/setup`, {
  method: "POST",
  headers,
  body: JSON.stringify({ installCode: pptaken.installCode, password: PASSWORD }),
});
if (setup.status !== 201) throw new Error(`setup: ${setup.status}`);
const [cookieName, cookieValue] = (setup.headers.get("set-cookie") ?? "").split(";")[0].split("=");

/** The SVG path the panel draws for a URL (same encoder, quiet zone of 4 modules included in the matrix). */
function qrPath(text) {
  const matrix = encodeQR(text, "raw", { ecc: "medium", border: 4 });
  let d = "";
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    });
  });
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pos = (p) => p.evaluate(() => `${document.body.dataset.slide}/${document.body.dataset.step}`);
const parse = (s) => s.split("/").map(Number);

async function runEngine(name, engine) {
  const r = { ok: false, checks: [], latencyMs: null };
  results.engines[name] = r;
  const check = (label, ok, detail = "") => {
    if (!ok) throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
    r.checks.push(label);
    if (process.env.PPTAKEN_TRACE) console.log(`  [${name}] ${label}`);
  };
  const browser = await engine.launch();
  const problems = [];
  let allowErrors = false;
  const frames = [];
  const watch = (page, who) => {
    page.on("pageerror", (e) => problems.push(`${who} pageerror: ${e}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !allowErrors) problems.push(`${who} console: ${m.text()}`);
    });
    page.on("websocket", (ws) => {
      ws.on("framesent", (f) => frames.push(String(f.payload)));
      ws.on("framereceived", (f) => frames.push(String(f.payload)));
    });
  };
  try {
    const laptopCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await laptopCtx.addCookies([
      { name: cookieName, value: cookieValue, url: app, httpOnly: true, sameSite: "Lax" },
    ]);
    const mobile = name === "firefox" ? {} : { isMobile: true, hasTouch: true };
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...mobile });
    const laptop = await laptopCtx.newPage();
    const phone = await phoneCtx.newPage();
    watch(laptop, "laptop");
    watch(phone, "phone");

    // ---------------------------------------------------------------------------------------------------------------
    // Pairing

    const pairWith = async (deckId) => {
      await laptop.goto(`${app}/p/${deckId}`);
      await laptop.waitForSelector('body[data-state="ready"]', { timeout: 15_000 });
      await laptop.waitForFunction(() => document.body.dataset.remote !== undefined, null, {
        timeout: 10_000,
      });
      const hiddenQr = await laptop.evaluate(
        () =>
          document.querySelector("[data-pptaken-remote-panel]")?.hidden !== false &&
          document.querySelector("[data-pptaken-qr] svg") === null,
      );
      check("QR not shown by default", hiddenQr);
      const pairing = laptop.waitForResponse(
        (res) => res.url().endsWith("/pairing") && res.request().method() === "POST",
      );
      await laptop.keyboard.press("r");
      const { secret } = await (await pairing).json();
      check("R opens the panel and creates a one-time code", /^[A-Za-z0-9_-]{22}$/.test(secret));
      await laptop.waitForSelector("[data-pptaken-qr] svg path", { timeout: 5000 });
      const drawn = await laptop.evaluate(() => ({
        d: document.querySelector("[data-pptaken-qr] svg path")?.getAttribute("d"),
        origin: document.querySelector("[data-pptaken-qr]")?.dataset.origin,
      }));
      check(
        "the QR encodes <origin>/r#<secret>",
        drawn.d === qrPath(`${app}/r#${secret}`) && drawn.origin === app,
      );
      await phone.goto(`${app}/r#${secret}`);
      await phone.waitForFunction(() => document.body.dataset.state === "pending", null, {
        timeout: 10_000,
      });
      check("the phone strips the secret from the URL", new URL(phone.url()).hash === "");
      const code = (await phone.locator("[data-pptaken-code]").innerText()).trim();
      const prompt = laptop.locator("[data-pptaken-remote-prompt]");
      await prompt.waitFor({ state: "visible", timeout: 10_000 });
      check(
        "the laptop asks with the same two digits",
        (await prompt.innerText()).includes(code) && /^\d\d$/.test(code),
      );
      const before = await pos(laptop);
      // Pending: the phone's buttons do nothing and no data reaches it.
      check(
        "a pending phone gets no deck data",
        (await phone.evaluate(() => document.body.dataset.data)) === undefined,
      );
      await laptop.keyboard.press("Enter");
      await phone.waitForFunction(() => document.body.dataset.state === "ready", null, {
        timeout: 10_000,
      });
      check("Enter approves (and does not navigate)", (await pos(laptop)) === before);
      await phone.waitForFunction(
        () => document.body.dataset.data === "loaded" && document.body.dataset.previews === "ready",
        null,
        { timeout: 15_000 },
      );
      check("approved: deck data and previews on the phone", true);
      await laptop.keyboard.press("Escape");
      await laptop.waitForFunction(() => document.querySelector("[data-pptaken-qr] svg") === null);
      check("Escape closes the panel and drops the QR", true);
    };

    await pairWith(talkDeck.presentationId);
    await phone.waitForFunction(
      (n) => document.querySelector("[data-pptaken-notes]")?.textContent?.includes(n),
      NOTE,
      {
        timeout: 5000,
      },
    );
    check("notes of the current slide on the phone", true);

    const converge = async (ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const [a, b] = [await pos(laptop), await pos(phone)];
        if (a === b && !a.includes("undefined")) return a;
        await sleep(50);
      }
      throw new Error(`phone and screen out of sync: ${await pos(laptop)} vs ${await pos(phone)}`);
    };
    const tap = async (action) => {
      await sleep(110);
      const prev = await pos(laptop);
      await phone.click(`[data-action="${action}"]`);
      await laptop.waitForFunction(
        (p) => `${document.body.dataset.slide}/${document.body.dataset.step}` !== p,
        prev,
        {
          timeout: 5000,
        },
      );
      return converge();
    };

    // ---------------------------------------------------------------------------------------------------------------
    // Every slide and step from the phone

    check("starts at 0/0", (await converge()) === "0/0");
    const visited = ["0/0"];
    // Paced under the 10/s navigation limit (excess taps are dropped by design); the end is two taps that do nothing.
    for (let i = 0, idle = 0; i < 200 && idle < 2; i++) {
      const prev = await pos(laptop);
      await phone.click('[data-action="next"]');
      const moved = await laptop
        .waitForFunction(
          (p) => `${document.body.dataset.slide}/${document.body.dataset.step}` !== p,
          prev,
          {
            timeout: 1200,
          },
        )
        .then(() => true)
        .catch(() => false);
      if (!moved) {
        idle += 1;
        continue;
      }
      idle = 0;
      visited.push(await converge());
      await sleep(110);
    }
    let stepwise = true;
    for (let i = 1; i < visited.length; i++) {
      const [s0, k0] = parse(visited[i - 1]);
      const [s1, k1] = parse(visited[i]);
      if (!((s1 === s0 && k1 === k0 + 1) || (s1 === s0 + 1 && k1 === 0))) stepwise = false;
    }
    const slides = new Set(visited.map((v) => v.split("/")[0]));
    check(
      `every slide and step from the phone (${visited.length} positions)`,
      stepwise && slides.size === talk.slides.length && visited.length > talk.slides.length,
      visited.join(" "),
    );
    const lastPos = visited.at(-1);
    await tap("prev");
    await tap("prev");
    check("prev", (await pos(laptop)) !== lastPos);
    check("first", (await tap("first")) === "0/0");
    check("last", (await tap("last")) === lastPos);
    await phone.click('[data-action="black"]');
    await laptop.waitForFunction(() => document.body.dataset.black === "true", null, {
      timeout: 5000,
    });
    await phone.waitForFunction(() => document.body.dataset.black === "true");
    await phone.click('[data-action="black"]');
    await laptop.waitForFunction(() => document.body.dataset.black === "false", null, {
      timeout: 5000,
    });
    check("black screen on and off from the phone", true);
    await tap("first");

    // Burst: 12 taps at once converge (rate limit: 10/s, excess dropped silently).
    await phone.evaluate(() => {
      const b = document.querySelector('[data-action="next"]');
      for (let i = 0; i < 12; i++) b.click();
    });
    await sleep(800);
    const burst = await converge();
    const [bs, bk] = parse(burst);
    check(`a burst of 12 taps converges (${burst})`, bs > 0 || bk > 0);

    // Latency: click on the phone -> the screen's state changes.
    await tap("first");
    await laptop.evaluate(() => {
      window.__changes = [];
      new MutationObserver(() => window.__changes.push(Date.now())).observe(document.body, {
        attributes: true,
        attributeFilter: ["data-slide", "data-step"],
      });
    });
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const n = await laptop.evaluate(() => window.__changes.length);
      const t0 = await phone.evaluate(() => {
        const t = Date.now();
        document.querySelector('[data-action="next"]').click();
        return t;
      });
      await laptop.waitForFunction((k) => window.__changes.length > k, n, { timeout: 5000 });
      const t1 = await laptop.evaluate((k) => window.__changes[k], n);
      samples.push(t1 - t0);
      await converge();
      await sleep(120); // stay under the 10/s rate limit
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)];
    r.latencyMs = { p50, max: samples.at(-1), samples };
    check(`latency click -> slide p50 ${p50} ms (< 150)`, p50 < 150, samples.join(","));

    // ---------------------------------------------------------------------------------------------------------------
    // Laser

    const laserCheck = async (canvas, viewports, tag) => {
      await phone.click('[data-action="laser"]');
      await phone.waitForSelector("[data-pptaken-pad]:not([hidden])");
      const pad = await phone.locator("[data-pptaken-pad]").boundingBox();
      check(
        `${tag}: the pad has the deck's aspect ratio`,
        Math.abs(pad.width / pad.height - canvas.width / canvas.height) < 0.02,
      );
      const dot = () =>
        laptop.evaluate(() => {
          const el = document.querySelector("[data-pptaken-laser]");
          const host = document.getElementById("stage").getBoundingClientRect();
          if (!el || el.style.display === "none") return null;
          const b = el.getBoundingClientRect();
          return {
            x: b.left + b.width / 2 - host.left,
            y: b.top + b.height / 2 - host.top,
            size: b.width,
            w: host.width,
            h: host.height,
          };
        });
      for (const [w, h] of viewports) {
        await laptop.setViewportSize({ width: w, height: h });
        await sleep(100);
        for (const [fx, fy] of [
          [0.5, 0.5],
          [0.1, 0.2],
          [0.9, 0.85],
        ]) {
          const mx = pad.x + fx * pad.width;
          const my = pad.y + fy * pad.height;
          await phone.mouse.move(mx, my);
          await phone.mouse.down();
          const px = Math.round(((mx - pad.x) / pad.width) * 10000) / 10000;
          const py = Math.round(((my - pad.y) / pad.height) * 10000) / 10000;
          let got = null;
          for (let i = 0; i < 60 && got === null; i++) {
            got = await dot();
            if (got === null) await sleep(25);
          }
          await phone.mouse.up();
          if (got === null) throw new Error(`${tag}: no laser dot at ${w}x${h}`);
          // The coordinates actually sent (the mouse lands on whole pixels of the pad, so compare the screen with
          // what travelled, and the pad mapping with the mouse position separately).
          const sent = frames
            .map((f) => {
              try {
                return JSON.parse(f);
              } catch {
                return null;
              }
            })
            .filter((f) => f?.type === "pointer")
            .at(-1);
          const s = Math.min(got.w / canvas.width, got.h / canvas.height);
          const ex = (got.w - canvas.width * s) / 2 + (sent.x / 10000) * canvas.width * s;
          const ey = (got.h - canvas.height * s) / 2 + (sent.y / 10000) * canvas.height * s;
          const size = 0.012 * canvas.height * s;
          check(
            `${tag}: laser at ${fx},${fy} on ${w}x${h}: pad mapping within 1 % and the dot within 1 px`,
            Math.abs(sent.x / 10000 - px) <= 0.01 &&
              Math.abs(sent.y / 10000 - py) <= 0.01 &&
              Math.abs(got.x - ex) <= 1 &&
              Math.abs(got.y - ey) <= 1 &&
              Math.abs(got.size - Math.max(size, 2)) <= 1,
            JSON.stringify({ got, sent, px, py, ex, ey, size }),
          );
          await laptop.waitForFunction(
            () => document.querySelector("[data-pptaken-laser]")?.style.display === "none",
            null,
            { timeout: 3000 },
          );
        }
      }
      await laptop.setViewportSize({ width: 1280, height: 720 });
      // Hidden after 1.5 s without frames, under the black screen and in the overview.
      const box = await phone.locator("[data-pptaken-pad]").boundingBox();
      await phone.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await phone.mouse.down();
      await laptop.waitForFunction(
        () => document.querySelector("[data-pptaken-laser]")?.style.display === "block",
        null,
        {
          timeout: 3000,
        },
      );
      await sleep(1800);
      const after = await laptop.evaluate(
        () => document.querySelector("[data-pptaken-laser]")?.style.display,
      );
      await phone.mouse.up();
      check(`${tag}: the dot hides 1.5 s after the last frame`, after === "none");
      for (const [key, label] of [
        ["b", "black screen"],
        ["o", "overview"],
      ]) {
        await laptop.keyboard.press(key);
        await sleep(150);
        await phone.mouse.move(box.x + box.width / 3, box.y + box.height / 3);
        await phone.mouse.down();
        await phone.mouse.move(box.x + box.width / 2.5, box.y + box.height / 2.5);
        await sleep(400);
        const shown = await laptop.evaluate(
          () => document.querySelector("[data-pptaken-laser]")?.style.display,
        );
        await phone.mouse.up();
        check(`${tag}: no dot under the ${label}`, shown === "none");
        await laptop.keyboard.press(key === "b" ? "b" : "Escape");
        await sleep(150);
      }
      await phone.click('[data-action="laser"]');
    };
    await laserCheck(
      { width: 1920, height: 1080 },
      [
        [1280, 720],
        [1000, 800],
        [700, 900],
      ],
      "16:9",
    );

    // ---------------------------------------------------------------------------------------------------------------
    // Server stopped: the screen keeps presenting; both reconnect and converge afterwards.

    allowErrors = true;
    const atStop = await converge();
    await server.stop();
    await laptop.keyboard.press("ArrowRight");
    await laptop.keyboard.press("ArrowRight");
    await sleep(300);
    check("server down: the screen still navigates", (await pos(laptop)) !== atStop);
    await phone.waitForFunction(() => document.body.dataset.socket === "connecting", null, {
      timeout: 15_000,
    });
    check("server down: the phone says it is reconnecting", true);
    await sleep(1000);
    await server.start();
    await phone.waitForFunction(
      () => document.body.dataset.socket === "open" && document.body.dataset.screen === "true",
      null,
      { timeout: 20_000 },
    );
    await laptop.waitForFunction(() => document.body.dataset.remote === "open", null, {
      timeout: 20_000,
    });
    const back = await converge(15_000);
    check(`server back: both reconnect and the phone shows the screen's position (${back})`, true);
    await tap("next");
    check("commands work after the restart", true);

    // Phone offline and back.
    await phoneCtx.setOffline(true);
    await sleep(800);
    await phoneCtx.setOffline(false);
    await phone.waitForFunction(() => document.body.dataset.socket === "open", null, {
      timeout: 20_000,
    });
    await tap("next");
    check("phone offline and back: converges and keeps working", true);
    allowErrors = false;

    // ---------------------------------------------------------------------------------------------------------------
    // Notes: on the phone over HTTP only; never in a socket frame, never in a content document.

    check(`socket frames observed (${frames.length})`, frames.length > 20);
    check("notes absent from every socket frame", !frames.some((f) => f.includes(NOTE)));
    for (const p of [laptop, phone]) {
      for (const f of p.frames().filter((f) => f.url().startsWith(`${content}/c/`))) {
        const html = await f.evaluate(() => document.documentElement.outerHTML);
        if (html.includes(NOTE)) throw new Error("notes leaked into a content document");
      }
    }
    check("notes absent from the content documents (laptop and phone previews)", true);

    // ---------------------------------------------------------------------------------------------------------------
    // Kick

    await laptop.keyboard.press("k");
    await phone.waitForFunction(() => document.body.dataset.state === "revoked", null, {
      timeout: 10_000,
    });
    check(
      "K disconnects the phone and forgets its credential",
      (await phone.evaluate(() => localStorage.getItem("pptaken.remote"))) === null,
    );
    await laptop.waitForFunction(() => document.body.dataset.remotes === "0", null, {
      timeout: 5000,
    });
    check("the laptop shows no remote", true);

    // ---------------------------------------------------------------------------------------------------------------
    // 4:3 deck: pair again (a new live session) and check the laser geometry.

    await pairWith(fourThree.presentationId);
    await laserCheck(
      { width: 1440, height: 1080 },
      [
        [1280, 720],
        [800, 900],
      ],
      "4:3",
    );
    check("4:3 notes stay off the socket", !frames.some((f) => f.includes(NOTE_4x3)));
    // Leave the session clean for the next engine (the limit of two remotes is per live session).
    await laptop.keyboard.press("k");
    await phone.waitForFunction(() => document.body.dataset.state === "revoked", null, {
      timeout: 10_000,
    });
    check("kick on the 4:3 session", true);

    // The presenter window has the same panel behind a button (HTTP only, no socket there).
    const presenter = await laptopCtx.newPage();
    watch(presenter, "presenter");
    await presenter.goto(`${app}/p/${talkDeck.presentationId}/presenter`);
    await presenter.waitForSelector('body[data-state="ready"]', { timeout: 15_000 });
    check(
      "presenter window: QR not shown by default",
      (await presenter.locator("[data-pptaken-qr] svg").count()) === 0,
    );
    await presenter.click("[data-pptaken-remote-button]");
    await presenter.waitForSelector("[data-pptaken-qr] svg path", { timeout: 5000 });
    check("presenter window: the remote button shows the pairing QR", true);
    await presenter.close();

    check("no console errors or page errors", problems.length === 0, problems.join(" | "));
    r.ok = true;
  } catch (error) {
    r.error = String(error?.message ?? error);
    for (const p of browser.contexts().flatMap((c) => c.pages())) {
      r.debug ??= [];
      r.debug.push(
        await p
          .evaluate(
            () =>
              `${location.pathname} ${JSON.stringify(document.body.dataset)} ${document.body.innerText.slice(0, 400)}`,
          )
          .catch(() => "?"),
      );
    }
    if (problems.length) r.problems = problems;
    failed = true;
  } finally {
    await browser.close();
  }
}

try {
  for (const name of selected) {
    const engine = ENGINES[name];
    if (!engine) throw new Error(`unknown engine ${name}`);
    await runEngine(name, engine);
    const r = results.engines[name];
    console.log(`${name}: ${r.ok ? "ok" : `FAILED ${r.error}`} (${r.checks.length} checks)`);
    for (const c of r.checks) console.log(`  - ${c}`);
    if (r.problems) console.log(`  problems: ${r.problems.join("\n    ")}`);
    if (r.debug) console.log(`  debug: ${r.debug.join("\n    ")}`);
  }
} finally {
  await server.stop();
  await pptaken.close();
  rmSync(dataDir, { recursive: true, force: true });
}
results.finishedAt = new Date().toISOString();
writeFileSync(
  new URL("./remote-last-run.json", import.meta.url),
  `${JSON.stringify(results, null, 2)}\n`,
);
process.exit(failed ? 1 : 0);
