// SPDX-License-Identifier: AGPL-3.0-or-later
// MANUAL smoke test of the vendoring fetcher over the REAL network (ADR-022). Not part of the automated suites.
// It performs two read-only GETs against public hosts (a Google Fonts css2 stylesheet and one font file it lists,
// and a jsDelivr script behind a version-range redirect), through every check of the real fetcher, and prints what
// it got. Nothing is written to disk.
// Usage: pnpm --filter @pptaken/server build && node apps/server/scripts/vendor-smoke.mjs
import { createHash } from "node:crypto";
import { createVendorFetcher } from "../dist/vendor-fetch.js";

const fetcher = createVendorFetcher({ enabled: true, cacheBytes: 0 });
const actor = { actor: "owner", tokenId: null };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const get = (url, kind) =>
  fetcher.fetch({ url, kind, deckId: "smoke", actor, deadline: Date.now() + 30_000 });

const css = await get(
  "https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400&display=swap",
  "stylesheet",
);
const text = new TextDecoder().decode(css.bytes);
const fontUrl = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/.exec(text)?.[1];
console.log(
  "css2:",
  css.finalUrl,
  css.bytes.length,
  "bytes;",
  (text.match(/@font-face/g) ?? []).length,
  "faces; woff2:",
  fontUrl !== undefined,
);
if (fontUrl !== undefined) {
  const font = await get(fontUrl, "font");
  console.log(
    "font:",
    font.finalUrl.slice(0, 80),
    font.bytes.length,
    "bytes, sha256",
    sha(font.bytes).slice(0, 16),
  );
}
const lib = await get("https://cdn.jsdelivr.net/npm/uplot@1/dist/uPlot.iife.min.js", "script");
console.log(
  "script:",
  lib.finalUrl,
  "redirects:",
  lib.redirects,
  lib.bytes.length,
  "bytes, sha256",
  sha(lib.bytes).slice(0, 16),
);
