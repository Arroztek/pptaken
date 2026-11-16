// SPDX-License-Identifier: AGPL-3.0-or-later
// importPptx: owner only, converter output treated as untrusted (validated, sanitized, assets verified), the
// converter's warnings passed through with slide paths, the core's added after them, audited.
import {
  agentPrincipal,
  createTestCore,
  ownerPrincipal,
  pngBytes,
  svgBytes,
} from "@pptaken/testing";
import { describe, expect, it } from "vitest";
import { DomainError, isDomainError } from "../src/errors.js";
import type { PptxConversionOutput, PptxConverter } from "../src/ports.js";
import { sha256Hex } from "../src/sha256.js";

const owner = ownerPrincipal();
const png = pngBytes(20, 10);
const pngSha = sha256Hex(png);

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error("Expected a DomainError");
}

function converterOf(output: PptxConversionOutput, seen: unknown[] = []): PptxConverter {
  return async (bytes, limits) => {
    seen.push({ size: bytes.length, limits });
    return output;
  };
}

const output: PptxConversionOutput = {
  deck: {
    schemaVersion: 1,
    title: "From PowerPoint",
    aspectRatio: "4:3",
    slides: [
      {
        id: "slide-1",
        title: "Hello",
        html: `<div style="position:absolute;left:0px"><img src="asset:${pngSha}" alt="pic"></div><script>alert(1)</script>`,
        notes: "Speaker",
      },
      { id: "slide-2", title: "Two", html: "<p>Two</p>" },
    ],
  },
  assets: [{ sha256: pngSha, mediaType: "image/png", bytes: png }],
  warnings: [
    {
      code: "PPTX_FEATURE_DROPPED",
      message: "Slide 2: charts are not imported",
      slide: 2,
      feature: "chart",
    },
    {
      code: "PPTX_FONT_REPLACED",
      message: "The font Calibri was replaced by Inter",
      feature: "font:Calibri",
    },
    { code: "SOMETHING_ELSE", message: "x".repeat(1000) },
  ],
};

describe("importPptx", () => {
  it("stores the converted deck as a new presentation with merged warnings", async () => {
    const seen: unknown[] = [];
    const t = createTestCore({ convertPptx: converterOf(output, seen) });
    const result = await t.core.importPptx(owner, { bytes: new Uint8Array([1, 2, 3]) });
    expect(result).toMatchObject({
      revision: 1,
      slideCount: 2,
      assetCount: 1,
      title: "From PowerPoint",
    });
    expect(seen[0]).toMatchObject({ size: 3, limits: { maxSlides: 200, maxAssetsPerDeck: 200 } });
    const codes = result.warnings.map((w) => w.code);
    // Converter warnings first (unknown codes normalized, messages bounded), then the sanitizer's.
    expect(codes.slice(0, 3)).toEqual([
      "PPTX_FEATURE_DROPPED",
      "PPTX_FONT_REPLACED",
      "PPTX_FEATURE_DROPPED",
    ]);
    expect(result.warnings[0]).toMatchObject({
      path: "slides[1]",
      slideId: "slide-2",
      name: "chart",
    });
    expect(result.warnings[2]?.message.length).toBeLessThanOrEqual(300);
    expect(codes).toContain("REMOVED_ELEMENT");

    const revision = await t.core.getRevision(owner, {
      presentationId: result.presentationId,
      revision: 1,
    });
    expect(revision.document.aspectRatio).toBe("4:3");
    expect(revision.document.slides[0]?.html).not.toContain("<script");
    expect(revision.document.slides[0]?.notes).toBe("Speaker");
    expect(revision.summary).toBe("Imported from PowerPoint with 2 slide(s)");
    expect(await t.blobs.has(pngSha)).toBe(true);
    const audit = await t.core.listAuditLog(owner, { target: `deck:${result.presentationId}` });
    expect(audit.items[0]).toMatchObject({
      action: "presentation.import_pptx",
      result: "ok",
      detail: { source: "pptx", slides: 2, assets: 1 },
    });
  });

  it("uses the given title", async () => {
    const t = createTestCore({ convertPptx: converterOf(output) });
    const result = await t.core.importPptx(owner, { bytes: new Uint8Array([1]), title: "Renamed" });
    expect(result.title).toBe("Renamed");
  });

  it("is for the owner only and needs a converter and a file", async () => {
    const t = createTestCore({ convertPptx: converterOf(output) });
    expect(
      (await failure(t.core.importPptx(agentPrincipal(), { bytes: new Uint8Array([1]) }))).code,
    ).toBe("FORBIDDEN_ACTOR");
    expect((await failure(t.core.importPptx(owner, { bytes: new Uint8Array() }))).code).toBe(
      "VALIDATION_ERROR",
    );
    const none = createTestCore();
    expect((await failure(none.core.importPptx(owner, { bytes: new Uint8Array([1]) }))).code).toBe(
      "UNSUPPORTED_MEDIA",
    );
    const audit = await t.core.listAuditLog(owner, {});
    expect(
      audit.items.some((e) => e.action === "presentation.import_pptx" && e.result === "denied"),
    ).toBe(true);
  });

  it("treats converter output as untrusted: bad decks and disguised assets are refused", async () => {
    const badDeck = createTestCore({
      convertPptx: converterOf({ ...output, deck: { schemaVersion: 1, title: "", slides: [] } }),
    });
    expect(
      (await failure(badDeck.core.importPptx(owner, { bytes: new Uint8Array([1]) }))).code,
    ).toBe("VALIDATION_ERROR");
    const svg = svgBytes();
    const disguised = createTestCore({
      convertPptx: converterOf({
        ...output,
        assets: [{ sha256: sha256Hex(svg), mediaType: "image/png", bytes: svg }],
      }),
    });
    expect(
      (await failure(disguised.core.importPptx(owner, { bytes: new Uint8Array([1]) }))).code,
    ).toBe("UNSUPPORTED_MEDIA");
    const tooMany = createTestCore({
      config: { limits: { maxSlides: 1 } },
      convertPptx: converterOf(output),
    });
    expect(
      (await failure(tooMany.core.importPptx(owner, { bytes: new Uint8Array([1]) }))).code,
    ).toBe("LIMIT_EXCEEDED");
  });

  it("passes converter refusals through", async () => {
    const t = createTestCore({
      convertPptx: async () => {
        throw new DomainError("UNSUPPORTED_MEDIA", "This is a PowerPoint 97-2003 (.ppt) file", {
          hint: "Save it as .pptx",
        });
      },
    });
    const e = await failure(t.core.importPptx(owner, { bytes: new Uint8Array([1]) }));
    expect(e.code).toBe("UNSUPPORTED_MEDIA");
    expect(e.hint).toBe("Save it as .pptx");
  });
});
