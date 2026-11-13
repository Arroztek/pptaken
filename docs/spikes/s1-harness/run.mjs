// Runs the isolation harness against Chromium, Firefox and WebKit with Playwright.
// Usage (from the repo root): node docs/spikes/s1-harness/run.mjs
import { spawn } from "node:child_process";
import { chromium, firefox, webkit } from "@playwright/test";

const BASE = "http://localhost:5391";
const server = spawn(
  process.execPath,
  [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  { stdio: "ignore" },
);
await new Promise((r) => setTimeout(r, 1200));

// Loads /c/deck?csp=<variant> in an iframe (with or without the sandbox attribute) and returns the deck's test results.
const probe = (page, { variant, attr }) =>
  page.evaluate(
    ({ variant, attr }) =>
      new Promise((resolve) => {
        document.querySelectorAll("iframe.probe").forEach((i) => i.remove());
        let last = null;
        const onMsg = (e) => {
          if (e.data?.type === "tests") last = { postMessageOrigin: e.origin, ...e.data.results };
          if (e.data?.type === "ready") done();
        };
        const i = document.createElement("iframe");
        i.className = "probe";
        if (attr) i.setAttribute("sandbox", "allow-scripts");
        i.style.cssText = "width:300px;height:100px";
        const done = () => {
          removeEventListener("message", onMsg);
          resolve(last);
        };
        addEventListener("message", onMsg);
        setTimeout(done, 12000);
        i.src = `/c/deck?csp=${variant}&x=${Date.now()}`;
        document.body.appendChild(i);
      }),
    { variant, attr },
  );

const report = {};
for (const [name, type] of [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
]) {
  const browser = await type.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/parent`);
  const r = {};
  // A) the harness page itself: sandbox attribute + CSP header sandbox (the production configuration)
  r["A attr+header"] = await probe(page, { variant: "default", attr: true });
  // B) header only
  r["B header only"] = await probe(page, { variant: "default", attr: false });
  // C) attribute only (no CSP at all)
  r["C attr only"] = await probe(page, { variant: "none", attr: true });
  // D) explicit origin in img-src/font-src instead of 'self'
  r["D attr+header, explicit origin"] = await probe(page, { variant: "explicit", attr: true });
  // E) keyboard: click inside the page iframe and press a key; does the parent receive it?
  await page.goto(`${BASE}/parent`);
  await page.waitForFunction(() => window.__R?.ready, null, { timeout: 12000 }).catch(() => {});
  await page.locator("#deck").click({ position: { x: 100, y: 100 } });
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  r["E keys forwarded from focused iframe"] = await page.evaluate(() => window.__R.keys);
  report[name] = r;
  await browser.close();
}
server.kill();
console.log(JSON.stringify(report, null, 2));
