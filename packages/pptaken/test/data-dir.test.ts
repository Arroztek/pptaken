// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DataDirError,
  defaultDataDir,
  ensureWritableDataDir,
  resolveDataDir,
} from "../src/data-dir.js";

describe("defaultDataDir", () => {
  it("Windows: %LOCALAPPDATA%\\PPTaken", () => {
    expect(
      defaultDataDir({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" },
        homedir: "C:\\Users\\ana",
      }),
    ).toBe("C:\\Users\\ana\\AppData\\Local\\PPTaken");
  });

  it("Windows without (or with a relative) LOCALAPPDATA falls back to the home folder", () => {
    const ctx = { platform: "win32" as const, homedir: "C:\\Users\\ana" };
    const expected = "C:\\Users\\ana\\AppData\\Local\\PPTaken";
    expect(defaultDataDir({ ...ctx, env: {} })).toBe(expected);
    expect(defaultDataDir({ ...ctx, env: { LOCALAPPDATA: "" } })).toBe(expected);
    expect(defaultDataDir({ ...ctx, env: { LOCALAPPDATA: "relative\\dir" } })).toBe(expected);
  });

  it("macOS: ~/Library/Application Support/PPTaken", () => {
    expect(defaultDataDir({ platform: "darwin", env: {}, homedir: "/Users/ana" })).toBe(
      "/Users/ana/Library/Application Support/PPTaken",
    );
  });

  it("Linux: $XDG_DATA_HOME/pptaken when absolute, else ~/.local/share/pptaken", () => {
    const ctx = { platform: "linux" as const, homedir: "/home/ana" };
    expect(defaultDataDir({ ...ctx, env: { XDG_DATA_HOME: "/data/xdg" } })).toBe(
      "/data/xdg/pptaken",
    );
    expect(defaultDataDir({ ...ctx, env: {} })).toBe("/home/ana/.local/share/pptaken");
    expect(defaultDataDir({ ...ctx, env: { XDG_DATA_HOME: "relative" } })).toBe(
      "/home/ana/.local/share/pptaken",
    );
  });

  it("other Unix systems follow the XDG rule too", () => {
    expect(defaultDataDir({ platform: "freebsd", env: {}, homedir: "/home/ana" })).toBe(
      "/home/ana/.local/share/pptaken",
    );
  });
});

describe("resolveDataDir", () => {
  const ctx = { platform: "linux" as const, homedir: "/home/ana" };

  it("the option wins over the environment, which wins over the default", () => {
    const env = { PPTAKEN_DATA_DIR: "/srv/pptaken" };
    expect(resolveDataDir("./mine", { ...ctx, env })).toEqual({
      path: resolve("./mine"),
      source: "option",
    });
    expect(resolveDataDir(undefined, { ...ctx, env })).toEqual({
      path: resolve("/srv/pptaken"),
      source: "environment",
    });
    expect(resolveDataDir(undefined, { ...ctx, env: { PPTAKEN_DATA_DIR: "" } })).toEqual({
      path: "/home/ana/.local/share/pptaken",
      source: "default",
    });
  });
});

describe("ensureWritableDataDir", () => {
  const dirs: string[] = [];
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), "pptaken-datadir-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("creates nested folders and leaves no probe file behind", () => {
    const target = join(temp(), "a", "b");
    ensureWritableDataDir(target);
    ensureWritableDataDir(target);
    expect(readdirSync(target)).toEqual([]);
  });

  it("explains a path that runs through a file", () => {
    const file = join(temp(), "file");
    writeFileSync(file, "x");
    expect(() => ensureWritableDataDir(join(file, "data"))).toThrow(DataDirError);
    expect(() => ensureWritableDataDir(join(file, "data"))).toThrow(
      /cannot create its data folder/,
    );
    expect(() => ensureWritableDataDir(file)).toThrow(/is a file, not a folder/);
  });
});
