// SPDX-License-Identifier: AGPL-3.0-or-later
// Configuration from environment variables (architecture §12), validated at startup with clear errors.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf8")) as {
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
  /** Optional separate, cookie-less origin for `/c/*` (deck documents, assets, fonts). */
  contentUrl: string | null;
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
  /** Largest `.pptaken` archive accepted by `POST /api/v1/decks/import` (PPTAKEN_MAX_IMPORT_MB, default 100). */
  maxImportBytes: number;
  logLevel: "debug" | "info" | "warn" | "error";
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

function int(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
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
  const allowedHosts = (env.PPTAKEN_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  for (const h of allowedHosts) {
    if (!/^[a-z0-9.-]+$/.test(h))
      throw new ConfigError(`PPTAKEN_ALLOWED_HOSTS: invalid host name "${h}"`);
  }
  return {
    version: packageVersion(),
    publicUrl,
    contentUrl,
    host: env.PPTAKEN_HOST || "0.0.0.0",
    port: int("PPTAKEN_PORT", env.PPTAKEN_PORT, 8080, 0, 65535),
    dataDir: resolve(env.PPTAKEN_DATA_DIR || "./data"),
    trustProxy: bool("PPTAKEN_TRUST_PROXY", env.PPTAKEN_TRUST_PROXY),
    webDir: resolve(env.PPTAKEN_WEB_DIR || resolve(PACKAGE_DIR, "../web/dist")),
    fontsDir: resolve(env.PPTAKEN_FONTS_DIR || resolve(PACKAGE_DIR, "../../packages/ui/fonts")),
    allowedHosts,
    defaultLang: lang,
    adminPassword: adminPasswordFrom(env),
    secretKey: env.PPTAKEN_SECRET_KEY || undefined,
    secretKeyFile: env.PPTAKEN_SECRET_KEY_FILE || undefined,
    maxApiBodyBytes:
      int("PPTAKEN_MAX_API_BODY_KB", env.PPTAKEN_MAX_API_BODY_KB, 64, 1, 1024) * 1024,
    maxMcpBodyBytes:
      int("PPTAKEN_MAX_MCP_BODY_MB", env.PPTAKEN_MAX_MCP_BODY_MB, 4, 1, 32) * 1024 * 1024,
    maxImportBytes:
      int("PPTAKEN_MAX_IMPORT_MB", env.PPTAKEN_MAX_IMPORT_MB, 100, 1, 1024) * 1024 * 1024,
    logLevel: logLevel as ServerConfig["logLevel"],
  };
}
