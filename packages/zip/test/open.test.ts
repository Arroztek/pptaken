// SPDX-License-Identifier: AGPL-3.0-or-later
// The lazy reader (`openZip`). The hostile-archive suite of the reader itself lives in @pptaken/export's tests
// (`readZip` is built on `openZip`); these cover what `openZip` adds: entries that are skipped are validated but
// never inflated or size-checked, and included entries are inflated and CRC-checked only when read.
import { describe, expect, it } from "vitest";
import { openZip, writeZip, ZipError } from "../src/index.js";

const enc = new TextEncoder();
const LIMITS = {
  maxEntries: 100,
  maxTotalBytes: 1024 * 1024,
  maxEntryBytes: () => 64 * 1024,
  maxRatio: 100,
};

describe("openZip", () => {
  it("reads included entries on demand and lists skipped ones", () => {
    const zip = writeZip([
      { name: "keep/a.xml", data: enc.encode("<a/>"), compress: true },
      { name: "skip/bomb.bin", data: new Uint8Array(8 * 1024 * 1024), compress: true },
      { name: "dir/", data: new Uint8Array() },
    ]);
    const opened = openZip(zip, { ...LIMITS, include: (n) => n.startsWith("keep/") });
    expect(opened.names).toEqual(["keep/a.xml", "skip/bomb.bin", "dir/"]);
    expect(opened.skipped).toEqual(["skip/bomb.bin"]);
    expect(opened.has("keep/a.xml")).toBe(true);
    expect(opened.has("skip/bomb.bin")).toBe(false);
    expect(opened.size("keep/a.xml")).toBe(4);
    expect(new TextDecoder().decode(opened.read("keep/a.xml") as Uint8Array)).toBe("<a/>");
    expect(opened.read("skip/bomb.bin")).toBeNull();
    expect(opened.read("missing")).toBeNull();
  });

  it("applies size and ratio limits to included entries only", () => {
    const zip = writeZip([
      { name: "big.bin", data: new Uint8Array(8 * 1024 * 1024), compress: true },
    ]);
    expect(() => openZip(zip, LIMITS)).toThrow(ZipError);
    expect(() => openZip(zip, { ...LIMITS, include: () => false })).not.toThrow();
  });

  it("still refuses unsafe names in skipped entries", () => {
    const zip = writeZip([{ name: "a/b.txt", data: enc.encode("x") }]);
    const patched = zip.slice();
    const from = enc.encode("a/b.txt");
    const to = enc.encode("../b.tx");
    for (let i = 0; i <= patched.length - from.length; i++) {
      if (from.every((b, j) => patched[i + j] === b)) patched.set(to, i);
    }
    expect(() => openZip(patched, { ...LIMITS, include: () => false })).toThrow(
      /Unsafe entry name/,
    );
  });

  it("detects a damaged included entry when it is read (CRC)", () => {
    const data = enc.encode("hello hello hello");
    const zip = writeZip([{ name: "h.txt", data }]);
    const patched = zip.slice();
    // Stored entry: the content follows the 30-byte local header and the name.
    patched[30 + "h.txt".length] = "j".charCodeAt(0);
    const opened = openZip(patched, LIMITS);
    expect(() => opened.read("h.txt")).toThrow(/CRC/);
  });
});
