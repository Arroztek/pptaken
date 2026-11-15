// SPDX-License-Identifier: Apache-2.0
// Player browser test: the built shell, runtime and builder in Chromium, Firefox and WebKit, with the production
// isolation (sandboxed iframe, CSP sandbox, no-network CSP, separate content origin).
// Usage: pnpm --filter @pptaken/player test:browser   (builds first; needs the Playwright browsers)
//
//   a. every step and slide of the 20-slide deck, forward and back, state and DOM checked after each key
//   b. keys with focus inside the iframe and on the parent page; typing and modifiers ignored
//   c. URL hash: updated on every move, read on load (clamped), followed on hashchange
//   d. black screen (b, .) and full screen (f)
//   e. scaling: 16:9 and 4:3 at several viewport sizes keep the aspect ratio, centered on black
//   f. frame times while pressing next/prev quickly (asserted in Chromium only)
//   g. security: raw hostile content injected after the builder cannot reach the parent, cookies or the network;
//      a content-initiated navigation is detected as a fault; content cannot select, change the mode, print, open
//      help or open windows by itself
//   h. overview (o): keyboard and mouse, highlight, sections, all steps shown, select validated
//   i. overview performance with 200 slides (measured; asserted loosely in Chromium)
//   j. key help overlay (?)
//   k. print (p): layout in every engine; in Chromium a real PDF via page.pdf, page count and page text checked
//   l. presenter window (s): sync both ways over BroadcastChannel, previews, notes only there, black, clock, pace
//   m. pace with the Playwright clock (behind after 20 fake minutes)
//   n. offline: in-memory preload and indicator, every slide and step with the network cut, overview and black
//      screen offline, "partial" with a missing asset, the srcdoc delivery path (offline document under the
//      production page CSP) with the same hostile-content checks, a content navigation fault, and a document
//      without the no-network CSP refused
// Results go to browser/last-run.json.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";
import { sanitizeDeck } from "@pptaken/sanitizer";
import { parseDeck } from "@pptaken/schema";
import * as nav from "../dist/navigation.js";
import { MISSING_ASSET, scriptHash, startServers } from "./server.mjs";

const EXAMPLES = new URL("../../schema/examples/", import.meta.url);
const ASSET = "5746af00ffb22400fac7f2aa16181d00";

const load = (file) => {
  const r = parseDeck(JSON.parse(readFileSync(new URL(file, EXAMPLES), "utf8")));
  if (!r.ok) throw new Error(`${file}: ${JSON.stringify(r.issues)}`);
  return r.deck;
};
const clean = (deck) => {
  const r = sanitizeDeck(deck);
  if (r.warnings.length > 0) throw new Error(`unexpected warnings: ${JSON.stringify(r.warnings)}`);
  return r.deck;
};

// The 20-slide example plus one image asset (the F1 definition of done: steps, SVG and images).
const talkSource = load("talk-20-slides.json");
const talk = clean({
  ...talkSource,
  slides: talkSource.slides.map((s) =>
    s.id === "risks"
      ? {
          ...s,
          html: `${s.html}<img src="asset:${ASSET}" width="160" height="160" alt="logo" style="position:absolute;right:120px;bottom:80px">`,
        }
      : s,
  ),
});
const charla = clean(load("charla-4-3.json"));
const hello = clean(load("hello.json"));
// Step semantics: numbered steps first (ascending, equal numbers together), then unnumbered in document order.
const steps = clean(
  parseDeck({
    schemaVersion: 1,
    title: "Steps",
    slides: [
      {
        id: "mixed",
        html: '<p data-step="2">B</p><p data-step>U1</p><p data-step="1">A</p><p data-step="">U2</p><p data-step="2">B2</p><p>always</p>',
      },
      { id: "plain", html: "<p>no steps</p>" },
    ],
  }).deck,
);

const RAW = (o) =>
  [
    `<img src="/api/img-relative">`,
    `<img src="x">`,
    `<img src="${o.shell}/api/img-app-origin">`,
    `<img src="${o.content}/api/img-content-origin">`,
    `<script>window.__pwned=1;parent.postMessage({pwned:"inline-script"},"*")</script>`,
    `<img src="/c/asset/${ASSET}" onerror="parent.postMessage({pwned:'onerror'},'*')" onload="parent.postMessage({pwned:'onload'},'*')">`,
    `<style>@import url(/api/css-import);@font-face{font-family:evil;src:url(/api/font)}.e{font-family:evil;background:url(/api/css-bg)}</style>`,
    `<p class="e">x</p>`,
    `<link rel="stylesheet" href="/api/link">`,
    `<svg><image href="/api/svg-image"></image><a href="javascript:parent.postMessage({pwned:'svg-js'},'*')"><text y="20">x</text></a></svg>`,
    `<div style="background-image:url(/api/inline-bg);width:10px;height:10px"></div>`,
    `<iframe src="/api/frame"></iframe><object data="/api/object"></object><embed src="/api/embed">`,
    `<video src="/api/video" autoplay></video><audio src="/api/audio" autoplay></audio>`,
    `<form action="/api/form"><button id="evilbtn">x</button></form>`,
  ].join("");

const PROBE = (o) => `(() => {
  const r = {};
  const t = (name, fn) => { try { r[name] = "allowed:" + String(fn()).slice(0, 60); } catch (e) { r[name] = "blocked:" + e.name; } };
  t("cookie", () => document.cookie);
  t("localStorage", () => localStorage.length);
  t("parentDocument", () => parent.document.title);
  t("parentLocation", () => parent.location.href);
  t("topNavigation", () => { top.location.href = "${o.shell}/api/top"; return "assigned"; });
  t("windowOpen", () => window.open("${o.shell}/api/open"));
  t("eval", () => eval("1 + 1"));
  t("newFunction", () => new Function("return 2")());
  t("formSubmit", () => { document.querySelector("form")?.requestSubmit(); return "submitted"; });
  r.selfOrigin = self.origin;
  const img = new Image(); img.src = "${o.shell}/api/js-image";
  Promise.allSettled([fetch("/api/fetch"), fetch("${o.shell}/api/fetch-app"), new Promise((ok, ko) => {
    const x = new XMLHttpRequest(); x.onload = ok; x.onerror = () => ko(new Error("xhr")); x.open("GET", "/api/xhr"); x.send();
  })]).then((all) => {
    r.network = all.map((a) => a.status);
    // Try to drive the shell without a user gesture: select a slide, change the mode, open the presenter
    // window, print, show help. All of it must be ignored.
    for (const m of [
      { v: 1, type: "select", slide: 2 },
      { v: 1, type: "mode", mode: "print" },
      { v: 1, type: "mode", mode: "overview" },
      { v: 1, type: "key", code: "KeyO" },
      { v: 1, type: "key", code: "KeyS" },
      { v: 1, type: "key", code: "KeyP" },
      { v: 1, type: "key", code: "Question" },
    ]) parent.postMessage(m, "*");
    parent.postMessage({ probe: r }, "*");
  });
})();`;

const hostile = {
  deck: hello,
  inject: (html, nonce, o) =>
    html
      .replace("</head>", `<script nonce="${nonce}">${PROBE(o)}</script></head>`)
      .replace("hidden>", `hidden>${RAW(o)}`),
};
const hostileNav = {
  deck: hello,
  inject: (html, _nonce, o) =>
    html.replace(
      "hidden>",
      `hidden><meta http-equiv="refresh" content="1;url=${o.content}/elsewhere">`,
    ),
};

// 200 slides (the schema maximum) with text, a list, an SVG and a step each, in 10 sections: overview performance.
const big = clean(
  parseDeck({
    schemaVersion: 1,
    title: "Big",
    slides: Array.from({ length: 200 }, (_, i) => ({
      id: `s${i}`,
      title: `Slide ${i + 1}`,
      section: `Part ${Math.floor(i / 20) + 1}`,
      html:
        `<h1 style="font:700 96px sans-serif;margin:80px">Slide ${i + 1}</h1>` +
        `<ul style="font:48px sans-serif;margin:0 80px">${"<li>A point worth making</li>".repeat(4)}</ul>` +
        `<p data-step="1" style="font:48px sans-serif;margin:40px 80px">Revealed later</p>` +
        `<svg width="400" height="300" viewBox="0 0 4 3" style="position:absolute;right:80px;bottom:80px"><rect width="4" height="3" fill="hsl(${(i * 37) % 360} 60% 50%)"/></svg>`,
    })),
  }).deck,
);

// Offline: one image that the content origin answers with 404 (preload "partial").
const partial = clean({
  ...hello,
  slides: hello.slides.map((s, i) =>
    i === 1
      ? { ...s, html: `${s.html}<img src="asset:${MISSING_ASSET}" width="40" height="40" alt="">` }
      : s,
  ),
});

const DECKS = new Map([
  ["talk", { deck: talk }],
  ["big", { deck: big }],
  ["charla", { deck: charla }],
  ["hello", { deck: hello }],
  ["steps", { deck: steps }],
  ["hostile", hostile],
  ["hostile-nav", hostileNav],
  ["partial", { deck: partial }],
  // Offline delivery (srcdoc). The page CSP allows the probe's hash: this models a script that got through.
  ["offline-hostile", { ...hostile, pageHashes: (o) => [scriptHash(PROBE(o))] }],
  // The same document under the real page CSP: the inherited policy blocks the probe too.
  ["offline-hostile-strict", hostile],
  ["offline-nav", hostileNav],
]);

const server = await startServers((key) => DECKS.get(key) ?? null);
const { origins } = server;
const report = { date: new Date().toISOString(), origins, engines: {} };
let failed = false;

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const round = (n) => Math.round(n * 100) / 100;

for (const [name, type] of [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
]) {
  const engine = { passed: 0, failed: 0, failures: [], notes: [] };
  report.engines[name] = engine;
  const check = (label, ok, detail = "") => {
    if (ok) engine.passed++;
    else {
      engine.failed++;
      failed = true;
      engine.failures.push(`${label}${detail ? `: ${detail}` : ""}`);
    }
    return ok;
  };
  const section = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      check(label, false, String(error?.message ?? error).split("\n")[0]);
    }
  };

  const browser = await type.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  // Responses only: Chromium reports CSP-blocked requests as "request" events that never reach the network.
  const responses = [];
  page.on("response", (r) => responses.push(r.url()));
  const waitHash = (p) =>
    page
      .waitForFunction((h) => location.hash === h, nav.formatHash(p), { timeout: 3000 })
      .then(
        () => true,
        () => false,
      );

  const open = async (key, hash = "") => {
    await page.goto("about:blank");
    await page.goto(`${origins.shell}/player/${key}${hash}`);
    await page.waitForFunction(() => window.__test?.slides && window.__test.rendered, null, {
      timeout: 10000,
    });
  };
  const frame = () => page.frames().find((f) => f.url().includes("/c/deck/"));
  const state = () => page.evaluate(() => window.__player.getState());
  const waitState = (slide, step) =>
    page.waitForFunction(
      ([s, t]) => {
        const r = window.__test.rendered;
        const p = window.__player.getState();
        return r && p && r.slide === s && r.step === t && p.slide === s && p.step === t;
      },
      [slide, step],
      { timeout: 4000 },
    );
  const view = () =>
    frame().evaluate(() => {
      const shown = [...document.querySelectorAll("#pptaken-stage > section")].filter(
        (s) => getComputedStyle(s).display !== "none",
      );
      const s = shown[0];
      const stepEls = s ? [...s.querySelectorAll("[data-step]")] : [];
      return {
        shown: shown.map((x) => x.getAttribute("data-slide")),
        revealed: stepEls
          .filter((e) => getComputedStyle(e).visibility === "visible")
          .map((e) => e.getAttribute("data-step") || e.textContent),
        hiddenWithLayout: stepEls
          .filter((e) => getComputedStyle(e).visibility === "hidden")
          .every((e) => e.getBoundingClientRect().height > 0),
      };
    });
  const focusParent = () =>
    page.evaluate(() => {
      const i = document.getElementById("typing");
      i.focus();
      i.blur();
      return document.activeElement === document.body && document.hasFocus();
    });
  const focusIframe = async () => {
    await page.mouse.click(640, 360);
    return page.evaluate(() => document.activeElement?.tagName === "IFRAME");
  };

  // a + b. Full traversal: forward with focus in the iframe, back with focus on the parent.
  await section("traversal", async () => {
    await open("talk");
    const slides = await page.evaluate(() => window.__test.slides);
    const expectedSteps = talk.slides.map((s) => (s.html.match(/data-step=/g) ?? []).length);
    check(
      "ready lists the deck's slides",
      JSON.stringify(slides.map((s) => s.id)) === JSON.stringify(talk.slides.map((s) => s.id)),
    );
    check(
      "ready counts the steps",
      JSON.stringify(slides.map((s) => s.steps)) === JSON.stringify(expectedSteps),
    );
    const shape = { slides };
    const all = [];
    for (let p = nav.first(shape); ; p = nav.next(shape, p)) {
      all.push(p);
      if (nav.samePosition(p, nav.last(shape))) break;
    }
    const verify = async (p, label) => {
      await waitState(p.slide, p.step);
      const v = await view();
      const want = Array.from({ length: p.step }, (_, i) => String(i + 1));
      return (
        check(
          `${label} shows ${slides[p.slide].id}`,
          v.shown.length === 1 && v.shown[0] === slides[p.slide].id,
          JSON.stringify(v.shown),
        ) &&
        check(
          `${label} reveals ${p.step} steps of ${slides[p.slide].id}`,
          JSON.stringify(v.revealed) === JSON.stringify(want),
          JSON.stringify(v.revealed),
        )
      );
    };
    check("initial focus moves into the iframe on click", await focusIframe());
    await verify(all[0], "start");
    const forwardKeys = ["ArrowRight", "Space", "PageDown", "ArrowDown", "Enter"];
    const keysBefore = await page.evaluate(() => window.__test.keys);
    let ok = true;
    for (let i = 1; i < all.length && ok; i++) {
      await page.keyboard.press(forwardKeys[i % forwardKeys.length]);
      ok = await verify(all[i], `forward[iframe focus] #${i}`);
    }
    const forwarded = (await page.evaluate(() => window.__test.keys)) - keysBefore;
    check("keys were forwarded by the iframe", forwarded === all.length - 1, `${forwarded}`);
    const end = all[all.length - 1];
    check("hash is written once navigation pauses", await waitHash(end));
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
    check("next at the end stays", nav.samePosition(await state(), end));

    // The image asset loaded under the opaque origin with img-src limited to the asset path.
    await page.keyboard.press("Home");
    await page.evaluate(() => window.__player.goto(18, 0));
    await waitState(18, 0);
    const image = await frame().evaluate(() => {
      const img = document.querySelector('[data-slide="risks"] img');
      return img
        ? { complete: img.complete, width: img.naturalWidth, src: img.getAttribute("src") }
        : null;
    });
    check("asset image loads", image?.complete && image.width === 160, JSON.stringify(image));
    await page.keyboard.press("End");
    await waitState(end.slide, end.step);

    check("focus moves to the parent", await focusParent());
    const backKeys = ["ArrowLeft", "PageUp", "ArrowUp", "Backspace", "Shift+Space"];
    const keysBack = await page.evaluate(() => window.__test.keys);
    ok = true;
    for (let i = all.length - 2; i >= 0 && ok; i--) {
      await page.keyboard.press(backKeys[i % backKeys.length]);
      ok = await verify(all[i], `back[parent focus] #${i}`);
    }
    check(
      "parent keys are handled by the shell",
      (await page.evaluate(() => window.__test.keys)) === keysBack,
    );
    check("hash back at the start", await waitHash(all[0]));
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(100);
    check("prev at the start stays", nav.samePosition(await state(), all[0]));

    // Home/End from both sides.
    await page.keyboard.press("End");
    await waitState(end.slide, end.step);
    await page.keyboard.press("Home");
    await waitState(0, 0);
    check("Home/End on the parent", true);
    await focusIframe();
    await page.keyboard.press("End");
    await waitState(end.slide, end.step);
    await page.keyboard.press("Home");
    await waitState(0, 0);
    check("Home/End in the iframe", true);

    // Ignored keys: modifiers, typing in an input, unknown keys.
    for (const k of ["Control+ArrowRight", "Alt+ArrowRight", "Shift+ArrowRight", "a", "Escape"]) {
      await page.keyboard.press(k);
    }
    await focusParent();
    for (const k of ["Control+ArrowRight", "Shift+ArrowRight", "x"]) await page.keyboard.press(k);
    await page.focus("#typing");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await page.waitForTimeout(150);
    const s = await state();
    check(
      "modifiers, unknown keys and typing are ignored",
      s.slide === 0 && s.step === 0,
      JSON.stringify(s),
    );
  });

  // Step semantics in the browser.
  await section("steps", async () => {
    await open("steps");
    const slides = await page.evaluate(() => window.__test.slides);
    check(
      "mixed steps counted",
      slides[0].steps === 4 && slides[1].steps === 0,
      JSON.stringify(slides),
    );
    // Revealed elements in document order (B=2, U1, A=1, U2, B2=2), by data-step value or text if unnumbered.
    const expected = [
      [],
      ["1"],
      ["2", "1", "2"],
      ["2", "U1", "1", "2"],
      ["2", "U1", "1", "U2", "2"],
    ];
    for (let step = 0; step <= 4; step++) {
      await page.evaluate((t) => window.__player.goto(0, t), step);
      await waitState(0, step);
      const v = await view();
      check(
        `steps: step ${step} reveals`,
        JSON.stringify(v.revealed) === JSON.stringify(expected[step]),
        JSON.stringify(v.revealed),
      );
      check(`steps: hidden steps keep their layout at ${step}`, v.hiddenWithLayout);
    }
    const always = await frame().evaluate(() => {
      const p = [...document.querySelectorAll('[data-slide="mixed"] p')].find(
        (e) => e.textContent === "always",
      );
      return getComputedStyle(p).visibility;
    });
    check("elements without data-step are always visible", always === "visible");
  });

  // c. URL hash.
  await section("hash", async () => {
    await open("talk", "#/5/1");
    await waitState(4, 1);
    const v = await view();
    check(
      "#/5/1 loads slide 5 step 1",
      v.shown[0] === "brief" && JSON.stringify(v.revealed) === '["1"]',
      JSON.stringify(v),
    );
    for (const [hash, slide, step] of [
      ["#/99/42", 19, 0],
      ["#/2/99", 1, 4],
      ["#/0/0", 0, 0],
      ["#/nope", 0, 0],
    ]) {
      await open("talk", hash);
      await waitState(slide, step);
      check(`hash ${hash} clamps to ${slide}/${step}`, true);
      check(`hash ${hash} is rewritten`, await waitHash({ slide, step }));
    }
    await page.evaluate(() => {
      location.hash = "#/3/0";
    });
    await waitState(2, 0);
    check("hashchange navigates", true);
    await focusParent();
    await page.keyboard.press("ArrowRight");
    await waitState(3, 0);
    check("hash follows navigation", await waitHash({ slide: 3, step: 0 }));
    await page.evaluate(() => {
      location.hash = "#/garbage";
    });
    check("an invalid hash edited by hand is replaced", await waitHash({ slide: 3, step: 0 }));

    // On-demand slide counter: shown after a move, gone after 2 s.
    const hud = () =>
      page.evaluate(() => {
        const h = document.getElementById("host").children[2];
        return {
          text: h.textContent,
          opacity: getComputedStyle(h).opacity,
          color: getComputedStyle(h).color,
        };
      });
    await page.keyboard.press("ArrowRight");
    await waitState(3, 1);
    const shown = await hud();
    check(
      "HUD shows n / N in neutral gray",
      shown.text === "4 / 20" && shown.color === "rgb(139, 143, 160)",
      JSON.stringify(shown),
    );
    await page.waitForTimeout(2600);
    check("HUD fades after 2 s", (await hud()).opacity === "0");
  });

  // d. Black screen and full screen.
  await section("black-fullscreen", async () => {
    await open("hello");
    const curtain = () =>
      page.evaluate(() => {
        const c = document.getElementById("host").children[1];
        const r = c.getBoundingClientRect();
        return {
          black: window.__player.getState().black,
          shown:
            getComputedStyle(c).display !== "none" &&
            r.width === innerWidth &&
            r.height === innerHeight,
          bg: getComputedStyle(c).backgroundColor,
        };
      });
    await focusParent();
    await page.keyboard.press("b");
    let c = await curtain();
    check(
      "b turns the screen black",
      c.black && c.shown && c.bg === "rgb(0, 0, 0)",
      JSON.stringify(c),
    );
    await page.keyboard.press(".");
    c = await curtain();
    check(". turns it back", !c.black && !c.shown, JSON.stringify(c));
    await focusIframe();
    await page.keyboard.press(".");
    await page.waitForFunction(() => window.__player.getState().black);
    c = await curtain();
    check("black screen from inside the iframe", c.black && c.shown, JSON.stringify(c));
    await page.keyboard.press("b");
    await page.waitForFunction(() => !window.__player.getState().black);
    check("b from inside the iframe turns it back", true);

    await focusParent();
    await page.keyboard.press("f");
    const entered = await page
      .waitForFunction(() => document.fullscreenElement === document.getElementById("host"), null, {
        timeout: 3000,
      })
      .then(
        () => true,
        () => false,
      );
    check("f enters full screen on the host", entered);
    await page.keyboard.press("f");
    const left = await page
      .waitForFunction(() => document.fullscreenElement === null, null, { timeout: 3000 })
      .then(
        () => true,
        () => false,
      );
    check("f leaves full screen", left);
    await focusIframe();
    await page.keyboard.press("f");
    const fromFrame = await page
      .waitForFunction(() => document.fullscreenElement === document.getElementById("host"), null, {
        timeout: 3000,
      })
      .then(
        () => true,
        () => false,
      );
    check("f from inside the iframe enters full screen", fromFrame);
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
    await page.waitForFunction(() => document.fullscreenElement === null).catch(() => {});
  });

  // e. Scaling and letterbox.
  await section("scaling", async () => {
    for (const [key, w, h] of [
      ["talk", 1920, 1080],
      ["charla", 1440, 1080],
    ]) {
      await page.setViewportSize({ width: 1280, height: 720 });
      await open(key);
      for (const [vw, vh] of [
        [1280, 720],
        [1000, 1000],
        [800, 600],
        [1920, 1200],
        [480, 900],
        [1600, 500],
      ]) {
        await page.setViewportSize({ width: vw, height: vh });
        const expectedScale = Math.min(vw / w, vh / h);
        await frame().waitForFunction(
          (s) =>
            Math.abs(document.getElementById("pptaken-stage").getBoundingClientRect().width - s) <
            1,
          w * expectedScale,
          { timeout: 4000 },
        );
        const m = await frame().evaluate(() => {
          const r = document.getElementById("pptaken-stage").getBoundingClientRect();
          const s = [...document.querySelectorAll("#pptaken-stage > section")]
            .find((x) => !x.hidden)
            .getBoundingClientRect();
          return {
            r: { x: r.x, y: r.y, w: r.width, h: r.height },
            s: { x: s.x, y: s.y, w: s.width, h: s.height },
            vw: innerWidth,
            vh: innerHeight,
            bg: getComputedStyle(document.body).backgroundColor,
            htmlBg: getComputedStyle(document.documentElement).backgroundColor,
          };
        });
        const { r, s } = m;
        const label = `${key} at ${vw}x${vh}`;
        check(`${label}: frame fills the viewport`, m.vw === vw && m.vh === vh, JSON.stringify(m));
        check(
          `${label}: aspect ratio kept`,
          Math.abs(r.w / r.h - w / h) < 0.005,
          JSON.stringify(r),
        );
        check(
          `${label}: fits one dimension`,
          Math.abs(r.w - vw) < 1 || Math.abs(r.h - vh) < 1,
          JSON.stringify(r),
        );
        check(`${label}: inside the viewport`, r.w <= vw + 0.5 && r.h <= vh + 0.5);
        check(
          `${label}: centered`,
          Math.abs(r.x - (vw - r.w) / 2) < 1 && Math.abs(r.y - (vh - r.h) / 2) < 1,
          JSON.stringify(r),
        );
        check(
          `${label}: slide covers the stage`,
          Math.abs(s.x - r.x) < 1 && Math.abs(s.w - r.w) < 1 && Math.abs(s.h - r.h) < 1,
        );
        check(`${label}: black letterbox`, m.bg === "rgb(0, 0, 0)", m.bg);
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  // f. Frame times while navigating: a burst (keys as fast as Playwright sends them) and a paced run (each key
  // waits until the iframe confirms the new state, so every move is rendered).
  await section("frames", async () => {
    await open("talk");
    await focusParent();
    const measure = async (label, presses, paced) => {
      // One recording loop at a time: a generation counter stops the previous one.
      await page.evaluate(() => {
        window.__frames = [];
        const gen = (window.__gen = (window.__gen ?? 0) + 1);
        const loop = (t) => {
          if (window.__gen !== gen) return;
          window.__frames.push(t);
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      await page.waitForTimeout(200);
      const started = Date.now();
      for (let i = 0; i < presses; i++) {
        const forward = i < presses / 2;
        await page.keyboard.press(forward ? "ArrowRight" : "ArrowLeft");
        if (paced) {
          const p = await state();
          await waitState(p.slide, p.step);
        }
      }
      const elapsedMs = Date.now() - started;
      await page.waitForTimeout(100);
      const frames = await page.evaluate(() => {
        window.__gen++;
        return window.__frames;
      });
      const intervals = frames
        .slice(1)
        .map((t, i) => t - frames[i])
        .sort((a, b) => a - b);
      const stats = {
        label,
        presses,
        elapsedMs,
        frames: frames.length,
        p50: round(pct(intervals, 50)),
        p95: round(pct(intervals, 95)),
        max: round(intervals[intervals.length - 1]),
      };
      const st = await state();
      check(
        `${label}: ${presses} presses end at the start`,
        st.slide === 0 && st.step === 0,
        JSON.stringify(st),
      );
      if (name === "chromium")
        check(`${label}: frame time p95 < 33 ms (${stats.p95} ms)`, stats.p95 < 33);
      return stats;
    };
    engine.frameTimes = [await measure("burst", 140, false), await measure("paced", 120, true)];
    if (name !== "chromium") engine.notes.push("frame times recorded, not asserted");
  });

  // g. Security: raw hostile content in the built document.
  await section("security", async () => {
    server.hits.length = 0;
    responses.length = 0;
    await open("hostile");
    await page.waitForFunction(() => window.__test.probe, null, { timeout: 8000 });
    await page.waitForTimeout(1500);
    const t = await page.evaluate(() => window.__test);
    const p = t.probe;
    check("no hostile script or handler ran", t.pwned.length === 0, JSON.stringify(t.pwned));
    check("content has an opaque origin", p.selfOrigin === "null", p.selfOrigin);
    for (const k of [
      "cookie",
      "localStorage",
      "parentDocument",
      "parentLocation",
      "topNavigation",
      "eval",
      "newFunction",
    ]) {
      check(`content cannot use ${k}`, String(p[k]).startsWith("blocked:"), p[k]);
    }
    check(
      "window.open is blocked",
      p.windowOpen === "allowed:null" || String(p.windowOpen).startsWith("blocked:"),
      p.windowOpen,
    );
    check(
      "fetch and XHR are blocked",
      JSON.stringify(p.network) === '["rejected","rejected","rejected"]',
      JSON.stringify(p.network),
    );
    const pwnedInFrame = await frame().evaluate(() => window.__pwned);
    check("inline script did not run", pwnedInFrame === undefined);
    check("no request reached any server", server.hits.length === 0, server.hits.join(" | "));
    const apiResponses = responses.filter((u) => u.includes("/api/"));
    check(
      "no response from /api reached the content",
      apiResponses.length === 0,
      apiResponses.join(" | "),
    );
    check("shell still works next to hostile content", (await state())?.slideCount === 3);
    const after = await state();
    const shellSide = await page.evaluate(() => ({
      printing: document.getElementById("host").hasAttribute("data-pptaken-printing"),
      help: !document.querySelector("#host [role=dialog]").hidden,
    }));
    check(
      "content cannot select, change the mode, print, open help or open windows by itself",
      after.mode === "present" &&
        after.slide === 0 &&
        !shellSide.printing &&
        !shellSide.help &&
        context.pages().length === 1,
      JSON.stringify({ after, shellSide, pages: context.pages().length }),
    );
    check(
      "no fault for a document that stays put",
      t.faults.length === 0,
      JSON.stringify(t.faults),
    );

    server.hits.length = 0;
    await open("hostile-nav");
    const faulted = await page
      .waitForFunction(() => window.__test.faults.includes("unexpected-navigation"), null, {
        timeout: 8000,
      })
      .then(
        () => true,
        () => false,
      );
    check("content navigation is detected as a fault", faulted);
    const nav2 = server.hits.filter((h) => h.includes("/elsewhere"));
    check(
      "the navigation carried no cookie (separate origin)",
      nav2.every((h) => h.endsWith("cookies=none")),
      nav2.join(" | "),
    );
    check(
      "no session cookie on any request",
      server.hits.every((h) => !/\bsid\b/.test(h)),
      server.hits.join(" | "),
    );
    // Harness self-test: the navigation request is recorded, so "no hit" above means something.
    check("control: the server records content-initiated requests", nav2.length >= 1);
  });

  // h. Overview: keyboard and mouse, highlight, sections, steps fully revealed, and the select message.
  await section("overview", async () => {
    await open("talk", "#/5/1");
    await waitState(4, 1);
    const ov = () =>
      frame().evaluate(() => {
        const sections = [...document.querySelectorAll("#pptaken-stage > section")];
        const steps = [...document.querySelectorAll("#pptaken-stage [data-step]")];
        const mark = document.getElementById("pptaken-mark")?.getBoundingClientRect();
        return {
          mode: document.documentElement.getAttribute("data-pptaken-mode"),
          shown: sections.filter((s) => getComputedStyle(s).display !== "none").length,
          stepsVisible: steps.filter((e) => getComputedStyle(e).visibility === "visible").length,
          steps: steps.length,
          labels: [...document.querySelectorAll("#pptaken-overlay > .pptaken-sec")].map(
            (e) => e.textContent,
          ),
          rects: sections.map((s) => {
            const r = s.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }),
          mark: mark ? [mark.x, mark.y, mark.width, mark.height] : null,
        };
      });
    const inMark = (v, i) => {
      const [x, y, w, h] = v.rects[i];
      const [mx, my, mw, mh] = v.mark ?? [0, 0, 0, 0];
      return mx <= x && my <= y && mx + mw >= x + w - 0.5 && my + mh >= y + h - 0.5;
    };
    await focusParent();
    await page.keyboard.press("o");
    await page.waitForFunction(() => window.__player.getState().mode === "overview");
    await frame().waitForFunction(
      () => document.documentElement.getAttribute("data-pptaken-mode") === "overview",
    );
    let v = await ov();
    check("o opens the overview with every slide", v.shown === 20, JSON.stringify(v.shown));
    check(
      "the overview shows every step (fully revealed by design)",
      v.stepsVisible === v.steps && v.steps > 0,
      `${v.stepsVisible}/${v.steps}`,
    );
    check(
      "the overview groups by section",
      JSON.stringify(v.labels) === JSON.stringify([...new Set(talk.slides.map((s) => s.section))]),
      JSON.stringify(v.labels),
    );
    const [, , w0, h0] = v.rects[0];
    check(
      "thumbnails keep the canvas aspect ratio and fit 5 columns",
      Math.abs(w0 / h0 - 16 / 9) < 0.01 && w0 * 5 < 1280,
      JSON.stringify(v.rects[0]),
    );
    check("the current slide is highlighted", inMark(v, 4), JSON.stringify([v.mark, v.rects[4]]));
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => window.__player.getState().highlight === 10);
    // The content applies the goto asynchronously: poll until the ring is on slide 11.
    for (let i = 0; i < 40; i++) {
      v = await ov();
      if (inMark(v, 10)) break;
      await page.waitForTimeout(50);
    }
    check(
      "arrows move the highlight (right, down a row of 5)",
      inMark(v, 10),
      JSON.stringify([v.mark, v.rects[10]]),
    );
    check("the position does not change while browsing", (await state()).slide === 4);
    await page.keyboard.press("Enter");
    await waitState(10, 0);
    check("Enter goes to the highlighted slide", (await state()).mode === "present");
    check("the content is back in present mode", (await ov()).shown === 1);

    // Escape and o close without moving; iframe focus works too (keys forwarded with a user gesture).
    await page.keyboard.press("o");
    await page.waitForFunction(() => window.__player.getState().mode === "overview");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Escape");
    await waitState(10, 0);
    check("Escape closes the overview where it was", (await state()).mode === "present");
    await focusIframe();
    await page.keyboard.press("o");
    const fromFrame = await page
      .waitForFunction(() => window.__player.getState().mode === "overview", null, {
        timeout: 3000,
      })
      .then(
        () => true,
        () => false,
      );
    check("o from inside the iframe opens the overview", fromFrame);
    if (fromFrame) {
      await page.keyboard.press("o");
      await page.waitForFunction(() => window.__player.getState().mode === "present");
      check("o closes it again", true);
    }

    // Mouse: click a thumbnail.
    await page.evaluate(() => window.__player.overview(true));
    await frame().waitForFunction(
      () => document.documentElement.getAttribute("data-pptaken-mode") === "overview",
    );
    v = await ov();
    const [x, y, w, h] = v.rects[13];
    await page.mouse.click(x + w / 2, y + h / 2);
    await waitState(13, 0);
    check("clicking a thumbnail goes to it", (await state()).mode === "present");

    // The select message: validated, and only honoured while the overview is open.
    const post = (m) => frame().evaluate((msg) => parent.postMessage(msg, "*"), m);
    await post({ v: 1, type: "select", slide: 4 });
    await page.waitForTimeout(200);
    check("select is ignored outside the overview", (await state()).slide === 13);
    await page.evaluate(() => window.__player.overview(true));
    await page.waitForFunction(() => window.__player.getState().mode === "overview");
    for (const m of [
      { v: 1, type: "select", slide: 99 },
      { v: 1, type: "select", slide: "4" },
      { v: 1, type: "select", slide: 4, step: 1 },
      { v: 2, type: "select", slide: 4 },
      { v: 1, type: "mode", mode: "present" },
    ])
      await post(m);
    await page.waitForTimeout(200);
    const s = await state();
    check(
      "invalid select messages are dropped",
      s.mode === "overview" && s.slide === 13,
      JSON.stringify(s),
    );
    await post({ v: 1, type: "key", code: "KeyP" });
    await page.waitForTimeout(200);
    check(
      "a forged print key (no user gesture) is ignored",
      !(await page.evaluate(() =>
        document.getElementById("host").hasAttribute("data-pptaken-printing"),
      )),
    );
    await post({ v: 1, type: "select", slide: 4 });
    await waitState(4, 0);
    check("a valid select in the overview is honoured", (await state()).mode === "present");
  });

  // i. Overview performance with 200 slides (no virtualization; content-visibility: auto).
  await section("overview-200", async () => {
    await open("big");
    const tOpen = Date.now();
    await page.evaluate(() => window.__player.overview(true));
    await frame().waitForFunction(
      () =>
        document.documentElement.getAttribute("data-pptaken-mode") === "overview" &&
        document.querySelectorAll("#pptaken-overlay > .pptaken-cap").length === 200,
    );
    // Time to the first two frames painted in overview, measured inside the content.
    const firstFrames = await frame().evaluate(
      () =>
        new Promise((resolve) => {
          const t0 = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
        }),
    );
    const openMs = Date.now() - tOpen;
    // Scroll the grid through the whole deck and record frame intervals: a first (cold) pass renders every
    // thumbnail for the first time; the second (warm) pass is what browsing feels like afterwards.
    const measureScroll = () =>
      frame().evaluate(
        () =>
          new Promise((resolve) => {
            const stage = document.getElementById("pptaken-stage");
            const max = stage.scrollHeight - stage.clientHeight;
            const times = [];
            let n = 0;
            const step = (t) => {
              times.push(t);
              stage.scrollTop = (max * n) / 90;
              n += 1;
              if (n <= 90) requestAnimationFrame(step);
              else {
                const d = times
                  .slice(1)
                  .map((x, i) => x - times[i])
                  .sort((a, b) => a - b);
                resolve({
                  height: stage.scrollHeight,
                  p50: d[Math.floor(d.length * 0.5)],
                  p95: d[Math.floor(d.length * 0.95)],
                  max: d[d.length - 1],
                });
              }
            };
            requestAnimationFrame(step);
          }),
      );
    const r2 = (x) => ({ ...x, p50: round(x.p50), p95: round(x.p95), max: round(x.max) });
    const cold = r2(await measureScroll());
    const scroll = r2(await measureScroll());
    // Keyboard through the grid.
    await focusParent();
    const t1 = Date.now();
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => window.__player.getState().highlight === 180);
    const keysMs = Date.now() - t1;
    const visibleMark = await frame().evaluate(() => {
      const r = document.getElementById("pptaken-mark").getBoundingClientRect();
      return r.top >= -1 && r.bottom <= innerHeight + 1;
    });
    check("the highlight scrolls into view (slide 181 of 200)", visibleMark);
    engine.overview200 = {
      openToReadyMs: openMs,
      firstTwoFramesMs: round(firstFrames),
      scrollCold: cold,
      scrollWarm: scroll,
      thirtyArrowDownMs: keysMs,
    };
    if (name === "chromium") {
      check(`200 slides: overview ready in < 2 s (${openMs} ms)`, openMs < 2000);
      check(`200 slides: warm scroll frame p95 < 50 ms (${scroll.p95} ms)`, scroll.p95 < 50);
    }
    await page.keyboard.press("Enter");
    await waitState(180, 0);
    check("200 slides: Enter goes to slide 181", true);
  });

  // j. Key help overlay.
  await section("help", async () => {
    await open("hello");
    await focusParent();
    const help = () =>
      page.evaluate(() => {
        const d = document.querySelector("#host [role=dialog]");
        return {
          hidden: d.hidden,
          opacity: getComputedStyle(d).opacity,
          color: getComputedStyle(d).color,
          text: d.textContent,
        };
      });
    check("no help by default (no persistent chrome)", (await help()).hidden);
    await page.keyboard.press("?");
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("#host [role=dialog]")).opacity === "1",
    );
    const shown = await help();
    check(
      "? shows the key help in neutral gray",
      !shown.hidden &&
        shown.color === "rgb(139, 143, 160)" &&
        ["Overview", "Presenter view", "Print / PDF", "Black screen"].every((k) =>
          shown.text.includes(k),
        ),
      JSON.stringify(shown),
    );
    await page.keyboard.press("ArrowRight");
    await waitState(1, 0);
    check("keys still work with the help open", true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#host [role=dialog]").hidden, null, {
      timeout: 2000,
    });
    check("Escape closes the help", true);
  });

  // k. Print: every step, one page per slide. Chromium: a real PDF (page.pdf) with the page count checked.
  await section("print", async () => {
    await open("talk", "#/6/1");
    await waitState(5, 1);
    await page.evaluate(() => {
      window.__printed = 0;
      window.print = () => {
        window.__printed += 1;
      };
    });
    await focusParent();
    await page.keyboard.press("p");
    await page.waitForFunction(() => window.__printed === 1, null, { timeout: 5000 });
    const layout = await page.evaluate(() => ({
      mode: window.__player.getState().mode,
      printing: document.getElementById("host").hasAttribute("data-pptaken-printing"),
      iframe: [
        document.querySelector("iframe").offsetWidth,
        document.querySelector("iframe").offsetHeight,
      ],
    }));
    check(
      "p switches to print mode with a 20-canvas tall frame",
      layout.mode === "print" &&
        layout.printing &&
        layout.iframe[0] === 1920 &&
        layout.iframe[1] === 20 * 1080,
      JSON.stringify(layout),
    );
    const stacked = await frame().evaluate(() => {
      const s = [...document.querySelectorAll("#pptaken-stage > section")];
      const steps = [...document.querySelectorAll("[data-step]")];
      return {
        tops: s.map((x) => Math.round(x.getBoundingClientRect().top)),
        allSteps: steps.every((e) => getComputedStyle(e).visibility === "visible"),
        breakAfter: getComputedStyle(s[0]).breakAfter,
      };
    });
    check(
      "print mode stacks every slide at canvas size with every step",
      stacked.allSteps && stacked.tops.every((t, i) => t === i * 1080),
      JSON.stringify(stacked),
    );
    if (name === "chromium") {
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      const file = join(tmpdir(), `pptaken-print-${process.pid}.pdf`);
      writeFileSync(file, pdf);
      const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
      check(`PDF has one page per slide (${pages} pages)`, pages === 20);
      let texts = null;
      try {
        texts = Array.from({ length: pages }, (_, i) =>
          execFileSync("pdftotext", ["-f", String(i + 1), "-l", String(i + 1), file, "-"], {
            encoding: "utf8",
          }).trim(),
        );
      } catch {
        engine.notes.push("pdftotext not available: page texts not checked");
      }
      if (texts) {
        check(
          "every PDF page has text (non-blank)",
          texts.every((t) => t.length > 0),
          JSON.stringify(texts.map((t) => t.length)),
        );
        // Every step is printed: the revealable items of slide 6 (index 5) are on page 6.
        const want = (talk.slides[5].html.match(/data-step="[^"]*"[^>]*>([^<]{4,30})/) ?? [])[1];
        if (want) check("steps are printed", texts[5].includes(want.trim()), want);
      }
      engine.pdf = { pages, bytes: pdf.length };
      rmSync(file, { force: true });
    } else {
      engine.notes.push(
        "print layout checked; PDF output not verifiable (Playwright pdf is Chromium-only)",
      );
    }
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await waitState(5, 1);
    const back = await page.evaluate(() => ({
      mode: window.__player.getState().mode,
      printing: document.getElementById("host").hasAttribute("data-pptaken-printing"),
      h: document.querySelector("iframe").offsetHeight,
    }));
    check(
      "afterprint returns to present mode at the same position",
      back.mode === "present" && !back.printing && back.h === 720,
      JSON.stringify(back),
    );
  });

  // l. Presenter window: opened with s, kept in sync both ways, notes only there, next preview, clock, pace.
  await section("presenter", async () => {
    await open("talk");
    await focusParent();
    const [popup] = await Promise.all([
      context.waitForEvent("page", { timeout: 10000 }),
      page.keyboard.press("s"),
    ]);
    await popup.waitForFunction(() => window.__presenterReady === true, null, { timeout: 15000 });
    check("s opens the presenter window", popup.url().endsWith("/presenter/talk"));
    const pState = () => popup.evaluate(() => window.__presenter.getState());
    const same = async (slide, step) => {
      await popup.waitForFunction(
        ([a, b]) => {
          const s = window.__presenter.getState();
          return s && s.slide === a && s.step === b;
        },
        [slide, step],
        { timeout: 4000 },
      );
      await waitState(slide, step);
    };
    // Main -> presenter.
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    const m = await state();
    await same(m.slide, m.step);
    check("main window moves, the presenter follows", true);
    // Presenter -> main (keyboard and button).
    await popup.bringToFront();
    await popup.keyboard.press("ArrowRight");
    const p1 = await pState();
    await same(p1.slide, p1.step);
    check("presenter moves (key), the main window follows", true);
    await popup.getByRole("button", { name: "Next" }).click();
    const p2 = await pState();
    await same(p2.slide, p2.step);
    check(
      "presenter moves (button), the main window follows",
      p2.slide * 100 + p2.step > p1.slide * 100 + p1.step,
    );
    // A burst on the main window converges.
    await page.bringToFront();
    await focusParent();
    for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    const m2 = await state();
    await same(m2.slide, m2.step);
    check("both windows converge after a burst of keys", true);

    // Previews: the current one shows the position, the next one the next position.
    const shape = { slides: await page.evaluate(() => window.__test.slides) };
    const cur = await pState();
    const want = nav.next(shape, cur);
    const previews = await popup.evaluate(() => ({
      current: window.__presenter.current.getState(),
      upcoming: window.__presenter.upcoming.getState(),
    }));
    check(
      "the next preview is at the next slide/step",
      previews.current.slide === cur.slide &&
        previews.current.step === cur.step &&
        previews.upcoming.slide === want.slide &&
        previews.upcoming.step === want.step,
      JSON.stringify({ previews, want }),
    );
    const contentFrames = popup.frames().filter((f) => f.url().includes("/c/deck/"));
    check("the previews are sandboxed content frames", contentFrames.length === 2);

    // Notes: shown in the presenter for the current slide, absent from every content document.
    const notes = await popup.evaluate((i) => {
      const d = new DOMParser().parseFromString(window.__data.slides[i].notesHtml, "text/html");
      const el = document.querySelector(".pp-notes");
      return { expected: d.body.textContent, shown: el.textContent, html: el.innerHTML };
    }, cur.slide);
    check(
      "the notes of the current slide are shown",
      notes.expected.length > 0 && notes.shown === notes.expected,
      JSON.stringify(notes).slice(0, 200),
    );
    const probeText = notes.expected.slice(0, 40);
    let leaked = false;
    for (const f of [frame(), ...contentFrames]) {
      const html = await f.evaluate(() => document.documentElement.outerHTML);
      if (html.includes(probeText)) leaked = true;
    }
    const raw = await (await fetch(`${origins.content}/c/deck/talk`)).text();
    check("notes are absent from every content document", !leaked && !raw.includes(probeText));
    const anyNote = talk.slides.find((s) => s.notes)?.notes.slice(0, 30) ?? "";
    check("no slide's notes are in the /c/ response", anyNote !== "" && !raw.includes(anyNote));

    // Black screen both ways.
    await page.keyboard.press("b");
    await popup.waitForFunction(() => !document.querySelector(".pp-black").hidden);
    check("black screen on the main window shows in the presenter", true);
    await popup.bringToFront();
    await popup.keyboard.press("b");
    await page.waitForFunction(() => !window.__player.getState().black);
    check("black screen off from the presenter", true);

    // Clock: t starts/pauses, Shift+R resets (short real times).
    const clock = () => popup.evaluate(() => document.querySelector(".pp-elapsed").textContent);
    await popup.keyboard.press("t");
    await popup.waitForFunction(() => window.__presenter.getState().running === true);
    await popup.waitForTimeout(1300);
    const running = await clock();
    check("t starts the clock", running !== "0:00", running);
    await popup.keyboard.press("t");
    const paused = await clock();
    await popup.waitForTimeout(1100);
    check("t pauses it", (await clock()) === paused);
    await popup.keyboard.press("Shift+R");
    await popup.waitForFunction(() => document.querySelector(".pp-elapsed").textContent === "0:00");
    check("Shift+R resets it", true);

    // Pace: jump far ahead in the deck with little time spent: ahead.
    await page.bringToFront();
    await page.evaluate(() => window.__player.goto(15, 0));
    await same(15, 0);
    const status = await popup.evaluate(() => document.querySelector(".pp-status").dataset.status);
    check("pace shows ahead on slide 16 after a few seconds", status === "ahead", status);
    await popup.close();
  });

  // m. Pace with the Playwright clock: behind after 20 fake minutes on slide 1; planned vs actual per section.
  await section("pace-clock", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const p = await ctx.newPage();
      await p.clock.install();
      await p.goto(`${origins.shell}/presenter/talk`);
      await p.waitForFunction(() => window.__presenterReady === true, null, { timeout: 15000 });
      await p.keyboard.press("t");
      await p.clock.fastForward("20:00");
      await p.clock.runFor(500);
      const r = await p.evaluate(() => ({
        elapsed: document.querySelector(".pp-elapsed").textContent,
        target: document.querySelector(".pp-target").textContent,
        status: document.querySelector(".pp-status").dataset.status,
        text: document.querySelector(".pp-status").textContent,
        rows: [...document.querySelectorAll(".pp-sections tbody tr")].map((tr) => [
          tr.dataset.state,
          ...[...tr.cells].map((c) => c.textContent),
          tr.cells[3]?.dataset.status ?? "",
        ]),
      }));
      check(
        "fake clock: 20:00 elapsed against the 20:00 target",
        r.elapsed === "20:00" && r.target === "/ 20:00",
        JSON.stringify(r),
      );
      check(
        "fake clock: behind on slide 1",
        r.status === "behind" && r.text.includes("behind"),
        r.text,
      );
      const first = r.rows[0];
      check(
        "pace per section: current section planned vs actual, behind",
        r.rows.length === 5 &&
          first?.[0] === "current" &&
          first?.[3] === "20:00" &&
          first?.[5] === "behind",
        JSON.stringify(r.rows),
      );
    } finally {
      await ctx.close();
    }
  });

  // n. Offline.
  const viewOf = (f) =>
    f.evaluate(() => {
      const shown = [...document.querySelectorAll("#pptaken-stage > section")].filter(
        (s) => getComputedStyle(s).display !== "none",
      );
      const s = shown[0];
      const images = s ? [...s.querySelectorAll("img")] : [];
      return {
        shown: shown.map((x) => x.getAttribute("data-slide")),
        revealed: s
          ? [...s.querySelectorAll("[data-step]")].filter(
              (e) => getComputedStyle(e).visibility === "visible",
            ).length
          : -1,
        imagesOk: images.every((i) => i.complete && i.naturalWidth > 0),
        images: images.length,
      };
    });
  const waitOffline = () =>
    page.waitForFunction(
      () => window.__test.offline && window.__test.offline.state !== "loading",
      null,
      {
        timeout: 40_000,
      },
    );
  const cut = async () => {
    await context.setOffline(true);
    await context.route("**/*", (r) => r.abort());
  };
  const restore = async () => {
    await context.unroute("**/*");
    await context.setOffline(false);
  };
  /** Every slide and every step forward with keys on the parent page, state and DOM checked after each. */
  const traverse = async (getFrame, label) => {
    const slides = await page.evaluate(() => window.__test.slides);
    await focusParent();
    await page.keyboard.press("Home");
    await waitState(0, 0);
    const bad = [];
    let images = 0;
    let p = { slide: 0, step: 0 };
    for (;;) {
      const n = nav.next({ slides }, p);
      if (nav.samePosition(n, p)) break;
      await page.keyboard.press("ArrowRight");
      await waitState(n.slide, n.step);
      const v = await viewOf(getFrame());
      images += n.step === 0 ? v.images : 0;
      if (v.shown.join() !== slides[n.slide].id || v.revealed !== n.step || !v.imagesOk)
        bad.push(`${n.slide}/${n.step}: ${JSON.stringify(v)}`);
      p = n;
    }
    check(
      `${label}: every slide and step, DOM reveals and images`,
      bad.length === 0 && p.slide === slides.length - 1,
      bad.slice(0, 3).join(" | "),
    );
    return images;
  };

  await section("offline-preload", async () => {
    await open("talk");
    await waitOffline();
    const o = await page.evaluate(() => window.__test.offline);
    check(
      "preload: ready, the deck's image decoded, no failure",
      o.state === "ready" && o.images >= 1 && o.failed.length === 0 && o.copy === false,
      JSON.stringify(o),
    );
    const dot = await page.evaluate(() => {
      const d = document.querySelector("#host [data-offline]");
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return {
        state: d.getAttribute("data-offline"),
        w: r.width,
        h: r.height,
        right: innerWidth - r.right,
        top: r.top,
        label: d.getAttribute("aria-label"),
        bg: getComputedStyle(d).backgroundColor,
      };
    });
    check(
      "status dot: 8 px in the top-right corner, green, readable label",
      dot?.state === "ready" &&
        dot.w === 8 &&
        dot.h === 8 &&
        dot.right === 12 &&
        dot.top === 12 &&
        dot.bg === "rgb(61, 214, 140)" &&
        dot.label === "Ready to present offline.",
      JSON.stringify(dot),
    );
    const hud = await page.evaluate(() =>
      [...document.querySelectorAll("#host > div[aria-hidden=true]")]
        .map((d) => d.textContent)
        .join("|"),
    );
    check(
      "the HUD shows the text when it becomes ready",
      hud.includes("Ready to present offline."),
      hud,
    );
    await focusParent();
    await page.keyboard.press("?");
    const help = await page.evaluate(
      () => document.querySelector("#host [role=dialog]").textContent,
    );
    check(
      "help overlay shows the offline status",
      help.includes("Offline: Ready to present offline."),
      help,
    );
    await page.keyboard.press("Escape");

    await cut();
    try {
      const images = await traverse(frame, "network cut after ready");
      check("the image slide was shown offline", images >= 1, String(images));
      await focusParent();
      await page.keyboard.press("o");
      await page.waitForFunction(() => window.__player.getState().mode === "overview");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Enter");
      const last = talk.slides.length - 1;
      await page.waitForFunction(
        (s) => {
          const st = window.__player.getState();
          return st.mode === "present" && st.slide === s;
        },
        last - 1,
        { timeout: 4000 },
      );
      check("overview: open and select a slide offline", true);
      await page.keyboard.press("b");
      const black = await page.evaluate(() => window.__player.getState().black);
      await page.keyboard.press("b");
      check(
        "black screen offline",
        black && !(await page.evaluate(() => window.__player.getState().black)),
      );
    } finally {
      await restore();
    }
  });

  await section("offline-partial", async () => {
    await open("partial");
    await waitOffline();
    const o = await page.evaluate(() => window.__test.offline);
    check(
      "a missing asset makes the state partial",
      o.state === "partial" && o.failed.includes("image-error"),
      JSON.stringify(o),
    );
    const dot = await page.evaluate(() => {
      const d = document.querySelector("#host [data-offline]");
      return { bg: getComputedStyle(d).backgroundColor, label: d.getAttribute("aria-label") };
    });
    check(
      "partial dot: warning color and text",
      dot.bg === "rgb(255, 159, 67)" && dot.label === "Some resources could not be loaded.",
      JSON.stringify(dot),
    );
    await focusParent();
    await page.keyboard.press("ArrowRight");
    await waitState(1, 0);
    check("navigation still works when partial", true);
  });

  const openOffline = async (key) => {
    await page.goto("about:blank");
    await page.goto(`${origins.shell}/offline-player/${key}`);
  };
  const srcdocFrame = () => page.frames().find((f) => f.url() === "about:srcdoc");

  await section("offline-srcdoc", async () => {
    server.hits.length = 0;
    responses.length = 0;
    await openOffline("talk");
    await page.waitForFunction(() => window.__test.slides && window.__test.rendered, null, {
      timeout: 10_000,
    });
    await waitOffline();
    const o = await page.evaluate(() => window.__test.offline);
    check(
      "srcdoc document: runtime runs under the page CSP, preload ready with the inlined image",
      o.state === "ready" && o.images >= 1,
      JSON.stringify(o),
    );
    check(
      "srcdoc document has an opaque origin",
      (await srcdocFrame().evaluate(() => self.origin)) === "null",
    );
    await cut();
    try {
      await traverse(srcdocFrame, "srcdoc, network cut");
    } finally {
      await restore();
    }
    check("the srcdoc document made no request", server.hits.length === 0, server.hits.join(" | "));
    check("no faults", (await page.evaluate(() => window.__test.faults)).length === 0);
  });

  await section("offline-srcdoc-security", async () => {
    server.hits.length = 0;
    // A fresh tab: no transient user activation left over from the keys pressed by the previous sections (the
    // shell's gate for mode keys from the content relies on it).
    const tab = await context.newPage();
    const tabResponses = [];
    tab.on("response", (r) => tabResponses.push(r.url()));
    await tab.goto(`${origins.shell}/offline-player/offline-hostile`);
    await tab.waitForFunction(() => window.__test.probe, null, { timeout: 8000 });
    await tab.waitForTimeout(1500);
    const t = await tab.evaluate(() => window.__test);
    const p = t.probe;
    check(
      "srcdoc: no hostile script or handler ran",
      t.pwned.length === 0,
      JSON.stringify(t.pwned),
    );
    check("srcdoc: content has an opaque origin", p.selfOrigin === "null", p.selfOrigin);
    // WebKit answers `document.cookie` with "" in a sandboxed srcdoc document instead of throwing: accepted as
    // long as no cookie of the page shows through (`legacy=1` is readable by scripts there).
    check(
      "srcdoc: content cannot read cookies",
      String(p.cookie).startsWith("blocked:") || p.cookie === "allowed:",
      p.cookie,
    );
    if (p.cookie === "allowed:")
      engine.notes.push("srcdoc: document.cookie returns '' (no exception)");
    for (const k of [
      "localStorage",
      "parentDocument",
      "parentLocation",
      "topNavigation",
      "eval",
      "newFunction",
    ]) {
      check(`srcdoc: content cannot use ${k}`, String(p[k]).startsWith("blocked:"), p[k]);
    }
    check(
      "srcdoc: window.open is blocked",
      p.windowOpen === "allowed:null" || String(p.windowOpen).startsWith("blocked:"),
      p.windowOpen,
    );
    check(
      "srcdoc: fetch and XHR are blocked",
      JSON.stringify(p.network) === '["rejected","rejected","rejected"]',
      JSON.stringify(p.network),
    );
    check(
      "srcdoc: no request reached any server",
      server.hits.length === 0,
      server.hits.join(" | "),
    );
    const api = tabResponses.filter((u) => u.includes("/api/"));
    check("srcdoc: no response from /api reached the content", api.length === 0, api.join(" | "));
    const after = await tab.evaluate(() => ({
      ...window.__player.getState(),
      printing: document.getElementById("host").hasAttribute("data-pptaken-printing"),
    }));
    check(
      "srcdoc: content cannot select a slide, print or open windows",
      after.slide === 0 &&
        after.mode !== "print" &&
        !after.printing &&
        context.pages().length === 2,
      JSON.stringify(after),
    );
    // The gate on mode keys from the content (navigator.userActivation) cannot be exercised here: under
    // Playwright `isActive` is always true, in all three engines (measured), so a forwarded `o` is honoured.
    if (t.activation.includes(true)) {
      engine.notes.push(
        "gated keys from content not testable: userActivation.isActive is always true",
      );
    } else {
      check("srcdoc: content cannot change the mode", after.mode === "present", after.mode);
    }
    await tab.close();

    // Under the real page CSP (no probe hash), the inherited policy blocks even a script with the right nonce.
    await openOffline("offline-hostile-strict");
    await page.waitForFunction(() => window.__test.slides, null, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    const strict = await page.evaluate(() => window.__test);
    check(
      "srcdoc: the inherited page CSP blocks a nonced script that is not the runtime",
      strict.probe === null && strict.pwned.length === 0,
      JSON.stringify({ probe: strict.probe, pwned: strict.pwned }),
    );

    server.hits.length = 0;
    await openOffline("offline-nav");
    const faulted = await page
      .waitForFunction(() => window.__test.faults.includes("unexpected-navigation"), null, {
        timeout: 8000,
      })
      .then(
        () => true,
        () => false,
      );
    check("srcdoc: content navigation is detected as a fault", faulted);
    check(
      "srcdoc: the navigation carried no cookie",
      server.hits.every((h) => h.endsWith("cookies=none")),
      server.hits.join(" | "),
    );

    const refused = await page.evaluate(async () => {
      const { createPlayer } = await import("/dist/shell.js");
      const host = document.createElement("div");
      document.body.append(host);
      const out = [];
      for (const html of [
        "<!doctype html><html><head><script>1</script></head></html>",
        `<!doctype html>\n<html>\n<head>\n<meta http-equiv="Content-Security-Policy" content="default-src *">\n`,
      ]) {
        try {
          createPlayer(host, { contentHtml: html });
          out.push("accepted");
        } catch (e) {
          out.push(e.name);
        }
      }
      host.remove();
      return out;
    });
    check(
      "a document without the no-network CSP <meta> first is refused",
      JSON.stringify(refused) === '["TypeError","TypeError"]',
      JSON.stringify(refused),
    );
  });

  console.log(
    `${name}: ${engine.failed === 0 ? "PASS" : "FAIL"} - ${engine.passed} checks passed, ${engine.failed} failed`,
  );
  if (engine.overview200)
    console.log(`  overview 200 slides: ${JSON.stringify(engine.overview200)}`);
  if (engine.pdf) console.log(`  print PDF: ${JSON.stringify(engine.pdf)}`);
  for (const f of engine.frameTimes ?? []) {
    console.log(
      `  frame times, ${f.label}: ${f.presses} presses in ${f.elapsedMs} ms, p50 ${f.p50} ms, p95 ${f.p95} ms, max ${f.max} ms (${f.frames} frames)`,
    );
  }
  for (const f of engine.failures.slice(0, 30)) console.log(`  - ${f}`);
  await browser.close();
}

await server.close();
writeFileSync(new URL("./last-run.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
process.exit(failed ? 1 : 0);
