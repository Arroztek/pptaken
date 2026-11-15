// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds deliberately malformed ZIP archives for the reader's tests. Every field can be overridden; nothing is
// validated (that is the point).
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../src/zip.js";

export interface CraftEntry {
  name: string;
  data?: Uint8Array;
  /** 0 = stored, 8 = deflate (the data is deflated here unless `raw` is given). */
  method?: number;
  /** Bytes written as the entry's content (overrides the compressed data). */
  raw?: Uint8Array;
  crc?: number;
  size?: number;
  compressedSize?: number;
  flags?: number;
  madeBy?: number;
  external?: number;
  /** Name in the local header (defaults to `name`). */
  localName?: string;
  /** Points the central directory entry to the local header of another entry (index). */
  offsetOf?: number;
  /** Name bytes as given (no UTF-8 encoding), for invalid-encoding tests. */
  nameBytes?: Uint8Array;
}

export function craftZip(
  entries: CraftEntry[],
  options: { comment?: string; countOverride?: number } = {},
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  const prepared = entries.map((e) => {
    const data = e.data ?? new Uint8Array();
    const method = e.method ?? 0;
    const body = e.raw ?? (method === 8 ? new Uint8Array(deflateRawSync(data)) : data);
    const nameBytes = e.nameBytes ?? enc.encode(e.name);
    const localNameBytes = e.localName === undefined ? nameBytes : enc.encode(e.localName);
    return { e, data, method, body, nameBytes, localNameBytes };
  });
  for (const p of prepared) {
    const { e, data, method, body, localNameBytes } = p;
    const local = new Uint8Array(30 + localNameBytes.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, e.flags ?? 0x0800, true);
    v.setUint16(8, method, true);
    v.setUint32(14, e.crc ?? crc32(data), true);
    v.setUint32(18, e.compressedSize ?? body.length, true);
    v.setUint32(22, e.size ?? data.length, true);
    v.setUint16(26, localNameBytes.length, true);
    local.set(localNameBytes, 30);
    offsets.push(offset);
    parts.push(local, body);
    offset += local.length + body.length;
  }
  prepared.forEach((p, i) => {
    const { e, data, method, body, nameBytes } = p;
    const c = new Uint8Array(46 + nameBytes.length);
    const v = new DataView(c.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, e.madeBy ?? 0x0314, true);
    v.setUint16(6, 20, true);
    v.setUint16(8, e.flags ?? 0x0800, true);
    v.setUint16(10, method, true);
    v.setUint32(16, e.crc ?? crc32(data), true);
    v.setUint32(20, e.compressedSize ?? body.length, true);
    v.setUint32(24, e.size ?? data.length, true);
    v.setUint16(28, nameBytes.length, true);
    v.setUint32(38, e.external ?? (0o100644 << 16) >>> 0, true);
    v.setUint32(42, offsets[e.offsetOf ?? i] as number, true);
    c.set(nameBytes, 46);
    centrals.push(c);
  });
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const comment = enc.encode(options.comment ?? "");
  const end = new Uint8Array(22 + comment.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  const count = options.countOverride ?? entries.length;
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, comment.length, true);
  end.set(comment, 22);
  const all = [...parts, ...centrals, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
