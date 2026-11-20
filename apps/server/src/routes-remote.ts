// SPDX-License-Identifier: AGPL-3.0-or-later
// Static side of the remote control (phase F4): the phone page `/r` (no session: the pairing secret travels in the
// URL fragment, which the browser never sends; the page strips it and redeems it over HTTP) and the browser
// modules under `/_rt/` (the @pptaken/realtime ES modules, the phone stylesheet and the pinned QR encoder).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_FILES, PHONE_CSS } from "@pptaken/realtime";
import { Hono } from "hono";
import type { AppEnv, Services } from "./context.js";
import { playerPagePolicy } from "./routes-content.js";
import { runtimePaths } from "./runtime-paths.js";

const REALTIME_DIST = runtimePaths.realtimeDir;
/** The QR encoder: `qr` (paulmillr/qr), pinned in package.json, zero dependencies, one self-contained module. */
const QR_FILE = runtimePaths.qrFile;
const FILES = new Set<string>(BROWSER_FILES);

/** The phone page script: injects the player modules the phone needs (previews, next position, notes, clock). */
export const PHONE_PAGE_SCRIPT = `// PPTaken remote (phone). Strips the pairing secret from the URL at once, then pairs and connects.
import { startPhone } from "./phone.js";
import { pickRemoteLocale } from "./i18n.js";
import { createPlayer } from "/_player/shell.js";
import { next } from "/_player/navigation.js";
import * as pace from "/_player/pace.js";
import { setNotesHtml } from "/_player/presenter.js";
const locale = pickRemoteLocale(navigator.languages);
document.documentElement.lang = locale;
startPhone({ root: document.getElementById("app"), locale, deps: { createPlayer, next, setNotesHtml, pace } });
`;

function phonePage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><meta name="color-scheme" content="dark">
<title>PPTaken remote</title>
<link rel="stylesheet" href="/_player/presenter.css"><link rel="stylesheet" href="/_rt/phone.css"></head>
<body data-state="loading"><main id="app"></main>
<script type="module" src="/_rt/phone-page.js"></script></body></html>`;
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function remotePageRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  let qrSource: string | null = null;

  app.get("/r", (c) =>
    c.html(phonePage(), 200, {
      "Content-Security-Policy": playerPagePolicy(c, s),
      "Cache-Control": "no-store",
    }),
  );

  app.get("/_rt/:file", (c) => {
    const file = c.req.param("file");
    const headers = { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
    const js = { ...headers, "Content-Type": "text/javascript; charset=utf-8" };
    if (file === "phone-page.js") return c.body(PHONE_PAGE_SCRIPT, 200, js);
    if (file === "phone.css") {
      return c.body(PHONE_CSS, 200, { ...headers, "Content-Type": "text/css; charset=utf-8" });
    }
    if (file === "qr.js") {
      qrSource ??= readFileSync(QR_FILE, "utf8");
      return c.body(qrSource, 200, js);
    }
    if (!FILES.has(file)) return notFound();
    const path = join(REALTIME_DIST, file);
    if (!existsSync(path)) return notFound();
    return c.body(readFileSync(path, "utf8"), 200, js);
  });

  return app;
}
