// SPDX-License-Identifier: AGPL-3.0-or-later
// The ingest-time vendoring fetcher (ADR-022, threat T8 and T8b): the only component that fetches resources an
// agent names. Every hop of a request gets the full SSRF check of `safe-fetch.ts` (https only, port 443, no
// credentials, every resolved address public unicast, IPv4-mapped/NAT64/6to4/CGNAT/link-local/metadata refused) and
// the connection is pinned to the checked address (no second resolution: DNS rebinding cannot swap it). At most 3
// redirects, each re-checked from scratch. Bodies are capped per kind while they stream, content encodings are
// refused (nothing is ever decompressed, so there is no decompression bomb), and the content is checked by magic
// bytes (`checkVendored`), never by the declared type. A per-request timeout (default 10 s) and the write's deadline
// bound the time; a semaphore bounds the concurrency; a token bucket bounds fetches per actor; the operator can
// switch it off or restrict hosts. Responses are cached in memory by kind + URL for an hour.
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { TokenBucketLimiter } from "@pptaken/auth-local";
import {
  checkVendored,
  VENDOR_MAX_BYTES,
  VendorError,
  type VendorFetcher,
  type VendorFetchRequest,
  type VendorFetchResult,
  type VendorKind,
} from "@pptaken/core";
import { FetchBlockedError, type ResolvedAddress, resolveSafeTarget } from "./safe-fetch.js";

/** One HTTP exchange on a checked, pinned address (tests replace it with a fake network). */
export type VendorTransport = (request: {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  abort(): void;
}>;

export interface VendorFetcherOptions {
  /** PPTAKEN_VENDOR_FETCH: false refuses every fetch (`disabled`). */
  enabled: boolean;
  /** PPTAKEN_VENDOR_ALLOW_HOSTS: when non-empty, only these hosts (and their subdomains). */
  allowHosts?: readonly string[];
  /** PPTAKEN_VENDOR_DENY_HOSTS: never these hosts (and their subdomains). */
  denyHosts?: readonly string[];
  /** DNS resolution (tests inject one). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  transport?: VendorTransport;
  /** Per-request (per hop) timeout, default 10 s. */
  requestTimeoutMs?: number;
  /** Redirects followed, default 3 (jsDelivr/unpkg redirect version ranges). */
  maxRedirects?: number;
  /** Fetches in flight on the whole instance, default 8. */
  maxConcurrent?: number;
  /** Per-actor limiter (key: actor and token). */
  limiter?: TokenBucketLimiter;
  /** In-memory cache budget, default 64 MB; 0 disables it. */
  cacheBytes?: number;
  cacheTtlMs?: number;
  now?: () => number;
  /** Per-kind caps (default {@link VENDOR_MAX_BYTES}); tests lower them. */
  maxBytes?: Partial<Record<VendorKind, number>>;
}

const ACCEPT: Record<VendorKind, string> = {
  script: "application/javascript, text/javascript, */*;q=0.1",
  stylesheet: "text/css, */*;q=0.1",
  font: "font/woff2, font/woff, font/ttf, font/otf, */*;q=0.1",
  image: "image/avif, image/webp, image/png, image/jpeg, image/gif, */*;q=0.1",
};

/**
 * A browser-like User-Agent: Google Fonts picks the font format by User-Agent and serves WOFF2 only to browsers it
 * recognizes. It identifies PPTaken at the end.
 */
export const VENDOR_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PPTaken-vendor/1";

/** True when `host` is `entry` or a subdomain of it. */
export function hostMatches(host: string, entry: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const e = entry
    .toLowerCase()
    .replace(/^\*?\./, "")
    .replace(/\.$/, "");
  return e !== "" && (h === e || h.endsWith(`.${e}`));
}

const defaultTransport: VendorTransport = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    const pinned: LookupFunction = (_hostname, opts, callback) => {
      if ((opts as { all?: boolean }).all === true)
        (callback as unknown as (e: null, list: ResolvedAddress[]) => void)(null, [address]);
      else callback(null, address.address, address.family);
    };
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        lookup: pinned,
        agent: false,
        signal,
        headers,
      },
      (res) => {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") flat[k] = v;
          else if (Array.isArray(v)) flat[k] = v.join(", ");
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: flat,
          body: res,
          abort: () => res.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

interface CacheEntry {
  result: VendorFetchResult;
  at: number;
}

/** Creates the instance's {@link VendorFetcher}. */
export function createVendorFetcher(options: VendorFetcherOptions): VendorFetcher & {
  /** Fetches currently in flight (tests). */
  readonly inFlight: number;
} {
  const transport = options.transport ?? defaultTransport;
  const now = options.now ?? Date.now;
  const requestTimeout = options.requestTimeoutMs ?? 10_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const maxConcurrent = options.maxConcurrent ?? 8;
  const cacheBytes = options.cacheBytes ?? 64 * 1024 * 1024;
  const cacheTtl = options.cacheTtlMs ?? 60 * 60 * 1000;
  const caps: Record<VendorKind, number> = { ...VENDOR_MAX_BYTES, ...options.maxBytes };
  const allow = options.allowHosts ?? [];
  const deny = options.denyHosts ?? [];
  const cache = new Map<string, CacheEntry>();
  let cached = 0;
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  const acquire = async (deadline: number): Promise<void> => {
    if (inFlight < maxConcurrent) {
      inFlight++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const at = waiting.indexOf(go);
          if (at >= 0) waiting.splice(at, 1);
          reject(new VendorError("timeout", "Timed out waiting for a download slot"));
        },
        Math.max(0, deadline - now()),
      );
      const go = () => {
        clearTimeout(timer);
        inFlight++;
        resolve();
      };
      waiting.push(go);
    });
  };
  const release = () => {
    inFlight--;
    waiting.shift()?.();
  };

  const checkHost = (url: URL) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (deny.some((d) => hostMatches(host, d))) {
      throw new VendorError("not-allowed-host", `The host ${host} is refused by this instance`);
    }
    if (allow.length > 0 && !allow.some((a) => hostMatches(host, a))) {
      throw new VendorError(
        "not-allowed-host",
        `The host ${host} is not in this instance's allow list`,
      );
    }
  };

  /** One hop: checked, pinned, timed; returns the response or a redirect target. */
  const hop = async (
    raw: string,
    kind: VendorKind,
    deadline: number,
  ): Promise<{ redirect: string } | { bytes: Uint8Array; contentType: string | null }> => {
    let target: Awaited<ReturnType<typeof resolveSafeTarget>>;
    try {
      const parsed = new URL(raw);
      checkHost(parsed);
      target = await resolveSafeTarget(raw, options.resolve);
    } catch (error) {
      if (error instanceof VendorError) throw error;
      throw new VendorError(
        "blocked-address",
        error instanceof FetchBlockedError ? error.message : "Not a valid URL",
      );
    }
    const remaining = Math.min(requestTimeout, deadline - now());
    if (remaining <= 0) throw new VendorError("timeout", "The write's download deadline passed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const res = await transport({
        url: target.url,
        address: target.address,
        headers: {
          Accept: ACCEPT[kind],
          "User-Agent": VENDOR_USER_AGENT,
          "Accept-Encoding": "identity",
        },
        signal: controller.signal,
      });
      try {
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.location;
          if (location === undefined)
            throw new VendorError("http-error", `HTTP ${res.status} without a Location`);
          return { redirect: new URL(location, target.url).href };
        }
        if (res.status < 200 || res.status >= 300) {
          throw new VendorError("http-error", `The server answered HTTP ${res.status}`);
        }
        const encoding = (res.headers["content-encoding"] ?? "identity").trim().toLowerCase();
        if (encoding !== "" && encoding !== "identity") {
          throw new VendorError(
            "bad-type",
            `Compressed responses (${encoding.slice(0, 20)}) are not accepted`,
          );
        }
        const declared = Number(res.headers["content-length"] ?? "0");
        if (Number.isFinite(declared) && declared > caps[kind]) {
          throw new VendorError("too-large", `The ${kind} is larger than ${caps[kind]} bytes`);
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        // Every read races the timer: a server that trickles bytes (slow-loris) cannot hold the slot.
        const aborted = new Promise<never>((_, reject) => {
          const fail = () =>
            reject(new VendorError("timeout", `No complete answer within ${remaining} ms`));
          if (controller.signal.aborted) fail();
          else controller.signal.addEventListener("abort", fail, { once: true });
        });
        aborted.catch(() => {});
        const iterator = res.body[Symbol.asyncIterator]();
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next.done === true) break;
          const chunk = next.value;
          size += chunk.length;
          if (size > caps[kind])
            throw new VendorError("too-large", `The ${kind} is larger than ${caps[kind]} bytes`);
          chunks.push(chunk);
        }
        const bytes = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.length;
        }
        return { bytes, contentType: res.headers["content-type"] ?? null };
      } finally {
        res.abort();
      }
    } catch (error) {
      if (error instanceof VendorError) throw error;
      if (controller.signal.aborted)
        throw new VendorError("timeout", `No complete answer within ${remaining} ms`);
      throw new VendorError("fetch-failed", "The connection failed");
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    enabled: options.enabled,
    get inFlight() {
      return inFlight;
    },
    async fetch(request: VendorFetchRequest): Promise<VendorFetchResult> {
      if (!options.enabled) {
        throw new VendorError(
          "disabled",
          "The operator turned vendoring off (PPTAKEN_VENDOR_FETCH=off)",
        );
      }
      const key = `${request.kind} ${request.url}`;
      const hit = cache.get(key);
      if (hit !== undefined && now() - hit.at < cacheTtl) {
        return {
          ...hit.result,
          bytes: hit.result.bytes.slice(),
          redirects: [...hit.result.redirects],
        };
      }
      if (options.limiter !== undefined) {
        const decision = options.limiter.take(
          `${request.actor.actor}:${request.actor.tokenId ?? "-"}`,
        );
        if (!decision.ok)
          throw new VendorError("rate-limited", "Too many downloads by this agent; retry later");
      }
      await acquire(request.deadline);
      try {
        let url = request.url;
        const redirects: string[] = [];
        for (let i = 0; ; i++) {
          const answer = await hop(url, request.kind, request.deadline);
          if ("redirect" in answer) {
            if (i >= maxRedirects)
              throw new VendorError("http-error", `More than ${maxRedirects} redirects`);
            redirects.push(answer.redirect);
            url = answer.redirect;
            continue;
          }
          // Magic bytes and structure, not the declared type (the core checks again before storing).
          checkVendored(request.kind, answer.bytes, Number.MAX_SAFE_INTEGER);
          const result: VendorFetchResult = {
            url: request.url,
            finalUrl: url,
            redirects,
            bytes: answer.bytes,
            contentType: answer.contentType,
          };
          if (cacheBytes > 0 && answer.bytes.length <= cacheBytes / 4) {
            const old = cache.get(key);
            if (old !== undefined) cached -= old.result.bytes.length;
            cache.delete(key);
            cache.set(key, { result: { ...result, bytes: answer.bytes.slice() }, at: now() });
            cached += answer.bytes.length;
            for (const [k, v] of cache) {
              if (cached <= cacheBytes) break;
              cache.delete(k);
              cached -= v.result.bytes.length;
            }
          }
          return result;
        }
      } finally {
        release();
      }
    },
  };
}
