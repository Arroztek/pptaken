#!/usr/bin/env node
// Recomputes every foreground/background pair of the brand contrast table (doc 05 §5.2)
// plus the pairs this design system adds, using the WCAG 2.x formula.
// Exits with code 1 if any pair falls below its required minimum.
// Dependency-free: `node scripts/check-contrast.mjs [--json]`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const t = JSON.parse(readFileSync(join(root, "tokens.json"), "utf8"));
const prim = t.color.primitive;

const ref = (v) =>
  v.replace(/\{([\w-]+)(?:\.([\w-]+))?\}/g, (_, g, k) => (k === undefined ? prim[g] : prim[g][k]));
const theme = (mode) => ({
  ...t.color.semantic[mode],
  ...t.color.component[mode],
  ...t.color.semantic.stage,
});
const val = (mode, name) => {
  const v = theme(mode)[name];
  if (v === undefined) throw new Error(`Unknown token ${mode}.${name}`);
  return ref(v);
};

/** Parse #RRGGBB or rgba(); returns [r,g,b,a] with r,g,b in 0..255. */
function parse(c) {
  if (c.startsWith("#")) return [0, 2, 4].map((i) => parseInt(c.slice(1 + i, 3 + i), 16)).concat(1);
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`Cannot parse color ${c}`);
  const [r, g, b, a = 1] = m[1].split(",").map(Number);
  return [r, g, b, a];
}
/** Alpha-composite fg over an opaque bg. */
const over = (fg, bg) => {
  const [r, g, b, a] = parse(fg);
  const [R, G, B] = parse(bg);
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
};
const lum = ([r, g, b]) => {
  const ch = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const AAA = 7,
  AA = 4.5,
  UI = 3;
// [label, mode, fg token, bg token, required minimum, documented ratio in 05 (or null), note]
// A bg written as "token@over:#HEX" means: token (translucent) composited over that opaque color.
const pairs = [
  // ---- Doc 05 §5.2 ----
  ["Ink on Paper", "light", "text", "bg", AAA, 16.6],
  ["Secondary on Paper", "light", "text-muted", "bg", AA, 6.3],
  ["Chalk on Backstage", "dark", "text", "bg", AAA, 16.5],
  ["Secondary on Backstage", "dark", "text-muted", "bg", AA, 8.0],
  ["Secondary on dark Surface", "dark", "text-muted", "surface", AA, 7.3],
  ["Ink on Spotlight", "light", "on-accent", "accent", AAA, 9.9],
  ["Spotlight on Backstage", "dark", "accent", "bg", AAA, 10.5],
  [
    "Spotlight on Paper (restricted: fill only)",
    "light",
    "accent",
    "bg",
    0,
    1.7,
    "documented failure; never text",
  ],
  ["Spotlight-text on Paper", "light", "accent-text", "bg", AA, 5.6],
  ["Curtain on Paper", "light", "interactive", "bg", AA, 6.8],
  ["White on Curtain", "light", "on-interactive", "interactive", AA, 7.2],
  ["Light Curtain on Backstage", "dark", "interactive", "bg", AA, 7.9],
  ["Success on Paper", "light", "success", "bg", AA, 5.0],
  ["Danger on Paper", "light", "danger", "bg", AA, 5.0],
  ["Warning on Paper", "light", "warning", "bg", AA, 4.7],
  ["Success on Backstage", "dark", "success", "bg", AA, 10.1],
  ["Danger on Backstage", "dark", "danger", "bg", AA, 6.8],
  ["Warning on Backstage", "dark", "warning", "bg", AA, 9.3],
  ["Strong border on background (light)", "light", "border-strong", "bg", UI, 3.9],
  ["Strong border on background (dark)", "dark", "border-strong", "bg", UI, 5.9],
  // ---- Added by the design system ----
  ...["light", "dark"].flatMap((m) => [
    [`Text on Surface 2`, m, "text", "surface-2", AAA, null],
    [`Secondary on Surface 2`, m, "text-muted", "surface-2", AA, null],
    [`Secondary on Surface`, m, "text-muted", "surface", AA, null],
    [`Curtain on Surface`, m, "interactive", "surface", AA, null],
    [`Curtain on Surface 2`, m, "interactive", "surface-2", AA, null],
    [`On Curtain`, m, "on-interactive", "interactive", AA, null],
    [`Spotlight-text on Surface`, m, "accent-text", "surface", AA, null],
    [`Spotlight-text on Surface 2`, m, "accent-text", "surface-2", AA, null],
    ...["success", "danger", "warning"].flatMap((s) => [
      [`${s} on Surface`, m, s, "surface", AA, null],
      [`${s} on Surface 2`, m, s, "surface-2", AA, null],
    ]),
    [`On Danger`, m, "on-danger", "danger", AA, null],
    [`Ink on Spotlight (hover)`, m, "on-accent", "accent-hover", AAA, null],
    [`Strong border on Surface`, m, "border-strong", "surface", UI, null],
    [`Strong border on Surface 2`, m, "border-strong", "surface-2", UI, null],
    [`Focus ring on background`, m, "focus-ring", "bg", UI, null],
    [`Focus ring on Surface`, m, "focus-ring", "surface", UI, null],
    [`Inverse text`, m, "inverse-text", "inverse-bg", AAA, null],
    [`Text on selection (subtle Curtain)`, m, "text", "interactive-subtle@over:surface", AAA, null],
    ...["a", "b", "c", "d"].flatMap((q) => [
      [`Letter on quiz-${q}`, m, "on-quiz", `quiz-${q}`, AA, null],
      [`quiz-${q} on Surface (graphic)`, m, `quiz-${q}`, "surface", UI, null],
    ]),
  ]),
  ["Player chrome on letterbox", "light", "chrome", "letterbox", AA, null],
  [
    "Player chrome on its plate, over a white slide (worst case)",
    "light",
    "chrome",
    "chrome-bg@over:#FFFFFF",
    AA,
    null,
  ],
  [
    "Player chrome on its plate, over a black slide",
    "light",
    "chrome",
    "chrome-bg@over:#000000",
    AA,
    null,
  ],
];

const resolveBg = (mode, spec) => {
  const [tok, base] = spec.split("@over:");
  const c = val(mode, tok);
  if (!base) return parse(c);
  const baseColor = base.startsWith("#") ? base : val(mode, base);
  return over(c, baseColor);
};

let fails = 0;
const rows = pairs.map(([label, mode, fg, bg, min, doc, note]) => {
  const r = ratio(parse(val(mode, fg)), resolveBg(mode, bg));
  const pass = r >= min;
  if (!pass) fails++;
  const level = r >= 7 ? "AAA" : r >= 4.5 ? "AA" : r >= 3 ? "AA-large/UI" : "fail";
  const drift =
    doc === null
      ? ""
      : Math.abs(r - doc) > 0.1
        ? ` (doc ${doc}, drift ${(r - doc).toFixed(2)})`
        : "";
  return { label, mode, fg, bg, ratio: Number(r.toFixed(2)), min, level, pass, doc, note, drift };
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows)
    console.log(
      `${r.pass ? "PASS" : "FAIL"}  ${r.ratio.toFixed(2).padStart(5)}:1  ${r.level.padEnd(11)} ${r.mode.padEnd(5)}  ${r.label}  [${r.fg} / ${r.bg}]${r.drift}${r.note ? `  - ${r.note}` : ""}`,
    );
  console.log(`\n${rows.length - fails} passed, ${fails} failed, ${rows.length} pairs checked.`);
}
process.exit(fails ? 1 : 0);
