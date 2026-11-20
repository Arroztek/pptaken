// SPDX-License-Identifier: AGPL-3.0-or-later
// The licence gate of the build: unknown or incompatible licences and missing licence texts stop the build.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error: plain ESM build script without type declarations
import * as licenses from "../scripts/licenses.mjs";

interface Text {
  name: string;
  text: string;
}
interface Component {
  name: string;
  version: string;
  license: string | null;
  how?: string;
  homepage?: string;
  texts: Text[];
}
interface FirstParty {
  name: string;
  version: string;
  license: string | null;
}
const L = licenses as {
  isAllowedExpression(expr: unknown): boolean;
  licenseOf(pkg: Record<string, unknown>): string | null;
  gateProblems(c: { thirdParty: Component[]; firstParty: FirstParty[] }): string[];
  enforceGate(c: { thirdParty: Component[]; firstParty: FirstParty[] }): void;
  componentsFromMetafile(
    metafile: { inputs: Record<string, unknown> },
    opts: { workingDir: string; root: string },
  ): { thirdParty: Component[]; firstParty: FirstParty[] };
  renderNotices(input: {
    product: string;
    version: string;
    thirdParty: Component[];
    firstParty: FirstParty[];
  }): string;
  LicenseGateError: new (problems: string[]) => Error;
};

const MIT: Text = { name: "LICENSE", text: "MIT License\n\nCopyright (c) Someone" };
const ok = (name: string, license: string | null, texts: Text[] = [MIT]): Component => ({
  name,
  version: "1.0.0",
  license,
  how: "bundled",
  texts,
});

describe("SPDX expressions", () => {
  it("accepts permissive licences and OR choices with one acceptable side", () => {
    for (const expr of [
      "MIT",
      "ISC",
      "Apache-2.0",
      "BSD-3-Clause",
      "(MIT OR Apache-2.0)",
      "MIT OR GPL-3.0-only",
      "(MIT AND BSD-2-Clause)",
      "CC0-1.0",
      "OFL-1.1",
    ]) {
      expect(L.isAllowedExpression(expr), expr).toBe(true);
    }
  });

  it("refuses unknown, copyleft, exception and malformed expressions", () => {
    for (const expr of [
      "GPL-3.0-only",
      "GPL-2.0-only",
      "SSPL-1.0",
      "BUSL-1.1",
      "UNLICENSED",
      "SEE LICENSE IN LICENSE.md",
      "MIT AND GPL-2.0-only",
      "GPL-2.0-only WITH Classpath-exception-2.0",
      "(MIT",
      "MIT OR",
      "",
      null,
    ]) {
      expect(L.isAllowedExpression(expr), String(expr)).toBe(false);
    }
  });

  it("reads the license field in its old shapes too", () => {
    expect(L.licenseOf({ license: "MIT" })).toBe("MIT");
    expect(L.licenseOf({ license: { type: "ISC" } })).toBe("ISC");
    expect(L.licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
      "(MIT OR Apache-2.0)",
    );
    expect(L.licenseOf({})).toBeNull();
  });
});

describe("the gate", () => {
  it("passes for compatible licences with texts", () => {
    expect(
      L.gateProblems({
        thirdParty: [ok("a", "MIT"), ok("b", "(MIT OR Apache-2.0)")],
        firstParty: [{ name: "@pptaken/core", version: "0.0.0", license: "AGPL-3.0-or-later" }],
      }),
    ).toEqual([]);
  });

  it("stops on an unknown or incompatible licence, a missing licence or missing text", () => {
    const problems = L.gateProblems({
      thirdParty: [
        ok("gpl", "GPL-3.0-only"),
        ok("none", null),
        ok("weird", "WTFPL"),
        ok("bare", "MIT", []),
      ],
      firstParty: [{ name: "@pptaken/x", version: "0.0.0", license: "MIT" }],
    });
    expect(problems).toEqual([
      'gpl@1.0.0: licence "GPL-3.0-only" is not on the allowlist',
      "none@1.0.0: no licence declared",
      'weird@1.0.0: licence "WTFPL" is not on the allowlist',
      "bare@1.0.0: no LICENSE/NOTICE file to ship with it",
      '@pptaken/x: first-party licence "MIT" is neither AGPL-3.0-or-later nor Apache-2.0',
    ]);
    expect(() =>
      L.enforceGate({ thirdParty: [ok("gpl", "GPL-3.0-only")], firstParty: [] }),
    ).toThrow(L.LicenseGateError);
  });
});

describe("components from an esbuild metafile", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pptaken-lic-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, content: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write(
    "packages/core/package.json",
    JSON.stringify({ name: "@pptaken/core", version: "0.0.0", license: "AGPL-3.0-or-later" }),
  );
  write("packages/core/dist/index.js", "");
  write(
    "node_modules/dep/package.json",
    JSON.stringify({ name: "dep", version: "2.0.0", license: "MIT" }),
  );
  write("node_modules/dep/LICENSE", "MIT text");
  write("node_modules/dep/lib/esm/package.json", JSON.stringify({ type: "module" }));
  write("node_modules/dep/lib/esm/index.js", "");
  write(
    "node_modules/bad/package.json",
    JSON.stringify({ name: "bad", version: "1.0.0", license: "SSPL-1.0" }),
  );
  write("node_modules/bad/index.js", "");

  it("splits first- and third-party code, skips nested type-only package.json files, and gates", () => {
    const result = L.componentsFromMetafile(
      {
        inputs: {
          "packages/core/dist/index.js": {},
          "node_modules/dep/lib/esm/index.js": {},
          "node_modules/bad/index.js": {},
          "<runtime>": {},
        },
      },
      { workingDir: root, root },
    );
    expect(result.firstParty.map((c) => c.name)).toEqual(["@pptaken/core"]);
    expect(result.thirdParty.map((c) => `${c.name}@${c.version}`).sort()).toEqual([
      "bad@1.0.0",
      "dep@2.0.0",
    ]);
    expect(result.thirdParty.find((c) => c.name === "dep")?.texts).toEqual([
      { name: "LICENSE", text: "MIT text" },
    ]);
    expect(L.gateProblems(result)).toEqual([
      'bad@1.0.0: licence "SSPL-1.0" is not on the allowlist',
      "bad@1.0.0: no LICENSE/NOTICE file to ship with it",
    ]);
  });

  it("renders deterministic notices with every licence text", () => {
    const input = {
      product: "PPTaken",
      version: "1.2.3",
      thirdParty: [
        ok("zeta", "MIT"),
        ok("alpha", "ISC", [{ name: "LICENSE", text: "has ``` fences" }]),
      ],
      firstParty: [{ name: "@pptaken/core", version: "0.0.0", license: "AGPL-3.0-or-later" }],
    };
    const text = L.renderNotices(input);
    expect(L.renderNotices(input)).toBe(text);
    expect(text.indexOf("### alpha")).toBeLessThan(text.indexOf("### zeta"));
    expect(text).toContain("| zeta | 1.0.0 | MIT | bundled |");
    expect(text).toContain("````text\nhas ``` fences\n````");
  });
});
