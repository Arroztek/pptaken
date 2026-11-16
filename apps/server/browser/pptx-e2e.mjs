// SPDX-License-Identifier: AGPL-3.0-or-later
// PowerPoint import smoke test: the REAL server and the REAL built web app in Chromium. The owner imports a generated
// .pptx through the panel (dialog -> file picker), sees the results summary, opens the new deck from its link and the
// player reaches the ready state with the picture loaded inside the sandboxed content frame.
// Usage: pnpm --filter @pptaken/server build && node apps/server/browser/pptx-e2e.mjs (needs apps/web built)

import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { chromium } from "@playwright/test";
import { buildPptx, inch, para, ph, picture, textBox } from "@pptaken/testing/pptx";
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

/** A real, decodable PNG (solid colour), so the browser can paint it. */
function solidPng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const x of bytes) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
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

const port = await freePort();
const app = `http://localhost:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "pptaken-pptx-e2e-"));
const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) process.exitCode = 1;
};

const pptx = buildPptx({
  title: "Imported from PowerPoint",
  media: { "image1.png": solidPng(160, 90, [255, 178, 36]) },
  slides: [
    {
      shapes:
        ph(2, "title", null, ["Imported from PowerPoint"]) +
        picture(4, "rId2", { x: inch(1), y: inch(2.5), w: inch(4), h: inch(2.25) }, "Amber block"),
      rels: [{ id: "rId2", type: "image", target: "../media/image1.png" }],
      notes: "Speaker notes survive the trip",
    },
    {
      shapes:
        ph(2, "title", null, ["Second slide"]) +
        textBox(5, { x: inch(1), y: inch(2), w: inch(8), h: inch(2) }, para("Plain text box")),
    },
  ],
});

const pptaken = await createServer(
  loadConfig({ PPTAKEN_DATA_DIR: dataDir, PPTAKEN_PUBLIC_URL: app, PPTAKEN_LOG_LEVEL: "warn" }),
  { logSink: () => {} },
);
const http = serve({ fetch: pptaken.fetch, port, hostname: "::" });
const browser = await chromium.launch();
try {
  // Owner set-up through the API, then the session cookie goes to the browser.
  const setup = await fetch(`${app}/api/v1/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app, "X-PPTaken-CSRF": "1" },
    body: JSON.stringify({
      installCode: pptaken.installCode,
      password: "violet otter climbs 7 dunes",
    }),
  });
  const cookie = /([^=;\s]*pptaken_session)=([^;]+)/.exec(setup.headers.get("set-cookie") ?? "");
  check("owner set up", setup.status === 201 && cookie !== null);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: cookie[1], value: cookie[2], url: app }]);
  const page = await context.newPage();
  const problems = [];
  const watch = (p) => {
    p.on("pageerror", (e) => problems.push(`pageerror: ${e}`));
    p.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
    p.on("request", (r) => {
      if (!r.url().startsWith(app)) problems.push(`external request: ${r.url()}`);
    });
  };
  watch(page);

  await page.goto(`${app}/decks`);
  await page.getByRole("button", { name: "Import", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Import a presentation" });
  await dialog.waitFor({ timeout: 10_000 });
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose a file" }).click();
  await (await chooser).setFiles({
    name: "Imported from PowerPoint.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(pptx),
  });
  await page.getByText("Imported “Imported from PowerPoint”.").waitFor({ timeout: 30_000 });
  check("the panel imports the .pptx and shows the results summary", true);
  check(
    "the summary lists the font replacement",
    await page.getByText(/Fonts replaced/).isVisible(),
  );

  const open = page.getByRole("link", { name: "Open the presentation" });
  const popupPromise = context.waitForEvent("page", { timeout: 5000 });
  await open.click();
  const player = await popupPromise;
  watch(player);
  await player.waitForSelector('body[data-state="ready"]', { timeout: 20_000 });
  check("the imported deck opens in the player and reaches the ready state", true);

  const content = player.frames().find((f) => f.url().includes("/c/"));
  const image = content
    ? await content.evaluate(async () => {
        const img = document.querySelector("img");
        if (img === null) return null;
        if (!img.complete)
          await new Promise((r) => img.addEventListener("load", r, { once: true }));
        return { width: img.naturalWidth, alt: img.alt };
      })
    : null;
  check(
    "the picture loads inside the content frame",
    image?.width === 160 && image.alt === "Amber block",
  );
  // Optional visual check: PPTX_E2E_SCREENSHOT=<file.png> saves the first slide as the audience sees it.
  if (process.env.PPTX_E2E_SCREENSHOT)
    await player.screenshot({ path: process.env.PPTX_E2E_SCREENSHOT });

  check("no console errors, page errors or external requests", problems.length === 0);
  if (problems.length) console.log(problems.join("\n"));
} catch (e) {
  console.log(`FAIL  unexpected error: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  http.close();
  await pptaken.close?.();
  rmSync(dataDir, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(process.exitCode ?? 0);
