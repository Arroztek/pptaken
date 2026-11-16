// SPDX-License-Identifier: AGPL-3.0-or-later
// Hostile corpus: every file must be refused with a PptxError or converted within limits, quickly, and nothing
// else may escape (no crash, no hang, no unbounded memory). The isolated runner is checked for its time limit.
import { sanitizeDeck } from "@pptaken/sanitizer";
import { LIMITS, parseDeck } from "@pptaken/schema";
import { pngBytes } from "@pptaken/testing";
import {
  buildPptx,
  escapeXml,
  inch,
  NS,
  para,
  ph,
  picture,
  shape,
  textBox,
} from "@pptaken/testing/pptx";
import { crc32, openZip, writeZip, type ZipInputEntry } from "@pptaken/zip";
import { describe, expect, it } from "vitest";
import {
  convertPptx,
  isPptxError,
  type PptxConversion,
  PptxError,
  type PptxErrorCode,
} from "../src/index.js";

const enc = new TextEncoder();

function outcome(bytes: Uint8Array): PptxErrorCode | PptxConversion {
  const started = performance.now();
  try {
    const out = convertPptx(bytes);
    // Whatever comes out must fit the format and survive the sanitizer, like the server path.
    const parsed = parseDeck(out.deck);
    expect(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.issues.slice(0, 2))).toBe(true);
    if (parsed.ok) sanitizeDeck(parsed.deck);
    return out;
  } catch (error) {
    if (!isPptxError(error)) throw error;
    return error.code;
  } finally {
    expect(performance.now() - started).toBeLessThan(10_000);
  }
}

function errorOf(bytes: Uint8Array): PptxError {
  try {
    convertPptx(bytes);
  } catch (error) {
    if (error instanceof PptxError) return error;
    throw error;
  }
  throw new Error("expected a PptxError");
}

/** Rebuilds a valid package with some parts replaced (raw bytes, as given). */
function withParts(
  replace: Record<string, Uint8Array | string>,
  base = buildPptx({ slides: [{ shapes: "" }] }),
): Uint8Array {
  // Re-zip from the generator's entries: regenerate by name.
  const entries = readStored(base);
  for (const [name, data] of Object.entries(replace)) {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    const at = entries.findIndex((e) => e.name === name);
    if (at >= 0) entries[at] = { name, data: bytes, compress: true };
    else entries.push({ name, data: bytes, compress: true });
  }
  return writeZip(entries);
}

function readStored(bytes: Uint8Array): ZipInputEntry[] {
  const zip = openZip(bytes, {
    maxEntries: 10_000,
    maxTotalBytes: 1e9,
    maxEntryBytes: () => 1e9,
    maxRatio: 1e9,
  });
  return zip.names.map((name) => ({ name, data: zip.read(name) as Uint8Array, compress: true }));
}

/** A ZIP whose central directory entries all point to the same local header (overlapping entries). */
function overlapping(): Uint8Array {
  const data = enc.encode("<x/>");
  const name = enc.encode("ppt/presentation.xml");
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0x0800, true);
  lv.setUint32(14, crc32(data), true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  const centrals: Uint8Array[] = [];
  for (const n of ["ppt/presentation.xml", "ppt/slides/slide1.xml"]) {
    const nb = enc.encode(n);
    const c = new Uint8Array(46 + nb.length);
    const v = new DataView(c.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 0x0314, true);
    v.setUint16(6, 20, true);
    v.setUint16(8, 0x0800, true);
    v.setUint32(16, crc32(data), true);
    v.setUint32(20, data.length, true);
    v.setUint32(24, data.length, true);
    v.setUint16(28, nb.length, true);
    v.setUint32(38, (0o100644 << 16) >>> 0, true);
    v.setUint32(42, 0, true);
    c.set(nb, 46);
    centrals.push(c);
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 2, true);
  ev.setUint16(10, 2, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, local.length + data.length, true);
  const parts = [local, data, ...centrals, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Start tags of serialized HTML with their attribute names (attribute values skipped, quotes respected). */
function tagsOf(html: string): { name: string; attrs: string[] }[] {
  const out: { name: string; attrs: string[] }[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<" && /[a-z]/i.test(html[i + 1] ?? "")) {
      let j = i + 1;
      while (j < html.length && /[a-z0-9-]/i.test(html[j] as string)) j++;
      const tag = { name: html.slice(i + 1, j).toLowerCase(), attrs: [] as string[] };
      while (j < html.length && html[j] !== ">") {
        const m = /^\s*([^\s=>]+)(?:="[^"]*")?/.exec(html.slice(j));
        if (m === null || m[0] === "") {
          j++;
          continue;
        }
        tag.attrs.push((m[1] as string).toLowerCase());
        j += m[0].length;
      }
      out.push(tag);
      i = j;
    } else i++;
  }
  return out;
}

function cfb(streamName: string): Uint8Array {
  const out = new Uint8Array(4096);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  const name = Buffer.from(streamName, "utf16le");
  out.set(name, 1024);
  return out;
}

const slideXml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree></p:cSld></p:sld>`;

describe("hostile files are refused or contained", () => {
  it("refuses a ZIP bomb in a part that is read", () => {
    const zeros = new Uint8Array(15 * 1024 * 1024);
    const bytes = withParts({ "ppt/slides/slide1.xml": zeros });
    const e = errorOf(bytes);
    expect(e.code).toBe("INVALID_FILE");
    expect(e.message).toMatch(/ZIP bomb|compressed more than/);
  });

  it("never inflates parts outside the allow-list (macros, embeddings, ActiveX), even bombs", () => {
    const base = buildPptx({ slides: [{ shapes: ph(2, "title", null, ["Macro deck"]) }] });
    const entries = readStored(base);
    entries.push({
      name: "ppt/vbaProject.bin",
      data: new Uint8Array(40 * 1024 * 1024),
      compress: true,
    });
    entries.push({
      name: "ppt/embeddings/oleObject1.bin",
      data: new Uint8Array(40 * 1024 * 1024),
      compress: true,
    });
    entries.push({ name: "ppt/activeX/activeX1.bin", data: enc.encode("x"), compress: true });
    const out = outcome(writeZip(entries));
    expect(typeof out).toBe("object");
    const conv = out as PptxConversion;
    expect(conv.deck.slides[0]?.title).toBe("Macro deck");
    expect(conv.warnings.map((w) => w.feature)).toEqual(
      expect.arrayContaining(["macros", "activex"]),
    );
  });

  it("refuses overlapping entries", () => {
    expect(errorOf(overlapping()).code).toBe("INVALID_FILE");
  });

  it("refuses DOCTYPE and ENTITY declarations (billion laughs, XXE) before parsing", () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><p:sld ${NS}><p:cSld><p:spTree><a:t>&lol3;</a:t></p:spTree></p:cSld></p:sld>`;
    let e = errorOf(withParts({ "ppt/slides/slide1.xml": laughs }));
    expect(e.code).toBe("INVALID_FILE");
    expect(e.message).toMatch(/DOCTYPE/);
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
    e = errorOf(withParts({ "_rels/.rels": xxe }));
    expect(e.code).toBe("INVALID_FILE");
    // An entity reference without a DTD is an error too, not an expansion.
    e = errorOf(withParts({ "ppt/slides/slide1.xml": slideXml("<p:sp>&undefined;</p:sp>") }));
    expect(e.code).toBe("INVALID_FILE");
  });

  it("refuses path traversal names and confines relationship targets to the package", () => {
    const entries = readStored(buildPptx({ slides: [{ shapes: "" }] }));
    entries.push({ name: "ppt/media/ok.png", data: pngBytes(), compress: false });
    const zip = writeZip(entries);
    // Rename an entry to a traversal name in both headers (same length keeps the archive consistent).
    const target = enc.encode("ppt/media/ok.png");
    const evil = enc.encode("../../../etc/pwn");
    expect(evil.length).toBe(target.length);
    const patched = zip.slice();
    for (let i = 0; i < patched.length - target.length; i++) {
      if (target.every((b, j) => patched[i + j] === b)) patched.set(evil, i);
    }
    expect(errorOf(patched).message).toMatch(/Unsafe entry name/);

    // Relationship targets that leave the package are never resolved.
    const out = outcome(
      buildPptx({
        slides: [
          {
            shapes:
              picture(4, "rId2", { x: 0, y: 0, w: inch(1), h: inch(1) }) +
              picture(5, "rId3", { x: 0, y: 0, w: inch(1), h: inch(1) }),
            rels: [
              { id: "rId2", type: "image", target: "../../../../etc/passwd" },
              { id: "rId3", type: "image", target: "file:///C:/Windows/win.ini" },
            ],
          },
        ],
      }),
    ) as PptxConversion;
    expect(out.assets).toHaveLength(0);
    expect(out.warnings.filter((w) => w.code === "PPTX_IMAGE_DROPPED").length).toBeGreaterThan(0);
  });

  it("detects encrypted presentations and legacy .ppt files", () => {
    expect(errorOf(cfb("EncryptedPackage")).code).toBe("ENCRYPTED");
    const legacy = errorOf(cfb("PowerPoint Document"));
    expect(legacy.code).toBe("LEGACY_PPT");
    expect(legacy.hint).toMatch(/save it as \.pptx/);
    expect(errorOf(cfb("WordDocument")).code).toBe("NOT_PPTX");
    expect(errorOf(enc.encode("just some text, not a presentation")).code).toBe("NOT_PPTX");
    expect(errorOf(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])).code).toBe("INVALID_FILE");
  });

  it("refuses other Office documents", () => {
    const docx = writeZip([
      {
        name: "_rels/.rels",
        data: enc.encode(
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        ),
      },
      { name: "word/document.xml", data: enc.encode("<w:document/>") },
    ]);
    expect(errorOf(docx).code).toBe("NOT_PPTX");
  });

  it("contains giant image dimensions without decoding anything", () => {
    const out = outcome(
      buildPptx({
        media: { "image1.png": pngBytes(2 ** 31 - 1, 2 ** 31 - 1) },
        slides: [
          {
            shapes: picture(4, "rId2", { x: 0, y: 0, w: inch(1), h: inch(1) }),
            rels: [{ id: "rId2", type: "image", target: "../media/image1.png" }],
          },
        ],
      }),
    ) as PptxConversion;
    expect(out.assets).toHaveLength(0);
    expect(out.warnings.some((w) => w.code === "PPTX_IMAGE_DROPPED")).toBe(true);
  });

  it("refuses 10,000 slides (by count) and archives with too many entries", () => {
    const ids = Array.from(
      { length: 10_000 },
      (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 10}"/>`,
    ).join("");
    const pres = `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`;
    const e = errorOf(withParts({ "ppt/presentation.xml": pres }));
    expect(e.code).toBe("TOO_LARGE");
    expect(e.message).toMatch(/10000 slides/);

    const entries = readStored(buildPptx({ slides: [{ shapes: "" }] }));
    for (let i = 0; i < 6000; i++)
      entries.push({ name: `ppt/slides/slide${i + 100}.xml`, data: enc.encode("<x/>") });
    expect(errorOf(writeZip(entries)).code).toBe("TOO_LARGE");
  });

  it("contains deeply nested groups: XML depth is capped, group depth is cut with a warning", () => {
    const group = (inner: string, id: number) =>
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:grpSp>`;
    let deep = shape(
      9999,
      "rect",
      { x: 0, y: 0, w: 10, h: 10 },
      '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>',
    );
    for (let i = 0; i < 3000; i++) deep = group(deep, i + 10);
    expect(errorOf(withParts({ "ppt/slides/slide1.xml": slideXml(deep) })).message).toMatch(
      /nested too deeply/,
    );

    let medium = shape(
      9999,
      "rect",
      { x: 0, y: 0, w: 10, h: 10 },
      '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>',
    );
    for (let i = 0; i < 40; i++) medium = group(medium, i + 10);
    const out = outcome(withParts({ "ppt/slides/slide1.xml": slideXml(medium) })) as PptxConversion;
    expect(out.warnings.map((w) => w.feature)).toContain("nested-groups");
  });

  it("refuses truncated XML and malformed UTF-8", () => {
    const good = slideXml(ph(2, "title", null, ["Title"]));
    expect(
      errorOf(withParts({ "ppt/slides/slide1.xml": good.slice(0, good.length - 40) })).code,
    ).toBe("INVALID_FILE");
    const bad = enc.encode(good);
    const broken = new Uint8Array(bad.length + 2);
    broken.set(bad.subarray(0, 200), 0);
    broken.set([0xc3, 0x28], 200);
    broken.set(bad.subarray(200), 202);
    expect(errorOf(withParts({ "ppt/slides/slide1.xml": broken })).message).toMatch(/UTF-8/);
  });

  it("never follows external relationships (slides, images, hyperlinks)", () => {
    const base = buildPptx({
      slides: [
        {
          shapes:
            textBox(
              4,
              { x: 0, y: 0, w: inch(3), h: inch(1) },
              para("click me", '<a:rPr lang="en-US"><a:hlinkClick r:id="rId5"/></a:rPr>'),
            ) + picture(5, "rId6", { x: 0, y: inch(2), w: inch(1), h: inch(1) }),
          rels: [
            {
              id: "rId5",
              type: "hyperlink",
              target: "http://attacker.example/track",
              external: true,
            },
            {
              id: "rId6",
              type: "image",
              target: "http://attacker.example/pixel.png",
              external: true,
            },
          ],
        },
      ],
    });
    const out = outcome(base) as PptxConversion;
    const json = JSON.stringify(out.deck);
    expect(json).not.toContain("attacker.example");
    expect(out.deck.slides[0]?.html).toContain("click me");
    expect(out.warnings.map((w) => w.feature)).toEqual(
      expect.arrayContaining(["links", "linked-image"]),
    );
    // An external relationship used as a slide is a missing slide, not a fetch.
    const presRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="http://attacker.example/slide.xml" TargetMode="External"/></Relationships>`;
    expect(errorOf(withParts({ "ppt/_rels/presentation.xml.rels": presRels })).message).toMatch(
      /No slide/,
    );
  });

  it("escapes hostile text, alt text and font names", () => {
    const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>"'`;
    const out = outcome(
      buildPptx({
        media: { "image1.png": pngBytes() },
        slides: [
          {
            shapes:
              textBox(
                4,
                { x: 0, y: 0, w: inch(5), h: inch(1) },
                para(
                  evil,
                  `<a:rPr lang="en-US"><a:latin typeface="${escapeXml(`x';}*{background:url(http://e/)}`)}"/></a:rPr>`,
                ),
              ) + picture(5, "rId2", { x: 0, y: inch(2), w: inch(1), h: inch(1) }, evil),
            rels: [{ id: "rId2", type: "image", target: "../media/image1.png" }],
            notes: evil,
          },
        ],
      }),
    ) as PptxConversion;
    const parsed = parseDeck(out.deck);
    if (!parsed.ok) throw new Error("schema");
    const clean = sanitizeDeck(parsed.deck);
    expect(clean.warnings).toEqual([]);
    const html = clean.deck.slides[0]?.html ?? "";
    // Outside attribute values (where `<` is inert text), no element or handler was created.
    const tags = tagsOf(html);
    expect(tags.map((t) => t.name)).not.toContain("script");
    expect(tags.filter((t) => t.name === "img")).toHaveLength(1);
    expect(tags.flatMap((t) => t.attrs)).not.toContain("onerror");
    expect(html).not.toContain("http://e/");
    expect(html).toContain("&lt;script&gt;");
    expect(out.deck.slides[0]?.notes).toContain("\\<script\\>");
  });

  it("caps shapes per slide and slide HTML size", () => {
    const many = Array.from({ length: 1500 }, (_, i) =>
      shape(
        i + 10,
        "rect",
        { x: i * 100, y: 0, w: 1000, h: 1000 },
        '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>',
      ),
    ).join("");
    let out = outcome(withParts({ "ppt/slides/slide1.xml": slideXml(many) })) as PptxConversion;
    expect(out.warnings.map((w) => w.feature)).toContain("too-many-shapes");

    let n = 7;
    const words = Array.from({ length: 2000 }, () =>
      (n = (n * 7919 + 13) % 104729).toString(36),
    ).join(" ");
    const big = Array.from({ length: 40 }, (_, i) =>
      textBox(i + 10, { x: 0, y: 0, w: inch(5), h: inch(5) }, para(words)),
    ).join("");
    out = outcome(withParts({ "ppt/slides/slide1.xml": slideXml(big) })) as PptxConversion;
    expect((out.deck.slides[0]?.html ?? "").length).toBeLessThanOrEqual(LIMITS.maxSlideHtml);
    expect(out.warnings.map((w) => w.code)).toContain("PPTX_CONTENT_TRUNCATED");
  });

  it("random corruption only ever produces a PptxError (fuzz)", () => {
    const base = buildPptx({
      media: { "image1.png": pngBytes(8, 8) },
      slides: [
        {
          shapes:
            ph(2, "title", null, ["Fuzz"]) +
            picture(4, "rId2", { x: 0, y: 0, w: inch(1), h: inch(1) }),
          rels: [{ id: "rId2", type: "image", target: "../media/image1.png" }],
          notes: "notes",
        },
      ],
    });
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 300; round++) {
      const bytes = base.slice();
      const flips = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < flips; i++)
        bytes[Math.floor(rand() * bytes.length)] = Math.floor(rand() * 256);
      const cut = rand() < 0.2 ? Math.floor(rand() * bytes.length) : bytes.length;
      outcome(bytes.subarray(0, cut));
    }
  });
});

describe("the isolated runner", () => {
  it("converts in a worker and enforces the hard timeout", async () => {
    const { convertPptxIsolated } = await import("../dist/isolated.js");
    const bytes = buildPptx({ slides: [{ shapes: ph(2, "title", null, ["Isolated"]) }] });
    const out = await convertPptxIsolated(bytes, { timeoutMs: 20_000 });
    expect(out.deck.slides[0]?.title).toBe("Isolated");
    await expect(convertPptxIsolated(bytes, { timeoutMs: 1 })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    await expect(convertPptxIsolated(enc.encode("nope"))).rejects.toMatchObject({
      code: "NOT_PPTX",
    });
  });
});
