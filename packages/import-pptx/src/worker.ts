// SPDX-License-Identifier: AGPL-3.0-or-later
// Worker-thread entry of `convertPptxIsolated`: converts the bytes it is given and posts the result back. It has
// no access to anything else the server holds (no database, no secrets: it gets an empty environment).
import { parentPort, workerData } from "node:worker_threads";
import { convertPptx } from "./convert.js";
import { isPptxError } from "./errors.js";
import type { PptxLimits } from "./types.js";

interface Input {
  bytes: Uint8Array;
  limits: Partial<PptxLimits>;
}

const input = workerData as Input;
try {
  const result = convertPptx(new Uint8Array(input.bytes), { limits: input.limits });
  const transfer: ArrayBuffer[] = [];
  for (const asset of result.assets) {
    const buf = asset.bytes.buffer;
    if (
      buf instanceof ArrayBuffer &&
      asset.bytes.byteOffset === 0 &&
      asset.bytes.byteLength === buf.byteLength &&
      !transfer.includes(buf)
    ) {
      transfer.push(buf);
    }
  }
  parentPort?.postMessage({ ok: true, result }, transfer);
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: isPptxError(error)
      ? { code: error.code, message: error.message, hint: error.hint }
      : { code: "INVALID_FILE", message: "The file could not be converted" },
  });
}
