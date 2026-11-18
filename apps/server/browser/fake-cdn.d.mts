// SPDX-License-Identifier: AGPL-3.0-or-later
// Types for fake-cdn.mjs (plain Node, shared by the vitest suite and the browser e2e).
import type { ResolvedAddress } from "../src/safe-fetch.js";
import type { VendorTransport } from "../src/vendor-fetch.js";

export const PNG: Buffer;
export const URLS: {
  css2: string;
  font: string;
  libRange: string;
  libPinned: string;
  image: string;
};
export const LIB_SOURCE: string;
export const CSS2_BODY: string;
export const ARTIFACT: string;
export function fakeCdn(
  extra?: Record<string, { body?: Buffer; type?: string; status?: number; location?: string }>,
): {
  requests: string[];
  resolve: (hostname: string) => Promise<ResolvedAddress[]>;
  transport: VendorTransport;
};
