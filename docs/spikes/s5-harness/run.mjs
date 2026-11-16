// SPDX-License-Identifier: Apache-2.0
// Spike S5: hostile author script inside the sandboxed content frame. Runs Chromium, Firefox and WebKit through
// Playwright and writes `last-run.json`.
//
// Usage (from the repository root, after `pnpm --filter @pptaken/player build` so packages/player/dist exists):
//   node docs/spikes/s5-harness/run.mjs [--only=nav,net,abuse,watchdog,proto,srcdoc] [--engines=chromium,firefox]
// Throwaway code: not product code.

import { writeFileSync } from "node:fs";
import { chromium, firefox, webkit } from "@playwright/test";
import { deckHtml, PROBE_SHA256, startServers } from "./server.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const SECTIONS = (args.only ?? "nav,net,abuse,watchdog,proto,srcdoc").split(",");
const ENGINES = (args.engines ?? "chromium,firefox,webkit").split(",");
// "chromium" is Playwright's default headless shell, which runs without site isolation (one renderer for every
// frame). "chromium-full" is the full Chromium build in new headless mode, which isolates like desktop Chrome.
// "firefox-fission" turns Fission (site isolation) on, which Playwright's Firefox leaves off.
const BROWSERS = {
  chromium,
  firefox,
  webkit,
  "chromium-full": chromium,
  "firefox-fission": firefox,
};
const LAUNCH = {
  "chromium-full": { channel: "chromium" },
  "firefox-fission": {
    firefoxUserPrefs: { "fission.autostart": true, "fission.webContentIsolationStrategy": 1 },
  },
};

const srv = await startServers();
const O = srv.origins;
const SRCDOC_NONCE = "c3Bpa2UtczUtbm9uY2UtMTIzNDU2";
const results = {
  startedAt: new Date().toISOString(),
  playwright: "1.65",
  origins: O,
  probeSha256: PROBE_SHA256,
  engines: {},
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) =>
  Promise.race([p, sleep(ms).then(() => ({ timeout: `${what ?? "operation"} > ${ms} ms` }))]);

const TRANSPORT_ORIGIN = { "same-origin": O.app, "same-site": O.site2, "cross-site": O.xsite };
const cfgOf = (token, probe, extra = {}) => ({
  token,
  probe,
  listener: O.listener,
  listenerWs: O.listenerWs,
  stun: O.stun,
  stun2: O.stun2,
  turn: O.turn,
  preconnect: O.preconnect,
  appOrigin: O.app,
  ...extra,
});
const docUrl = (transport, cfg) =>
  `${TRANSPORT_ORIGIN[transport]}/c/doc?cfg=${Buffer.from(JSON.stringify(cfg)).toString("base64url")}`;
const mount = (page, id, transport, cfg0) => {
  const cfg = { ...cfg0, selfOrigin: TRANSPORT_ORIGIN[transport] ?? O.app };
  return transport === "srcdoc"
    ? page.evaluate(
        ([i, html]) => window.__mount(i, null, html),
        [id, deckHtml({ cfg, nonce: SRCDOC_NONCE, kind: "srcdoc" })],
      )
    : page.evaluate(([i, src]) => window.__mount(i, src, null), [id, docUrl(transport, cfg)]);
};

const hitsOf = (token) =>
  srv.log.http
    .filter((h) => h.token === token)
    .map((h) => `${h.name}${h.dest ? `(${h.dest})` : ""}${h.cookie === "yes" ? "[cookie]" : ""}`);
const countBy = (arr, label, socket) =>
  arr.filter((x) => x.label === label && (!socket || x.socket === socket)).length;
const maxGap = (gaps, from, to) =>
  gaps.filter(([at]) => at >= from && at <= to).reduce((m, [, g]) => Math.max(m, g), 0);

async function chromiumProcesses(browser) {
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = await cdp.send("Target.getTargets");
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    await cdp.detach();
    return {
      oopifTargets: targetInfos
        .filter((t) => t.type === "iframe")
        .map((t) => t.url.replace(/\?.*/, "").slice(0, 60)),
      renderers: processInfo.filter((p) => p.type === "renderer").length,
    };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}

const NAV_PROBES = [
  "loc_assign",
  "loc_replace",
  "loc_content_origin",
  "loc_app_origin",
  "meta_refresh",
  "window_open",
  "top_location",
  "a_click",
  "a_blank",
  "a_top",
  "a_download",
  "a_ping",
  "form_get",
  "form_post",
  "navigation_api",
  "docopen_refresh",
  "dw_res",
];

for (const name of ENGINES) {
  const browser = await BROWSERS[name].launch(LAUNCH[name] ?? {});
  const E = (results.engines[name] = { version: browser.version() });
  log(name, browser.version());
  const consoleSample = [];
  const watchConsole = (page) =>
    page.on("console", (m) => {
      const t = m.text();
      if (
        consoleSample.length < 60 &&
        /refused|block|violat|security|sandbox|denied|not allowed/i.test(t)
      )
        consoleSample.push(`${m.type()}: ${t.slice(0, 180)}`);
    });

  try {
    // ---------------------------------------------------------------- 1. self-navigation exfiltration
    if (SECTIONS.includes("nav")) {
      E.nav = {};
      for (const csp of ["strict", "loose"]) {
        for (const transport of ["same-origin", "cross-site", "srcdoc"]) {
          const ctx = await browser.newContext();
          const label = `nav.${name}.${csp}.${transport}`;
          srv.state.label = label;
          const popups = [];
          const downloads = [];
          const page = await ctx.newPage();
          ctx.on("page", (p) => {
            if (p === page) return;
            popups.push("opened");
            p.close().catch(() => {});
          });
          watchConsole(page);
          page.on("download", (d) => downloads.push(d.url().replace(/.*\/hit\/[^/]+\//, "")));
          await page.goto(`${O.app}/shell?csp=${csp}`);
          for (const probe of NAV_PROBES)
            await mount(page, probe, transport, cfgOf(`${label}.${probe}`, probe));
          await sleep(6000);
          const s = await withTimeout(
            page.evaluate(() => ({
              msgs: window.__s5.msgs,
              loads: window.__s5.loads,
              viol: window.__s5.viol,
            })),
            20000,
            "evaluate",
          );
          const row = {};
          for (const probe of NAV_PROBES) {
            const token = `${label}.${probe}`;
            const mine = (s.msgs ?? []).filter((m) => m.token === token);
            row[probe] = {
              result: mine.find((m) => m.type === "result")?.value ?? null,
              contentViolations: [
                ...new Set([
                  ...(mine.find((m) => m.type === "late")?.violations ?? []),
                  ...(mine.find((m) => m.type === "result")?.value?.violations ?? []),
                ]),
              ],
              frameLoads: s.loads?.[probe] ?? null,
              listenerHits: hitsOf(token),
            };
          }
          row._preconnectTcp = countBy(srv.log.tcp, label, "preconnect");
          row._popups = popups.length;
          row._downloads = downloads;
          row._shellViolations = [...new Set(s.viol ?? [])];
          E.nav[`${csp} shell CSP / ${transport}`] = row;
          await ctx.close();
          log(name, "nav", csp, transport, "done");
        }
      }
    }

    // ---------------------------------------------------------------- 2. network side channels
    if (SECTIONS.includes("net")) {
      E.net = {};
      const variants = [
        { v: "prod", extra: {} },
        { v: "prod+webrtc 'block'", extra: { cspExtra: "webrtc 'block'" } },
        { v: "hash-only script-src", extra: { scripts: "hash" } },
      ];
      for (const { v, extra } of variants) {
        for (const transport of ["same-origin", "cross-site", "srcdoc"]) {
          if (transport === "srcdoc" && v !== "prod") continue;
          const ctx = await browser.newContext();
          const label = `net.${name}.${v.replace(/\W+/g, "_")}.${transport}`;
          srv.state.label = label;
          const page = await ctx.newPage();
          watchConsole(page);
          await page.goto(`${O.app}/shell?csp=strict`);
          await mount(page, "net", transport, cfgOf(`${label}.net`, "net", extra));
          await mount(
            page,
            "docopen",
            transport,
            cfgOf(`${label}.docopen`, "realm_docopen", extra),
          );
          await page
            .waitForFunction(
              (tok) => window.__s5.msgs.some((m) => m.token === tok && m.type === "result"),
              `${label}.net`,
              { timeout: 25000 },
            )
            .catch(() => {});
          await sleep(1500);
          const s = await page.evaluate(() => ({ msgs: window.__s5.msgs, viol: window.__s5.viol }));
          const res =
            s.msgs.find((m) => m.token === `${label}.net` && m.type === "result")?.value ?? null;
          E.net[`${v} / ${transport}`] = {
            authorScriptRan: res !== null,
            results: res,
            docopen:
              s.msgs.find((m) => m.token === `${label}.docopen` && m.type === "result")?.value ??
              null,
            listenerHits: hitsOf(`${label}.net`),
            stunUdpPackets: countBy(srv.log.udp, label, "stun"),
            realmStunUdpPackets: countBy(srv.log.udp, label, "stun2"),
            turnTcpConnections: countBy(srv.log.tcp, label, "turn"),
            preconnectTcpConnections: countBy(srv.log.tcp, label, "preconnect"),
            shellViolations: [...new Set(s.viol)],
          };
          await ctx.close();
          log(name, "net", v, transport, "done");
        }
      }
    }

    // ---------------------------------------------------------------- 3. resource abuse
    if (SECTIONS.includes("abuse")) {
      E.abuse = {};
      const plan = [
        ["busy", ["same-origin", "same-site", "cross-site", "srcdoc"]],
        ["alloc", ["same-origin", "cross-site"]],
        ["raf", ["same-origin", "cross-site"]],
        ["dom", ["same-origin", "cross-site"]],
        ["canvas", ["same-origin", "cross-site"]],
      ];
      for (const [kind, transports] of plan) {
        for (const transport of transports) {
          const ctx = await browser.newContext();
          const label = `abuse.${name}.${kind}.${transport}`;
          srv.state.label = label;
          const page = await ctx.newPage();
          let crashed = false;
          page.on("crash", () => {
            crashed = true;
          });
          await page.goto(`${O.app}/shell?csp=strict`);
          await page.evaluate(() => {
            window.__heartbeat();
            document.getElementById("focus").focus();
          });
          await sleep(300);
          const t0 = Date.now();
          await mount(
            page,
            "a",
            transport,
            cfgOf(label, `abuse_${kind}`, { ms: 7000, mb: 1536, startAfter: 1500 }),
          );
          await sleep(800);
          const proc = name.startsWith("chromium") ? await chromiumProcesses(browser) : "n/a";
          await sleep(2700);
          const keySent = Date.now();
          page.keyboard.press("k").catch(() => {});
          await sleep(8500);
          const s = await withTimeout(
            page.evaluate(() => ({
              gaps: window.__s5.gaps,
              keys: window.__s5.keys,
              msgs: window.__s5.msgs,
            })),
            60000,
            "parent evaluate",
          ).catch((e) => ({ error: String(e).slice(0, 120) }));
          const mine = (s.msgs ?? []).filter((m) => m.token === label);
          const start = mine.find((m) => m.type === "start")?.t ?? null;
          const end = mine.find((m) => m.type === "end");
          const key = (s.keys ?? []).find((k) => k.at >= keySent);
          E.abuse[`${kind} / ${transport}`] = {
            contentStarted: start !== null,
            contentRanMs: start && end ? end.t - start : null,
            contentResult: end?.value ?? mine.find((m) => m.type === "alloc-error") ?? null,
            parentMaxEventLoopGapMs: s.gaps ? maxGap(s.gaps, t0, t0 + 30000) : null,
            parentKeyLatencyMs: key ? key.at - keySent : null,
            parentPageCrashed: crashed,
            evaluateError: s.error ?? s.timeout ?? null,
            chromium: proc,
          };
          await ctx.close().catch(() => {});
          log(
            name,
            "abuse",
            kind,
            transport,
            JSON.stringify(E.abuse[`${kind} / ${transport}`]).slice(0, 160),
          );
        }
      }
    }

    // ---------------------------------------------------------------- 3b. shell watchdog
    if (SECTIONS.includes("watchdog")) {
      E.watchdog = {};
      for (const transport of ["same-origin", "same-site", "cross-site", "srcdoc"]) {
        const ctx = await browser.newContext();
        const label = `wd.${name}.${transport}`;
        srv.state.label = label;
        const page = await ctx.newPage();
        await page.goto(`${O.app}/shell?csp=strict`);
        await page.evaluate(() => window.__heartbeat());
        await mount(page, "w", transport, cfgOf(label, "heartbeat", { busyAt: 4000, ms: 20000 }));
        await sleep(1500);
        await page.evaluate(() => window.__watchdog("w", 3));
        const procBefore = name.startsWith("chromium") ? await chromiumProcesses(browser) : "n/a";
        await sleep(27000);
        const procAfter = name.startsWith("chromium") ? await chromiumProcesses(browser) : "n/a";
        const s = await withTimeout(
          page.evaluate(() => ({
            wd: window.__s5.wd,
            msgs: window.__s5.msgs,
            gaps: window.__s5.gaps,
          })),
          60000,
          "parent evaluate",
        );
        const mine = (s.msgs ?? []).filter((m) => m.token === label);
        const busyStart = mine.find((m) => m.type === "busy-start")?.t ?? null;
        const wd = s.wd ?? {};
        E.watchdog[transport] = {
          beatsBeforeBusy: wd.beats ?? null,
          detectedMsAfterBusyStart: busyStart && wd.detectAt ? wd.detectAt - busyStart : null,
          safeDocLoadedMsAfterDetect:
            wd.safeLoadAt && wd.detectAt ? wd.safeLoadAt - wd.detectAt : null,
          parentMaxGapDuringBusyMs:
            busyStart && s.gaps ? maxGap(s.gaps, busyStart, busyStart + 24000) : null,
          parentMaxGapAfterReplaceMs:
            wd.detectAt && s.gaps ? maxGap(s.gaps, wd.detectAt + 300, wd.detectAt + 15000) : null,
          busyEndReported: mine.some((m) => m.type === "busy-end"),
          chromiumBefore: procBefore,
          chromiumAfter: procAfter,
          evaluateError: s.timeout ?? null,
        };
        await ctx.close().catch(() => {});
        log(name, "watchdog", transport, JSON.stringify(E.watchdog[transport]).slice(0, 200));
      }
    }

    // ---------------------------------------------------------------- 4. protocol forgery against the real shell
    if (SECTIONS.includes("proto")) {
      E.proto = {};
      for (const transport of ["same-origin", "cross-site"]) {
        const ctx = await browser.newContext();
        const label = `proto.${name}.${transport}`;
        srv.state.label = label;
        const popups = [];
        const page = await ctx.newPage();
        ctx.on("page", (p) => {
          if (p !== page) popups.push(p.url());
        });
        const content = docUrl(transport, cfgOf(label, "forge"));
        await page.goto(`${O.app}/proto?content=${encodeURIComponent(content)}`);
        // No evaluate / input for 10 s: Playwright's evaluate itself grants transient user activation.
        await sleep(10000);
        await page.mouse.click(480, 270);
        await sleep(13500);
        await page.keyboard.press("ArrowRight");
        await sleep(1500);
        const s = await page.evaluate(() => ({
          log: window.__s5.log,
          final: window.__player.getState(),
          offline: window.__player.getOffline(),
          activeInsideEvaluate: navigator.userActivation?.isActive ?? null,
        }));
        E.proto[transport] = { ...s, popups };
        await ctx.close();
        log(name, "proto", transport, "done");
      }
    }

    // ---------------------------------------------------------------- 5. srcdoc (offline) path with author script
    if (SECTIONS.includes("srcdoc")) {
      E.srcdoc = {};
      for (const ah of ["1", "0"]) {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        watchConsole(page);
        await page.goto(`${O.app}/shell?csp=strict&ah=${ah}`);
        const label = `srcdoc.${name}.${ah}`;
        await mount(page, "q", "srcdoc", cfgOf(label, "author_ran"));
        await sleep(2500);
        const s = await page.evaluate(() => ({ msgs: window.__s5.msgs, viol: window.__s5.viol }));
        E.srcdoc[
          ah === "1" ? "page CSP has the author script hash" : "page CSP has only the runtime hash"
        ] = {
          runtimeReady: s.msgs.some((m) => m.runtime === "ready"),
          authorScriptRan: s.msgs.some((m) => m.token === label && m.type === "result"),
          shellViolations: [...new Set(s.viol)],
        };
        await ctx.close();
      }
    }
  } catch (error) {
    E.error = String(error?.stack ?? error).slice(0, 600);
    log(name, "ERROR", E.error);
  } finally {
    E.consoleSample = consoleSample;
    await browser.close().catch(() => {});
  }
  writeFileSync(
    new URL(args.out ?? "./last-run.json", import.meta.url),
    `${JSON.stringify(results, null, 2)}\n`,
  );
}

results.finishedAt = new Date().toISOString();
await srv.close();
writeFileSync(
  new URL(args.out ?? "./last-run.json", import.meta.url),
  `${JSON.stringify(results, null, 2)}\n`,
);
log("written last-run.json");
