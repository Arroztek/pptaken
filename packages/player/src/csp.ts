// SPDX-License-Identifier: Apache-2.0
// HTTP headers of the content route (barriers 2 and 3 of ADR-001, with the findings of its two verifications).
//
// Production must serve deck documents and assets from a separate, cookie-less origin (for example
// `https://usercontent.example`), also for self-hosted instances: a navigation started by content (for example a
// `<meta http-equiv="refresh">` that slipped past the sanitizer) cannot be stopped by any CSP directive, and on
// the app origin it would carry the session cookie in WebKit. The shell only takes a `contentUrl`, so where the
// content lives is the server's decision.

/** `http(s)://host[:port]/path/`: absolute (CSP source expressions need a host) and ending in `/`. */
const ASSET_BASE_URL =
  /^https?:\/\/(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?\/(?:(?!\.{1,2}\/)[A-Za-z0-9._~-]+\/)*$/;

/** A CSP nonce: at least 128 bits in base64 or base64url. */
const NONCE = /^[A-Za-z0-9+/_-]{22,128}={0,2}$/;

/** A frame ancestor: an origin `http(s)://host[:port]` with no path. */
const ORIGIN =
  /^https?:\/\/(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;

export function assertNonce(nonce: unknown): asserts nonce is string {
  if (typeof nonce !== "string" || !NONCE.test(nonce)) {
    throw new TypeError(
      "nonce must be a fresh random value of at least 128 bits in base64 (22 to 128 characters)",
    );
  }
}

export function assertAssetBaseUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || !ASSET_BASE_URL.test(url)) {
    throw new TypeError(
      "assetBaseUrl must be an absolute http(s) URL of the asset path ending in '/', such as https://content.example/c/asset/",
    );
  }
}

/** A CSP hash source value: SHA-256 in base64 (44 characters). */
const SHA256_B64 = /^[A-Za-z0-9+/]{43}=$/;

export interface CspOptions {
  /**
   * Per-response nonce of the runtime script (static documents). Exactly one of `nonce` and `scriptHashes` is
   * required.
   */
  nonce?: string | undefined;
  /**
   * Script mode (ADR-020): the SHA-256 (base64) of every script of the document: the runtime, each library and
   * each wrapped author script. The policy is then hash-only (no nonce, no `'strict-dynamic'`, no
   * `'unsafe-eval'`) and adds `script-src-attr 'none'`, `worker-src 'none'`, `webrtc 'block'` and Trusted Types.
   */
  scriptHashes?: readonly string[] | undefined;
  /**
   * Absolute URL of the content asset path (`https://content.example/c/asset/`). Images and fonts are allowed
   * only under it, never `'self'`. Without it, images and fonts are blocked (`'none'`).
   */
  assetBaseUrl?: string | undefined;
  /**
   * Absolute URL of the bundled-font path (`https://content.example/c/fonts/`). Allowed in `font-src` in addition to
   * the asset path; fonts are never allowed from anywhere else.
   */
  fontBaseUrl?: string | undefined;
  /** Origins allowed to frame the deck document (`frame-ancestors`), for example the app origin. */
  frameAncestors?: readonly string[] | undefined;
}

/** Value of the `Content-Security-Policy` header of a deck document. */
export function contentSecurityPolicy(options: CspOptions): string {
  const hashes = options.scriptHashes;
  if ((options.nonce === undefined) === (hashes === undefined)) {
    throw new TypeError("pass exactly one of nonce and scriptHashes");
  }
  let scriptSrc: string;
  if (hashes !== undefined) {
    if (hashes.length === 0 || hashes.length > 512)
      throw new TypeError("scriptHashes: 1 to 512 hashes");
    for (const h of hashes) {
      if (typeof h !== "string" || !SHA256_B64.test(h))
        throw new TypeError("scriptHashes: not a SHA-256");
    }
    scriptSrc = [...new Set(hashes)].map((h) => `'sha256-${h}'`).join(" ");
  } else {
    assertNonce(options.nonce);
    scriptSrc = `'nonce-${options.nonce}'`;
  }
  let assets = "'none'";
  if (options.assetBaseUrl !== undefined) {
    assertAssetBaseUrl(options.assetBaseUrl);
    assets = options.assetBaseUrl;
  }
  let fonts = assets;
  if (options.fontBaseUrl !== undefined) {
    assertAssetBaseUrl(options.fontBaseUrl);
    fonts = assets === "'none'" ? options.fontBaseUrl : `${assets} ${options.fontBaseUrl}`;
  }
  const directives = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'unsafe-inline'",
    `img-src ${assets}`,
    `font-src ${fonts}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ];
  if (hashes !== undefined) {
    directives.push(
      "script-src-attr 'none'",
      "worker-src 'none'",
      "object-src 'none'",
      "webrtc 'block'",
      "require-trusted-types-for 'script'",
      "trusted-types default",
    );
  }
  if (options.frameAncestors !== undefined) {
    for (const origin of options.frameAncestors) {
      if (!ORIGIN.test(origin)) throw new TypeError(`frameAncestors: not an origin: ${origin}`);
    }
    const list = options.frameAncestors.length > 0 ? options.frameAncestors.join(" ") : "'none'";
    directives.push(`frame-ancestors ${list}`);
  }
  return directives.join("; ");
}

/** Powerful features the content never needs. */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/**
 * Recommended response headers of a deck document. The nonce must be new for every response, which is why the
 * document is not cacheable (offline caching is designed in F3).
 */
export function contentHeaders(options: CspOptions): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": contentSecurityPolicy(options),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cache-Control": "no-store",
    // Anchors created by content must not leak host names to DNS (an exfiltration channel CSP cannot see).
    "X-DNS-Prefetch-Control": "off",
  };
}

/**
 * Recommended security headers of an asset response (add `Content-Type`). Assets are requested by an opaque
 * origin, so fonts need `Access-Control-Allow-Origin` (spike S1). Send it on asset routes only: never on API
 * routes. Assets are content-addressed, hence immutable. Do not redirect asset requests: CSP path matching is
 * relaxed after a redirect.
 */
export function assetHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "public, max-age=31536000, immutable",
  };
}
