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
//      a content-initiated navigation is detected as a fault
// Results go to browser/last-run.json.

import { readFileSync, writeFileSync } from "node:fs";
import { chromium, firefox, webkit } from "@playwright/test";
import { sanitizeDeck } from "@pptaken/sanitizer";
import { parseDeck } from "@pptaken/schema";
import * as nav from "../dist/navigation.js";
import { startServers } from "./server.mjs";

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

const DECKS = new Map([
  ["talk", { deck: talk }],
  ["charla", { deck: charla }],
  ["hello", { deck: hello }],
  ["steps", { deck: steps }],
  ["hostile", hostile],
  ["hostile-nav", hostileNav],
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

  console.log(
    `${name}: ${engine.failed === 0 ? "PASS" : "FAIL"} - ${engine.passed} checks passed, ${engine.failed} failed`,
  );
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
