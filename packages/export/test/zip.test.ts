// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  crc32,
  readZip,
  unsafeNameReason,
  writeZip,
  ZipError,
  type ZipReadLimits,
} from "../src/zip.js";
import { craftZip } from "./craft.js";

const LIMITS: ZipReadLimits = {
  maxEntries: 20,
  maxTotalBytes: 1024 * 1024,
  maxEntryBytes: () => 512 * 1024,
  maxRatio: 100,
};
const enc = new TextEncoder();

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ZipError) return error.code;
    throw error;
  }
  return "OK";
}

describe("crc32", () => {
  it("matches the reference values", () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("writeZip + readZip", () => {
  it("round-trips stored and deflated entries", () => {
    const big = enc.encode("slide ".repeat(5000));
    const bin = new Uint8Array(300).map((_, i) => (i * 37) & 0xff);
    const zip = writeZip([
      { name: "a.json", data: big, compress: true },
      { name: "dir/b.bin", data: bin },
      { name: "empty.txt", data: new Uint8Array() },
    ]);
    const out = readZip(zip, LIMITS);
    expect(out.map((e) => e.name)).toEqual(["a.json", "dir/b.bin", "empty.txt"]);
    expect(out[0]?.data).toEqual(big);
    expect(out[1]?.data).toEqual(bin);
    expect(out[2]?.data.length).toBe(0);
    expect(zip.length).toBeLessThan(big.length); // the JSON was deflated
  });

  it("is readable by a standard unzip tool when one is installed", () => {
    let tool: string | null = null;
    for (const candidate of ["unzip", "tar"]) {
      try {
        execFileSync(candidate, candidate === "unzip" ? ["-v"] : ["--version"], {
          stdio: "ignore",
        });
        tool = candidate;
        break;
      } catch {
        // not installed
      }
    }
    if (tool === null) return;
    const dir = mkdtempSync(join(tmpdir(), "pptaken-zip-"));
    try {
      const file = join(dir, "x.zip");
      writeFileSync(
        file,
        writeZip([
          { name: "sub/hello.txt", data: enc.encode("héllo ".repeat(100)), compress: true },
        ]),
      );
      if (tool === "unzip") execFileSync("unzip", ["-q", file, "-d", join(dir, "out")]);
      else execFileSync("tar", ["-xf", file, "-C", dir]);
      const extracted = readFileSync(
        join(dir, tool === "unzip" ? "out" : "", "sub", "hello.txt"),
        "utf8",
      );
      expect(extracted).toBe("héllo ".repeat(100));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses unsafe names and duplicates when writing", () => {
    expect(() => writeZip([{ name: "../x", data: new Uint8Array() }])).toThrow(TypeError);
    expect(() =>
      writeZip([
        { name: "a", data: new Uint8Array() },
        { name: "a", data: new Uint8Array() },
      ]),
    ).toThrow(TypeError);
  });
});

describe("unsafeNameReason", () => {
  it.each([
    ["", "empty name"],
    ["/etc/passwd", "absolute path"],
    ["C:/Windows/x", "drive letter"],
    ["c:x", "drive letter"],
    ["a\\..\\b", "backslash in name"],
    ["../x", "path traversal"],
    ["a/../../x", "path traversal"],
    ["a/./b", "path traversal"],
    ["a//b", "empty path segment"],
    [`a${String.fromCharCode(0)}b`, "control character in name"],
    [`evil${String.fromCharCode(0x202e)}gpj.exe`, "control character in name"],
    ["x".repeat(300), "name too long"],
  ])("%j is refused (%s)", (name, reason) => {
    expect(unsafeNameReason(name)).toBe(reason);
  });

  it("accepts plain relative names and directories", () => {
    for (const name of ["deck.json", "assets/", "assets/abc", "ünïcode/ファイル.txt"]) {
      expect(unsafeNameReason(name)).toBeNull();
    }
  });
});

describe("readZip refuses hostile archives", () => {
  const data = enc.encode("hello");

  it("not a ZIP", () => {
    expect(code(() => readZip(enc.encode("hello world, not a zip at all"), LIMITS))).toBe(
      "NOT_A_ZIP",
    );
    expect(code(() => readZip(new Uint8Array(5), LIMITS))).toBe("NOT_A_ZIP");
  });

  it.each(["../evil.txt", "/abs.txt", "C:/x.txt", "a\\b.txt", "a/../../b.txt"])(
    "ZIP slip name %j",
    (name) => {
      expect(code(() => readZip(craftZip([{ name, data }]), LIMITS))).toBe("UNSAFE_NAME");
    },
  );

  it("names that are not UTF-8, or non-ASCII without the UTF-8 flag", () => {
    expect(
      code(() =>
        readZip(
          craftZip([{ name: "x", nameBytes: new Uint8Array([0x61, 0xff, 0xfe]), data }]),
          LIMITS,
        ),
      ),
    ).toBe("UNSAFE_NAME");
    expect(code(() => readZip(craftZip([{ name: "café", flags: 0, data }]), LIMITS))).toBe(
      "UNSAFE_NAME",
    );
  });

  it("duplicate names, also by case", () => {
    expect(
      code(() =>
        readZip(
          craftZip([
            { name: "a", data },
            { name: "a", data },
          ]),
          LIMITS,
        ),
      ),
    ).toBe("DUPLICATE_ENTRY");
    expect(
      code(() =>
        readZip(
          craftZip([
            { name: "A.json", data },
            { name: "a.JSON", data },
          ]),
          LIMITS,
        ),
      ),
    ).toBe("DUPLICATE_ENTRY");
  });

  it("symlinks and other non-regular files", () => {
    const link = (0o120777 << 16) >>> 0;
    expect(
      code(() =>
        readZip(craftZip([{ name: "l", data: enc.encode("/etc/passwd"), external: link }]), LIMITS),
      ),
    ).toBe("SYMLINK");
    const fifo = (0o010644 << 16) >>> 0;
    expect(code(() => readZip(craftZip([{ name: "f", data, external: fifo }]), LIMITS))).toBe(
      "UNSUPPORTED",
    );
  });

  it("encryption, unknown methods, ZIP64 markers", () => {
    expect(code(() => readZip(craftZip([{ name: "e", data, flags: 0x0801 }]), LIMITS))).toBe(
      "ENCRYPTED",
    );
    expect(code(() => readZip(craftZip([{ name: "m", data, method: 12 }]), LIMITS))).toBe(
      "UNSUPPORTED",
    );
    expect(code(() => readZip(craftZip([{ name: "z", data, size: 0xffffffff }]), LIMITS))).toBe(
      "UNSUPPORTED",
    );
  });

  it("too many entries", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, data }));
    expect(code(() => readZip(craftZip(many), LIMITS))).toBe("TOO_MANY_ENTRIES");
  });

  it("entries or totals above the limits, before inflating", () => {
    const big = new Uint8Array(600 * 1024);
    expect(
      code(() =>
        readZip(craftZip([{ name: "big", data: big, method: 8 }]), { ...LIMITS, maxRatio: 10_000 }),
      ),
    ).toBe("TOO_LARGE");
    const parts = Array.from({ length: 3 }, (_, i) => ({
      name: `p${i}`,
      data: new Uint8Array(400 * 1024),
      method: 8,
    }));
    expect(code(() => readZip(craftZip(parts), { ...LIMITS, maxRatio: 10_000 }))).toBe("TOO_LARGE");
  });

  it("a ZIP bomb: high compression ratio", () => {
    const zeros = new Uint8Array(400 * 1024);
    expect(code(() => readZip(craftZip([{ name: "bomb", data: zeros, method: 8 }]), LIMITS))).toBe(
      "COMPRESSION_RATIO",
    );
  });

  it("a ZIP bomb: declared size smaller than the real content", () => {
    const zeros = new Uint8Array(200 * 1024);
    const crafted = craftZip([
      { name: "liar", data: zeros, method: 8, size: 1000, crc: crc32(zeros.subarray(0, 1000)) },
    ]);
    expect(code(() => readZip(crafted, LIMITS))).toBe("CORRUPT");
  });

  it("a ZIP bomb: overlapping entries sharing one local header", () => {
    const crafted = craftZip([
      { name: "a", data },
      { name: "b", data, localName: "b", offsetOf: 0 },
    ]);
    expect(code(() => readZip(crafted, LIMITS))).toBe("CORRUPT");
  });

  it("CRC mismatch", () => {
    expect(code(() => readZip(craftZip([{ name: "c", data, crc: 1234 }]), LIMITS))).toBe(
      "CRC_MISMATCH",
    );
  });

  it("local header that disagrees with the central directory", () => {
    expect(
      code(() => readZip(craftZip([{ name: "a.txt", localName: "b.txt", data }]), LIMITS)),
    ).toBe("CORRUPT");
  });

  it("stored entries with inconsistent sizes and truncated data", () => {
    expect(code(() => readZip(craftZip([{ name: "s", data, compressedSize: 3 }]), LIMITS))).toBe(
      "CORRUPT",
    );
    const zip = writeZip([{ name: "t", data: new Uint8Array(1000) }]);
    const truncated = zip.slice(0, 500);
    expect(code(() => readZip(truncated, LIMITS))).toBe("NOT_A_ZIP");
  });

  it("data hidden between the entries and the central directory, or a wrong entry count", () => {
    const zip = writeZip([{ name: "a", data }]);
    expect(code(() => readZip(craftZip([{ name: "a", data }], { countOverride: 2 }), LIMITS))).toBe(
      "CORRUPT",
    );
    // An archive comment is fine; trailing bytes after it are not.
    expect(readZip(craftZip([{ name: "a", data }], { comment: "hi" }), LIMITS)).toHaveLength(1);
    const trailing = new Uint8Array([...zip, 1, 2, 3]);
    expect(code(() => readZip(trailing, LIMITS))).toBe("NOT_A_ZIP");
  });

  it("an acceptName allow-list stops unexpected entries before inflating", () => {
    const zip = craftZip([{ name: "__MACOSX/x", data }]);
    expect(code(() => readZip(zip, { ...LIMITS, acceptName: (n) => n === "ok" }))).toBe(
      "UNEXPECTED_ENTRY",
    );
  });

  it("random corruption never escapes as anything but a ZipError (fuzz)", () => {
    const base = writeZip([
      {
        name: "deck.json",
        data: enc.encode(JSON.stringify({ a: "x".repeat(2000) })),
        compress: true,
      },
      { name: "assets/one", data: new Uint8Array(500).map((_, i) => i & 0xff) },
    ]);
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 0x100000000;
    };
    const outcomes = new Map<string, number>();
    for (let round = 0; round < 1500; round++) {
      const bytes = base.slice();
      const flips = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < flips; i++) {
        bytes[Math.floor(rand() * bytes.length)] = Math.floor(rand() * 256);
      }
      const cut = rand() < 0.1 ? Math.floor(rand() * bytes.length) : bytes.length;
      const result = code(() => readZip(bytes.subarray(0, cut), LIMITS));
      outcomes.set(result, (outcomes.get(result) ?? 0) + 1);
      if (result === "OK") {
        // Whatever was accepted still passed the CRC checks, so the content is what the CRC says.
        for (const e of readZip(bytes.subarray(0, cut), LIMITS))
          expect(e.data).toBeInstanceOf(Uint8Array);
      }
    }
    expect(outcomes.size).toBeGreaterThan(2);
  });
});
