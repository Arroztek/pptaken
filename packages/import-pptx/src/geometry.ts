// SPDX-License-Identifier: AGPL-3.0-or-later
// Shape geometry: which preset shapes render as a styled box (rect, rounded rect, ellipse), a small set of preset
// polygons drawn as SVG paths, and custom geometry paths. Anything else falls back to a rectangle (reported).
import { attr, child, children, type XmlElement } from "./xml.js";

export type BoxKind = "rect" | "roundRect" | "ellipse";

const BOX_ALIASES: Record<string, BoxKind> = {
  rect: "rect",
  flowChartProcess: "rect",
  flowChartPredefinedProcess: "rect",
  flowChartInternalStorage: "rect",
  snip1Rect: "rect",
  snip2SameRect: "rect",
  round1Rect: "roundRect",
  round2SameRect: "roundRect",
  roundRect: "roundRect",
  flowChartAlternateProcess: "roundRect",
  flowChartTerminator: "roundRect",
  ellipse: "ellipse",
  flowChartConnector: "ellipse",
  donut: "ellipse",
};

export const LINE_PRESETS = new Set([
  "line",
  "straightConnector1",
  "bentConnector2",
  "bentConnector3",
  "bentConnector4",
  "bentConnector5",
  "curvedConnector2",
  "curvedConnector3",
  "curvedConnector4",
  "curvedConnector5",
]);

export function boxKind(prst: string): BoxKind | null {
  return BOX_ALIASES[prst] ?? null;
}

/** Adjust value `name` of a preset (`<a:gd name="adj" fmla="val 25000"/>`), or the default. */
export function adjust(prstGeom: XmlElement | undefined, name: string, fallback: number): number {
  for (const gd of children(child(prstGeom, "a:avLst"), "a:gd")) {
    if (attr(gd, "name") !== name) continue;
    const m = /^val\s+(-?\d{1,9})$/.exec(attr(gd, "fmla") ?? "");
    if (m !== null) return Number(m[1]);
  }
  return fallback;
}

type Pt = [number, number];

function poly(points: Pt[]): string {
  return `${points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${r(x)} ${r(y)}`).join(" ")} Z`;
}

function r(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** SVG path data of a supported preset polygon in a `w`×`h` box, or null when the preset is not supported. */
export function presetPath(
  prst: string,
  w: number,
  h: number,
  geom: XmlElement | undefined,
): string | null {
  const ss = Math.min(w, h);
  const a = (name: string, d: number) => adjust(geom, name, d) / 100000;
  switch (prst) {
    case "triangle":
    case "flowChartExtract":
      return poly([
        [w * a("adj", 50000), 0],
        [w, h],
        [0, h],
      ]);
    case "rtTriangle":
      return poly([
        [0, 0],
        [w, h],
        [0, h],
      ]);
    case "diamond":
    case "flowChartDecision":
      return poly([
        [w / 2, 0],
        [w, h / 2],
        [w / 2, h],
        [0, h / 2],
      ]);
    case "parallelogram":
    case "flowChartInputOutput": {
      const x = Math.min(w, ss * a("adj", 25000));
      return poly([
        [x, 0],
        [w, 0],
        [w - x, h],
        [0, h],
      ]);
    }
    case "trapezoid": {
      const x = Math.min(w / 2, ss * a("adj", 25000));
      return poly([
        [0, h],
        [x, 0],
        [w - x, 0],
        [w, h],
      ]);
    }
    case "hexagon": {
      const x = Math.min(w / 2, ss * a("adj", 25000));
      return poly([
        [0, h / 2],
        [x, 0],
        [w - x, 0],
        [w, h / 2],
        [w - x, h],
        [x, h],
      ]);
    }
    case "octagon": {
      const x = Math.min(w / 2, h / 2, ss * a("adj", 29289));
      return poly([
        [x, 0],
        [w - x, 0],
        [w, x],
        [w, h - x],
        [w - x, h],
        [x, h],
        [0, h - x],
        [0, x],
      ]);
    }
    case "pentagon":
      return poly([
        [w / 2, 0],
        [w, h * 0.382],
        [w * 0.809, h],
        [w * 0.191, h],
        [0, h * 0.382],
      ]);
    case "homePlate": {
      const x = Math.min(w, ss * a("adj", 50000));
      return poly([
        [0, 0],
        [w - x, 0],
        [w, h / 2],
        [w - x, h],
        [0, h],
      ]);
    }
    case "chevron": {
      const x = Math.min(w / 2, ss * a("adj", 50000));
      return poly([
        [0, 0],
        [w - x, 0],
        [w, h / 2],
        [w - x, h],
        [0, h],
        [x, h / 2],
      ]);
    }
    case "plus": {
      const x = Math.min(w / 2, h / 2, ss * a("adj", 25000));
      return poly([
        [x, 0],
        [w - x, 0],
        [w - x, x],
        [w, x],
        [w, h - x],
        [w - x, h - x],
        [w - x, h],
        [x, h],
        [x, h - x],
        [0, h - x],
        [0, x],
        [x, x],
      ]);
    }
    case "rightArrow":
    case "leftArrow": {
      const t = h * a("adj1", 50000);
      const head = Math.min(w, ss * a("adj2", 50000));
      const y1 = (h - t) / 2;
      const y2 = (h + t) / 2;
      const pts: Pt[] = [
        [0, y1],
        [w - head, y1],
        [w - head, 0],
        [w, h / 2],
        [w - head, h],
        [w - head, y2],
        [0, y2],
      ];
      return poly(prst === "leftArrow" ? pts.map(([x, y]) => [w - x, y]) : pts);
    }
    case "upArrow":
    case "downArrow": {
      const t = w * a("adj1", 50000);
      const head = Math.min(h, ss * a("adj2", 50000));
      const x1 = (w - t) / 2;
      const x2 = (w + t) / 2;
      const pts: Pt[] = [
        [x1, h],
        [x1, head],
        [0, head],
        [w / 2, 0],
        [w, head],
        [x2, head],
        [x2, h],
      ];
      return poly(prst === "downArrow" ? pts.map(([x, y]) => [x, h - y]) : pts);
    }
    case "star5": {
      const pts: Pt[] = [];
      for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const radius = i % 2 === 0 ? 0.5 : 0.19;
        pts.push([
          w / 2 + w * radius * Math.cos(angle),
          h / 2 + h * radius * Math.sin(angle) * 1.05,
        ]);
      }
      return poly(pts);
    }
    default:
      return null;
  }
}

/**
 * SVG path data of a custom geometry (`a:custGeom`) scaled to `w`×`h`, or null if it uses formulas instead of
 * literal coordinates (rare; the shape then falls back to a rectangle).
 */
export function customPath(custGeom: XmlElement, w: number, h: number): string | null {
  const parts: string[] = [];
  let commands = 0;
  for (const path of children(child(custGeom, "a:pathLst"), "a:path")) {
    const pw = Number(attr(path, "w") ?? 0);
    const ph = Number(attr(path, "h") ?? 0);
    const sx = pw > 0 ? w / pw : 1;
    const sy = ph > 0 ? h / ph : 1;
    let cur: Pt = [0, 0];
    const pt = (el: XmlElement | undefined): Pt | null => {
      const x = attr(el, "x");
      const y = attr(el, "y");
      if (
        x === undefined ||
        y === undefined ||
        !/^-?\d{1,12}$/.test(x) ||
        !/^-?\d{1,12}$/.test(y)
      ) {
        return null;
      }
      return [Number(x) * sx, Number(y) * sy];
    };
    for (const cmd of path.children) {
      if (++commands > 5000) return null;
      const pts = children(cmd, "a:pt").map(pt);
      if (pts.some((p) => p === null)) return null;
      const p = pts as Pt[];
      switch (cmd.name) {
        case "a:moveTo":
          if (p[0] === undefined) return null;
          cur = p[0];
          parts.push(`M${r(cur[0])} ${r(cur[1])}`);
          break;
        case "a:lnTo":
          if (p[0] === undefined) return null;
          cur = p[0];
          parts.push(`L${r(cur[0])} ${r(cur[1])}`);
          break;
        case "a:cubicBezTo":
          if (p.length < 3) return null;
          cur = p[2] as Pt;
          parts.push(`C${p.map(([x, y]) => `${r(x)} ${r(y)}`).join(" ")}`);
          break;
        case "a:quadBezTo":
          if (p.length < 2) return null;
          cur = p[1] as Pt;
          parts.push(`Q${p.map(([x, y]) => `${r(x)} ${r(y)}`).join(" ")}`);
          break;
        case "a:arcTo": {
          const num = (name: string) => {
            const v = attr(cmd, name);
            return v !== undefined && /^-?\d{1,12}$/.test(v) ? Number(v) : null;
          };
          const wR = num("wR");
          const hR = num("hR");
          const st = num("stAng");
          const sw = num("swAng");
          if (wR === null || hR === null || st === null || sw === null) return null;
          const rx = wR * sx;
          const ry = hR * sy;
          const s = ((st / 60000) * Math.PI) / 180;
          const e = (((st + sw) / 60000) * Math.PI) / 180;
          const cx = cur[0] - rx * Math.cos(s);
          const cy = cur[1] - ry * Math.sin(s);
          const end: Pt = [cx + rx * Math.cos(e), cy + ry * Math.sin(e)];
          const large = Math.abs(sw / 60000) > 180 ? 1 : 0;
          const sweep = sw > 0 ? 1 : 0;
          parts.push(`A${r(rx)} ${r(ry)} 0 ${large} ${sweep} ${r(end[0])} ${r(end[1])}`);
          cur = end;
          break;
        }
        case "a:close":
          parts.push("Z");
          break;
        default:
          break;
      }
    }
  }
  return parts.length === 0 ? null : parts.join(" ");
}
