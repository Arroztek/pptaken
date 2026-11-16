// SPDX-License-Identifier: AGPL-3.0-or-later
// SSRF-safe outbound fetch (threat T8, security §6): used for OAuth client metadata documents (CIMD) and meant for
// `add_asset` by URL later. Rules: https only, port 443 only, no credentials in the URL; the host name is resolved
// here and EVERY resolved address must be public unicast (private, loopback, link-local, CGNAT, metadata,
// documentation, multicast and reserved ranges are refused, including IPv4-mapped and NAT64 forms); the connection
// is pinned to the checked address (no second resolution: DNS rebinding); redirects are never followed; a hard
// timeout covers the whole exchange; the body is capped while it streams. No proxy is used.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

export class FetchBlockedError extends Error {
  override readonly name = "FetchBlockedError";
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface SafeFetchOptions {
  /** Largest body accepted, in bytes. */
  maxBytes: number;
  /** Deadline for the whole exchange (DNS, connect, TLS, headers, body). */
  timeoutMs: number;
  accept?: string;
  /** DNS resolution (tests inject one); default: every A/AAAA record via the system resolver. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
}

export interface SafeFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

// ---------------------------------------------------------------------------------------------------------------
// Address classification

function v4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

function v4Blocked(n: number): boolean {
  for (const [base, bits] of V4_BLOCKED) {
    const b = v4ToInt(base) as number;
    const size = 2 ** (32 - bits);
    if (n >= b && n < b + size) return true;
  }
  return false;
}

/** 16 bytes of an IPv6 address, or null (zone ids are refused). */
function v6Bytes(address: string): number[] | null {
  if (address.includes("%")) return null;
  let text = address;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = v4ToInt(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [(v4 >>> 24) & 255, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = Number.parseInt(g, 16);
    bytes.push(v >> 8, v & 255);
  }
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

function prefixEquals(bytes: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

function v6Blocked(bytes: number[]): boolean {
  const embeddedV4 = () =>
    (((bytes[12] ?? 0) << 24) >>> 0) +
    ((bytes[13] ?? 0) << 16) +
    ((bytes[14] ?? 0) << 8) +
    (bytes[15] ?? 0);
  // IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96: judge the IPv4 address inside.
  if (prefixEquals(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96))
    return v4Blocked(embeddedV4());
  if (prefixEquals(bytes, [0, 0x64, 0xff, 0x9b], 96)) return v4Blocked(embeddedV4());
  // Only global unicast 2000::/3 is reachable on purpose; inside it, refuse special-purpose blocks.
  if (!prefixEquals(bytes, [0x20], 3)) return true;
  const blocked: [number[], number][] = [
    [[0x20, 0x01, 0x00, 0x00], 23], // IETF protocol assignments (Teredo, ORCHID, benchmarking…)
    [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
    [[0x20, 0x02], 16], // 6to4 (embeds arbitrary IPv4)
    [[0x3f, 0xff, 0xf0, 0x00], 20], // documentation (RFC 9637)
  ];
  return blocked.some(([p, bits]) => prefixEquals(bytes, p, bits));
}

/** Whether an IP address must never be contacted (anything but public unicast, or unparsable). */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const n = v4ToInt(address);
    return n === null || v4Blocked(n);
  }
  if (kind === 6) {
    const bytes = v6Bytes(address);
    return bytes === null || v6Blocked(bytes);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Fetch

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

/** Validates the URL and resolves it to one checked address. Throws {@link FetchBlockedError}. */
export async function resolveSafeTarget(
  raw: string,
  resolve: (hostname: string) => Promise<ResolvedAddress[]> = systemResolve,
): Promise<{ url: URL; address: ResolvedAddress }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError("not a valid URL");
  }
  if (url.protocol !== "https:") throw new FetchBlockedError("only https URLs are fetched");
  if (url.username !== "" || url.password !== "")
    throw new FetchBlockedError("credentials in the URL are not allowed");
  if (url.port !== "" && url.port !== "443")
    throw new FetchBlockedError("only port 443 is allowed");
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (host === "" || host === "localhost" || host.endsWith(".localhost"))
    throw new FetchBlockedError("this host is not reachable");
  let addresses: ResolvedAddress[];
  if (isIP(host) !== 0) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new FetchBlockedError("the host name does not resolve");
    }
  }
  if (addresses.length === 0) throw new FetchBlockedError("the host name does not resolve");
  // Every answer must be public: a mixed answer is how rebinding attacks start.
  if (addresses.some((a) => isBlockedAddress(a.address)))
    throw new FetchBlockedError("the host resolves to a private or reserved address");
  return { url, address: addresses[0] as ResolvedAddress };
}

/** GET with the rules above. Resolves only for a 2xx response; anything else throws. */
export async function safeFetch(
  raw: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResponse> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const target = await Promise.race([
    resolveSafeTarget(raw, options.resolve),
    new Promise<never>((_, reject) =>
      deadline.addEventListener("abort", () => reject(new FetchBlockedError("timed out")), {
        once: true,
      }),
    ),
  ]);
  const pinned: LookupFunction = (_hostname, opts, callback) => {
    const { address, family } = target.address;
    if ((opts as { all?: boolean }).all === true)
      (callback as unknown as (e: null, list: ResolvedAddress[]) => void)(null, [
        { address, family },
      ]);
    else callback(null, address, family);
  };
  return new Promise<SafeFetchResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: target.url.hostname.replace(/^\[|\]$/g, ""),
        port: 443,
        path: `${target.url.pathname}${target.url.search}`,
        method: "GET",
        lookup: pinned,
        agent: false,
        signal: deadline,
        headers: {
          Accept: options.accept ?? "*/*",
          "User-Agent": "PPTaken",
          "Accept-Encoding": "identity",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          reject(new FetchBlockedError("redirects are not followed"));
          return;
        }
        if (status < 200 || status >= 300) {
          res.destroy();
          reject(new FetchBlockedError(`the server answered HTTP ${status}`));
          return;
        }
        const declared = Number(res.headers["content-length"] ?? "0");
        if (declared > options.maxBytes) {
          res.destroy();
          reject(new FetchBlockedError("the response is too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            res.destroy();
            reject(new FetchBlockedError("the response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
          }
          resolve({ status, headers, body: Buffer.concat(chunks) });
        });
        res.on("error", (e) => reject(new FetchBlockedError(e.message)));
      },
    );
    req.on("error", (e) =>
      reject(
        e instanceof FetchBlockedError
          ? e
          : new FetchBlockedError(deadline.aborted ? "timed out" : "the connection failed"),
      ),
    );
    req.end();
  });
}

/** `max-age` from a Cache-Control header (seconds), or null. */
export function maxAgeOf(cacheControl: string | undefined): number | null {
  if (cacheControl === undefined) return null;
  if (/(^|,)\s*(no-store|no-cache)\s*(,|$)/i.test(cacheControl)) return 0;
  const m = /(?:^|,)\s*max-age\s*=\s*"?(\d{1,9})"?/i.exec(cacheControl);
  return m === null ? null : Number(m[1]);
}

/** CIMD limits (ADR-0018): https, 5 KB, 5 s, no redirects. */
export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;

/** Fetches an OAuth client metadata document through {@link safeFetch}. */
export async function fetchClientMetadataDocument(
  url: string,
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>,
): Promise<{ body: unknown; maxAgeSec: number | null }> {
  const res = await safeFetch(url, {
    maxBytes: CIMD_MAX_BYTES,
    timeoutMs: CIMD_TIMEOUT_MS,
    accept: "application/json",
    ...(resolve === undefined ? {} : { resolve }),
  });
  const type = (res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type !== "application/json" && !type.endsWith("+json"))
    throw new FetchBlockedError("the metadata document is not JSON");
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new FetchBlockedError("the metadata document is not valid JSON");
  }
  return { body, maxAgeSec: maxAgeOf(res.headers["cache-control"]) };
}

/** Shape of an injected CIMD fetcher (tests). */
export type CimdFetcherOverride = (
  url: string,
) => Promise<{ body: unknown; maxAgeSec: number | null }>;
