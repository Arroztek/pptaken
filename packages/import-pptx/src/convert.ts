// SPDX-License-Identifier: AGPL-3.0-or-later
// The converter: a .pptx package in, a pptaken.deck envelope plus images and warnings out. Pure (no I/O besides
// reading the bytes it is given), deterministic, and bounded by the limits in `types.ts`.
//
// Fidelity promise: "recognizable and editable", not pixel-faithful. Shapes keep their absolute positions on the
// canvas; text keeps its runs, sizes, colours, alignment and bullets; fonts map to the bundled catalog. What does
// not convert produces a warning naming the slide and the feature, never a failure.
import { sha256Hex, sniffImage } from "@pptaken/core";
import {
  ASPECT_RATIOS,
  type AspectRatio,
  type DeckInput,
  type FontName,
  LIMITS,
} from "@pptaken/schema";
import {
  type ColorContext,
  colorMapOf,
  colorOf,
  css,
  type Fill,
  fillElement,
  firstColorChild,
  parseFill,
  type Rgba,
  schemeOf,
} from "./color.js";
import { PptxError } from "./errors.js";
import { type FontChoice, fontFamilyCss, mapFont } from "./fonts.js";
import { boxKind, customPath, LINE_PRESETS, presetPath } from "./geometry.js";
import { clipText, esc, escapeMarkdown, num, px, style } from "./html.js";
import { PptxPackage, relKind } from "./package.js";
import {
  type BodyOptions,
  EMU_PER_PT,
  paragraphText,
  renderParagraphs,
  type StyleChain,
  type TextEnv,
} from "./text.js";
import {
  type ConvertOptions,
  DEFAULT_PPTX_LIMITS,
  type PptxAsset,
  type PptxConversion,
  type PptxLimits,
  type PptxWarning,
  type PptxWarningCode,
} from "./types.js";
import {
  attr,
  boolAttr,
  child,
  children,
  find,
  findAll,
  intAttr,
  path,
  resolveAlternates,
  type XmlElement,
} from "./xml.js";

// ---------------------------------------------------------------------------------------------------------------
// Detection

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function utf16Contains(bytes: Uint8Array, text: string): boolean {
  const needle = Buffer.from(text, "utf16le");
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(needle) >= 0;
}

/** Refuses what is not a ZIP-based presentation, with a precise reason for the common cases. */
function detect(bytes: Uint8Array): void {
  if (bytes.length >= 8 && CFB_MAGIC.every((b, i) => bytes[i] === b)) {
    if (utf16Contains(bytes, "EncryptedPackage") || utf16Contains(bytes, "EncryptionInfo")) {
      throw new PptxError(
        "ENCRYPTED",
        "This presentation is protected with a password",
        "Open it in PowerPoint, remove the password (File > Info > Protect Presentation) and save it again.",
      );
    }
    if (utf16Contains(bytes, "PowerPoint Document")) {
      throw new PptxError(
        "LEGACY_PPT",
        "This is a PowerPoint 97-2003 (.ppt) file, which cannot be imported",
        "Open it in PowerPoint (or LibreOffice Impress) and save it as .pptx, then import that file.",
      );
    }
    throw new PptxError("NOT_PPTX", "This is an older Office file, not a .pptx presentation");
  }
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    throw new PptxError("NOT_PPTX", "This file is not a .pptx presentation");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Messages

const FEATURE_TEXT: Record<string, string> = {
  transition: "the slide transition is not kept",
  animation: "motion, emphasis, exit and timed animations are not kept",
  "animation-steps": "entrance animations became click steps (effects and timing are not kept)",
  chart: "charts are not imported; an empty box marks where they were",
  smartart: "SmartArt is not imported; an empty box marks where it was",
  ole: "an embedded object is not imported; an empty box marks where it was",
  "ole-picture": "an embedded object is shown as its picture only",
  "embedded-object": "an embedded object is not imported; an empty box marks where it was",
  video: "video is not imported (its poster frame is kept as a picture)",
  audio: "audio is not imported",
  ink: "ink drawings are not imported",
  "3d": "3D effects are not imported",
  wordart: "WordArt and text effects are shown as plain coloured text",
  links: "links are kept as plain text",
  effects: "glow, reflection and soft-edge effects are not kept",
  pattern: "pattern fills are shown as a solid colour",
  "gradient-shape": "gradient fills of drawn shapes are shown as a solid colour",
  connectors: "bent and curved connectors are drawn as straight lines",
  "group-rotation": "rotated groups are shown without rotation",
  "table-style": "table style colours are approximated",
  "table-size": "a very large table was cut",
  hidden: "this slide is hidden in PowerPoint; it is shown here",
  "nested-groups": "deeply nested groups were cut",
  "too-many-shapes": "the slide has too many shapes; the rest were left out",
  "slide-size": "the slide content was too large for one slide; the rest was left out",
  "picture-crop": "a picture fill's crop is approximated",
  "vertical-text": "vertical text is approximated",
};

function featureLabel(feature: string): string {
  if (feature.startsWith("shape:")) {
    return `the shape "${feature.slice(6)}" is drawn as a rectangle`;
  }
  return FEATURE_TEXT[feature] ?? `${feature} is not imported`;
}

// ---------------------------------------------------------------------------------------------------------------
// Converter

interface Transform {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { sx: 1, sy: 1, tx: 0, ty: 0 };

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

interface ThemeInfo {
  scheme: Record<string, string>;
  majorFont: string;
  minorFont: string;
  fillStyles: XmlElement[];
  lineStyles: XmlElement[];
  bgFillStyles: XmlElement[];
}

interface Layer {
  part: string;
  root: XmlElement;
}

interface Placeholder {
  type: string | undefined;
  idx: string | undefined;
}

interface SteppedShapes {
  shapes: Map<string, number>;
  paragraphs: Map<string, Map<number, number>>;
}

interface SlideState {
  number: number;
  slide: Layer;
  layout: Layer | null;
  master: Layer | null;
  theme: ThemeInfo;
  colors: ColorContext;
  steps: SteppedShapes;
  out: string[];
  size: number;
  shapes: number;
  stopped: boolean;
  ids: number;
}

type ImageResult = { sha256: string } | { failed: string };

const PLACEHOLDER_STYLE =
  "background:repeating-linear-gradient(45deg,#ececec 0 14px,#f6f6f6 14px 28px);border:2px dashed #b5b5b5;box-sizing:border-box";

const EMF_SIG = [0x01, 0x00, 0x00, 0x00];

function describeUnsupportedImage(bytes: Uint8Array, name: string): string {
  const lower = name.toLowerCase();
  if (
    bytes.length > 44 &&
    EMF_SIG.every((b, i) => bytes[i] === b) &&
    bytes[40] === 0x20 &&
    bytes[41] === 0x45
  ) {
    return "EMF";
  }
  if (bytes[0] === 0xd7 && bytes[1] === 0xcd && bytes[2] === 0xc6 && bytes[3] === 0x9a)
    return "WMF";
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) {
    if (lower.endsWith(".tif") || lower.endsWith(".tiff") || bytes[2] === 0x2a || bytes[3] === 0x2a)
      return "TIFF";
  }
  if (lower.endsWith(".svg")) return "SVG";
  if (lower.endsWith(".emf")) return "EMF";
  if (lower.endsWith(".wmf")) return "WMF";
  return "an unsupported format";
}

class Converter {
  private readonly pkg: PptxPackage;
  private readonly warnings = new Map<string, PptxWarning>();
  private readonly assets = new Map<string, PptxAsset>();
  private readonly imageCache = new Map<string, ImageResult>();
  private assetBytes = 0;
  private readonly fontUse = new Map<FontName, number>();
  private readonly substitutions = new Map<string, FontName>();
  private readonly langs = new Map<string, number>();
  private readonly themes = new Map<string, ThemeInfo>();
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private presentation!: XmlElement;
  private presentationPart = "ppt/presentation.xml";
  private defaultStyle: XmlElement | undefined;
  private current: SlideState | null = null;

  constructor(
    bytes: Uint8Array,
    private readonly limits: PptxLimits,
  ) {
    this.pkg = new PptxPackage(bytes, limits);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Warnings

  private warn(code: PptxWarningCode, feature: string, message: string, slide?: number): void {
    const key = `${code}|${feature}|${slide ?? ""}`;
    if (this.warnings.has(key)) return;
    const w: PptxWarning = { code, message, feature };
    if (slide !== undefined) w.slide = slide;
    this.warnings.set(key, w);
  }

  private slideWarn(code: PptxWarningCode, feature: string, detail?: string): void {
    const n = this.current?.number;
    const text = detail ?? featureLabel(feature);
    this.warn(code, feature, n === undefined ? capitalize(text) : `Slide ${n}: ${text}`, n);
  }

  private dropped(feature: string): void {
    this.slideWarn("PPTX_FEATURE_DROPPED", feature);
  }

  private simplified(feature: string): void {
    this.slideWarn("PPTX_FEATURE_SIMPLIFIED", feature);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Entry

  run(): PptxConversion {
    const presPart = this.locatePresentation();
    this.presentationPart = presPart;
    const pres = this.pkg.xml(presPart);
    if (pres === null || pres.name !== "p:presentation") {
      throw new PptxError("NOT_PPTX", "This file is not a PowerPoint presentation");
    }
    this.presentation = pres;
    this.defaultStyle = child(pres, "p:defaultTextStyle");
    this.packageWarnings();

    const aspect = this.canvas(pres);
    const sections = this.sections(pres);
    const slideRefs = children(child(pres, "p:sldIdLst"), "p:sldId");
    if (slideRefs.length === 0) {
      throw new PptxError("INVALID_FILE", "The presentation has no slides");
    }
    if (slideRefs.length > this.limits.maxSlides) {
      throw new PptxError(
        "TOO_LARGE",
        `The presentation has ${slideRefs.length} slides; the limit is ${this.limits.maxSlides}`,
        "Split it into several presentations in PowerPoint and import each one.",
      );
    }

    const slides: DeckInput["slides"] = [];
    slideRefs.forEach((ref, i) => {
      const rel = this.pkg.rel(presPart, attr(ref, "r:id"));
      if (rel === undefined || rel.target === null || relKind(rel.type) !== "slide") {
        this.warn(
          "PPTX_FEATURE_DROPPED",
          "missing-slide",
          `Slide ${i + 1} is missing from the file`,
          i + 1,
        );
        return;
      }
      const slide = this.convertSlide(rel.target, i + 1, sections.get(attr(ref, "id") ?? ""));
      if (slide !== null) slides.push(slide);
    });
    if (slides.length === 0) throw new PptxError("INVALID_FILE", "No slide could be read");

    // Fonts: the theme lists at most 4; rarer ones are folded into the most used font.
    const ranked = [...this.fontUse.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
    const kept = ranked.slice(0, LIMITS.maxThemeFonts);
    const fallback = kept[0] ?? "Inter";
    const folded = ranked.slice(LIMITS.maxThemeFonts);
    if (folded.length > 0) {
      for (const slide of slides) {
        for (const f of folded) {
          slide.html = slide.html.split(fontFamilyCss(f)).join(fontFamilyCss(fallback));
        }
      }
    }
    for (const [source, font] of this.substitutions) {
      const shown = folded.includes(font) ? fallback : font;
      this.warn(
        "PPTX_FONT_REPLACED",
        `font:${source}`,
        `The font "${clipText(source, 60)}" was replaced by ${shown}; line breaks may differ and text may be cut at the edge of its box`,
      );
    }

    const deck: DeckInput = {
      schemaVersion: 1,
      title: this.deckTitle(slides),
      aspectRatio: aspect,
      slides,
    };
    if (kept.length > 0) deck.theme = { fonts: kept };
    const lang = this.deckLang();
    if (lang !== undefined) deck.lang = lang;

    return {
      deck,
      assets: [...this.assets.values()],
      warnings: [...this.warnings.values()].sort((a, b) => (a.slide ?? 0) - (b.slide ?? 0)),
    };
  }

  private locatePresentation(): string {
    const rels = this.pkg.rels("");
    const office = rels.find((r) => relKind(r.type) === "officeDocument" && !r.external);
    const target = office?.target ?? null;
    if (target === null || !this.pkg.has(target)) {
      throw new PptxError(
        "NOT_PPTX",
        rels.length === 0
          ? "This file is not a .pptx presentation"
          : "This is an Office file but not a PowerPoint presentation",
      );
    }
    const types = this.pkg.xml("[Content_Types].xml");
    const override = children(types ?? undefined, "ct:Override").find(
      (o) => (attr(o, "PartName") ?? "").replace(/^\//, "") === target,
    );
    const contentType = (attr(override, "ContentType") ?? "").toLowerCase();
    if (contentType !== "" && !/presentationml|ms-powerpoint/.test(contentType)) {
      throw new PptxError("NOT_PPTX", "This is an Office file but not a PowerPoint presentation");
    }
    if (contentType.includes("macroenabled")) {
      this.warn("PPTX_FEATURE_DROPPED", "macros", "Macros were removed (they are never imported)");
    }
    return target;
  }

  private packageWarnings(): void {
    const skipped = this.pkg.skippedParts;
    const any = (re: RegExp) => skipped.some((n) => re.test(n));
    if (any(/(^|\/)vbaProject\.bin$/i)) {
      this.warn("PPTX_FEATURE_DROPPED", "macros", "Macros were removed (they are never imported)");
    }
    if (any(/^ppt\/activeX\//i)) {
      this.warn("PPTX_FEATURE_DROPPED", "activex", "ActiveX controls are not imported");
    }
    if (any(/^ppt\/fonts\//i)) {
      this.warn(
        "PPTX_FEATURE_DROPPED",
        "embedded-fonts",
        "Embedded fonts are not imported; bundled fonts are used instead",
      );
    }
    if (any(/^ppt\/(comments\/|comments\d*\.xml$|commentAuthors\.xml$)/i)) {
      this.warn("PPTX_FEATURE_DROPPED", "comments", "Comments are not imported");
    }
  }

  private canvas(pres: XmlElement): AspectRatio {
    const sz = child(pres, "p:sldSz");
    let cx = intAttr(sz, "cx", 12192000);
    let cy = intAttr(sz, "cy", 6858000);
    const MIN = 914400;
    const MAX = 51206400;
    if (cx < MIN || cx > MAX || cy < MIN || cy > MAX) {
      cx = 12192000;
      cy = 6858000;
      this.warn(
        "PPTX_CANVAS_ADJUSTED",
        "slide-size",
        "The slide size is out of range; 16:9 was used",
      );
    }
    const ratio = cx / cy;
    const options: AspectRatio[] = ["16:9", "4:3"];
    const aspect = options.reduce((best, a) => {
      const { width, height } = ASPECT_RATIOS[a];
      const { width: bw, height: bh } = ASPECT_RATIOS[best];
      return Math.abs(Math.log(ratio / (width / height))) < Math.abs(Math.log(ratio / (bw / bh)))
        ? a
        : best;
    }, "16:9" as AspectRatio);
    const { width, height } = ASPECT_RATIOS[aspect];
    this.scale = Math.min(width / cx, height / cy);
    this.offsetX = (width - cx * this.scale) / 2;
    this.offsetY = (height - cy * this.scale) / 2;
    if (Math.abs(ratio / (width / height) - 1) > 0.02) {
      this.warn(
        "PPTX_CANVAS_ADJUSTED",
        "slide-size",
        `The slides are not 16:9 or 4:3; they were fitted into ${aspect} with margins`,
      );
    }
    return aspect;
  }

  private sections(pres: XmlElement): Map<string, string> {
    const out = new Map<string, string>();
    const list = findAll(child(pres, "p:extLst"), "p14:section");
    for (const section of list) {
      const name = clipText(attr(section, "name") ?? "", LIMITS.maxSectionLength);
      for (const id of findAll(section, "p14:sldId")) {
        const v = attr(id, "id");
        if (v !== undefined && name !== "") out.set(v, name);
      }
    }
    return out;
  }

  private deckTitle(slides: DeckInput["slides"]): string {
    const core = this.pkg.xml("docProps/core.xml");
    const fromCore = clipText(
      child(core ?? undefined, "dc:title")?.text ?? "",
      LIMITS.maxTitleLength,
    );
    if (fromCore !== "") return fromCore;
    const first = slides.find((s) => (s.title ?? "").trim() !== "");
    return first?.title ? clipText(first.title, LIMITS.maxTitleLength) : "Imported presentation";
  }

  private deckLang(): string | undefined {
    let best: string | undefined;
    let count = 0;
    for (const [lang, n] of this.langs) {
      if (n > count) {
        best = lang;
        count = n;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Theme and layers

  private themeOf(masterPart: string | null): ThemeInfo {
    const fallback: ThemeInfo = {
      scheme: schemeOf(undefined),
      majorFont: "Calibri",
      minorFont: "Calibri",
      fillStyles: [],
      lineStyles: [],
      bgFillStyles: [],
    };
    if (masterPart === null) return fallback;
    const cached = this.themes.get(masterPart);
    if (cached !== undefined) return cached;
    const rel = this.pkg.relOfKind(masterPart, "theme");
    const theme = rel?.target ? this.pkg.xml(rel.target) : null;
    const elements = child(theme ?? undefined, "a:themeElements");
    const fonts = child(elements, "a:fontScheme");
    const fmt = child(elements, "a:fmtScheme");
    const info: ThemeInfo = {
      scheme: schemeOf(child(elements, "a:clrScheme")),
      majorFont: attr(path(fonts, "a:majorFont", "a:latin"), "typeface") || "Calibri",
      minorFont: attr(path(fonts, "a:minorFont", "a:latin"), "typeface") || "Calibri",
      fillStyles: [...(child(fmt, "a:fillStyleLst")?.children ?? [])],
      lineStyles: children(child(fmt, "a:lnStyleLst"), "a:ln"),
      bgFillStyles: [...(child(fmt, "a:bgFillStyleLst")?.children ?? [])],
    };
    this.themes.set(masterPart, info);
    return info;
  }

  private layer(part: string | null | undefined): Layer | null {
    if (part === null || part === undefined) return null;
    const root = this.pkg.xml(part);
    return root === null ? null : { part, root };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Slides

  private convertSlide(
    part: string,
    number: number,
    section: string | undefined,
  ): DeckInput["slides"][number] | null {
    const slide = this.layer(part);
    if (slide === null || slide.root.name !== "p:sld") {
      this.warn(
        "PPTX_FEATURE_DROPPED",
        "missing-slide",
        `Slide ${number} could not be read`,
        number,
      );
      return null;
    }
    const layout = this.layer(this.pkg.relOfKind(part, "slideLayout")?.target);
    const master =
      layout === null ? null : this.layer(this.pkg.relOfKind(layout.part, "slideMaster")?.target);
    const theme = this.themeOf(master?.part ?? null);

    // Colour map: master map, overridden by the layout or slide (`a:overrideClrMapping`).
    let map = colorMapOf(child(master?.root, "p:clrMap"));
    for (const l of [layout, slide]) {
      const ovr = path(l?.root, "p:clrMapOvr", "a:overrideClrMapping");
      if (ovr !== undefined) map = colorMapOf(ovr);
    }
    const state: SlideState = {
      number,
      slide,
      layout,
      master,
      theme,
      colors: { scheme: theme.scheme, map },
      steps: { shapes: new Map(), paragraphs: new Map() },
      out: [],
      size: 0,
      shapes: 0,
      stopped: false,
      ids: 0,
    };
    this.current = state;

    if (attr(slide.root, "show") === "0") this.simplified("hidden");
    const top = resolveAlternates(slide.root.children);
    if (top.some((c) => c.name === "p:transition")) this.dropped("transition");
    const timing = child(slide.root, "p:timing");
    if (timing !== undefined) state.steps = this.steps(timing);

    // Shapes: master (unless hidden), layout (unless hidden), then the slide's own.
    const showMaster = boolAttr(slide.root, "showMasterSp") !== false;
    const layoutShowsMaster = boolAttr(layout?.root, "showMasterSp") !== false;
    if (showMaster && layoutShowsMaster && master !== null) this.drawTree(master, false);
    if (showMaster && layout !== null) this.drawTree(layout, false);
    this.drawTree(slide, true);

    const title = this.slideTitle(slide);
    const notes = this.notes(part);
    const background = this.background(state);

    const result: DeckInput["slides"][number] = {
      id: `slide-${number}`,
      title: clipText(title, LIMITS.maxTitleLength),
      html: state.out.join(""),
    };
    if (background !== null) result.css = `:root{background:${background}}`;
    if (notes !== "") result.notes = notes;
    if (section !== undefined) result.section = section;
    this.current = null;
    return result;
  }

  private slideTitle(slide: Layer): string {
    for (const sp of findAll(path(slide.root, "p:cSld", "p:spTree"), "p:sp")) {
      const ph = this.placeholderOf(sp);
      if (ph !== null && (ph.type === "title" || ph.type === "ctrTitle")) {
        const text = children(child(sp, "p:txBody"), "a:p").map(paragraphText).join(" ");
        if (text.trim() !== "") return text;
      }
    }
    return "";
  }

  private notes(slidePart: string): string {
    const rel = this.pkg.relOfKind(slidePart, "notesSlide");
    if (rel?.target === null || rel === undefined) return "";
    const notes = this.pkg.xml(rel.target);
    if (notes === null) return "";
    const lines: string[] = [];
    for (const sp of findAll(path(notes, "p:cSld", "p:spTree"), "p:sp")) {
      const ph = this.placeholderOf(sp);
      if (ph === null || ph.type !== "body") continue;
      for (const p of children(child(sp, "p:txBody"), "a:p")) {
        const text = paragraphText(p).replace(/\r/g, "");
        lines.push(text.split("\n").map(escapeMarkdown).join("  \n"));
      }
    }
    let md = lines
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (md.length > LIMITS.maxNotes) {
      md = md
        .slice(0, LIMITS.maxNotes - 2)
        .replace(/\\$/, "")
        .trimEnd();
      md = `${md}…`;
      this.warn(
        "PPTX_CONTENT_TRUNCATED",
        "notes",
        `Slide ${this.current?.number ?? "?"}: the speaker notes were cut to ${LIMITS.maxNotes / 1024} KB`,
        this.current?.number,
      );
    }
    return md;
  }

  private steps(timing: XmlElement): SteppedShapes {
    const out: SteppedShapes = { shapes: new Map(), paragraphs: new Map() };
    const ctns = findAll(timing, "p:cTn");
    const main = ctns.find((c) => attr(c, "nodeType") === "mainSeq");
    let entrances = false;
    if (main === undefined) {
      if (ctns.some((c) => attr(c, "presetClass") !== undefined)) this.dropped("animation");
      return out;
    }
    // Effects outside the main click sequence (triggers, interactive sequences) are not kept.
    const inMain = new Set(findAll(main, "p:cTn"));
    let others = ctns.some((c) => attr(c, "presetClass") !== undefined && !inMain.has(c));
    const clicks = children(child(main, "p:childTnLst"), "p:par");
    clicks.forEach((par, i) => {
      const step = Math.min(99, i + 1);
      for (const ctn of findAll(par, "p:cTn")) {
        const cls = attr(ctn, "presetClass");
        if (cls === undefined) continue;
        if (cls !== "entr") {
          others = true;
          continue;
        }
        const target = find(ctn, "p:spTgt");
        const spid = attr(target, "spid");
        if (spid === undefined) continue;
        entrances = true;
        const range = find(target, "p:pRg");
        if (range !== undefined) {
          const st = Math.max(0, intAttr(range, "st", 0));
          const end = Math.min(st + 500, Math.max(st, intAttr(range, "end", st)));
          let map = out.paragraphs.get(spid);
          if (map === undefined) {
            map = new Map();
            out.paragraphs.set(spid, map);
          }
          for (let p = st; p <= end; p++) if (!map.has(p)) map.set(p, step);
        } else if (!out.shapes.has(spid)) {
          out.shapes.set(spid, step);
        }
      }
    });
    if (entrances) this.simplified("animation-steps");
    if (others) this.dropped("animation");
    return out;
  }

  private background(state: SlideState): string | null {
    for (const l of [state.slide, state.layout, state.master]) {
      if (l === null) continue;
      const bg = path(l.root, "p:cSld", "p:bg");
      if (bg === undefined) continue;
      const bgPr = child(bg, "p:bgPr");
      let fill: Fill | null = null;
      if (bgPr !== undefined) {
        fill = parseFill(fillElement(bgPr), state.colors);
      } else {
        const ref = child(bg, "p:bgRef");
        const idx = intAttr(ref, "idx", 0);
        const ph = colorOf(firstColorChild(ref), state.colors) ?? undefined;
        const styleEl =
          idx >= 1001
            ? state.theme.bgFillStyles[idx - 1001]
            : idx > 0
              ? state.theme.fillStyles[idx - 1]
              : undefined;
        fill = parseFill(styleEl, state.colors, ph);
        if (fill === null && ph !== undefined) fill = { kind: "solid", color: ph };
      }
      if (fill === null) continue;
      switch (fill.kind) {
        case "none":
          return null;
        case "solid":
          return css(fill.color);
        case "pattern":
          this.simplified("pattern");
          return css(fill.color);
        case "gradient":
          return fill.css;
        case "picture": {
          const result = this.imageFromBlip(l.part, fill.blip, "background picture");
          if ("sha256" in result) {
            const stretch = child(fill.blip, "a:tile") === undefined;
            return stretch
              ? `url(asset:${result.sha256}) center/100% 100% no-repeat`
              : `url(asset:${result.sha256}) repeat`;
          }
          return null;
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Shape tree

  private drawTree(layer: Layer, isSlide: boolean): void {
    const tree = path(layer.root, "p:cSld", "p:spTree");
    if (tree === undefined) return;
    this.drawChildren(tree.children, layer, isSlide, IDENTITY, 0, undefined);
  }

  private drawChildren(
    list: readonly XmlElement[],
    layer: Layer,
    isSlide: boolean,
    t: Transform,
    depth: number,
    groupStep: number | undefined,
  ): void {
    for (const el of resolveAlternates(list)) {
      const state = this.current as SlideState;
      if (state.stopped) return;
      switch (el.name) {
        case "p:sp":
        case "p:cxnSp":
          this.drawShape(el, layer, isSlide, t, groupStep);
          break;
        case "p:pic":
          this.drawPicture(el, layer, isSlide, t, groupStep);
          break;
        case "p:graphicFrame":
          if (isSlide || this.placeholderOf(el) === null) this.drawFrame(el, layer, t, groupStep);
          break;
        case "p:grpSp":
          this.drawGroup(el, layer, isSlide, t, depth, groupStep);
          break;
        case "p:contentPart":
          this.dropped("ink");
          break;
        default:
          break;
      }
    }
  }

  private drawGroup(
    el: XmlElement,
    layer: Layer,
    isSlide: boolean,
    t: Transform,
    depth: number,
    groupStep: number | undefined,
  ): void {
    if (depth >= this.limits.maxGroupDepth) {
      this.simplified("nested-groups");
      return;
    }
    const xfrm = path(el, "p:grpSpPr", "a:xfrm");
    let inner = t;
    if (xfrm !== undefined) {
      const off = child(xfrm, "a:off");
      const ext = child(xfrm, "a:ext");
      const chOff = child(xfrm, "a:chOff");
      const chExt = child(xfrm, "a:chExt");
      const cx = intAttr(ext, "cx", 0);
      const cy = intAttr(ext, "cy", 0);
      const ccx = intAttr(chExt, "cx", 0);
      const ccy = intAttr(chExt, "cy", 0);
      const sx = ccx > 0 && cx > 0 ? cx / ccx : 1;
      const sy = ccy > 0 && cy > 0 ? cy / ccy : 1;
      const gx = intAttr(off, "x", 0) - intAttr(chOff, "x", 0) * sx;
      const gy = intAttr(off, "y", 0) - intAttr(chOff, "y", 0) * sy;
      inner = { sx: t.sx * sx, sy: t.sy * sy, tx: t.sx * gx + t.tx, ty: t.sy * gy + t.ty };
      if (intAttr(xfrm, "rot", 0) % 21600000 !== 0) this.simplified("group-rotation");
    }
    const id = attr(path(el, "p:nvGrpSpPr", "p:cNvPr"), "id");
    const step = groupStep ?? (id === undefined ? undefined : this.current?.steps.shapes.get(id));
    this.drawChildren(el.children, layer, isSlide, inner, depth + 1, step);
  }

  /** Adds one element's HTML within the slide's size and shape budgets. */
  private emit(html: string): void {
    const state = this.current as SlideState;
    if (state.stopped) return;
    if (state.shapes >= this.limits.maxShapesPerSlide) {
      state.stopped = true;
      this.simplified("too-many-shapes");
      return;
    }
    if (state.size + html.length > this.limits.maxSlideHtmlChars) {
      state.stopped = true;
      this.slideWarn("PPTX_CONTENT_TRUNCATED", "slide-size");
      return;
    }
    state.shapes++;
    state.size += html.length;
    state.out.push(html);
  }

  placeholderOf(el: XmlElement): Placeholder | null {
    const nv = el.children.find((c) => c.name.startsWith("p:nv"));
    const ph = path(nv, "p:nvPr", "p:ph");
    if (ph === undefined) return null;
    return {
      type: attr(ph, "type") ?? (attr(ph, "idx") === undefined ? undefined : "body"),
      idx: attr(ph, "idx"),
    };
  }

  private static normalType(type: string | undefined): string {
    switch (type) {
      case "title":
      case "ctrTitle":
        return "title";
      case "dt":
      case "ftr":
      case "sldNum":
      case "hdr":
        return type;
      default:
        return "body";
    }
  }

  /** The matching placeholder shape on a layout (by idx, then type) or a master (by type). */
  private matchPlaceholder(
    layer: Layer | null,
    ph: Placeholder,
    byIdx: boolean,
  ): XmlElement | undefined {
    if (layer === null) return undefined;
    const shapes = findAll(path(layer.root, "p:cSld", "p:spTree"), "p:sp");
    const withPh = shapes
      .map((sp) => ({ sp, p: this.placeholderOf(sp) }))
      .filter((x): x is { sp: XmlElement; p: Placeholder } => x.p !== null);
    if (byIdx && ph.idx !== undefined) {
      const hit = withPh.find((x) => x.p.idx === ph.idx);
      if (hit !== undefined) return hit.sp;
    }
    const exact = withPh.find((x) => (x.p.type ?? "body") === (ph.type ?? "body"));
    if (exact !== undefined) return exact.sp;
    const norm = Converter.normalType(ph.type);
    return withPh.find((x) => Converter.normalType(x.p.type) === norm)?.sp;
  }

  /** Inheritance chain of a slide or layout placeholder: [own, layout ph, master ph]. */
  private placeholderChain(el: XmlElement, layer: Layer): XmlElement[] {
    const state = this.current as SlideState;
    const ph = this.placeholderOf(el);
    if (ph === null) return [el];
    const out = [el];
    if (layer === state.slide) {
      const lay = this.matchPlaceholder(state.layout, ph, true);
      if (lay !== undefined) out.push(lay);
      const mas = this.matchPlaceholder(state.master, this.placeholderOf(lay ?? el) ?? ph, false);
      if (mas !== undefined) out.push(mas);
    } else if (layer === state.layout) {
      const mas = this.matchPlaceholder(state.master, ph, false);
      if (mas !== undefined) out.push(mas);
    }
    return out;
  }

  private boxOf(xfrm: XmlElement | undefined, t: Transform): Box | null {
    if (xfrm === undefined) return null;
    const off = child(xfrm, "a:off");
    const ext = child(xfrm, "a:ext");
    if (off === undefined || ext === undefined) return null;
    const x = intAttr(off, "x", 0);
    const y = intAttr(off, "y", 0);
    const cx = Math.max(0, intAttr(ext, "cx", 0));
    const cy = Math.max(0, intAttr(ext, "cy", 0));
    const s = this.scale;
    return {
      x: (t.sx * x + t.tx) * s + this.offsetX,
      y: (t.sy * y + t.ty) * s + this.offsetY,
      w: t.sx * cx * s,
      h: t.sy * cy * s,
      rot: (intAttr(xfrm, "rot", 0) / 60000) % 360,
      flipH: boolAttr(xfrm, "flipH") === true,
      flipV: boolAttr(xfrm, "flipV") === true,
    };
  }

  private boxCss(box: Box, mirror: boolean): string[] {
    const transforms: string[] = [];
    if (box.rot !== 0) transforms.push(`rotate(${num(box.rot)}deg)`);
    if (mirror && (box.flipH || box.flipV))
      transforms.push(`scale(${box.flipH ? -1 : 1},${box.flipV ? -1 : 1})`);
    return [
      "position:absolute",
      `left:${px(box.x)}`,
      `top:${px(box.y)}`,
      `width:${px(box.w)}`,
      `height:${px(box.h)}`,
      transforms.length > 0 ? `transform:${transforms.join(" ")}` : "",
    ];
  }

  private stepAttr(id: string | undefined, groupStep: number | undefined): string {
    const step = groupStep ?? (id === undefined ? undefined : this.current?.steps.shapes.get(id));
    return step === undefined ? "" : ` data-step="${step}"`;
  }

  private textEnv(): TextEnv {
    const state = this.current as SlideState;
    return {
      colors: state.colors,
      len: (emu) => emu * this.scale,
      majorFont: state.theme.majorFont,
      minorFont: state.theme.minorFont,
      useFont: (face) => this.useFont(face),
      noteLang: (lang) => {
        if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(lang) && lang.length <= 35) {
          this.langs.set(lang, (this.langs.get(lang) ?? 0) + 1);
        }
      },
      simplified: (feature) => this.simplified(feature),
    };
  }

  private useFont(face: string): FontChoice {
    const choice = mapFont(face);
    this.fontUse.set(choice.font, (this.fontUse.get(choice.font) ?? 0) + 1);
    if (choice.substituted) {
      const key = clipText(face, 60);
      if (!this.substitutions.has(key)) this.substitutions.set(key, choice.font);
    }
    return choice;
  }

  private styleRef(el: XmlElement, name: string): { idx: number; color: Rgba | null } | null {
    const ref = path(el, "p:style", name);
    if (ref === undefined) return null;
    const state = this.current as SlideState;
    return { idx: intAttr(ref, "idx", 0), color: colorOf(firstColorChild(ref), state.colors) };
  }

  /** Fill of a shape: its own, then its placeholder chain, then its style reference. */
  private shapeFill(chain: XmlElement[], el: XmlElement): Fill | null {
    const state = this.current as SlideState;
    for (const sp of chain) {
      const f = fillElement(child(sp, "p:spPr"));
      if (f !== undefined) return parseFill(f, state.colors);
    }
    const ref = this.styleRef(el, "a:fillRef");
    if (ref !== null && ref.idx > 0) {
      const themeFill =
        ref.idx >= 1001
          ? state.theme.bgFillStyles[ref.idx - 1001]
          : state.theme.fillStyles[ref.idx - 1];
      return (
        parseFill(themeFill, state.colors, ref.color ?? undefined) ??
        (ref.color ? { kind: "solid", color: ref.color } : null)
      );
    }
    return null;
  }

  private shapeLine(
    chain: XmlElement[],
    el: XmlElement,
  ): { color: string; width: number; dash: string | null } | null {
    const state = this.current as SlideState;
    let ln: XmlElement | undefined;
    let ph: Rgba | undefined;
    for (const sp of chain) {
      ln = child(child(sp, "p:spPr"), "a:ln");
      if (ln !== undefined) break;
    }
    const ref = this.styleRef(el, "a:lnRef");
    if (ref !== null && ref.idx > 0) {
      ph = ref.color ?? undefined;
      const themeLine = state.theme.lineStyles[ref.idx - 1];
      if (ln === undefined) ln = themeLine;
      else if (fillElement(ln) === undefined && themeLine !== undefined && ph !== undefined) {
        // Own width or dash, colour from the style.
        const width = intAttr(ln, "w") ?? intAttr(themeLine, "w", 9525);
        return {
          color: css(ph),
          width: Math.max(1, width * this.scale),
          dash: dashOf(ln) ?? dashOf(themeLine),
        };
      }
    }
    if (ln === undefined) return null;
    const fill = parseFill(fillElement(ln), state.colors, ph);
    if (fill === null || fill.kind === "none" || fill.kind === "picture") return null;
    const color = fill.kind === "gradient" ? fill.first : fill.color;
    const width = intAttr(ln, "w", 9525);
    return { color: css(color), width: Math.max(0.5, width * this.scale), dash: dashOf(ln) };
  }

  private shadow(spPr: XmlElement | undefined): string | null {
    const effects = child(spPr, "a:effectLst");
    if (effects === undefined) return null;
    if (effects.children.some((c) => c.name !== "a:outerShdw")) this.simplified("effects");
    const sh = child(effects, "a:outerShdw");
    if (sh === undefined) return null;
    const state = this.current as SlideState;
    const color = colorOf(firstColorChild(sh), state.colors);
    if (color === null) return null;
    const dist = intAttr(sh, "dist", 0) * this.scale;
    const dir = ((intAttr(sh, "dir", 0) / 60000) * Math.PI) / 180;
    const blur = intAttr(sh, "blurRad", 0) * this.scale;
    return `${px(dist * Math.cos(dir))} ${px(dist * Math.sin(dir))} ${px(blur)} ${css(color)}`;
  }

  private fillCss(fill: Fill | null, part: string): string | null {
    if (fill === null) return null;
    switch (fill.kind) {
      case "none":
        return null;
      case "solid":
        return `background:${css(fill.color)}`;
      case "pattern":
        this.simplified("pattern");
        return `background:${css(fill.color)}`;
      case "gradient":
        return `background:${fill.css}`;
      case "picture": {
        const result = this.imageFromBlip(part, fill.blip, "picture fill");
        if (!("sha256" in result)) return null;
        if (child(fill.blip, "a:srcRect") !== undefined) this.simplified("picture-crop");
        return `background:url(asset:${result.sha256}) center/100% 100% no-repeat`;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Shapes and text

  private drawShape(
    el: XmlElement,
    layer: Layer,
    isSlide: boolean,
    t: Transform,
    groupStep: number | undefined,
  ): void {
    const ph = this.placeholderOf(el);
    // Placeholders of masters and layouts are prompts, never drawn on slides.
    if (ph !== null && !isSlide) return;
    const chain = this.placeholderChain(el, layer);
    const spPr = child(el, "p:spPr");
    let box: Box | null = null;
    for (const sp of chain) {
      box = this.boxOf(child(child(sp, "p:spPr"), "a:xfrm"), t);
      if (box !== null) break;
    }
    if (box === null) return;
    const cNvPr = path(
      el.children.find((c) => c.name.startsWith("p:nv")),
      "p:cNvPr",
    );
    const id = attr(cNvPr, "id");
    if (child(cNvPr, "a:hlinkClick") !== undefined) this.simplified("links");
    if (child(spPr, "a:scene3d") !== undefined || child(spPr, "a:sp3d") !== undefined)
      this.dropped("3d");

    const geom = child(spPr, "a:prstGeom") ?? child(child(chain[1], "p:spPr"), "a:prstGeom");
    const custom = child(spPr, "a:custGeom");
    const prst = attr(geom, "prst") ?? (custom !== undefined ? "custom" : "rect");
    const fill = this.shapeFill(chain, el);
    const line = this.shapeLine(chain, el);
    const shadow = this.shadow(spPr);
    const step = this.stepAttr(id, groupStep);

    if (el.name === "p:cxnSp" || LINE_PRESETS.has(prst)) {
      if (prst !== "line" && prst !== "straightConnector1") this.simplified("connectors");
      this.drawLine(box, line, el, spPr, step);
      return;
    }

    const text = this.textOf(el, chain, box, layer, id);
    const kind = custom !== undefined ? null : boxKind(prst);
    const fillCss = this.fillCss(fill, layer.part);
    if (!text.hasText && fillCss === null && line === null && shadow === null) return;

    let svg = "";
    let radius: string | null = null;
    if (kind === "roundRect") {
      const adj = attr(child(child(geom, "a:avLst"), "a:gd"), "fmla");
      const m = /^val\s+(\d{1,9})$/.exec(adj ?? "");
      const ratio = (m === null ? 16667 : Number(m[1])) / 100000;
      radius = px(Math.min(box.w, box.h) * Math.min(0.5, ratio));
    } else if (kind === "ellipse") {
      radius = "50%";
    } else if (kind === null) {
      const d =
        custom !== undefined
          ? customPath(custom, box.w, box.h)
          : presetPath(prst, box.w, box.h, geom);
      if (d !== null && (fillCss !== null || line !== null)) {
        svg = this.svgShape(box, d, fill, line, layer.part);
      } else if (d === null) {
        this.simplified(`shape:${custom !== undefined ? "custom" : prst}`);
      }
    }

    const useBox = svg === "" || kind !== null;
    const decls = [
      ...this.boxCss(box, false),
      useBox && fillCss !== null ? fillCss : null,
      useBox && line !== null
        ? `border:${px(line.width)} ${line.dash ?? "solid"} ${line.color}`
        : null,
      radius !== null ? `border-radius:${radius}` : null,
      shadow !== null && useBox ? `box-shadow:${shadow}` : null,
      "box-sizing:border-box",
      text.hasText ? text.frameCss : null,
    ];
    if (svg !== "") {
      this.emit(svg.replace("<svg ", `<svg${step} `));
      if (!text.hasText) return;
    }
    const altText = attr(cNvPr, "descr");
    const label =
      !text.hasText && altText ? ` role="img" aria-label="${esc(clipText(altText, 500))}"` : "";
    this.emit(`<div${step}${label} style="${style(decls)}">${text.hasText ? text.html : ""}</div>`);
  }

  private textOf(
    el: XmlElement,
    chain: XmlElement[],
    box: Box,
    layer: Layer,
    id: string | undefined,
  ): { html: string; hasText: boolean; frameCss: string } {
    const state = this.current as SlideState;
    const txBody = child(el, "p:txBody");
    if (txBody === undefined) return { html: "", hasText: false, frameCss: "" };
    const ph = this.placeholderOf(el);
    const master = state.master?.root;
    const txStyles = child(master, "p:txStyles");
    let masterStyle: XmlElement | undefined;
    const type = ph === null ? null : Converter.normalType(ph.type);
    if (type === "title") masterStyle = child(txStyles, "p:titleStyle");
    else if (type === "body") masterStyle = child(txStyles, "p:bodyStyle");
    else masterStyle = child(txStyles, "p:otherStyle");
    if (layer !== state.slide && ph === null) masterStyle = child(txStyles, "p:otherStyle");

    const lstStyles = chain
      .map((sp) => child(child(sp, "p:txBody"), "a:lstStyle"))
      .filter((x): x is XmlElement => x !== undefined && x.children.length > 0);
    const ownStyles = child(txBody, "a:lstStyle")?.children.length ? 1 : 0;
    const fontRef = this.styleRef(el, "a:fontRef");
    const styleChain: StyleChain = {
      lstStyles,
      masterStyle,
      defaultStyle: this.defaultStyle,
      fontRefColor: fontRef?.color ?? null,
      ownStyles,
    };
    const bodyPrs = chain
      .map((sp) => child(child(sp, "p:txBody"), "a:bodyPr"))
      .filter((b) => b !== undefined);
    const bp = (name: string) => {
      for (const b of bodyPrs) {
        const v = attr(b, name);
        if (v !== undefined) return v;
      }
      return undefined;
    };
    const own = child(txBody, "a:bodyPr");
    const autofit = child(own, "a:normAutofit");
    const options: BodyOptions = {
      fontScale: Math.min(1, Math.max(0.1, (intAttr(autofit, "fontScale") ?? 100000) / 100000)),
      lineReduction: Math.min(0.5, Math.max(0, (intAttr(autofit, "lnSpcReduction") ?? 0) / 100000)),
      paragraphSteps: id === undefined ? undefined : state.steps.paragraphs.get(id),
      noWrap: bp("wrap") === "none",
    };
    const warp = child(own, "a:prstTxWarp");
    if (warp !== undefined && attr(warp, "prst") !== "textNoShape") this.simplified("wordart");
    if (child(own, "a:scene3d") !== undefined || child(own, "a:sp3d") !== undefined)
      this.dropped("3d");

    const rendered = renderParagraphs(txBody, styleChain, this.textEnv(), options);
    const ins = (name: string, d: number) => {
      const v = bp(name);
      return (v !== undefined && /^-?\d{1,12}$/.test(v) ? Number(v) : d) * this.scale;
    };
    const anchor = bp("anchor");
    // `safe`: if a replaced font makes the text taller than its box, it overflows (and is clipped) at the bottom,
    // never above the box where the first lines would be lost.
    const justify =
      anchor === "ctr" ? "safe center" : anchor === "b" ? "safe flex-end" : "flex-start";
    const vert = bp("vert");
    let writing: string | null = null;
    if (vert !== undefined && vert !== "horz") {
      writing = "writing-mode:vertical-rl";
      if (vert !== "vert" && vert !== "eaVert") this.simplified("vertical-text");
    }
    const frameCss = style([
      "display:flex",
      "flex-direction:column",
      `justify-content:${justify}`,
      `padding:${px(ins("tIns", 45720))} ${px(ins("rIns", 91440))} ${px(ins("bIns", 45720))} ${px(ins("lIns", 91440))}`,
      "overflow:hidden",
      writing,
    ]);
    void box;
    return { html: rendered.html, hasText: rendered.hasText, frameCss };
  }

  private svgShape(
    box: Box,
    d: string,
    fill: Fill | null,
    line: { color: string; width: number; dash: string | null } | null,
    part: string,
  ): string {
    const state = this.current as SlideState;
    let defs = "";
    let fillAttr = "none";
    if (fill !== null) {
      if (fill.kind === "solid" || fill.kind === "pattern") fillAttr = css(fill.color);
      else if (fill.kind === "gradient") fillAttr = css(fill.first);
      else if (fill.kind === "picture") {
        const result = this.imageFromBlip(part, fill.blip, "picture fill");
        if ("sha256" in result) {
          const pid = `p${state.number}i${++state.ids}`;
          defs = `<defs><pattern id="${pid}" patternUnits="objectBoundingBox" width="1" height="1"><image href="asset:${result.sha256}" width="${num(box.w)}" height="${num(box.h)}" preserveAspectRatio="none"></image></pattern></defs>`;
          fillAttr = `url(#${pid})`;
        }
      }
      if (fill.kind === "gradient") this.simplified("gradient-shape");
    }
    const sw = line?.width ?? 0;
    const pad = sw;
    const vb = `${num(-pad)} ${num(-pad)} ${num(box.w + 2 * pad)} ${num(box.h + 2 * pad)}`;
    const transforms: string[] = [];
    if (box.rot !== 0) transforms.push(`rotate(${num(box.rot)}deg)`);
    if (box.flipH || box.flipV)
      transforms.push(`scale(${box.flipH ? -1 : 1},${box.flipV ? -1 : 1})`);
    const css2 = style([
      "position:absolute",
      `left:${px(box.x - pad)}`,
      `top:${px(box.y - pad)}`,
      `width:${px(box.w + 2 * pad)}`,
      `height:${px(box.h + 2 * pad)}`,
      transforms.length > 0 ? `transform:${transforms.join(" ")}` : null,
    ]);
    const strokeAttrs =
      line === null
        ? ""
        : ` stroke="${line.color}" stroke-width="${num(sw)}"${line.dash === "dashed" ? ` stroke-dasharray="${num(sw * 4)} ${num(sw * 3)}"` : line.dash === "dotted" ? ` stroke-dasharray="${num(sw)} ${num(sw * 2)}"` : ""}`;
    return `<svg style="${css2}" viewBox="${vb}" aria-hidden="true">${defs}<path d="${d}" fill="${fillAttr}"${strokeAttrs}></path></svg>`;
  }

  private drawLine(
    box: Box,
    line: { color: string; width: number; dash: string | null } | null,
    el: XmlElement,
    spPr: XmlElement | undefined,
    step: string,
  ): void {
    if (line === null) return;
    const sw = line.width;
    const pad = sw * 4 + 2;
    let x1 = 0;
    let y1 = 0;
    let x2 = box.w;
    let y2 = box.h;
    if (box.flipH) [x1, x2] = [x2, x1];
    if (box.flipV) [y1, y2] = [y2, y1];
    const ln = child(spPr, "a:ln");
    const arrow = (
      end: XmlElement | undefined,
      fx: number,
      fy: number,
      tx: number,
      ty: number,
    ): string => {
      const type = attr(end, "type");
      if (type === undefined || type === "none") return "";
      const len = Math.max(sw * 3, 6);
      const ang = Math.atan2(ty - fy, tx - fx);
      const a1 = ang + Math.PI - 0.45;
      const a2 = ang + Math.PI + 0.45;
      const pts = [
        [tx, ty],
        [tx + len * Math.cos(a1), ty + len * Math.sin(a1)],
        [tx + len * Math.cos(a2), ty + len * Math.sin(a2)],
      ];
      return `<polygon points="${pts.map(([x, y]) => `${num(x as number)},${num(y as number)}`).join(" ")}" fill="${line.color}"></polygon>`;
    };
    const heads =
      arrow(child(ln, "a:tailEnd"), x1, y1, x2, y2) + arrow(child(ln, "a:headEnd"), x2, y2, x1, y1);
    const dash =
      line.dash === "dashed"
        ? ` stroke-dasharray="${num(sw * 4)} ${num(sw * 3)}"`
        : line.dash === "dotted"
          ? ` stroke-dasharray="${num(sw)} ${num(sw * 2)}"`
          : "";
    const transforms = box.rot !== 0 ? `;transform:rotate(${num(box.rot)}deg)` : "";
    void el;
    this.emit(
      `<svg${step} style="position:absolute;left:${px(box.x - pad)};top:${px(box.y - pad)};width:${px(box.w + 2 * pad)};height:${px(box.h + 2 * pad)}${transforms}" viewBox="${num(-pad)} ${num(-pad)} ${num(box.w + 2 * pad)} ${num(box.h + 2 * pad)}" aria-hidden="true"><line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${line.color}" stroke-width="${num(sw)}"${dash}></line>${heads}</svg>`,
    );
  }

  // -------------------------------------------------------------------------------------------------------------
  // Pictures

  private placeholderBox(box: Box, step: string, label: string): void {
    this.emit(
      `<div${step} role="img" aria-label="${esc(clipText(label, 300))}" style="${style([...this.boxCss(box, false), PLACEHOLDER_STYLE])}"></div>`,
    );
  }

  private drawPicture(
    el: XmlElement,
    layer: Layer,
    isSlide: boolean,
    t: Transform,
    groupStep: number | undefined,
  ): void {
    const ph = this.placeholderOf(el);
    if (ph !== null && !isSlide) return;
    const chain = this.placeholderChain(el, layer);
    let box: Box | null = null;
    for (const sp of chain) {
      box = this.boxOf(child(child(sp, "p:spPr"), "a:xfrm"), t);
      if (box !== null) break;
    }
    if (box === null) return;
    const nv = child(el, "p:nvPicPr");
    const cNvPr = child(nv, "p:cNvPr");
    const nvPr = child(nv, "p:nvPr");
    const id = attr(cNvPr, "id");
    const step = this.stepAttr(id, groupStep);
    const alt = clipText(attr(cNvPr, "descr") ?? attr(cNvPr, "title") ?? "", 500);
    if (child(nvPr, "a:videoFile") !== undefined || child(nvPr, "a:quickTimeFile") !== undefined)
      this.dropped("video");
    else if (
      child(nvPr, "a:audioFile") !== undefined ||
      child(nvPr, "a:audioCd") !== undefined ||
      child(nvPr, "a:wavAudioFile") !== undefined
    )
      this.dropped("audio");
    else if (find(nvPr, "p14:media") !== undefined) this.dropped("video");
    if (child(cNvPr, "a:hlinkClick") !== undefined) this.simplified("links");

    const blipFill = child(el, "p:blipFill");
    const result = this.imageFromBlip(
      layer.part,
      blipFill,
      alt === "" ? "picture" : `picture "${alt}"`,
    );
    if (!("sha256" in result)) {
      this.placeholderBox(box, step, alt || "Image not imported");
      return;
    }
    const src = `asset:${result.sha256}`;
    const altAttr = esc(alt);
    const rect = child(blipFill, "a:srcRect");
    const crop = (n: string) => Math.min(0.99, Math.max(-10, (intAttr(rect, n) ?? 0) / 100000));
    const l = crop("l");
    const tp = crop("t");
    const rt = crop("r");
    const b = crop("b");
    const shadow = this.shadow(child(el, "p:spPr"));
    const line = this.shapeLine([el], el);
    const geom = attr(child(child(el, "p:spPr"), "a:prstGeom"), "prst");
    const radius =
      geom === "ellipse"
        ? "border-radius:50%"
        : geom === "roundRect"
          ? `border-radius:${px(Math.min(box.w, box.h) * 0.16667)}`
          : null;
    const outer = [
      ...this.boxCss(box, true),
      shadow !== null ? `box-shadow:${shadow}` : null,
      line !== null ? `outline:${px(line.width)} ${line.dash ?? "solid"} ${line.color}` : null,
      radius,
    ];
    if (l === 0 && tp === 0 && rt === 0 && b === 0) {
      this.emit(
        `<img${step} src="${src}" alt="${altAttr}" style="${style([...outer, "object-fit:fill", "display:block"])}">`,
      );
      return;
    }
    const iw = box.w / Math.max(0.01, 1 - l - rt);
    const ih = box.h / Math.max(0.01, 1 - tp - b);
    this.emit(
      `<div${step} style="${style([...outer, "overflow:hidden"])}"><img src="${src}" alt="${altAttr}" style="${style(
        [
          "position:absolute",
          `left:${px(-l * iw)}`,
          `top:${px(-tp * ih)}`,
          `width:${px(iw)}`,
          `height:${px(ih)}`,
          "max-width:none",
          "display:block",
        ],
      )}"></div>`,
    );
  }

  /** Resolves the image of an `a:blip` (inside a blip fill) to an asset, with a warning when it cannot be used. */
  private imageFromBlip(part: string, blipFill: XmlElement | undefined, what: string): ImageResult {
    const blip = child(blipFill, "a:blip");
    if (blip === undefined) return { failed: "no image" };
    const embed = attr(blip, "r:embed");
    const link = attr(blip, "r:link");
    if (embed === undefined) {
      if (link !== undefined) {
        this.slideWarn(
          "PPTX_IMAGE_DROPPED",
          "linked-image",
          `a linked ${what} points outside the file and is never downloaded; a placeholder marks it`,
        );
        return { failed: "linked" };
      }
      return { failed: "no image" };
    }
    const rel = this.pkg.rel(part, embed);
    if (rel === undefined || rel.external || rel.target === null) {
      this.slideWarn(
        "PPTX_IMAGE_DROPPED",
        "linked-image",
        rel?.external
          ? `a linked ${what} points outside the file and is never downloaded; a placeholder marks it`
          : `a ${what} is missing from the file; a placeholder marks it`,
      );
      return { failed: "missing" };
    }
    const target = rel.target;
    let result = this.imageCache.get(target);
    if (result === undefined) {
      result = this.loadImage(target);
      this.imageCache.set(target, result);
    }
    if ("failed" in result) {
      this.slideWarn(
        "PPTX_IMAGE_DROPPED",
        `image:${result.failed}`,
        `a ${what} ${result.failed}; a placeholder marks it`,
      );
    }
    return result;
  }

  private loadImage(target: string): ImageResult {
    const L = this.limits;
    if (!target.startsWith("ppt/media/") || !this.pkg.has(target)) {
      return { failed: "is missing from the file" };
    }
    const size = this.pkg.size(target) ?? 0;
    if (size > L.maxAssetBytes) {
      return {
        failed: `is larger than ${Math.floor(L.maxAssetBytes / 1024 / 1024)} MB (compress it in PowerPoint and import again)`,
      };
    }
    const bytes = this.pkg.bytes(target);
    if (bytes === null || bytes.length === 0) return { failed: "is missing from the file" };
    const sniff = sniffImage(bytes);
    if (!sniff.ok) {
      const format =
        sniff.kind === "svg"
          ? "SVG"
          : sniff.kind === "malformed"
            ? "a damaged file"
            : describeUnsupportedImage(bytes, target);
      return { failed: `is in ${format}, which cannot be imported` };
    }
    const w = sniff.width ?? 0;
    const h = sniff.height ?? 0;
    if (w > L.maxImageDimension || h > L.maxImageDimension || w * h > L.maxImagePixels) {
      return { failed: `is too large (${w}×${h} pixels)` };
    }
    const sha256 = sha256Hex(bytes);
    if (this.assets.has(sha256)) return { sha256 };
    if (this.assets.size >= L.maxAssetsPerDeck) {
      return { failed: `is over the limit of ${L.maxAssetsPerDeck} images per presentation` };
    }
    if (this.assetBytes + bytes.length > L.maxAssetBytesPerDeck) {
      return {
        failed: `is over the limit of ${Math.floor(L.maxAssetBytesPerDeck / 1024 / 1024)} MB of images per presentation`,
      };
    }
    this.assetBytes += bytes.length;
    this.assets.set(sha256, {
      sha256,
      mediaType: sniff.mediaType,
      width: sniff.width,
      height: sniff.height,
      bytes,
    });
    return { sha256 };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Graphic frames: tables, charts, SmartArt, OLE

  private drawFrame(
    el: XmlElement,
    layer: Layer,
    t: Transform,
    groupStep: number | undefined,
  ): void {
    const box = this.boxOf(child(el, "p:xfrm"), t);
    if (box === null) return;
    const id = attr(path(el, "p:nvGraphicFramePr", "p:cNvPr"), "id");
    const step = this.stepAttr(id, groupStep);
    const data = path(el, "a:graphic", "a:graphicData");
    const uri = attr(data, "uri") ?? "";
    if (uri.endsWith("/drawingml/2006/table")) {
      const tbl = child(data, "a:tbl");
      if (tbl !== undefined) this.drawTable(tbl, box, step, layer);
      return;
    }
    if (uri.endsWith("/drawingml/2006/chart") || uri.includes("/drawing/2014/chartex")) {
      this.dropped("chart");
      this.placeholderBox(box, step, "Chart");
      return;
    }
    if (uri.endsWith("/drawingml/2006/diagram")) {
      this.dropped("smartart");
      this.placeholderBox(box, step, "SmartArt");
      return;
    }
    if (uri.endsWith("/presentationml/2006/ole")) {
      const pic = find(data, "p:pic");
      const blipFill = child(pic, "p:blipFill");
      if (blipFill !== undefined) {
        const result = this.imageFromBlip(layer.part, blipFill, "embedded object's picture");
        if ("sha256" in result) {
          this.simplified("ole-picture");
          this.emit(
            `<img${step} src="asset:${result.sha256}" alt="" style="${style([...this.boxCss(box, false), "object-fit:fill", "display:block"])}">`,
          );
          return;
        }
      }
      this.dropped("ole");
      this.placeholderBox(box, step, "Embedded object");
      return;
    }
    this.dropped("embedded-object");
    this.placeholderBox(box, step, "Embedded object");
  }

  private drawTable(tbl: XmlElement, box: Box, step: string, layer: Layer): void {
    const state = this.current as SlideState;
    const tblPr = child(tbl, "a:tblPr");
    const cols = children(child(tbl, "a:tblGrid"), "a:gridCol").map((c) =>
      Math.max(0, intAttr(c, "w", 0) * this.scale),
    );
    const rows = children(tbl, "a:tr");
    const styled = child(tblPr, "a:tableStyleId") !== undefined;
    const firstRow = boolAttr(tblPr, "firstRow") === true;
    const bandRow = boolAttr(tblPr, "bandRow") === true;
    const accent = colorOf(
      { name: "a:schemeClr", attrs: { val: "accent1" }, children: [], text: "" },
      state.colors,
    );
    const tintOf = (c: Rgba, k: number) => ({
      r: Math.round(c.r + (255 - c.r) * (1 - k)),
      g: Math.round(c.g + (255 - c.g) * (1 - k)),
      b: Math.round(c.b + (255 - c.b) * (1 - k)),
      a: 1,
    });
    let usedStyle = false;
    let cells = 0;
    const MAX_CELLS = 2000;
    const out: string[] = [];
    out.push(
      `<table${step} style="${style([
        "position:absolute",
        `left:${px(box.x)}`,
        `top:${px(box.y)}`,
        `width:${px(cols.reduce((a, b) => a + b, 0) || box.w)}`,
        "border-collapse:collapse",
        "table-layout:fixed",
      ])}"><colgroup>${cols.map((w) => `<col style="width:${px(w)}">`).join("")}</colgroup><tbody>`,
    );
    const env = this.textEnv();
    const otherStyle = child(child(state.master?.root, "p:txStyles"), "p:otherStyle");
    rows.forEach((tr, ri) => {
      if (cells >= MAX_CELLS) return;
      out.push(`<tr style="height:${px(intAttr(tr, "h", 0) * this.scale)}">`);
      for (const tc of children(tr, "a:tc")) {
        if (boolAttr(tc, "hMerge") === true || boolAttr(tc, "vMerge") === true) continue;
        if (++cells > MAX_CELLS) break;
        const tcPr = child(tc, "a:tcPr");
        const span = Math.min(1000, Math.max(1, intAttr(tc, "gridSpan", 1)));
        const rspan = Math.min(1000, Math.max(1, intAttr(tc, "rowSpan", 1)));
        let bg: string | null = null;
        const ownFill = fillElement(tcPr);
        let header = false;
        if (ownFill !== undefined) {
          const f = parseFill(ownFill, state.colors);
          bg = f === null ? null : this.fillCss(f, layer.part);
        } else if (styled && accent !== null) {
          usedStyle = true;
          if (firstRow && ri === 0) {
            bg = `background:${css(accent)}`;
            header = true;
          } else if (bandRow) {
            const k = (ri - (firstRow ? 1 : 0)) % 2 === 0 ? 0.4 : 0.2;
            bg = `background:${css(tintOf(accent, k))}`;
          }
        }
        const border = (name: string, side: string) => {
          const ln = child(tcPr, name);
          if (ln === undefined) return styled ? `border-${side}:1px solid #ffffff` : null;
          const f = parseFill(fillElement(ln), state.colors);
          if (f === null || f.kind === "none" || f.kind === "picture") return `border-${side}:none`;
          const c = f.kind === "gradient" ? f.first : f.color;
          return `border-${side}:${px(Math.max(0.5, intAttr(ln, "w", 12700) * this.scale))} solid ${css(c)}`;
        };
        const mar = (name: string, d: number) => px((intAttr(tcPr, name) ?? d) * this.scale);
        const anchor = attr(tcPr, "anchor");
        const chainStyle: StyleChain = {
          lstStyles: [child(child(tc, "a:txBody"), "a:lstStyle")].filter(
            (x): x is XmlElement => x !== undefined && x.children.length > 0,
          ),
          masterStyle: otherStyle,
          defaultStyle: this.defaultStyle,
          fontRefColor: header ? { r: 255, g: 255, b: 255, a: 1 } : null,
          ownStyles: 1,
        };
        const text = renderParagraphs(child(tc, "a:txBody"), chainStyle, env, {
          fontScale: 1,
          lineReduction: 0,
          noWrap: false,
        });
        out.push(
          `<td${span > 1 ? ` colspan="${span}"` : ""}${rspan > 1 ? ` rowspan="${rspan}"` : ""} style="${style(
            [
              `padding:${mar("marT", 45720)} ${mar("marR", 91440)} ${mar("marB", 45720)} ${mar("marL", 91440)}`,
              `vertical-align:${anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top"}`,
              bg,
              header ? "font-weight:700" : null,
              border("a:lnL", "left"),
              border("a:lnR", "right"),
              border("a:lnT", "top"),
              border("a:lnB", "bottom"),
              "overflow:hidden",
            ],
          )}">${text.html}</td>`,
        );
      }
      out.push("</tr>");
    });
    out.push("</tbody></table>");
    if (cells > MAX_CELLS) this.simplified("table-size");
    if (usedStyle) this.simplified("table-style");
    this.emit(out.join(""));
  }
}

function dashOf(ln: XmlElement | undefined): string | null {
  const v = attr(child(ln, "a:prstDash"), "val");
  if (v === undefined || v === "solid") return null;
  if (/dot/i.test(v) && !/dash/i.test(v)) return "dotted";
  return "dashed";
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]?.toUpperCase() + text.slice(1);
}

/**
 * Converts a .pptx (or .pptm/.potx/.ppsx) file into a `pptaken.deck` envelope, its images and warnings.
 *
 * Pure: reads only `bytes`, never the file system or the network (external relationships are never followed).
 * Throws {@link PptxError} when the file cannot be imported at all; everything that only loses fidelity becomes a
 * warning. The output is untrusted: validate and sanitize it like any agent output.
 */
export function convertPptx(bytes: Uint8Array, options: ConvertOptions = {}): PptxConversion {
  const limits: PptxLimits = { ...DEFAULT_PPTX_LIMITS, ...options.limits };
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new PptxError("NOT_PPTX", "The file is empty");
  }
  detect(bytes);
  return new Converter(bytes, limits).run();
}

export { EMU_PER_PT };
