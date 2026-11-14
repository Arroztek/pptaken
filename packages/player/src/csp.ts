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

export interface CspOptions {
  /** Per-response nonce of the runtime script. */
  nonce: string;
  /**
   * Absolute URL of the content asset path (`https://content.example/c/asset/`). Images and fonts are allowed
   * only under it, never `'self'`. Without it, images and fonts are blocked (`'none'`).
   */
  assetBaseUrl?: string | undefined;
  /** Origins allowed to frame the deck document (`frame-ancestors`), for example the app origin. */
  frameAncestors?: readonly string[] | undefined;
}

/** Value of the `Content-Security-Policy` header of a deck document. */
export function contentSecurityPolicy(options: CspOptions): string {
  assertNonce(options.nonce);
  let assets = "'none'";
  if (options.assetBaseUrl !== undefined) {
    assertAssetBaseUrl(options.assetBaseUrl);
    assets = options.assetBaseUrl;
  }
  const directives = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'nonce-${options.nonce}'`,
    "style-src 'unsafe-inline'",
    `img-src ${assets}`,
    `font-src ${assets}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ];
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
