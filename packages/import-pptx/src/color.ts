// SPDX-License-Identifier: AGPL-3.0-or-later
// DrawingML colours: theme scheme colours through the colour map, the colour transforms PowerPoint writes most
// (lumMod, lumOff, tint, shade, alpha, satMod), and fills turned into CSS values.
import { attr, child, children, type XmlElement } from "./xml.js";

export interface ColorContext {
  /** Theme colour scheme: dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink as `rrggbb`. */
  scheme: Readonly<Record<string, string>>;
  /** Colour map (bg1 -> lt1, tx1 -> dk1...). */
  map: Readonly<Record<string, string>>;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const DEFAULT_MAP: Record<string, string> = {
  bg1: "lt1",
  tx1: "dk1",
  bg2: "lt2",
  tx2: "dk2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hlink: "hlink",
  folHlink: "folHlink",
};

export const DEFAULT_SCHEME: Record<string, string> = {
  dk1: "000000",
  lt1: "ffffff",
  dk2: "44546a",
  lt2: "e7e6e6",
  accent1: "4472c4",
  accent2: "ed7d31",
  accent3: "a5a5a5",
  accent4: "ffc000",
  accent5: "5b9bd5",
  accent6: "70ad47",
  hlink: "0563c1",
  folHlink: "954f72",
};

const PRESET: Record<string, string> = {
  black: "000000",
  white: "ffffff",
  red: "ff0000",
  green: "008000",
  lime: "00ff00",
  blue: "0000ff",
  yellow: "ffff00",
  orange: "ffa500",
  gray: "808080",
  grey: "808080",
  darkGray: "a9a9a9",
  lightGray: "d3d3d3",
  silver: "c0c0c0",
  navy: "000080",
  purple: "800080",
  teal: "008080",
  maroon: "800000",
  olive: "808000",
  cyan: "00ffff",
  magenta: "ff00ff",
};

export function colorMapOf(el: XmlElement | undefined): Record<string, string> {
  if (el === undefined) return { ...DEFAULT_MAP };
  const map: Record<string, string> = { ...DEFAULT_MAP };
  for (const key of Object.keys(DEFAULT_MAP)) {
    const v = attr(el, key);
    if (v !== undefined && /^[A-Za-z0-9]{1,16}$/.test(v)) map[key] = v;
  }
  return map;
}

export function schemeOf(clrScheme: XmlElement | undefined): Record<string, string> {
  const scheme: Record<string, string> = { ...DEFAULT_SCHEME };
  if (clrScheme === undefined) return scheme;
  for (const key of Object.keys(DEFAULT_SCHEME)) {
    const el = child(clrScheme, `a:${key}`);
    const value = el === undefined ? null : baseColor(el.children[0], null);
    if (value !== null) scheme[key] = hex({ ...value, a: 1 }).slice(1);
  }
  return scheme;
}

function parseHex(v: string | undefined): Rgba | null {
  if (v === undefined || !/^[0-9A-Fa-f]{6}$/.test(v)) return null;
  return {
    r: Number.parseInt(v.slice(0, 2), 16),
    g: Number.parseInt(v.slice(2, 4), 16),
    b: Number.parseInt(v.slice(4, 6), 16),
    a: 1,
  };
}

function pct(el: XmlElement, name = "val"): number | null {
  const v = attr(el, name);
  if (v === undefined || !/^-?\d{1,9}$/.test(v)) return null;
  return Number(v) / 100000;
}

/** The colour of a colour element before transforms (scheme colours resolved through `ctx`). */
function baseColor(
  el: XmlElement | undefined,
  ctx: ColorContext | null,
  phClr?: Rgba,
): Rgba | null {
  if (el === undefined) return null;
  switch (el.name) {
    case "a:srgbClr":
      return parseHex(attr(el, "val"));
    case "a:sysClr":
      return (
        parseHex(attr(el, "lastClr")) ??
        (attr(el, "val") === "window" ? parseHex("ffffff") : parseHex("000000"))
      );
    case "a:prstClr":
      return parseHex(PRESET[attr(el, "val") ?? ""]);
    case "a:scrgbClr": {
      const c = (n: string) => {
        const v = pct(el, n);
        return v === null ? 0 : Math.round(Math.min(1, Math.max(0, v)) * 255);
      };
      return { r: c("r"), g: c("g"), b: c("b"), a: 1 };
    }
    case "a:hslClr": {
      const h = (Number(attr(el, "hue") ?? 0) / 60000) % 360;
      const s = pct(el, "sat") ?? 0;
      const l = pct(el, "lum") ?? 0;
      return { ...hslToRgb(h, s, l), a: 1 };
    }
    case "a:schemeClr": {
      const val = attr(el, "val") ?? "";
      if (val === "phClr") return phClr ?? null;
      if (ctx === null) return null;
      const key = ctx.map[val] ?? val;
      return parseHex(ctx.scheme[key] ?? ctx.scheme[val]);
    }
    default:
      return null;
  }
}

function rgbToHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) * 60;
  else if (max === G) h = ((B - R) / d + 2) * 60;
  else h = ((R - G) / d + 4) * 60;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  s = clamp(s);
  l = clamp(l);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return {
    r: Math.round((rgb[0] + m) * 255),
    g: Math.round((rgb[1] + m) * 255),
    b: Math.round((rgb[2] + m) * 255),
  };
}

/** Resolves a colour element (srgbClr, schemeClr...) with its transforms. */
export function colorOf(el: XmlElement | undefined, ctx: ColorContext, phClr?: Rgba): Rgba | null {
  const base = baseColor(el, ctx, phClr);
  if (base === null || el === undefined) return null;
  let c = { ...base };
  for (const t of el.children) {
    const v = pct(t);
    if (v === null) continue;
    switch (t.name) {
      case "a:alpha":
        c.a = Math.min(1, Math.max(0, v));
        break;
      case "a:lumMod": {
        const hsl = rgbToHsl(c);
        c = { ...hslToRgb(hsl.h, hsl.s, hsl.l * v), a: c.a };
        break;
      }
      case "a:lumOff": {
        const hsl = rgbToHsl(c);
        c = { ...hslToRgb(hsl.h, hsl.s, hsl.l + v), a: c.a };
        break;
      }
      case "a:satMod": {
        const hsl = rgbToHsl(c);
        c = { ...hslToRgb(hsl.h, hsl.s * v, hsl.l), a: c.a };
        break;
      }
      case "a:shade":
        c = { r: Math.round(c.r * v), g: Math.round(c.g * v), b: Math.round(c.b * v), a: c.a };
        break;
      case "a:tint":
        c = {
          r: Math.round(c.r + (255 - c.r) * (1 - v)),
          g: Math.round(c.g + (255 - c.g) * (1 - v)),
          b: Math.round(c.b + (255 - c.b) * (1 - v)),
          a: c.a,
        };
        break;
      default:
        break;
    }
  }
  return {
    r: clampByte(c.r),
    g: clampByte(c.g),
    b: clampByte(c.b),
    a: Math.round(c.a * 1000) / 1000,
  };
}

function clampByte(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

/** First colour element child of a container (solidFill, a:fgClr, a:bgClr, a:gs...). */
export function firstColorChild(container: XmlElement | undefined): XmlElement | undefined {
  return container?.children.find((c) =>
    ["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr", "a:scrgbClr", "a:hslClr"].includes(
      c.name,
    ),
  );
}

export function hex(c: Rgba): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** CSS colour: `#rrggbb`, or `rgba()` when translucent. */
export function css(c: Rgba): string {
  return c.a >= 1 ? hex(c) : `rgba(${c.r},${c.g},${c.b},${c.a})`;
}

/** A fill element (`a:solidFill`, `a:gradFill`, `a:noFill`, `a:pattFill`, `a:blipFill`) as a parsed value. */
export type Fill =
  | { kind: "none" }
  | { kind: "solid"; color: Rgba }
  | { kind: "gradient"; css: string; first: Rgba }
  | { kind: "pattern"; color: Rgba }
  | { kind: "picture"; blip: XmlElement };

export const FILL_NAMES = [
  "a:noFill",
  "a:solidFill",
  "a:gradFill",
  "a:pattFill",
  "a:blipFill",
  "a:grpFill",
];

export function fillElement(container: XmlElement | undefined): XmlElement | undefined {
  return container?.children.find((c) => FILL_NAMES.includes(c.name));
}

export function parseFill(
  el: XmlElement | undefined,
  ctx: ColorContext,
  phClr?: Rgba,
): Fill | null {
  if (el === undefined) return null;
  switch (el.name) {
    case "a:noFill":
      return { kind: "none" };
    case "a:solidFill": {
      const c = colorOf(firstColorChild(el), ctx, phClr);
      return c === null ? null : { kind: "solid", color: c };
    }
    case "a:gradFill": {
      const stops = children(child(el, "a:gsLst"), "a:gs")
        .map((gs) => ({
          pos: Math.min(100, Math.max(0, Number(attr(gs, "pos") ?? 0) / 1000)),
          color: colorOf(firstColorChild(gs), ctx, phClr),
        }))
        .filter(
          (s): s is { pos: number; color: Rgba } => s.color !== null && Number.isFinite(s.pos),
        )
        .sort((a, b) => a.pos - b.pos)
        .slice(0, 16);
      const first = stops[0];
      if (first === undefined) return null;
      if (stops.length === 1) return { kind: "solid", color: first.color };
      const list = stops.map((s) => `${css(s.color)} ${Math.round(s.pos * 100) / 100}%`).join(",");
      const lin = child(el, "a:lin");
      if (child(el, "a:path") !== undefined && lin === undefined) {
        return { kind: "gradient", css: `radial-gradient(circle,${list})`, first: first.color };
      }
      const ang = Number(attr(lin, "ang") ?? 0) / 60000;
      const deg = Math.round(((Number.isFinite(ang) ? ang : 0) + 90) % 360);
      return { kind: "gradient", css: `linear-gradient(${deg}deg,${list})`, first: first.color };
    }
    case "a:pattFill": {
      const c = colorOf(firstColorChild(child(el, "a:fgClr")), ctx, phClr);
      return c === null ? null : { kind: "pattern", color: c };
    }
    case "a:blipFill":
      return { kind: "picture", blip: el };
    default:
      return null;
  }
}
