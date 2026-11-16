// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the converter in a worker thread with V8 heap limits and a hard timeout, so a hostile file can neither
// block the server's event loop nor exhaust its memory: the worker is terminated and the import fails cleanly.
import { Worker } from "node:worker_threads";
import { PptxError, type PptxErrorCode } from "./errors.js";
import type { ConvertOptions, PptxConversion } from "./types.js";

export interface IsolationOptions extends ConvertOptions {
  /** Hard wall-clock limit (default 30 s). */
  timeoutMs?: number;
  /** V8 old-generation heap of the worker in MB (default 512). */
  maxMemoryMb?: number;
}

interface WorkerReply {
  ok: boolean;
  result?: PptxConversion;
  error?: { code: string; message: string; hint?: string };
}

const CODES: readonly PptxErrorCode[] = [
  "NOT_PPTX",
  "LEGACY_PPT",
  "ENCRYPTED",
  "INVALID_FILE",
  "TOO_LARGE",
  "TIMEOUT",
];

/** {@link convertPptx} in an isolated worker thread. Rejects with {@link PptxError} only. */
export function convertPptxIsolated(
  bytes: Uint8Array,
  options: IsolationOptions = {},
): Promise<PptxConversion> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const memory = options.maxMemoryMb ?? 512;
  const copy = bytes.slice();
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: { bytes: copy, limits: options.limits ?? {} },
      transferList: [copy.buffer],
      env: {},
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: memory,
        maxYoungGenerationSizeMb: Math.min(64, Math.max(8, Math.floor(memory / 8))),
        codeRangeSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new PptxError(
            "TIMEOUT",
            "The presentation took too long to convert",
            "Remove very large or complex slides in PowerPoint, or split the file, and import again.",
          ),
        ),
      );
    }, timeoutMs);
    worker.on("message", (reply: WorkerReply) => {
      finish(() => {
        if (reply.ok && reply.result !== undefined) {
          resolve(reply.result);
          return;
        }
        const code = CODES.includes(reply.error?.code as PptxErrorCode)
          ? (reply.error?.code as PptxErrorCode)
          : "INVALID_FILE";
        reject(
          new PptxError(
            code,
            reply.error?.message ?? "The file could not be converted",
            reply.error?.hint,
          ),
        );
      });
    });
    worker.on("error", (error: Error & { code?: string }) => {
      finish(() => {
        if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
          reject(
            new PptxError(
              "TOO_LARGE",
              "The presentation needs too much memory to convert",
              "Split the file into smaller presentations in PowerPoint and import each one.",
            ),
          );
          return;
        }
        reject(new PptxError("INVALID_FILE", "The file could not be converted"));
      });
    });
    worker.on("exit", () => {
      finish(() => reject(new PptxError("INVALID_FILE", "The file could not be converted")));
    });
  });
}
