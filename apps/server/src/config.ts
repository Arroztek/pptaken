// SPDX-License-Identifier: AGPL-3.0-or-later
// Configuration from environment variables (architecture §12), validated at startup with clear errors.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { configVar } from "./config-vars.js";
import { runtimePaths } from "./runtime-paths.js";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(runtimePaths.packageJson, "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface ServerConfig {
  version: string;
  /** Public origin, e.g. `https://slides.example.com` (no path, no trailing slash); null: derived per request. */
  publicUrl: string | null;
  /**
   * Issuer of the built-in OAuth authorization server (ADR-0018): exactly PPTAKEN_PUBLIC_URL when it is https, or
   * http on a loopback host (development). Null otherwise: OAuth is off (no metadata, no endpoints), API tokens only.
   */
  oauthIssuer: string | null;
  /** Optional separate, cookie-less origin for `/c/*` (deck documents, assets, fonts). */
  contentUrl: string | null;
  /**
   * How the content origin relates to the app origin (ADR-020 §4): `same-origin` (no PPTAKEN_CONTENT_URL),
   * `same-site` (another port or a sibling host of the same registrable domain, conservatively) or
   * `separate-site`. Only `separate-site` gives Firefox process isolation for the content frame.
   */
  contentOrigin: ContentOriginRelation;
  /**
   * Interactive mode (ADR-020, PPTAKEN_SCRIPTS): `off` (default: author scripts are stored but never run) or
   * `owner` (they run in the owner's own session once the owner approved the deck's scripts digest).
   */
  scripts: "off" | "owner";
  /**
   * Ingest-time vendoring (ADR-022, PPTAKEN_VENDOR_FETCH): `on` (default) fetches the external resources a deck
   * references once and stores them; `off` refuses writes that reference external resources.
   */
  vendorFetch: boolean;
  /** PPTAKEN_VENDOR_ALLOW_HOSTS: when non-empty, only these hosts (and subdomains) are fetched. */
  vendorAllowHosts: string[];
  /** PPTAKEN_VENDOR_DENY_HOSTS: these hosts (and subdomains) are never fetched. */
  vendorDenyHosts: string[];
  host: string;
  port: number;
  dataDir: string;
  /** Take the client IP and scheme from X-Forwarded-For / X-Forwarded-Proto (only behind a trusted proxy). */
  trustProxy: boolean;
  /** Optional owner password for unattended installs (PPTAKEN_ADMIN_PASSWORD or the _FILE variant). */
  adminPassword?: string | undefined;
  /** Built web app (`apps/web/dist`); served only if it exists. */
  webDir: string;
  /** Bundled font files (`packages/ui/fonts`). */
  fontsDir: string;
  /** Extra host names accepted in the Host header (besides the public/content hosts, localhost and IPs). */
  allowedHosts: string[];
  defaultLang: string | undefined;
  /** Secret key injected through the environment (wins over `<dataDir>/secret.key`). */
  secretKey: string | undefined;
  secretKeyFile: string | undefined;
  maxApiBodyBytes: number;
  maxMcpBodyBytes: number;
  /** Largest `.pkn` archive accepted by `POST /api/v1/decks/import` (PPTAKEN_MAX_IMPORT_MB, default 100). */
  maxImportBytes: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export type ContentOriginRelation = "same-origin" | "same-site" | "separate-site";

/** Conservative "site" key of a host name: the host itself for IP literals and single labels, else its last two labels. */
function siteKey(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split(".");
  return labels.length <= 2 ? host : labels.slice(-2).join(".");
}

/**
 * How a content origin relates to the app origin, decided offline without the Public Suffix List (ADR-020 §4).
 * Host names are compared by their last two labels, so the answer errs on the safe side: `a.example.co.uk` and
 * `b.other.co.uk` (different sites for browsers) and `x.github.io` / `y.github.io` are reported as
 * `same-site`. Ports and schemes are ignored (cookies ignore ports). IP literals are separate sites when they
 * differ. `null` content URL: content is served from the app origin itself.
 */
export function contentOriginRelation(
  publicUrl: string | null,
  contentUrl: string | null,
): ContentOriginRelation {
  if (contentUrl === null || publicUrl === null) return "same-origin";
  const app = new URL(publicUrl);
  const content = new URL(contentUrl);
  if (app.origin === content.origin) return "same-origin";
  if (app.hostname.toLowerCase() === content.hostname.toLowerCase()) return "same-site";
  return siteKey(app.hostname) === siteKey(content.hostname) ? "same-site" : "separate-site";
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function originOf(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `${name} must be an absolute URL such as https://slides.example.com (got "${value}")`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must use http or https`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ConfigError(`${name} must not contain credentials, a query or a fragment`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ConfigError(
      `${name} must be an origin without a path (PPTaken is served from the root)`,
    );
  }
  return url.origin;
}

/** An integer variable: default and bounds come from the declarative table in config-vars.ts. */
function int(name: string, value: string | undefined): number {
  const spec = configVar(name);
  const fallback = Number(spec.default);
  const min = spec.min ?? 0;
  const max = spec.max ?? Number.MAX_SAFE_INTEGER;
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new ConfigError(`${name} must be an integer (got "${value}")`);
  const n = Number(value);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}

function adminPasswordFrom(env: Record<string, string | undefined>): string | undefined {
  if (env.PPTAKEN_ADMIN_PASSWORD) return env.PPTAKEN_ADMIN_PASSWORD;
  const file = env.PPTAKEN_ADMIN_PASSWORD_FILE;
  if (!file) return undefined;
  try {
    // A trailing newline is how most secret files end; it is not part of the password.
    return readFileSync(file, "utf8").replace(/\r?\n$/, "") || undefined;
  } catch {
    throw new ConfigError(`PPTAKEN_ADMIN_PASSWORD_FILE: cannot read ${file}`);
  }
}

function bool(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  const v = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(`${name} must be true or false (got "${value}")`);
}

/** The OAuth issuer for a public URL (see {@link ServerConfig.oauthIssuer}). */
export function oauthIssuerOf(publicUrl: string | null): string | null {
  if (publicUrl === null) return null;
  const url = new URL(publicUrl);
  if (url.protocol === "https:") return publicUrl;
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  return loopback ? publicUrl : null;
}

/** Reads and validates the configuration. Throws {@link ConfigError} with a message naming the variable. */
export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const publicUrl = env.PPTAKEN_PUBLIC_URL
    ? originOf("PPTAKEN_PUBLIC_URL", env.PPTAKEN_PUBLIC_URL)
    : null;
  const contentUrl = env.PPTAKEN_CONTENT_URL
    ? originOf("PPTAKEN_CONTENT_URL", env.PPTAKEN_CONTENT_URL)
    : null;
  if (contentUrl !== null && publicUrl === null) {
    throw new ConfigError("PPTAKEN_CONTENT_URL requires PPTAKEN_PUBLIC_URL");
  }
  if (contentUrl !== null && contentUrl === publicUrl) {
    throw new ConfigError("PPTAKEN_CONTENT_URL must be a different origin than PPTAKEN_PUBLIC_URL");
  }
  const lang = env.PPTAKEN_LANG || undefined;
  if (lang !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) {
    throw new ConfigError("PPTAKEN_LANG must be a BCP-47 tag such as en or es-PE");
  }
  const logLevel = (env.PPTAKEN_LOG_LEVEL || "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new ConfigError("PPTAKEN_LOG_LEVEL must be debug, info, warn or error");
  }
  const scripts = (env.PPTAKEN_SCRIPTS || "off").toLowerCase();
  if (scripts !== "off" && scripts !== "owner") {
    throw new ConfigError(
      'PPTAKEN_SCRIPTS must be "off" (default) or "owner" (author scripts run in the owner\'s own session after approval)',
    );
  }
  const allowedHosts = (env.PPTAKEN_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  for (const h of allowedHosts) {
    if (!/^[a-z0-9.-]+$/.test(h))
      throw new ConfigError(`PPTAKEN_ALLOWED_HOSTS: invalid host name "${h}"`);
  }
  const vendor = (env.PPTAKEN_VENDOR_FETCH || "on").toLowerCase();
  if (vendor !== "on" && vendor !== "off") {
    throw new ConfigError('PPTAKEN_VENDOR_FETCH must be "on" (default) or "off"');
  }
  const hostList = (name: string): string[] => {
    const list = (env[name] ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase().replace(/^\*\./, ""))
      .filter((h) => h !== "");
    for (const h of list) {
      if (!/^[a-z0-9.-]{1,253}$/.test(h))
        throw new ConfigError(`${name}: invalid host name "${h}"`);
    }
    return list;
  };
  return {
    version: packageVersion(),
    vendorFetch: vendor === "on",
    vendorAllowHosts: hostList("PPTAKEN_VENDOR_ALLOW_HOSTS"),
    vendorDenyHosts: hostList("PPTAKEN_VENDOR_DENY_HOSTS"),
    publicUrl,
    oauthIssuer: oauthIssuerOf(publicUrl),
    contentUrl,
    contentOrigin: contentOriginRelation(publicUrl, contentUrl),
    scripts,
    host: env.PPTAKEN_HOST || "0.0.0.0",
    port: int("PPTAKEN_PORT", env.PPTAKEN_PORT),
    dataDir: resolve(env.PPTAKEN_DATA_DIR || "./data"),
    trustProxy: bool("PPTAKEN_TRUST_PROXY", env.PPTAKEN_TRUST_PROXY),
    webDir: resolve(env.PPTAKEN_WEB_DIR || runtimePaths.webDir),
    fontsDir: resolve(env.PPTAKEN_FONTS_DIR || runtimePaths.fontsDir),
    allowedHosts,
    defaultLang: lang,
    adminPassword: adminPasswordFrom(env),
    secretKey: env.PPTAKEN_SECRET_KEY || undefined,
    secretKeyFile: env.PPTAKEN_SECRET_KEY_FILE || undefined,
    maxApiBodyBytes: int("PPTAKEN_MAX_API_BODY_KB", env.PPTAKEN_MAX_API_BODY_KB) * 1024,
    maxMcpBodyBytes: int("PPTAKEN_MAX_MCP_BODY_MB", env.PPTAKEN_MAX_MCP_BODY_MB) * 1024 * 1024,
    maxImportBytes: int("PPTAKEN_MAX_IMPORT_MB", env.PPTAKEN_MAX_IMPORT_MB) * 1024 * 1024,
    logLevel: logLevel as ServerConfig["logLevel"],
  };
}
