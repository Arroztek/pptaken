// SPDX-License-Identifier: AGPL-3.0-or-later
// Cover fixtures of the mock server (the grid view): the CSP of a cover document, as the real server sends it
// (cover mode, docs/spec/player.md), and hand-made first slides with a few different looks. No script, no network.

/** CSP of a cover document: a sandbox that grants nothing, no script source, framable by the app origin only. */
export function coverCsp(origin) {
  return [
    "sandbox",
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    `frame-ancestors ${origin}`,
  ].join("; ");
}

const LOOKS = [
  // Dark title slide with the accent bar of the landing.
  { bg: "#14161C", fg: "#FAF7F2", accent: "#FFB224", layout: "title" },
  // Light slide with a big figure.
  { bg: "#FAF7F2", fg: "#16181D", accent: "#4C3FD9", layout: "figure" },
  // Violet full-bleed statement.
  { bg: "#3B2FB5", fg: "#FFFFFF", accent: "#FFD27A", layout: "statement" },
  // Plain white with a rule, document-like.
  { bg: "#FFFFFF", fg: "#1D2330", accent: "#C2410C", layout: "title" },
  // Green-tinted light slide.
  { bg: "#EAF2EC", fg: "#12261A", accent: "#1F7A4C", layout: "figure" },
];

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function figure({ w, four, title, look, index }) {
  return `<div style="position:absolute;left:120px;top:150px;width:${w - 240}px;display:flex;gap:96px;align-items:center"><div style="flex:1"><div style="font:700 ${four ? 84 : 96}px/1.05 system-ui,sans-serif;letter-spacing:-0.03em">${title}</div><div style="margin-top:40px;width:160px;height:10px;background:${look.accent}"></div></div><div style="width:${four ? 380 : 560}px;height:600px;background:${look.accent};display:flex;align-items:flex-end;padding:48px;color:#fff;font:800 220px/1 system-ui,sans-serif;box-sizing:border-box">${(index % 9) + 1}</div></div>`;
}

function statement({ four, title, look }) {
  return `<div style="position:absolute;left:120px;right:120px;top:50%;transform:translateY(-50%)"><div style="font:300 ${four ? 110 : 132}px/1.02 system-ui,sans-serif;letter-spacing:-0.04em">${title}</div><div style="margin-top:56px;font:500 40px system-ui,sans-serif;color:${look.accent}">PPTaken</div></div>`;
}

function plainTitle({ four, title, look, deck }) {
  return `<div style="position:absolute;left:120px;top:120px;width:16px;height:840px;background:${look.accent}"></div><div style="position:absolute;left:200px;right:120px;top:50%;transform:translateY(-50%)"><div style="font:600 ${four ? 96 : 112}px/1.06 system-ui,sans-serif;letter-spacing:-0.03em">${title}</div><div style="margin-top:48px;font:400 44px system-ui,sans-serif;opacity:.65">${deck.slideCount} slides</div></div>`;
}

/** A hand-made first slide for a mock deck: varied so the grid has something to show. */
export function coverDocument(deck, index) {
  const look = LOOKS[index % LOOKS.length];
  const four = deck.aspectRatio === "4:3";
  const w = four ? 1440 : 1920;
  const h = 1080;
  const title = esc(deck.title);
  const args = { w, four, title, look, index, deck };
  const body =
    look.layout === "figure"
      ? figure(args)
      : look.layout === "statement"
        ? statement(args)
        : plainTitle(args);
  return `<!doctype html><html lang="${deck.lang ?? "en"}"><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#000}#s{position:absolute;left:0;top:0;width:${w}px;height:${h}px;overflow:hidden;background:${look.bg};color:${look.fg}}</style></head><body><section id="s" data-slide="a">${body}</section></body></html>`;
}
