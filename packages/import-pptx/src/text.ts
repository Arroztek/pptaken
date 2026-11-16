// SPDX-License-Identifier: AGPL-3.0-or-later
// Text bodies: paragraphs, runs and bullets with PowerPoint's style inheritance (run -> paragraph -> shape list
// style -> layout placeholder -> master placeholder -> master text styles -> presentation defaults).
import type { FontName } from "@pptaken/schema";
import {
  type ColorContext,
  colorOf,
  css,
  fillElement,
  firstColorChild,
  parseFill,
  type Rgba,
} from "./color.js";
import { type FontChoice, fontFamilyCss } from "./fonts.js";
import { esc, num, px, style } from "./html.js";
import { attr, child, children, intAttr, type XmlElement } from "./xml.js";

export const EMU_PER_PT = 12700;

export interface TextEnv {
  colors: ColorContext;
  /** EMU -> canvas px (scale only). */
  len(emu: number): number;
  majorFont: string;
  minorFont: string;
  /** Maps a typeface to the catalog and records it (substitution warnings). */
  useFont(typeface: string): FontChoice;
  /** Records a run language (for the deck's `lang`). */
  noteLang(lang: string): void;
  /** Records a slide-scoped feature warning. */
  simplified(feature: string): void;
}

export interface StyleChain {
  /** `a:lstStyle` elements in priority order (shape, layout placeholder, master placeholder). */
  lstStyles: XmlElement[];
  /** `p:titleStyle`, `p:bodyStyle` or `p:otherStyle` of the master. */
  masterStyle: XmlElement | undefined;
  /** `p:defaultTextStyle` of the presentation. */
  defaultStyle: XmlElement | undefined;
  /** Text colour of the shape style (`p:style/a:fontRef`), used before the inherited styles. */
  fontRefColor: Rgba | null;
  /** Number of `lstStyles` that belong to the shape itself (before `fontRefColor` applies). */
  ownStyles: number;
}

export interface BodyOptions {
  /** Font scale from `a:normAutofit/@fontScale` (1 = 100 %). */
  fontScale: number;
  /** Line spacing reduction from `a:normAutofit/@lnSpcReduction` (0.1 = 10 %). */
  lineReduction: number;
  /** Paragraph index -> reveal step. */
  paragraphSteps?: ReadonlyMap<number, number> | undefined;
  /** No wrapping (`a:bodyPr/@wrap="none"`). */
  noWrap: boolean;
}

export interface RenderedText {
  html: string;
  plain: string;
  /** True when at least one run has visible text. */
  hasText: boolean;
}

function levelOf(pPr: XmlElement | undefined): number {
  const lvl = intAttr(pPr, "lvl", 0);
  return Math.min(8, Math.max(0, lvl));
}

/** Paragraph property elements for a level, highest priority first. */
function pPrChain(chain: StyleChain, level: number, own: XmlElement | undefined): XmlElement[] {
  const name = `a:lvl${level + 1}pPr`;
  const out: XmlElement[] = [];
  if (own !== undefined) out.push(own);
  for (const ls of chain.lstStyles) {
    const el = child(ls, name);
    if (el !== undefined) out.push(el);
  }
  const ms = child(chain.masterStyle, name);
  if (ms !== undefined) out.push(ms);
  const ds = child(chain.defaultStyle, name);
  if (ds !== undefined) out.push(ds);
  return out;
}

function firstAttr(list: readonly (XmlElement | undefined)[], name: string): string | undefined {
  for (const el of list) {
    const v = el?.attrs[name];
    if (v !== undefined) return v;
  }
  return undefined;
}

function firstChild(
  list: readonly (XmlElement | undefined)[],
  name: string,
): XmlElement | undefined {
  for (const el of list) {
    const c = child(el, name);
    if (c !== undefined) return c;
  }
  return undefined;
}

/** Common Wingdings/Symbol bullet glyphs and their Unicode look-alikes. */
const SYMBOL_BULLETS: Record<string, string> = {
  "§": "▪",
  Ø: "➢",
  ü: "✓",
  n: "■",
  l: "●",
  q: "❑",
  v: "❖",
  à: "→",
  è: "➔",
  w: "◆",
  o: "○",
  "·": "•",
  "": "▪",
  "": "➢",
  "": "✓",
  "": "■",
  "": "●",
  "": "❑",
  "": "❖",
};

function roman(n: number): string {
  const table: [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let out = "";
  let v = Math.min(3999, Math.max(1, n));
  for (const [value, sym] of table) {
    while (v >= value) {
      out += sym;
      v -= value;
    }
  }
  return out;
}

function alpha(n: number): string {
  let v = Math.max(1, n);
  let out = "";
  while (v > 0) {
    v--;
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26);
  }
  return out;
}

/** Text of an automatic number (`arabicPeriod`, `romanUcParenR`, `alphaLcParenBoth`...). */
export function autoNumber(type: string, n: number): string {
  let core: string;
  if (type.startsWith("roman")) core = roman(n);
  else if (type.startsWith("alpha")) core = alpha(n);
  else core = String(n);
  if (/Uc/.test(type)) core = core.toUpperCase();
  if (type.endsWith("ParenBoth")) return `(${core})`;
  if (type.endsWith("ParenR")) return `${core})`;
  if (type.endsWith("Plain")) return core;
  if (type.endsWith("Minus")) return `-${core}-`;
  return `${core}.`;
}

interface RunStyle {
  sizePx: number;
  font: FontName;
  color: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  caps: boolean;
  baseline: number;
  spacingPx: number;
}

function resolveFont(typeface: string | undefined, env: TextEnv): FontChoice {
  let face = typeface ?? "+mn-lt";
  if (face.startsWith("+mj")) face = env.majorFont;
  else if (face.startsWith("+mn")) face = env.minorFont;
  if (face.trim() === "") face = env.minorFont;
  return env.useFont(face);
}

function runStyle(
  rPr: XmlElement | undefined,
  pChain: readonly XmlElement[],
  chain: StyleChain,
  env: TextEnv,
  options: BodyOptions,
): RunStyle {
  const defs = pChain.map((p) => child(p, "a:defRPr"));
  const list = [rPr, ...defs];
  const sz = Number(firstAttr(list, "sz") ?? 1800);
  const sizePt = (Number.isFinite(sz) && sz >= 100 && sz <= 400000 ? sz : 1800) / 100;
  const latin = firstChild(list, "a:latin");
  const choice = resolveFont(attr(latin, "typeface"), env);
  const font = choice.font;
  const sizePx = env.len(sizePt * EMU_PER_PT) * options.fontScale * choice.scale;

  // Colour: the run and the shape's own list style, then the shape style's font colour, then inherited styles.
  let color: string | null = null;
  const ownCount = 1 + Math.min(chain.ownStyles, defs.length);
  for (let i = 0; i < list.length; i++) {
    if (i === ownCount && chain.fontRefColor !== null) {
      color = css(chain.fontRefColor);
      break;
    }
    const el = list[i];
    const f = fillElement(el);
    if (f === undefined) continue;
    const fill = parseFill(f, env.colors);
    if (fill === null) continue;
    if (fill.kind === "solid" || fill.kind === "pattern") color = css(fill.color);
    else if (fill.kind === "gradient") {
      color = css(fill.first);
      env.simplified("wordart");
    } else if (fill.kind === "none") color = "transparent";
    break;
  }
  if (color === null && chain.fontRefColor !== null) color = css(chain.fontRefColor);
  if (color === null) {
    const tx1 = colorOf(
      { name: "a:schemeClr", attrs: { val: "tx1" }, children: [], text: "" },
      env.colors,
    );
    color = tx1 === null ? null : css(tx1);
  }

  const u = firstAttr(list, "u");
  const strike = firstAttr(list, "strike");
  const baseline = Number(firstAttr(list, "baseline") ?? 0);
  const spc = Number(firstAttr(list, "spc") ?? 0);
  if (rPr !== undefined) {
    if (child(rPr, "a:effectLst") !== undefined || child(rPr, "a:ln") !== undefined)
      env.simplified("wordart");
    if (child(rPr, "a:hlinkClick") !== undefined) env.simplified("links");
    const lang = attr(rPr, "lang");
    if (lang !== undefined) env.noteLang(lang);
  }
  const b = firstAttr(list, "b");
  const i = firstAttr(list, "i");
  return {
    sizePx,
    font,
    color,
    bold: b === "1" || b === "true",
    italic: i === "1" || i === "true",
    underline: u !== undefined && u !== "none",
    strike: strike !== undefined && strike !== "noStrike",
    caps: firstAttr(list, "cap") === "all",
    baseline: Number.isFinite(baseline) ? baseline / 1000 : 0,
    spacingPx: Number.isFinite(spc) ? env.len((spc / 100) * EMU_PER_PT) : 0,
  };
}

function runCss(s: RunStyle, base: RunStyle | null): string {
  const decoration = [s.underline ? "underline" : "", s.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  const small = s.baseline !== 0;
  return style([
    base === null || base.sizePx !== s.sizePx || small
      ? `font-size:${px(small ? s.sizePx * 0.7 : s.sizePx)}`
      : null,
    base === null || base.font !== s.font ? `font-family:${fontFamilyCss(s.font)}` : null,
    s.color !== null && (base === null || base.color !== s.color) ? `color:${s.color}` : null,
    s.bold && (base === null || !base.bold) ? "font-weight:700" : null,
    !s.bold && base?.bold ? "font-weight:400" : null,
    s.italic && (base === null || !base.italic) ? "font-style:italic" : null,
    !s.italic && base?.italic ? "font-style:normal" : null,
    decoration !== "" ? `text-decoration:${decoration}` : null,
    s.caps ? "text-transform:uppercase" : null,
    s.spacingPx !== 0 ? `letter-spacing:${px(s.spacingPx)}` : null,
    s.baseline > 0 ? "vertical-align:super" : s.baseline < 0 ? "vertical-align:sub" : null,
  ]);
}

function spacingPx(el: XmlElement | undefined, fontPx: number, env: TextEnv): number | null {
  if (el === undefined) return null;
  const pts = child(el, "a:spcPts");
  if (pts !== undefined) {
    const v = intAttr(pts, "val");
    return v === undefined ? null : env.len((v / 100) * EMU_PER_PT);
  }
  const pct = child(el, "a:spcPct");
  if (pct !== undefined) {
    const v = intAttr(pct, "val");
    return v === undefined ? null : (v / 100000) * fontPx * 1.2;
  }
  return null;
}

/** Plain text of a paragraph (runs, fields and line breaks). */
export function paragraphText(p: XmlElement): string {
  let out = "";
  for (const c of p.children) {
    if (c.name === "a:r" || c.name === "a:fld") out += child(c, "a:t")?.text ?? "";
    else if (c.name === "a:br") out += "\n";
  }
  return out;
}

/** Renders the paragraphs of a `p:txBody` / `a:txBody`. */
export function renderParagraphs(
  txBody: XmlElement | undefined,
  chain: StyleChain,
  env: TextEnv,
  options: BodyOptions,
): RenderedText {
  const paragraphs = children(txBody, "a:p");
  const html: string[] = [];
  const plain: string[] = [];
  let hasText = false;
  const counters: ({ type: string; n: number } | undefined)[] = [];

  paragraphs.forEach((p, index) => {
    const pPr = child(p, "a:pPr");
    const level = levelOf(pPr);
    const chainP = pPrChain(chain, level, pPr);
    const endRPr = child(p, "a:endParaRPr");
    const runs = p.children.filter(
      (c) => c.name === "a:r" || c.name === "a:br" || c.name === "a:fld",
    );
    const firstRPr =
      child(
        runs.find((r) => r.name !== "a:br"),
        "a:rPr",
      ) ?? endRPr;
    const base = runStyle(firstRPr, chainP, chain, env, options);
    const text = paragraphText(p);
    plain.push(text);

    // Bullets and numbering: a level continues its count until a paragraph of an outer level or a paragraph of
    // the same level without numbering interrupts it.
    if (text.trim() !== "")
      for (let l = level + 1; l < counters.length; l++) counters[l] = undefined;
    const bulletOwner = chainP.find((el) =>
      el.children.some((c) => ["a:buNone", "a:buChar", "a:buAutoNum", "a:buBlip"].includes(c.name)),
    );
    let bullet: string | null = null;
    const isEmpty = text.trim() === "";
    if (bulletOwner !== undefined && !isEmpty) {
      const buChar = child(bulletOwner, "a:buChar");
      const buAuto = child(bulletOwner, "a:buAutoNum");
      if (buChar !== undefined) {
        const ch = (attr(buChar, "char") ?? "•").slice(0, 2);
        const buFont = attr(firstChild(chainP, "a:buFont"), "typeface") ?? "";
        const symbolFont = /wingdings|symbol|webdings/i.test(buFont) || /[-]/.test(ch);
        bullet = symbolFont ? (SYMBOL_BULLETS[ch] ?? "•") : ch;
        counters[level] = undefined;
      } else if (buAuto !== undefined) {
        const type = attr(buAuto, "type") ?? "arabicPeriod";
        const startAt = Math.max(1, Math.min(32767, intAttr(buAuto, "startAt", 1)));
        const prev = counters[level];
        const current = prev !== undefined && prev.type === type ? prev.n + 1 : startAt;
        counters[level] = { type, n: current };
        bullet = autoNumber(type, current);
      } else {
        if (child(bulletOwner, "a:buBlip") !== undefined) bullet = "•";
        counters[level] = undefined;
      }
    } else if (!isEmpty) {
      counters[level] = undefined;
    }

    const algn = firstAttr(chainP, "algn");
    const align =
      algn === "ctr"
        ? "center"
        : algn === "r"
          ? "right"
          : algn === "just" || algn === "dist"
            ? "justify"
            : null;
    const marL = env.len(Number(firstAttr(chainP, "marL") ?? 0) || 0);
    const indent = env.len(Number(firstAttr(chainP, "indent") ?? 0) || 0);
    const lnSpc = firstChild(chainP, "a:lnSpc");
    let lineHeight: string | null = null;
    const pctEl = child(lnSpc, "a:spcPct");
    const ptsEl = child(lnSpc, "a:spcPts");
    if (pctEl !== undefined) {
      const v = Math.max(0.3, (intAttr(pctEl, "val") ?? 100000) / 100000 - options.lineReduction);
      lineHeight = num(1.2 * v);
    } else if (ptsEl !== undefined) {
      lineHeight = px(env.len(((intAttr(ptsEl, "val") ?? 1200) / 100) * EMU_PER_PT));
    } else if (options.lineReduction > 0) {
      lineHeight = num(1.2 * Math.max(0.3, 1 - options.lineReduction));
    }
    const before = spacingPx(firstChild(chainP, "a:spcBef"), base.sizePx, env);
    const after = spacingPx(firstChild(chainP, "a:spcAft"), base.sizePx, env);
    const rtl = firstAttr(chainP, "rtl") === "1";

    const pStyle = style([
      "margin:0",
      before !== null && before > 0 && index > 0 ? `margin-top:${px(before)}` : null,
      after !== null && after > 0 ? `margin-bottom:${px(after)}` : null,
      align !== null ? `text-align:${align}` : null,
      marL !== 0 ? `padding-left:${px(Math.max(0, marL))}` : null,
      indent !== 0 && bullet !== null ? `text-indent:${px(indent)}` : null,
      indent !== 0 && bullet === null && indent > 0 ? `text-indent:${px(indent)}` : null,
      lineHeight !== null ? `line-height:${lineHeight}` : null,
      options.noWrap ? "white-space:pre" : "white-space:pre-wrap",
      runCss(base, null),
    ]);

    let body = "";
    if (bullet !== null) {
      const buClr = colorOf(firstColorChild(firstChild(chainP, "a:buClr")), env.colors);
      const buSz = intAttr(firstChild(chainP, "a:buSzPct"), "val");
      const width = indent < 0 ? -indent : 0;
      body += `<span style="${style([
        width > 0 ? `display:inline-block;width:${px(width)};text-indent:0` : "margin-right:0.4em",
        buClr !== null ? `color:${css(buClr)}` : null,
        buSz !== undefined && buSz > 0 && buSz <= 400000 ? `font-size:${num(buSz / 1000)}%` : null,
        "font-style:normal;text-decoration:none",
      ])}">${esc(bullet)}</span>`;
    }
    for (const r of runs) {
      if (r.name === "a:br") {
        body += "<br>";
        continue;
      }
      const t = child(r, "a:t")?.text ?? "";
      if (t === "") continue;
      if (t.trim() !== "") hasText = true;
      const rs = runStyle(child(r, "a:rPr"), chainP, chain, env, options);
      const decl = runCss(rs, base);
      body += decl === "" ? esc(t) : `<span style="${decl}">${esc(t)}</span>`;
    }
    if (body === "" || isEmpty) body = body === "" ? "<br>" : body;
    const step = options.paragraphSteps?.get(index);
    const stepAttr = step === undefined ? "" : ` data-step="${step}"`;
    html.push(`<p${rtl ? ' dir="rtl"' : ""}${stepAttr} style="${pStyle}">${body}</p>`);
  });

  return { html: html.join(""), plain: plain.join("\n"), hasText };
}
