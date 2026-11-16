// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import type { Deck } from "@pptaken/schema";
import { describe, expect, it } from "vitest";
import { type ArchiveAsset, ArchiveError, readArchive, writeArchive } from "../src/archive.js";
import { readZip, writeZip } from "../src/zip.js";
import { craftZip } from "./craft.js";

const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const deck: Deck = {
  schemaVersion: 1,
  title: "Ünïcode talk: 1/2",
  lang: "es",
  aspectRatio: "16:9",
  slides: [
    { id: "a", title: "A", html: "<h1>A</h1>", notes: "secret note" },
    { id: "b", title: "B", html: "<p>B</p>" },
  ],
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const asset: ArchiveAsset = {
  sha256: sha(png),
  mediaType: "image/png",
  bytes: png,
  width: 4,
  height: 3,
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ArchiveError) return error.code;
    throw error;
  }
  return "OK";
}

/** Re-zips the entries of a valid archive after changing them. */
function mutate(
  bytes: Uint8Array,
  fn: (entries: { name: string; data: Uint8Array }[]) => { name: string; data: Uint8Array }[],
) {
  const entries = readZip(bytes, {
    maxEntries: 100,
    maxTotalBytes: 1e9,
    maxEntryBytes: () => 1e9,
    maxRatio: 1e9,
  });
  return writeZip(fn(entries));
}
const manifestOf = (bytes: Uint8Array) =>
  JSON.parse(
    new TextDecoder().decode(
      readZip(bytes, {
        maxEntries: 100,
        maxTotalBytes: 1e9,
        maxEntryBytes: () => 1e9,
        maxRatio: 1e9,
      }).find((e) => e.name === "manifest.json")?.data,
    ),
  );

describe("writeArchive / readArchive", () => {
  it("round-trips the deck (with notes by default) and the assets", () => {
    const written = writeArchive({
      deck,
      assets: [asset, asset],
      generator: "pptaken 0.2.0",
      exportedAt: new Date(Date.UTC(2026, 10, 15)),
    });
    expect(written.filename).toBe("unicode-talk-1-2.pkn");
    expect(written.manifest).toEqual({
      format: "pptaken.archive",
      formatVersion: 1,
      exportedAt: "2026-11-15T00:00:00.000Z",
      generator: "pptaken 0.2.0",
      deck: { title: "Ünïcode talk: 1/2", lang: "es" },
      notes: true,
      assets: [
        { sha256: asset.sha256, mediaType: "image/png", bytes: png.length, width: 4, height: 3 },
      ],
    });
    const read = readArchive(written.bytes);
    expect(read.deck).toEqual(deck);
    expect(read.assets).toHaveLength(1);
    expect(read.assets[0]?.bytes).toEqual(png);
    expect(read.manifest.notes).toBe(true);
  });

  it("strips notes on request", () => {
    const written = writeArchive({ deck, assets: [], generator: "x", includeNotes: false });
    expect(new TextDecoder().decode(written.bytes)).not.toContain("secret note");
    const read = readArchive(written.bytes);
    expect((read.deck as Deck).slides[0]?.notes).toBeUndefined();
    expect(read.manifest.notes).toBe(false);
  });

  it("refuses assets whose bytes do not match their hash", () => {
    expect(() =>
      writeArchive({ deck, assets: [{ ...asset, sha256: "0".repeat(64) }], generator: "x" }),
    ).toThrow(TypeError);
  });
});

describe("readArchive refuses bad archives", () => {
  const good = writeArchive({ deck, assets: [asset], generator: "x" }).bytes;

  it("too large before reading", () => {
    expect(code(() => readArchive(good, { maxArchiveBytes: 10 }))).toBe("TOO_LARGE");
  });

  it("not a zip", () => {
    expect(code(() => readArchive(enc.encode("{}")))).toBe("NOT_A_ZIP");
  });

  it("missing manifest or deck", () => {
    expect(
      code(() => readArchive(mutate(good, (e) => e.filter((x) => x.name !== "manifest.json")))),
    ).toBe("MISSING_ENTRY");
    expect(
      code(() => readArchive(mutate(good, (e) => e.filter((x) => x.name !== "deck.json")))),
    ).toBe("MISSING_ENTRY");
  });

  it("unexpected entries, including path traversal", () => {
    expect(
      code(() =>
        readArchive(mutate(good, (e) => [...e, { name: "extra.txt", data: enc.encode("x") }])),
      ),
    ).toBe("UNEXPECTED_ENTRY");
    expect(
      code(() => readArchive(craftZip([{ name: "../../manifest.json", data: enc.encode("{}") }]))),
    ).toBe("UNSAFE_NAME");
    expect(
      code(() =>
        readArchive(
          mutate(good, (e) => [...e, { name: `assets/${"a".repeat(64)}`, data: enc.encode("x") }]),
        ),
      ),
    ).toBe("UNEXPECTED_ENTRY");
  });

  it("bad manifest JSON or shape", () => {
    const withManifest = (m: unknown) =>
      mutate(good, (e) =>
        e.map((x) =>
          x.name === "manifest.json"
            ? { name: x.name, data: enc.encode(typeof m === "string" ? m : JSON.stringify(m)) }
            : x,
        ),
      );
    const m = manifestOf(good);
    expect(code(() => readArchive(withManifest("not json")))).toBe("BAD_MANIFEST");
    expect(code(() => readArchive(withManifest([])))).toBe("BAD_MANIFEST");
    expect(code(() => readArchive(withManifest({ ...m, format: "other" })))).toBe("BAD_MANIFEST");
    expect(code(() => readArchive(withManifest({ ...m, formatVersion: "1" })))).toBe(
      "BAD_MANIFEST",
    );
    expect(code(() => readArchive(withManifest({ ...m, notes: "yes" })))).toBe("BAD_MANIFEST");
    expect(
      code(() => readArchive(withManifest({ ...m, assets: [{ ...m.assets[0], sha256: "../x" }] }))),
    ).toBe("BAD_MANIFEST");
    expect(
      code(() => readArchive(withManifest({ ...m, assets: [m.assets[0], m.assets[0]] }))),
    ).toBe("BAD_MANIFEST");
    expect(code(() => readArchive(withManifest({ ...m, formatVersion: 2 })))).toBe(
      "UNSUPPORTED_VERSION",
    );
    expect(() => readArchive(withManifest({ ...m, formatVersion: 2 }))).toThrow(/version 2/);
    // Unknown keys are ignored.
    expect(code(() => readArchive(withManifest({ ...m, futureField: true })))).toBe("OK");
  });

  it("listed asset missing, or content not matching its name", () => {
    expect(
      code(() => readArchive(mutate(good, (e) => e.filter((x) => !x.name.startsWith("assets/"))))),
    ).toBe("MISSING_ENTRY");
    const tampered = mutate(good, (e) =>
      e.map((x) =>
        x.name.startsWith("assets/")
          ? { name: x.name, data: new Uint8Array([...x.data.slice(0, -1), 0]) }
          : x,
      ),
    );
    expect(code(() => readArchive(tampered))).toBe("HASH_MISMATCH");
  });

  it("deck.json that is not a JSON object", () => {
    const withDeck = (text: string) =>
      mutate(good, (e) =>
        e.map((x) => (x.name === "deck.json" ? { name: x.name, data: enc.encode(text) } : x)),
      );
    expect(code(() => readArchive(withDeck("{broken")))).toBe("BAD_DECK");
    expect(code(() => readArchive(withDeck("[1,2]")))).toBe("BAD_DECK");
    expect(
      code(() =>
        readArchive(
          mutate(good, (e) =>
            e.map((x) =>
              x.name === "deck.json" ? { name: x.name, data: new Uint8Array([0xff, 0xfe]) } : x,
            ),
          ),
        ),
      ),
    ).toBe("BAD_DECK");
  });

  it("too many assets", () => {
    expect(code(() => readArchive(good, { maxAssets: 0 }))).toBe("TOO_MANY_ENTRIES");
  });
});
