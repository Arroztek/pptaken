// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { checkImportFile, groupWarnings, importKindOf } from "./transfer";

describe("checkImportFile", () => {
  it("accepts .pkn, .zip and PowerPoint files up to 100 MB", () => {
    expect(checkImportFile({ name: "Talk.pkn", size: 10 })).toBeNull();
    expect(checkImportFile({ name: "talk.PKN", size: 10 })).toBeNull();
    expect(checkImportFile({ name: "talk.zip", size: 100 * 1024 * 1024 })).toBeNull();
    expect(checkImportFile({ name: "Deck.pptx", size: 10 })).toBeNull();
    expect(checkImportFile({ name: "macros.PPTM", size: 10 })).toBeNull();
  });

  it("refuses other files, empty files and files over the limit", () => {
    expect(checkImportFile({ name: "talk.html", size: 10 })).toBe("wrongType");
    // The old, never-released extension is not accepted.
    expect(checkImportFile({ name: "talk.pptaken", size: 10 })).toBe("wrongType");
    expect(checkImportFile({ name: "talk.pkn", size: 0 })).toBe("wrongType");
    expect(checkImportFile({ name: "talk.pkn", size: 100 * 1024 * 1024 + 1 })).toBe("tooLarge");
    expect(checkImportFile({ name: "deck.pptx", size: 100 * 1024 * 1024 + 1 })).toBe("tooLarge");
  });

  it("explains old PowerPoint files", () => {
    expect(checkImportFile({ name: "old.ppt", size: 10 })).toBe("legacyPpt");
    expect(checkImportFile({ name: "OLD.PPS", size: 10 })).toBe("legacyPpt");
  });
});

describe("importKindOf", () => {
  it("routes archives and PowerPoint files to their endpoints", () => {
    expect(importKindOf("a.pkn")).toBe("archive");
    expect(importKindOf("a.zip")).toBe("archive");
    expect(importKindOf("a.pptx")).toBe("pptx");
    expect(importKindOf("a.potx")).toBe("pptx");
    expect(importKindOf("a.ppt")).toBeNull();
    expect(importKindOf("pptx")).toBeNull();
  });
});

describe("groupWarnings", () => {
  it("groups by kind in a fixed order and keeps the server order inside a group", () => {
    const w = (code: string, message: string) => ({
      code,
      message,
      path: null,
      slideId: null,
      name: null,
    });
    const groups = groupWarnings([
      w("PPTX_FONT_REPLACED", "font"),
      w("PPTX_FEATURE_DROPPED", "Slide 2: chart"),
      w("REMOVED_ATTRIBUTE", "attr"),
      w("PPTX_FEATURE_DROPPED", "Slide 3: video"),
      w("UNUSED_ASSET", "unused"),
    ]);
    expect(groups.map((g) => g.group)).toEqual(["dropped", "fonts", "safety", "other"]);
    expect(groups[0]?.items.map((i) => i.message)).toEqual(["Slide 2: chart", "Slide 3: video"]);
  });
});
