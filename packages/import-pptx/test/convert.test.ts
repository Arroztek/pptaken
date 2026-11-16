// SPDX-License-Identifier: AGPL-3.0-or-later
// Converter features on generated .pptx files. Every output also goes through the real schema and sanitizer, the
// same path the server takes, and must come out without sanitizer warnings (the converter only writes what the
// sanitizer keeps).
import { sanitizeDeck } from "@pptaken/sanitizer";
import { parseDeck } from "@pptaken/schema";
import { gifBytes, jpegBytes, pngBytes } from "@pptaken/testing";
import { buildPptx, inch, para, ph, picture, shape, textBox } from "@pptaken/testing/pptx";
import { describe, expect, it } from "vitest";
import { autoNumber, convertPptx, type PptxConversion } from "../src/index.js";

function convert(bytes: Uint8Array): PptxConversion {
  const out = convertPptx(bytes);
  const parsed = parseDeck(out.deck);
  if (!parsed.ok) throw new Error(`schema: ${JSON.stringify(parsed.issues.slice(0, 3))}`);
  const sanitized = sanitizeDeck(parsed.deck);
  expect(sanitized.warnings, JSON.stringify(sanitized.warnings.slice(0, 5))).toEqual([]);
  return out;
}

const features = (out: PptxConversion) =>
  out.warnings.map((w) => `${w.code}:${w.feature ?? ""}:${w.slide ?? ""}`);

describe("convertPptx: text and layout inheritance", () => {
  it("converts title and body placeholders with inherited positions, sizes and bullets", () => {
    const out = convert(
      buildPptx({
        title: "Quarterly review",
        slides: [
          {
            shapes:
              ph(2, "title", null, ["Hello world"]) +
              ph(3, null, 1, ["First point", "Second point"]),
          },
        ],
      }),
    );
    const deck = out.deck;
    expect(deck.title).toBe("Quarterly review");
    expect(deck.aspectRatio).toBe("16:9");
    expect(deck.lang).toBe("en-US");
    const slide = deck.slides[0];
    expect(slide?.id).toBe("slide-1");
    expect(slide?.title).toBe("Hello world");
    // Title: master position (7 % / 5 % of 1920×1080) and the master's 44 pt -> 88 px, Calibri Light -> Inter set
    // 0.87× to keep its width (Calibri is narrower).
    expect(slide?.html).toContain("left:134.4px;top:54px;width:1651.2px;height:216px");
    expect(slide?.html).toContain("font-size:76.56px");
    expect(slide?.html).toContain("font-family:'Inter',sans-serif");
    // Body: 28 pt -> 56 px (Calibri: 0.88× = 49.28 px) with the master bullet, hanging indent (0.25 in = 36 px) and
    // 10 pt space before.
    expect(slide?.html).toContain("font-size:49.28px");
    expect(slide?.html).toContain("padding-left:36px;text-indent:-36px");
    expect(slide?.html).toMatch(
      /display:inline-block;width:36px;text-indent:0[^>]*>•<\/span>First point/,
    );
    expect(slide?.html).toContain("margin-top:20px");
    expect(slide?.html).toContain("First point");
    expect(deck.theme?.fonts).toEqual(["Inter"]);
    expect(features(out)).toContain("PPTX_FONT_REPLACED:font:Calibri Light:");
    expect(features(out)).toContain("PPTX_FONT_REPLACED:font:Calibri:");
  });

  it("keeps run formatting, alignment, numbering and line breaks", () => {
    const runs =
      '<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="es-PE" b="1" i="1" u="sng" sz="3200"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:latin typeface="Georgia"/></a:rPr><a:t>Bold &amp; red</a:t></a:r><a:br/><a:r><a:rPr lang="es-PE" strike="sngStrike" cap="all"/><a:t>second line</a:t></a:r></a:p>' +
      para(
        "One",
        '<a:rPr lang="es-PE"/>',
        '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>',
      ) +
      para(
        "Two",
        '<a:rPr lang="es-PE"/>',
        '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>',
      ) +
      para(
        "Sub",
        '<a:rPr lang="es-PE"/>',
        '<a:pPr marL="742950" lvl="1" indent="-285750"><a:buAutoNum type="alphaLcParenR"/></a:pPr>',
      ) +
      para(
        "Three",
        '<a:rPr lang="es-PE"/>',
        '<a:pPr marL="342900" indent="-342900"><a:buAutoNum type="arabicPeriod"/></a:pPr>',
      );
    const out = convert(
      buildPptx({ slides: [{ shapes: textBox(4, { x: 0, y: 0, w: inch(6), h: inch(3) }, runs) }] }),
    );
    const html = out.deck.slides[0]?.html ?? "";
    expect(html).toContain("text-align:center");
    expect(html).toContain("font-weight:700");
    expect(html).toContain("font-style:italic");
    expect(html).toContain("text-decoration:underline");
    expect(html).toContain("color:#c00000");
    expect(html).toContain("font-family:'Source Serif 4',serif");
    expect(html).toContain("Bold &amp; red<");
    expect(html).toContain("<br>");
    expect(html).toContain("text-decoration:line-through");
    expect(html).toContain("text-transform:uppercase");
    expect(html).toMatch(/>1\.<\/span>.*One/);
    expect(html).toMatch(/>2\.<\/span>.*Two/);
    expect(html).toMatch(/>a\)<\/span>.*Sub/);
    expect(html).toMatch(/>3\.<\/span>.*Three/);
    expect(out.deck.lang).toBe("es-PE");
    expect(out.deck.theme?.fonts).toContain("Source Serif 4");
  });

  it("numbers bullets like PowerPoint", () => {
    expect(autoNumber("arabicPeriod", 3)).toBe("3.");
    expect(autoNumber("romanUcPeriod", 4)).toBe("IV.");
    expect(autoNumber("alphaLcParenBoth", 28)).toBe("(ab)");
    expect(autoNumber("arabicParenR", 2)).toBe("2)");
  });

  it("uses the layout's own placeholder position before the master's", () => {
    const layoutShapes =
      ph(2, "title", null, null, { x: inch(1), y: inch(2), w: inch(5), h: inch(1) }) +
      ph(3, null, 1, null);
    const out = convert(
      buildPptx({ layoutShapes, slides: [{ shapes: ph(2, "title", null, ["Moved title"]) }] }),
    );
    // 1 in = 914400 EMU -> 144 px on a 13.333 in wide 16:9 slide.
    expect(out.deck.slides[0]?.html).toContain("left:144px;top:288px;width:720px;height:144px");
  });

  it("fits 4:3 slides to the 4:3 canvas and odd sizes to the nearest one with a warning", () => {
    const four = convert(
      buildPptx({
        size: { cx: 9144000, cy: 6858000 },
        slides: [{ shapes: ph(2, "title", null, ["4:3"]) }],
      }),
    );
    expect(four.deck.aspectRatio).toBe("4:3");
    expect(features(four).some((f) => f.startsWith("PPTX_CANVAS_ADJUSTED"))).toBe(false);
    // 9144000 EMU -> 1440 px: 1 pt = 2 px as well (88 px × 0.87 for Calibri Light).
    expect(four.deck.slides[0]?.html).toContain("font-size:76.56px");

    const wide = convert(
      buildPptx({
        size: { cx: 12192000, cy: 7620000 },
        slides: [{ shapes: ph(2, "title", null, ["16:10"]) }],
      }),
    );
    expect(wide.deck.aspectRatio).toBe("16:9");
    expect(features(wide)).toContain("PPTX_CANVAS_ADJUSTED:slide-size:");
  });

  it("writes speaker notes as escaped Markdown, slide sections and hidden slides", () => {
    const out = convert(
      buildPptx({
        sections: [
          { name: "Intro", slides: [0] },
          { name: "Details", slides: [1] },
        ],
        slides: [
          {
            shapes: ph(2, "title", null, ["One"]),
            notes: "Say *hello* to [everyone]\n\n1. not a list\n\n# not a heading",
          },
          { shapes: ph(2, "title", null, ["Two"]), attrs: 'show="0"' },
        ],
      }),
    );
    const [one, two] = out.deck.slides;
    expect(one?.notes).toBe(
      "Say \\*hello\\* to \\[everyone\\]\n\n1\\. not a list\n\n\\# not a heading",
    );
    expect(one?.section).toBe("Intro");
    expect(two?.section).toBe("Details");
    expect(two?.notes).toBeUndefined();
    expect(features(out)).toContain("PPTX_FEATURE_SIMPLIFIED:hidden:2");
  });
});

describe("convertPptx: pictures, shapes, groups, tables, backgrounds", () => {
  it("uploads pictures as assets with alt text and crop, deduplicated", () => {
    const png = pngBytes(64, 48);
    const out = convert(
      buildPptx({
        media: { "image1.png": png, "image2.jpeg": jpegBytes(8, 8) },
        slides: [
          {
            shapes:
              picture(4, "rId2", { x: 0, y: 0, w: inch(2), h: inch(1.5) }, "A chart of sales") +
              picture(
                5,
                "rId2",
                { x: inch(3), y: 0, w: inch(2), h: inch(1.5) },
                "",
                '<a:srcRect l="10000" r="10000"/>',
              ) +
              picture(6, "rId3", { x: inch(6), y: 0, w: inch(1), h: inch(1) }),
            rels: [
              { id: "rId2", type: "image", target: "../media/image1.png" },
              { id: "rId3", type: "image", target: "../media/image2.jpeg" },
            ],
          },
        ],
      }),
    );
    expect(out.assets).toHaveLength(2);
    const pngAsset = out.assets.find((a) => a.mediaType === "image/png");
    expect(pngAsset?.width).toBe(64);
    const html = out.deck.slides[0]?.html ?? "";
    expect(html).toContain(`src="asset:${pngAsset?.sha256}" alt="A chart of sales"`);
    // Crop: 80 % visible width -> image 1.25× the box, shifted left by 10 %.
    expect(html).toContain("overflow:hidden");
    expect(html).toMatch(/left:-36px;top:0px;width:360px/);
  });

  it("replaces unsupported images with a placeholder and a warning", () => {
    const emf = new Uint8Array(80);
    emf.set([1, 0, 0, 0], 0);
    emf.set([0x20, 0x45, 0x4d, 0x46], 40);
    const huge = pngBytes(30000, 30000);
    const out = convert(
      buildPptx({
        media: { "image1.emf": emf, "image2.png": huge },
        slides: [
          {
            shapes:
              picture(4, "rId2", { x: 0, y: 0, w: inch(2), h: inch(2) }, "Logo") +
              picture(5, "rId3", { x: inch(3), y: 0, w: inch(2), h: inch(2) }) +
              picture(6, "rId4", { x: inch(6), y: 0, w: inch(2), h: inch(2) }),
            rels: [
              { id: "rId2", type: "image", target: "../media/image1.emf" },
              { id: "rId3", type: "image", target: "../media/image2.png" },
              { id: "rId4", type: "image", target: "http://example.com/x.png", external: true },
            ],
          },
        ],
      }),
    );
    expect(out.assets).toHaveLength(0);
    const html = out.deck.slides[0]?.html ?? "";
    expect(html.match(/role="img"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Logo"');
    const messages = out.warnings
      .filter((w) => w.code === "PPTX_IMAGE_DROPPED")
      .map((w) => w.message);
    expect(messages.join("\n")).toMatch(/EMF/);
    expect(messages.join("\n")).toMatch(/30000×30000/);
    expect(messages.join("\n")).toMatch(/never downloaded/);
    expect(messages.every((m) => m.startsWith("Slide 1:"))).toBe(true);
  });

  it("draws rectangles, ellipses, lines, preset polygons and theme-styled shapes", () => {
    const solid =
      '<a:solidFill><a:srgbClr val="00B050"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="dash"/></a:ln>';
    const styleRef =
      '<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent2"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>';
    const out = convert(
      buildPptx({
        slides: [
          {
            shapes:
              shape(4, "rect", { x: 0, y: 0, w: inch(1), h: inch(1) }, solid) +
              shape(
                5,
                "ellipse",
                { x: inch(2), y: 0, w: inch(1), h: inch(1) },
                "",
                `${styleRef}<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/>${para("In circle")}</p:txBody>`,
              ) +
              shape(
                6,
                "triangle",
                { x: inch(4), y: 0, w: inch(1), h: inch(1) },
                '<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill>',
              ) +
              `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="7" name="Line"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm flipV="1"><a:off x="${inch(6)}" y="0"/><a:ext cx="${inch(2)}" cy="${inch(1)}"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>` +
              shape(
                8,
                "cloud",
                { x: inch(9), y: 0, w: inch(1), h: inch(1) },
                '<a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill>',
              ),
          },
        ],
      }),
    );
    const html = out.deck.slides[0]?.html ?? "";
    expect(html).toContain("background:#00b050");
    expect(html).toContain("border:4px dashed #000000"); // 2 pt = 4 px on the 16:9 canvas
    expect(html).toContain("border-radius:50%");
    expect(html).toContain("background:#ed7d31"); // fillRef accent2
    expect(html).toContain("color:#ffffff"); // fontRef lt1
    expect(html).toContain("justify-content:safe center");
    expect(html).toMatch(/<svg[^>]*><path d="M72 0 L144 144 L0 144 Z" fill="#2f5597"/);
    expect(html).toMatch(/<line x1="0" y1="144" x2="288" y2="0" stroke="#ff0000"/);
    expect(html).toContain("<polygon");
    expect(features(out)).toContain("PPTX_FEATURE_SIMPLIFIED:shape:cloud:1");
  });

  it("flattens groups with their child coordinate space and keeps rotation", () => {
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${inch(1)}" y="${inch(1)}"/><a:ext cx="${inch(2)}" cy="${inch(2)}"/><a:chOff x="0" y="0"/><a:chExt cx="${inch(4)}" cy="${inch(4)}"/></a:xfrm></p:grpSpPr>${shape(11, "rect", { x: inch(2), y: inch(2), w: inch(2), h: inch(2) }, '<a:solidFill><a:srgbClr val="112233"/></a:solidFill>').replace("<a:xfrm>", '<a:xfrm rot="5400000">')}</p:grpSp>`;
    const out = convert(buildPptx({ slides: [{ shapes: group }] }));
    // Child at (2 in, 2 in) of a 4 in space scaled 0.5 into a group at 1 in: (2 in, 2 in), 1 in square.
    expect(out.deck.slides[0]?.html).toContain(
      "left:288px;top:288px;width:144px;height:144px;transform:rotate(90deg)",
    );
  });

  it("converts a basic table, approximating the table style", () => {
    const cell = (t: string, extra = "") =>
      `<a:tc${extra}><a:txBody><a:bodyPr/><a:lstStyle/>${para(t)}</a:txBody><a:tcPr/></a:tc>`;
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${inch(1)}" y="${inch(1)}"/><a:ext cx="${inch(4)}" cy="${inch(1)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="${inch(2)}"/><a:gridCol w="${inch(2)}"/></a:tblGrid><a:tr h="${inch(0.5)}">${cell("Name")}${cell("Score")}</a:tr><a:tr h="${inch(0.5)}">${cell("Merged", ' gridSpan="2"')}${cell("", ' hMerge="1"')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const out = convert(buildPptx({ slides: [{ shapes: table }] }));
    const html = out.deck.slides[0]?.html ?? "";
    expect(html).toContain("<table");
    expect(html).toContain('<col style="width:288px">');
    expect(html).toContain('colspan="2"');
    expect(html.match(/<td/g)).toHaveLength(3);
    expect(html).toContain("background:#4472c4");
    expect(features(out)).toContain("PPTX_FEATURE_SIMPLIFIED:table-style:1");
  });

  it("converts solid, gradient and picture backgrounds and master shapes", () => {
    const gif = gifBytes(4, 4);
    const out = convert(
      buildPptx({
        media: { "image1.gif": gif },
        masterShapes: shape(
          9,
          "rect",
          { x: 0, y: inch(7), w: inch(13.333), h: inch(0.5) },
          '<a:solidFill><a:srgbClr val="222222"/></a:solidFill>',
        ),
        slides: [
          {
            shapes: "",
            background:
              '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFEEDD"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>',
          },
          {
            shapes: "",
            background:
              '<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>',
          },
          {
            shapes: "",
            background:
              '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>',
            rels: [{ id: "rId2", type: "image", target: "../media/image1.gif" }],
          },
          { shapes: "" },
        ],
      }),
    );
    const [a, b, c, d] = out.deck.slides;
    expect(a?.css).toBe(":root{background:#ffeedd}");
    expect(b?.css).toBe(":root{background:linear-gradient(180deg,#000000 0%,#ffffff 100%)}");
    expect(c?.css).toBe(
      `:root{background:url(asset:${out.assets[0]?.sha256}) center/100% 100% no-repeat}`,
    );
    expect(d?.css).toBe(":root{background:#ffffff}");
    expect(a?.html).toContain("background:#222222");
  });
});

describe("convertPptx: unsupported features become per-slide warnings", () => {
  it("reports charts, SmartArt, OLE, video, transitions, animations, 3D, ink and macros", () => {
    const frame = (id: number, uri: string) =>
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="F"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="${inch(2)}" cy="${inch(2)}"/></p:xfrm><a:graphic><a:graphicData uri="${uri}"><x:any xmlns:x="urn:x"/></a:graphicData></a:graphic></p:graphicFrame>`;
    const timing = `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>
<p:par><p:cTn id="3" fill="hold"><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:childTnLst><p:par><p:cTn id="5" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:childTnLst><p:set><p:cBhvr><p:cTn id="6"/><p:tgtEl><p:spTgt spid="5"/></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>
<p:par><p:cTn id="7" fill="hold"><p:childTnLst><p:par><p:cTn id="8" fill="hold"><p:childTnLst><p:par><p:cTn id="9" presetID="10" presetClass="entr" fill="hold" nodeType="clickEffect"><p:childTnLst><p:set><p:cBhvr><p:cTn id="10"/><p:tgtEl><p:spTgt spid="6"><p:txEl><p:pRg st="1" end="1"/></p:txEl></p:spTgt></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>
<p:par><p:cTn id="11" fill="hold"><p:childTnLst><p:par><p:cTn id="12" fill="hold"><p:childTnLst><p:par><p:cTn id="13" presetID="1" presetClass="exit" fill="hold" nodeType="clickEffect"><p:childTnLst><p:set><p:cBhvr><p:cTn id="14"/><p:tgtEl><p:spTgt spid="5"/></p:tgtEl></p:cBhvr></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>
</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
    const video = `<p:pic><p:nvPicPr><p:cNvPr id="20" name="Video"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rId9"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${inch(2)}" cy="${inch(2)}"/></a:xfrm></p:spPr></p:pic>`;
    const out = convert(
      buildPptx({
        media: { "image1.png": pngBytes(8, 8) },
        extra: [
          { name: "ppt/vbaProject.bin", data: new Uint8Array([1, 2, 3]) },
          { name: "ppt/embeddings/oleObject1.bin", data: new Uint8Array([4, 5, 6]) },
        ],
        mainContentType: "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
        slides: [
          { shapes: frame(4, "http://schemas.openxmlformats.org/drawingml/2006/chart") },
          {
            shapes:
              frame(4, "http://schemas.openxmlformats.org/drawingml/2006/diagram") +
              frame(5, "http://schemas.openxmlformats.org/presentationml/2006/ole"),
          },
          {
            shapes:
              shape(
                5,
                "rect",
                { x: 0, y: 0, w: inch(1), h: inch(1) },
                '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d/>',
              ) +
              textBox(
                6,
                { x: inch(2), y: 0, w: inch(3), h: inch(2) },
                para("first") + para("second"),
              ) +
              video +
              '<p:contentPart r:id="rId8"/>',
            after: `<p:transition spd="slow"><p:fade/></p:transition>${timing}`,
            rels: [
              { id: "rId2", type: "image", target: "../media/image1.png" },
              { id: "rId9", type: "video", target: "https://example.com/v.mp4", external: true },
            ],
          },
        ],
      }),
    );
    const f = features(out);
    expect(f).toContain("PPTX_FEATURE_DROPPED:chart:1");
    expect(f).toContain("PPTX_FEATURE_DROPPED:smartart:2");
    expect(f).toContain("PPTX_FEATURE_DROPPED:ole:2");
    expect(f).toContain("PPTX_FEATURE_DROPPED:3d:3");
    expect(f).toContain("PPTX_FEATURE_DROPPED:video:3");
    expect(f).toContain("PPTX_FEATURE_DROPPED:ink:3");
    expect(f).toContain("PPTX_FEATURE_DROPPED:transition:3");
    expect(f).toContain("PPTX_FEATURE_DROPPED:animation:3");
    expect(f).toContain("PPTX_FEATURE_SIMPLIFIED:animation-steps:3");
    expect(f).toContain("PPTX_FEATURE_DROPPED:macros:");
    for (const w of out.warnings.filter((x) => x.slide !== undefined)) {
      expect(w.message.startsWith(`Slide ${w.slide}:`)).toBe(true);
    }
    // Entrance effects became steps: the rectangle on click 1, the text box's second paragraph on click 2.
    const html = out.deck.slides[2]?.html ?? "";
    expect(html).toMatch(/<div data-step="1" style="position:absolute;left:0px/);
    expect(html).toMatch(/<p data-step="2"[^>]*>.*second/);
    expect(html).not.toMatch(/<p data-step="\d+"[^>]*>.*first/);
    // Video poster kept, charts and SmartArt replaced by placeholders.
    expect(out.assets).toHaveLength(1);
    expect(out.deck.slides[0]?.html).toContain('aria-label="Chart"');
    // The macro part is never read.
    expect(JSON.stringify(out.deck)).not.toContain("vbaProject");
  });
});
