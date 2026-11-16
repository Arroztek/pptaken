// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/import-pptx: converts a PowerPoint .pptx into a pptaken.deck envelope, its images and warnings.
//
// - `convertPptx(bytes, options)`: the pure converter (no I/O, deterministic, bounded by limits).
// - `@pptaken/import-pptx/isolated`: `convertPptxIsolated`, which runs the converter in a worker thread with memory
//   limits and a hard timeout. Servers must use this one: the input is hostile.
//
// The output is untrusted, like any agent output: the core validates it with `parseDeck`, sanitizes it and checks
// every image again before anything is stored.

export { convertPptx } from "./convert.js";
export { isPptxError, PptxError, type PptxErrorCode } from "./errors.js";
export { mapFont } from "./fonts.js";
export { autoNumber } from "./text.js";
export {
  type ConvertOptions,
  DEFAULT_PPTX_LIMITS,
  type PptxAsset,
  type PptxConversion,
  type PptxLimits,
  type PptxWarning,
  type PptxWarningCode,
} from "./types.js";
export { DEFAULT_XML_LIMITS, parseXml, type XmlElement, XmlError } from "./xml.js";
