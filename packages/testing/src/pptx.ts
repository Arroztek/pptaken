// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds small but structurally complete .pptx files in memory (the parts and relationships PowerPoint writes:
// content types, package and presentation relationships, a master with a theme and text styles, a layout with
// title/body placeholders, slides, notes and media), so every converter feature is tested without binary fixtures.
// Imported as `@pptaken/testing/pptx` (no Vitest dependency, usable from plain Node scripts).
import { writeZip, type ZipInputEntry } from "@pptaken/zip";

const enc = new TextEncoder();

export const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface FixtureRel {
  id: string;
  type: string;
  target: string;
  external?: boolean;
}

export interface FixtureSlide {
  /** Content of `p:spTree` after the group properties. */
  shapes: string;
  rels?: FixtureRel[];
  notes?: string;
  /** XML placed after `p:clrMapOvr` (timing, transition). */
  after?: string;
  /** `p:bg` element. */
  background?: string;
  attrs?: string;
}

export interface FixtureOptions {
  slides: FixtureSlide[];
  /** Slide size in EMU (default 16:9, 12192000×6858000). */
  size?: { cx: number; cy: number };
  media?: Record<string, Uint8Array>;
  title?: string;
  /** `p14:section` list: name and 0-based slide indexes. */
  sections?: { name: string; slides: number[] }[];
  /** Extra package entries (raw). */
  extra?: ZipInputEntry[];
  /** Overrides the main part content type. */
  mainContentType?: string;
  /** Replaces the layout's shapes. */
  layoutShapes?: string;
  /** Extra non-placeholder shapes on the master. */
  masterShapes?: string;
  /** Master background. */
  masterBackground?: string;
}

const xml = (s: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`;

export function rels(list: FixtureRel[]): string {
  return xml(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
      .map(
        (r) =>
          `<Relationship Id="${r.id}" Type="${r.type.startsWith("http") ? r.type : `${REL}/${r.type}`}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ""}/>`,
      )
      .join("")}</Relationships>`,
  );
}

export const THEME =
  xml(`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>
<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`);

/** A placeholder shape with text paragraphs (each string a paragraph; `\n` makes line breaks). */
export function ph(
  id: number,
  type: string | null,
  idx: number | null,
  paragraphs: string[] | null,
  xfrm?: { x: number; y: number; w: number; h: number },
  extraBody = "",
): string {
  const phEl = `<p:ph${type ? ` type="${type}"` : ""}${idx !== null ? ` idx="${idx}"` : ""}/>`;
  const spPr = xfrm
    ? `<p:spPr><a:xfrm><a:off x="${xfrm.x}" y="${xfrm.y}"/><a:ext cx="${xfrm.w}" cy="${xfrm.h}"/></a:xfrm></p:spPr>`
    : "<p:spPr/>";
  const body =
    paragraphs === null
      ? ""
      : `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.map((p) => para(p)).join("")}${extraBody}</p:txBody>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Placeholder ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${phEl}</p:nvPr></p:nvSpPr>${spPr}${body}</p:sp>`;
}

export function para(text: string, rPr = '<a:rPr lang="en-US" dirty="0"/>', pPr = ""): string {
  const lines = text.split("\n");
  const runs = lines
    .map((line) => `<a:r>${rPr}<a:t>${escapeXml(line)}</a:t></a:r>`)
    .join("<a:br/>");
  return `<a:p>${pPr}${runs}</a:p>`;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A text box (not a placeholder). */
export function textBox(
  id: number,
  box: { x: number; y: number; w: number; h: number },
  paragraphsXml: string,
  spPrExtra = "",
  bodyPr = '<a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr>',
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${spPrExtra}</p:spPr><p:txBody>${bodyPr}<a:lstStyle/>${paragraphsXml}</p:txBody></p:sp>`;
}

export function shape(
  id: number,
  prst: string,
  box: { x: number; y: number; w: number; h: number },
  spPrExtra: string,
  extra = "",
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${spPrExtra}</p:spPr>${extra}</p:sp>`;
}

export function picture(
  id: number,
  relId: string,
  box: { x: number; y: number; w: number; h: number },
  descr = "",
  srcRect = "",
): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${escapeXml(descr)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

const MASTER_TX_STYLES = `<p:txStyles>
<p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600" algn="l"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="1000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="685800" indent="-228600" algn="l"><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl2pPr></p:bodyStyle>
<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle>
</p:txStyles>`;

export function buildPptx(options: FixtureOptions): Uint8Array {
  const size = options.size ?? { cx: 12192000, cy: 6858000 };
  const { cx, cy } = size;
  const entries: ZipInputEntry[] = [];
  const add = (name: string, data: string | Uint8Array) =>
    entries.push({
      name,
      data: typeof data === "string" ? enc.encode(data) : data,
      compress: true,
    });

  const slideOverrides = options.slides
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("");
  add(
    "[Content_Types].xml",
    xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="${options.mainContentType ?? "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"}"/>${slideOverrides}</Types>`,
    ),
  );
  add(
    "_rels/.rels",
    rels([
      { id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" },
      {
        id: "rId2",
        type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
        target: "docProps/core.xml",
      },
    ]),
  );
  if (options.title !== undefined) {
    add(
      "docProps/core.xml",
      xml(
        `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(options.title)}</dc:title></cp:coreProperties>`,
      ),
    );
  }
  const presRels: FixtureRel[] = [
    { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
    { id: "rId2", type: "theme", target: "theme/theme1.xml" },
    ...options.slides.map((_, i) => ({
      id: `rId${i + 10}`,
      type: "slide",
      target: `slides/slide${i + 1}.xml`,
    })),
  ];
  const sections =
    options.sections === undefined
      ? ""
      : `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">${options.sections
          .map(
            (s, i) =>
              `<p14:section name="${escapeXml(s.name)}" id="{0000000${i}-0000-0000-0000-000000000000}"><p14:sldIdLst>${s.slides.map((n) => `<p14:sldId id="${256 + n}"/>`).join("")}</p14:sldIdLst></p14:section>`,
          )
          .join("")}</p14:sectionLst></p:ext></p:extLst>`;
  add(
    "ppt/presentation.xml",
    xml(
      `<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${options.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle>${sections}</p:presentation>`,
    ),
  );
  add("ppt/_rels/presentation.xml.rels", rels(presRels));
  add("ppt/theme/theme1.xml", THEME);
  const W = cx;
  const H = cy;
  add(
    "ppt/slideMasters/slideMaster1.xml",
    xml(
      `<p:sldMaster ${NS}><p:cSld>${options.masterBackground ?? '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${ph(2, "title", null, null, { x: Math.round(W * 0.07), y: Math.round(H * 0.05), w: Math.round(W * 0.86), h: Math.round(H * 0.2) })}${ph(3, "body", 1, null, { x: Math.round(W * 0.07), y: Math.round(H * 0.27), w: Math.round(W * 0.86), h: Math.round(H * 0.6) })}${options.masterShapes ?? ""}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>${MASTER_TX_STYLES}</p:sldMaster>`,
    ),
  );
  add(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    rels([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "theme", target: "../theme/theme1.xml" },
    ]),
  );
  add(
    "ppt/slideLayouts/slideLayout1.xml",
    xml(
      `<p:sldLayout ${NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${options.layoutShapes ?? `${ph(2, "title", null, null)}${ph(3, null, 1, null)}`}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    ),
  );
  add(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]),
  );
  options.slides.forEach((slide, i) => {
    const n = i + 1;
    add(
      `ppt/slides/slide${n}.xml`,
      xml(
        `<p:sld ${NS}${slide.attrs ? ` ${slide.attrs}` : ""}><p:cSld>${slide.background ?? ""}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${slide.shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${slide.after ?? ""}</p:sld>`,
      ),
    );
    const slideRels: FixtureRel[] = [
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      ...(slide.rels ?? []),
    ];
    if (slide.notes !== undefined) {
      slideRels.push({
        id: "rIdNotes",
        type: "notesSlide",
        target: `../notesSlides/notesSlide${n}.xml`,
      });
      add(
        `ppt/notesSlides/notesSlide${n}.xml`,
        xml(
          `<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${ph(2, "sldImg", null, null)}${ph(3, "body", 1, slide.notes.split("\n\n"))}</p:spTree></p:cSld></p:notes>`,
        ),
      );
      add(
        `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        rels([{ id: "rId1", type: "slide", target: `../slides/slide${n}.xml` }]),
      );
    }
    add(`ppt/slides/_rels/slide${n}.xml.rels`, rels(slideRels));
  });
  for (const [name, data] of Object.entries(options.media ?? {})) {
    entries.push({ name: `ppt/media/${name}`, data, compress: false });
  }
  for (const e of options.extra ?? []) entries.push(e);
  return writeZip(entries, { date: new Date(Date.UTC(2026, 0, 1)) });
}

/** Emu helpers: inches to EMU. */
export const inch = (v: number) => Math.round(v * 914400);
