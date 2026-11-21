// SPDX-License-Identifier: AGPL-3.0-or-later
// The environment variables the server reads, as data. config.ts takes the numeric bounds from this table, a test
// keeps the table and the code in step, and `pnpm -s --filter @pptaken/server docs:config` prints it as JSON for the
// documentation site (scripts/config-reference.mjs). Behaviour lives in loadConfig(); this file only describes it.

export type ConfigVarType =
  | "origin"
  | "boolean"
  | "integer"
  | "enum"
  | "list"
  | "string"
  | "path"
  | "secret"
  | "language";

export interface ConfigVar {
  name: string;
  type: ConfigVarType;
  /** Value used when the variable is unset or empty, as text; null when there is none. */
  default: string | null;
  /** Default in the official Docker image when it differs from `default` (the image sets it with ENV). */
  imageDefault?: string;
  /** Accepted values for `enum` (lower-case; the server compares case-insensitively). */
  allowed?: readonly string[];
  /** Inclusive bounds and unit for `integer`. */
  min?: number;
  max?: number;
  unit?: string;
  /** The server refuses to start without it. */
  required: boolean;
  example: string;
  /** Release that introduced the variable. */
  since: string;
  /** English description (the documentation adds translations). */
  description: string;
  group: "address" | "access" | "data" | "interactive" | "limits" | "network" | "advanced";
}

export const CONFIG_VARS: readonly ConfigVar[] = [
  {
    name: "PPTAKEN_PUBLIC_URL",
    type: "origin",
    default: null,
    required: false,
    example: "https://slides.example.com",
    since: "0.1.0",
    group: "address",
    description:
      "The address people and agents use to reach this PPTaken: an origin with no path and no trailing slash. It must match the name in the browser, or every request is refused with 403. OAuth (connecting Claude on the web and Desktop) is on only when it is https, or http on localhost. When unset the address is derived from each request.",
  },
  {
    name: "PPTAKEN_TRUST_PROXY",
    type: "boolean",
    default: "false",
    required: false,
    example: "true",
    since: "0.1.0",
    group: "network",
    description:
      "Take the client IP and the scheme from X-Forwarded-For and X-Forwarded-Proto. Set it to true only behind a reverse proxy you control; otherwise anyone can forge those headers. Accepts true, false, 1, 0, yes, no, on, off.",
  },
  {
    name: "PPTAKEN_ADMIN_PASSWORD",
    type: "secret",
    default: null,
    required: false,
    example: "a long passphrase of your own",
    since: "0.1.0",
    group: "access",
    description:
      "Creates the owner at the first start, so no install code is printed and you sign in with this password. At least 12 characters and not a weak one, or the server stops with a message. It is only used while no owner exists: it never changes an existing password.",
  },
  {
    name: "PPTAKEN_ADMIN_PASSWORD_FILE",
    type: "path",
    default: null,
    required: false,
    example: "/run/secrets/pptaken_admin_password",
    since: "0.1.0",
    group: "access",
    description:
      "Path of a file that holds the owner password (for example a Docker secret). Used when PPTAKEN_ADMIN_PASSWORD is empty. A trailing newline is ignored. The server stops if the file cannot be read.",
  },
  {
    name: "PPTAKEN_SCRIPTS",
    type: "enum",
    default: "off",
    allowed: ["off", "owner"],
    required: false,
    example: "owner",
    since: "0.1.0",
    group: "interactive",
    description:
      "Interactive mode. off: code that an agent adds to slides is stored but never runs. owner: code runs in the owner's own signed-in session after the owner has allowed it.",
  },
  {
    name: "PPTAKEN_CONTENT_URL",
    type: "origin",
    default: null,
    required: false,
    example: "https://content.example.net",
    since: "0.1.0",
    group: "interactive",
    description:
      "Optional separate origin that serves slide content (/c/*), without cookies. For stronger isolation of interactive code it must be a different site than PPTAKEN_PUBLIC_URL (a sibling subdomain does not count). Both names must reach the same PPTaken. Requires PPTAKEN_PUBLIC_URL and must differ from it.",
  },
  {
    name: "PPTAKEN_PUBLIC_LINKS",
    type: "enum",
    default: "on",
    allowed: ["on", "off"],
    required: false,
    example: "off",
    since: "0.1.0",
    group: "access",
    description:
      'Public links. on: the owner can share a presentation with a link that opens without an account (to watch it, or to present it from another computer). off: every /s/ link answers "not available" and the panel explains how to turn links on. The owner can also turn links off in Settings.',
  },
  {
    name: "PPTAKEN_ALLOWED_HOSTS",
    type: "list",
    default: null,
    required: false,
    example: "slides.internal,pptaken.lan",
    since: "0.1.0",
    group: "network",
    description:
      "Comma-separated extra host names accepted in the Host header, besides the public and content hosts, localhost and IP addresses. Use it when the same instance answers on another name.",
  },
  {
    name: "PPTAKEN_LANG",
    type: "language",
    default: null,
    required: false,
    example: "es",
    since: "0.1.0",
    group: "advanced",
    description:
      "Default language of new presentations and of the messages the agent relays to you (Spanish for any es tag, English otherwise). A BCP-47 tag such as en or es-PE.",
  },
  {
    name: "PPTAKEN_LOG_LEVEL",
    type: "enum",
    default: "info",
    allowed: ["debug", "info", "warn", "error"],
    required: false,
    example: "info",
    since: "0.1.0",
    group: "advanced",
    description: "How much the server writes to its log.",
  },
  {
    name: "PPTAKEN_SECRET_KEY",
    type: "secret",
    default: null,
    required: false,
    example: "64 hex characters (256 bits)",
    since: "0.1.0",
    group: "access",
    description:
      "The instance secret, 256 bits as 64 hex characters (or 43 base64 characters). Wins over the file. When neither is set the server creates data/secret.key at the first start, which is what most installs want.",
  },
  {
    name: "PPTAKEN_SECRET_KEY_FILE",
    type: "path",
    default: null,
    required: false,
    example: "/run/secrets/pptaken_secret_key",
    since: "0.1.0",
    group: "access",
    description: "Path of a file that holds the instance secret (for example a Docker secret).",
  },
  {
    name: "PPTAKEN_VENDOR_FETCH",
    type: "enum",
    default: "on",
    allowed: ["on", "off"],
    required: false,
    example: "on",
    since: "0.1.0",
    group: "interactive",
    description:
      "on: when a presentation references fonts, images, stylesheets or libraries by https address, the server downloads each one once and stores it. off: writes that reference outside files are refused with a clear message.",
  },
  {
    name: "PPTAKEN_VENDOR_ALLOW_HOSTS",
    type: "list",
    default: null,
    required: false,
    example: "fonts.googleapis.com,fonts.gstatic.com,cdn.jsdelivr.net",
    since: "0.1.0",
    group: "interactive",
    description:
      "Comma-separated host names (subdomains included). When not empty, only these hosts are downloaded from. A leading *. is accepted and ignored.",
  },
  {
    name: "PPTAKEN_VENDOR_DENY_HOSTS",
    type: "list",
    default: null,
    required: false,
    example: "tracker.example.com",
    since: "0.1.0",
    group: "interactive",
    description: "Comma-separated host names (subdomains included) that are never downloaded from.",
  },
  {
    name: "PPTAKEN_HOST",
    type: "string",
    default: "0.0.0.0",
    required: false,
    example: "0.0.0.0",
    since: "0.1.0",
    group: "network",
    description:
      "Address the server listens on inside its own network namespace. In Docker leave it alone: the published port is chosen by the platform or by PPTAKEN_BIND in the standalone compose file.",
  },
  {
    name: "PPTAKEN_PORT",
    type: "integer",
    default: "8080",
    min: 0,
    max: 65535,
    required: false,
    example: "8080",
    since: "0.1.0",
    group: "network",
    description:
      "Port the server listens on. The Docker image listens on 8080; to publish another port on your machine use PPTAKEN_PORT with the standalone compose file, which maps it to 8080 inside.",
  },
  {
    name: "PPTAKEN_DATA_DIR",
    type: "path",
    default: "./data",
    imageDefault: "/data",
    required: false,
    example: "/data",
    since: "0.1.0",
    group: "data",
    description:
      "Folder with everything PPTaken stores: pptaken.db, blobs/ and secret.key. The Docker image sets it to /data, a volume.",
  },
  {
    name: "PPTAKEN_WEB_DIR",
    type: "path",
    default: null,
    imageDefault: "/app/web",
    required: false,
    example: "/app/web",
    since: "0.1.0",
    group: "data",
    description:
      "Folder with the built panel. Set by the Docker image; you only need it when you run PPTaken from source.",
  },
  {
    name: "PPTAKEN_FONTS_DIR",
    type: "path",
    default: null,
    imageDefault: "/app/fonts",
    required: false,
    example: "/app/fonts",
    since: "0.1.0",
    group: "data",
    description:
      "Folder with the bundled font files. Set by the Docker image; you only need it when you run PPTaken from source.",
  },
  {
    name: "PPTAKEN_MAX_API_BODY_KB",
    type: "integer",
    default: "64",
    min: 1,
    max: 1024,
    unit: "KB",
    required: false,
    example: "64",
    since: "0.1.0",
    group: "limits",
    description: "Largest request body the panel API accepts.",
  },
  {
    name: "PPTAKEN_MAX_MCP_BODY_MB",
    type: "integer",
    default: "4",
    min: 1,
    max: 32,
    unit: "MB",
    required: false,
    example: "4",
    since: "0.1.0",
    group: "limits",
    description:
      "Largest request body the MCP endpoint accepts. Raise it if your agent sends very large presentations.",
  },
  {
    name: "PPTAKEN_MAX_IMPORT_MB",
    type: "integer",
    default: "100",
    min: 1,
    max: 1024,
    unit: "MB",
    required: false,
    example: "100",
    since: "0.1.0",
    group: "limits",
    description: "Largest .pkn archive that Import accepts.",
  },
];

export function configVar(name: string): ConfigVar {
  const found = CONFIG_VARS.find((v) => v.name === name);
  if (found === undefined) throw new Error(`Unknown configuration variable ${name}`);
  return found;
}
