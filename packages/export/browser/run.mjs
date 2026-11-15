// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser test of the single-file HTML export, opened from file:// (double click) in Chromium, Firefox and
// WebKit, with no server and no network.
// Usage: pnpm --filter @pptaken/export test:browser   (builds first; needs the Playwright browsers)
//
//   a. the 20-slide example (fonts: Bricolage Grotesque, Inter, JetBrains Mono; plus an asset: image): every
//      slide and step by keyboard, forward and back, against @pptaken/player's navigation module
//   b. URL hash written after navigation and read on load (clamped); hashchange
//   c. fonts really loaded inside the frame (document.fonts), the image decoded
//   d. the 4:3 Spanish example: traversal, 4:3 stage
//   e. black screen, counter, speaker notes panel (only when exported with notes), full screen (reported)
//   f. no request at all besides the file:// navigation
//   g. security: hostile content injected after the export (a sanitizer bypass) cannot reach the parent, storage,
//      the network (a local HTTP server counts hits) or navigate the top page; hostile titles do not break out
// Results go to browser/last-run.json.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium, firefox, webkit } from "@playwright/test";
import * as nav from "@pptaken/player/navigation";
import { sanitizeDeck } from "@pptaken/sanitizer";
import { parseDeck } from "@pptaken/schema";
import { exportHtml } from "../dist/index.js";

const EXAMPLES = new URL("../../schema/examples/", import.meta.url);
const FONTS = new URL("../../ui/fonts/", import.meta.url);

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

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

/** A real, decodable RGBA PNG of one color. */
function png(width, height, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) row.set(rgba, 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** The bundled faces of packages/ui/fonts/fonts.css with their bytes (what the server embeds). */
function bundledFonts() {
  const css = readFileSync(new URL("fonts.css", FONTS), "utf8");
  const faces = [];
  for (const [, block] of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const field = (name) => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block)?.[1]?.trim();
    const family = field("font-family")?.replace(/^["']|["']$/g, "");
    const src = /url\(["']?\.\/([a-z0-9-]+\/[a-z0-9-]+\.woff2)["']?\)/.exec(block)?.[1];
    faces.push({
      family,
      weight: field("font-weight"),
      unicodeRange: field("unicode-range"),
      bytes: new Uint8Array(readFileSync(new URL(src, FONTS))),
    });
  }
  return faces;
}

const image = png(160, 120, [87, 70, 175, 255]);
const imageSha = createHash("sha256").update(image).digest("hex");
const talkSource = load("talk-20-slides.json");
const talk = clean({
  ...talkSource,
  slides: talkSource.slides.map((s) =>
    s.id === "risks"
      ? {
          ...s,
          html: `${s.html}<img src="asset:${imageSha}" width="160" height="120" alt="logo" style="position:absolute;right:120px;bottom:80px">`,
        }
      : s,
  ),
});
const charla = clean(load("charla-4-3.json"));
const hello = clean(load("hello.json"));
const fonts = bundledFonts();
const assets = new Map([[imageSha, { mediaType: "image/png", bytes: image }]]);

const HOSTILE_TITLE = `</title></script><script>window.__pwned=1</script>" onload="x" &   <!-- end`;

const dir = mkdtempSync(join(tmpdir(), "pptaken-export-"));
const write = (name, html) => {
  const file = join(dir, name);
  writeFileSync(file, html);
  return pathToFileURL(file).href;
};

const talkExport = exportHtml({ deck: talk, assets, fonts, generator: "pptaken test" });
const talkNotesExport = exportHtml({ deck: talk, assets, fonts, includeNotes: true });
const charlaExport = exportHtml({ deck: charla, fonts });
const titleExport = exportHtml({ deck: { ...hello, title: HOSTILE_TITLE } });

// Hostile: a sanitizer bypass simulated by editing the deck document inside the srcdoc after the export.
const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url);
  res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
  res.end("leak");
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;

function injectIntoSrcdoc(html, fn) {
  const m = /srcdoc="([^"]*)"/.exec(html);
  const inner = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const nonce = /'nonce-([^']+)'/.exec(inner)[1];
  const changed = fn(inner, nonce);
  return html.replace(m[0], `srcdoc="${changed.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
}
const PROBE = `(() => {
  const r = {};
  const t = (name, fn) => { try { r[name] = "allowed:" + String(fn()).slice(0, 60); } catch (e) { r[name] = "blocked:" + e.name; } };
  t("cookie", () => document.cookie);
  t("localStorage", () => localStorage.length);
  t("parentDocument", () => parent.document.title);
  t("parentLocation", () => parent.location.href);
  t("topNavigation", () => { top.location.href = "${base}/top"; return "assigned"; });
  t("windowOpen", () => window.open("${base}/open"));
  t("eval", () => eval("1 + 1"));
  r.selfOrigin = self.origin;
  const img = new Image(); img.src = "${base}/js-image";
  Promise.allSettled([fetch("${base}/fetch"), fetch("file:///etc/hosts")]).then((all) => {
    r.network = all.map((a) => a.status);
    document.documentElement.setAttribute("data-probe", JSON.stringify(r));
  });
})();`;
const RAW = [
  `<img src="${base}/img">`,
  `<script>window.__pwned=1</script>`,
  `<img src="x" onerror="window.__pwned=2">`,
  `<style>@import url(${base}/css-import);.e{background:url(${base}/css-bg)}@font-face{font-family:e;src:url(${base}/font)}</style><p class="e" style="font-family:e">x</p>`,
  `<link rel="stylesheet" href="${base}/link">`,
  `<iframe src="${base}/frame"></iframe><object data="${base}/object"></object>`,
  `<video src="${base}/video" autoplay></video>`,
  `<form action="${base}/form"><button>x</button></form>`,
].join("");
const hostileExport = injectIntoSrcdoc(exportHtml({ deck: hello }).html, (inner, nonce) =>
  inner
    .replace("</head>", `<script nonce="${nonce}">${PROBE}</script></head>`)
    .replace("hidden>", `hidden>${RAW}`),
);
const hostileNavExport = injectIntoSrcdoc(exportHtml({ deck: hello }).html, (inner) =>
  inner.replace("hidden>", `hidden><meta http-equiv="refresh" content="0;url=${base}/refresh">`),
);

const URLS = {
  talk: write(talkExport.filename, talkExport.html),
  talkNotes: write(`notes-${talkNotesExport.filename}`, talkNotesExport.html),
  charla: write(charlaExport.filename, charlaExport.html),
  title: write("hostile-title.html", titleExport.html),
  hostile: write("hostile.html", hostileExport),
  hostileNav: write("hostile-nav.html", hostileNavExport),
};

// ---------------------------------------------------------------------------------------------------------------
// Run

const report = {
  date: new Date().toISOString(),
  sizes: {
    talk: talkExport.bytes,
    talkWithNotes: talkNotesExport.bytes,
    charla: charlaExport.bytes,
    embeddedFonts: talkExport.embeddedFonts,
  },
  engines: {},
};
let failed = false;

const stepsOf = (deck) => {
  // Same counting as the runtime: distinct numbered steps plus unnumbered ones.
  return deck.slides.map((s) => {
    const numbered = new Set();
    let unnumbered = 0;
    for (const m of s.html.matchAll(/\sdata-step="(\d*)"/g)) {
      if (m[1] === "") unnumbered++;
      else numbered.add(m[1]);
    }
    return { id: s.id, steps: numbered.size + unnumbered };
  });
};

for (const [name, type] of [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
]) {
  const engine = { passed: 0, failed: 0, failures: [], notes: [], requests: [] };
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
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  const open = async (url, hash = "") => {
    await page.goto("about:blank");
    requests.length = 0;
    await page.goto(`${url}${hash}`);
    await page.waitForFunction(() => document.body?.dataset.state === "ready", null, {
      timeout: 10000,
    });
  };
  const frame = () => page.frames().find((f) => f !== page.mainFrame());
  const waitAt = (slide, step) =>
    page.waitForFunction(
      ([s, t]) => document.body.dataset.rendered === `${s}/${t}`,
      [slide, step],
      { timeout: 4000 },
    );
  const waitHash = (p) =>
    page
      .waitForFunction((h) => location.hash === h, nav.formatHash(p), { timeout: 3000 })
      .then(
        () => true,
        () => false,
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
        revealed: stepEls.filter((e) => getComputedStyle(e).visibility === "visible").length,
      };
    });
  const onlyFileRequests = (label, url) => {
    const other = requests.filter((u) => !u.startsWith("file:") && !u.startsWith("data:"));
    const files = requests.filter((u) => u.startsWith("file:"));
    const dataUrls = requests.filter((u) => u.startsWith("data:")).length;
    if (dataUrls > 0 && !engine.notes.some((n) => n.startsWith("data:")))
      engine.notes.push(`data: URLs reported as requests by Playwright (${dataUrls} in ${label})`);
    check(`${label}: no network request`, other.length === 0, other.join(" | "));
    // Firefox does not report file:// navigations as request events; the other engines report exactly one.
    const same = (u) => decodeURI(u.split("#")[0]) === decodeURI(url);
    check(
      `${label}: only the file itself was loaded`,
      files.every(same) && files.length <= 1,
      `${files.length}: ${files.join(" | ")}`,
    );
    if (files.length === 0 && !engine.notes.some((n) => n.startsWith("file:")))
      engine.notes.push("file: navigation not reported as a request event by Playwright");
  };

  const traverse = async (label, deck, url) => {
    await open(url);
    const shape = { slides: stepsOf(deck) };
    const all = [];
    for (let p = nav.first(shape); ; p = nav.next(shape, p)) {
      all.push(p);
      if (nav.samePosition(p, nav.last(shape))) break;
    }
    const verify = async (p, what) => {
      await waitAt(p.slide, p.step);
      const v = await view();
      return (
        check(
          `${label} ${what}: shows ${shape.slides[p.slide].id}`,
          v.shown.length === 1 && v.shown[0] === shape.slides[p.slide].id,
          JSON.stringify(v.shown),
        ) &&
        check(`${label} ${what}: ${p.step} steps revealed`, v.revealed === p.step, `${v.revealed}`)
      );
    };
    await verify(all[0], "start");
    const forward = ["ArrowRight", "Space", "PageDown", "ArrowDown", "Enter"];
    let ok = true;
    for (let i = 1; i < all.length && ok; i++) {
      await page.keyboard.press(forward[i % forward.length]);
      ok = await verify(all[i], `forward #${i}`);
    }
    const end = all[all.length - 1];
    check(`${label}: hash written at the end`, await waitHash(end));
    const back = ["ArrowLeft", "PageUp", "ArrowUp", "Backspace", "Shift+Space"];
    ok = true;
    for (let i = all.length - 2; i >= 0 && ok; i--) {
      await page.keyboard.press(back[i % back.length]);
      ok = await verify(all[i], `back #${i}`);
    }
    check(`${label}: hash back at the start`, await waitHash(all[0]));
    await page.keyboard.press("End");
    await waitAt(end.slide, end.step);
    await page.keyboard.press("Home");
    await waitAt(0, 0);
    check(`${label}: Home and End`, true);
    return { shape, all };
  };

  await section("talk", async () => {
    const { shape } = await traverse("talk", talk, URLS.talk);
    onlyFileRequests("talk", URLS.talk);

    // Fonts: every bundled family the deck uses was loaded from its data: URI inside the frame.
    const fontState = await frame().evaluate(async () => {
      await document.fonts.ready;
      return {
        loaded: [
          ...new Set(
            [...document.fonts]
              .filter((f) => f.status === "loaded")
              .map((f) => f.family.replace(/"/g, "")),
          ),
        ].sort(),
        inter: document.fonts.check('40px "Inter"'),
        bodyFamily: getComputedStyle(document.querySelector("#pptaken-stage section")).fontFamily,
      };
    });
    for (const family of ["Bricolage Grotesque", "Inter"]) {
      check(
        `font ${family} loaded in the frame`,
        fontState.loaded.includes(family),
        JSON.stringify(fontState),
      );
    }
    engine.fonts = fontState.loaded;

    // Image from the asset: decoded at its natural size.
    const risks = shape.slides.findIndex((s) => s.id === "risks");
    await page.evaluate((n) => {
      location.hash = `#/${n + 1}/0`;
    }, risks);
    await waitAt(risks, 0);
    const img = await frame().evaluate(() => {
      const i = document.querySelector('[data-slide="risks"] img');
      return i
        ? {
            complete: i.complete,
            w: i.naturalWidth,
            h: i.naturalHeight,
            data: i.src.startsWith("data:image/png;base64,"),
          }
        : null;
    });
    check(
      "asset image is visible",
      img?.complete && img.w === 160 && img.h === 120 && img.data,
      JSON.stringify(img),
    );
    check("hashchange navigates", true);

    // Hash on load, clamped.
    for (const [hash, slide, step] of [
      ["#/5/1", 4, 1],
      ["#/99/42", 19, 0],
      ["#/2/99", 1, shape.slides[1].steps],
      ["#/nope", 0, 0],
    ]) {
      await open(URLS.talk, hash);
      await waitAt(slide, step);
      check(`hash ${hash} opens ${slide}/${step}`, true);
      check(`hash ${hash} is rewritten`, await waitHash({ slide, step }));
    }

    // Counter: shown after a move, gone after 2 s.
    await page.keyboard.press("ArrowRight");
    const hud = () =>
      page.evaluate(() => {
        const h = document.getElementById("pptaken-hud");
        return { text: h.textContent, opacity: getComputedStyle(h).opacity };
      });
    await page.waitForTimeout(300);
    const shown = await hud();
    check(
      "counter shows n / N",
      /^\d+ \/ 20$/.test(shown.text) && shown.opacity === "1",
      JSON.stringify(shown),
    );
    await page.waitForTimeout(2600);
    check("counter fades after 2 s", (await hud()).opacity === "0");

    // Black screen.
    const curtain = () => page.evaluate(() => !document.getElementById("pptaken-curtain").hidden);
    await page.keyboard.press("b");
    check("b turns the screen black", await curtain());
    await page.keyboard.press(".");
    check(". turns it back", !(await curtain()));
    // No notes panel when exported without notes.
    await page.keyboard.press("n");
    check(
      "no notes panel without notes",
      (await page.evaluate(() => document.getElementById("pptaken-notes"))) === null,
    );

    // Full screen (reported, not asserted: headless engines differ).
    await page.keyboard.press("f");
    const fs = await page
      .waitForFunction(() => document.fullscreenElement?.id === "pptaken-host", null, {
        timeout: 2000,
      })
      .then(
        () => true,
        () => false,
      );
    engine.notes.push(`full screen with f: ${fs ? "entered" : "not entered (headless)"}`);
    if (fs) {
      await page.keyboard.press("f");
      await page
        .waitForFunction(() => document.fullscreenElement === null, null, { timeout: 2000 })
        .catch(() => {});
    }
    check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
    consoleErrors.length = 0;
  });

  await section("notes", async () => {
    await open(URLS.talkNotes);
    await page.keyboard.press("n");
    const text = await page.evaluate(
      () => document.querySelector("#pptaken-notes .body")?.textContent,
    );
    check("n shows the speaker notes of the slide", text === talk.slides[0].notes, String(text));
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    const state = await page.evaluate(() => ({
      text: document.querySelector("#pptaken-notes .body").textContent,
      slide: Number(document.body.dataset.slide),
    }));
    check(
      "notes follow the slide",
      state.text === (talk.slides[state.slide].notes ?? ""),
      JSON.stringify(state),
    );
    const inFrame = await frame().evaluate(() => document.documentElement.outerHTML);
    check("notes never enter the deck frame", !inFrame.includes(talk.slides[0].notes.slice(0, 30)));
    await page.keyboard.press("n");
    check(
      "n hides them",
      await page.evaluate(() => document.getElementById("pptaken-notes").hidden),
    );
  });

  await section("charla", async () => {
    await traverse("charla 4:3", charla, URLS.charla);
    onlyFileRequests("charla", URLS.charla);
    const m = await frame().evaluate(() => {
      const r = document.getElementById("pptaken-stage").getBoundingClientRect();
      return { w: r.width, h: r.height, lang: document.documentElement.lang };
    });
    check(
      "4:3 stage keeps its aspect ratio",
      Math.abs(m.w / m.h - 4 / 3) < 0.01,
      JSON.stringify(m),
    );
    check("deck language is es", m.lang === "es");
    const fontState = await frame().evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => f.family.replace(/"/g, ""));
    });
    check(
      "charla fonts loaded",
      fontState.includes("Inter") && fontState.includes("Bricolage Grotesque"),
      JSON.stringify(fontState),
    );
  });

  await section("security", async () => {
    // Hostile title.
    await open(URLS.title);
    const title = await page.evaluate(() => ({ title: document.title, pwned: window.__pwned }));
    check(
      "hostile title is shown as text",
      title.title === HOSTILE_TITLE.replace(/\s+/g, " ").trim() ||
        title.title.includes("</script>"),
      JSON.stringify(title),
    );
    check("hostile title runs nothing", title.pwned === undefined);

    // Hostile content inside the frame.
    hits.length = 0;
    await open(URLS.hostile);
    await frame().waitForFunction(() => document.documentElement.hasAttribute("data-probe"), null, {
      timeout: 8000,
    });
    await page.waitForTimeout(1000);
    const p = JSON.parse(
      await frame().evaluate(() => document.documentElement.getAttribute("data-probe")),
    );
    check("content has an opaque origin", p.selfOrigin === "null", p.selfOrigin);
    // WebKit answers document.cookie with "" in an opaque origin instead of throwing: nothing readable either way.
    check(
      "content cannot read cookies",
      p.cookie === "allowed:" || String(p.cookie).startsWith("blocked:"),
      p.cookie,
    );
    if (p.cookie === "allowed:")
      engine.notes.push('document.cookie returns "" in the sandboxed frame (no throw)');
    for (const k of ["localStorage", "parentDocument", "parentLocation", "topNavigation", "eval"]) {
      check(`content cannot use ${k}`, String(p[k]).startsWith("blocked:"), p[k]);
    }
    check(
      "window.open is blocked",
      p.windowOpen === "allowed:null" || String(p.windowOpen).startsWith("blocked:"),
      p.windowOpen,
    );
    check(
      "fetch is blocked",
      JSON.stringify(p.network) === '["rejected","rejected"]',
      JSON.stringify(p.network),
    );
    const pwned = await frame().evaluate(() => window.__pwned);
    check("injected inline script and handler did not run", pwned === undefined, String(pwned));
    check("no request reached the local server", hits.length === 0, hits.join(" | "));
    check("the top page is still the file", page.url().startsWith(URLS.hostile));
    check("the shell still works", await page.evaluate(() => document.body.dataset.slides === "3"));

    // A content-initiated navigation of the frame is detected and the frame is blanked.
    hits.length = 0;
    await page.goto("about:blank");
    await page.goto(URLS.hostileNav);
    const faulted = await page
      .waitForFunction(() => document.body.dataset.state === "fault", null, { timeout: 8000 })
      .then(
        () => true,
        () => false,
      );
    engine.notes.push(
      `meta refresh in the frame: ${hits.length > 0 ? "navigation request sent" : "no request"}; ${faulted ? "fault detected" : "no fault"}`,
    );
    check(
      "a navigating frame is detected or blocked",
      faulted || hits.length === 0,
      `hits=${hits.length}`,
    );
  });

  console.log(
    `${name}: ${engine.failed === 0 ? "PASS" : "FAIL"} - ${engine.passed} checks passed, ${engine.failed} failed`,
  );
  for (const n of engine.notes) console.log(`  note: ${n}`);
  for (const f of engine.failures.slice(0, 30)) console.log(`  - ${f}`);
  await browser.close();
}

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(
  `sizes: talk ${(report.sizes.talk / 1024).toFixed(0)} KiB (fonts: ${report.sizes.embeddedFonts.join(", ")}), with notes ${(report.sizes.talkWithNotes / 1024).toFixed(0)} KiB, charla ${(report.sizes.charla / 1024).toFixed(0)} KiB`,
);
writeFileSync(new URL("./last-run.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
process.exit(failed ? 1 : 0);
