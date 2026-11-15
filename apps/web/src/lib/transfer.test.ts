// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { checkImportFile } from "./transfer";

describe("checkImportFile", () => {
  it("accepts .pptaken and .zip files up to 100 MB", () => {
    expect(checkImportFile({ name: "Talk.pptaken", size: 10 })).toBeNull();
    expect(checkImportFile({ name: "talk.PPTAKEN", size: 10 })).toBeNull();
    expect(checkImportFile({ name: "talk.zip", size: 100 * 1024 * 1024 })).toBeNull();
  });

  it("refuses other files, empty files and files over the limit", () => {
    expect(checkImportFile({ name: "talk.html", size: 10 })).toBe("wrongType");
    expect(checkImportFile({ name: "talk.pptaken", size: 0 })).toBe("wrongType");
    expect(checkImportFile({ name: "talk.pptaken", size: 100 * 1024 * 1024 + 1 })).toBe("tooLarge");
  });
});
