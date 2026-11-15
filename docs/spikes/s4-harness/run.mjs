// SPDX-License-Identifier: Apache-2.0
// Spike S4: runs the harness in Chromium, Firefox and WebKit and writes `last-run.json`.
// Usage (from the repository root): node docs/spikes/s4-harness/run.mjs

import { writeFileSync } from "node:fs";
import { chromium, firefox, webkit } from "@playwright/test";
import { startServers } from "./server.mjs";

const servers = await startServers();
const { app, content } = servers.origins;
const results = { startedAt: new Date().toISOString(), origins: servers.origins, engines: {} };

const collect = async (page) => {
  await page.waitForTimeout(3000);
  const controlled = await page.evaluate(() => navigator.serviceWorker?.controller != null);
  if (controlled) {
    await page.evaluate(() => window.__swLog());
    await page.waitForFunction(() => window.__s4.sw !== null, null, { timeout: 5000 });
  }
  return page.evaluate(() => window.__s4);
};

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  const r = {};
  results.engines[name] = r;
  const browser = await engine.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLines = [];
    page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 160)));
    await page.goto(`${app}/`);
    r.serviceWorkerApi = await page.evaluate(() => "serviceWorker" in navigator);
    if (r.serviceWorkerApi) {
      await page.evaluate(() => window.__register());
      // Wait for the "activated" state (`ready` may resolve while still activating), then navigate plainly
      // (Playwright's reload may bypass the service worker), twice if the first one is not controlled yet.
      await page.waitForFunction(
        async () =>
          (await navigator.serviceWorker.getRegistration("/"))?.active?.state === "activated",
        null,
        { timeout: 10_000 },
      );
      for (let i = 0; i < 2; i++) {
        await page.goto(`${app}/`);
        const ok = await page
          .waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
            timeout: 5_000,
          })
          .then(
            () => true,
            () => false,
          );
        if (ok) break;
      }
    }
    r.controlled = await page.evaluate(() => navigator.serviceWorker?.controller != null);
    await page.evaluate(
      ({ app, content }) => {
        window.__frame(`${app}/c/doc`, "src");
        window.__frame(`${content}/c/doc`, "src");
        window.__frame(window.__srcdoc.ok, "srcdoc");
        window.__frame(window.__srcdoc.unhashed, "srcdoc");
        window.__frame(`${app}/c/sw-only`, "src");
        window.__frame(`${content}/c/sw-only`, "src");
      },
      { app, content },
    );
    const s4 = await collect(page);
    r.messages = s4.messages.map(
      (m) =>
        `${m.which}: origin=${m.origin} img=${m.img} font=${m.font} api=${m.api}${m.served ? " served-by-sw" : ""}`,
    );
    r.serviceWorkerSaw = s4.sw;
    // The same srcdoc document under a page whose CSP has `font-src 'self'` (no data:).
    const strict = await context.newPage();
    await strict.goto(`${app}/strict`);
    await strict.evaluate(() => window.__frame(window.__srcdoc.ok, "srcdoc"));
    await strict.waitForFunction(() => window.__s4.messages.length > 0, null, { timeout: 5000 });
    const m = (await strict.evaluate(() => window.__s4.messages))[0];
    r.srcdocUnderStrictPage = `img=${m.img} font=${m.font}`;
    r.console = consoleLines.filter((l) => /refused|blocked|violat|Content.Security/i.test(l));
  } catch (error) {
    r.error = String(error);
  } finally {
    await browser.close();
  }
  console.log(name, JSON.stringify(r, null, 1));
}

await servers.close();
writeFileSync(new URL("./last-run.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
