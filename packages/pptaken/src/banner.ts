// SPDX-License-Identifier: AGPL-3.0-or-later
// What `npx pptaken` prints when it is ready: where to open it, the one-time install code, where the data lives,
// how to stop, and how to connect Claude. Pure text formatting (style is injected), unit tested.

export const DOCS = "https://docs-pkn.arroz.dev";
export const CONNECT_DOCS = `${DOCS}/connect/overview/`;
export const PUBLIC_HTTPS_DOCS = `${DOCS}/connect/overview/#why-claude-needs-a-public-https-address`;
export const REVERSE_PROXY_DOCS = `${DOCS}/deploy/reverse-proxy/`;

export interface Style {
  /** ANSI colours (off when NO_COLOR is set, when the output is not a terminal, or TERM=dumb). */
  color: boolean;
  /** Box-drawing and arrows; plain ASCII on legacy Windows consoles. */
  unicode: boolean;
}

/** Decides the output style from the stream and the environment (https://no-color.org). */
export function detectStyle(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Style {
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const color = stream.isTTY === true && !noColor && env.TERM !== "dumb";
  // Windows Terminal, VS Code, ConEmu and mintty render UTF-8 well; the legacy console host may not.
  const modernWindows =
    env.WT_SESSION !== undefined ||
    env.TERM_PROGRAM === "vscode" ||
    env.ConEmuANSI === "ON" ||
    (env.TERM ?? "").startsWith("xterm");
  const unicode = stream.isTTY === true && (platform !== "win32" || modernWindows);
  return { color, unicode };
}

const ANSI = {
  bold: [1, 22],
  dim: [2, 22],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
} as const;
type Tone = keyof typeof ANSI;

export function paint(style: Style, tone: Tone, text: string): string {
  if (!style.color) return text;
  const [on, off] = ANSI[tone];
  return `\u001b[${on}m${text}\u001b[${off}m`;
}

export interface BannerInput {
  version: string;
  url: string;
  installCode: string | null;
  dataDir: string;
  host: string;
  exposed: boolean;
  scripts: "owner" | "off";
  /** "Port 8080 was busy, so PPTaken uses 8081." */
  portNote?: string | undefined;
}

export function formatBanner(input: BannerInput, style: Style): string {
  const rule = style.unicode ? "─".repeat(64) : "-".repeat(64);
  const arrow = style.unicode ? "→" : "->";
  const label = (text: string) => paint(style, "dim", text.padEnd(14));
  const lines: string[] = [""];
  lines.push(`  ${paint(style, "bold", `PPTaken ${input.version} is running.`)}`);
  lines.push(`  ${rule}`);
  lines.push(`  ${label("Open")}${paint(style, "cyan", input.url)}`);
  if (input.installCode !== null) {
    lines.push(
      `  ${label("Install code")}${paint(style, "bold", paint(style, "green", input.installCode))}`,
    );
    lines.push(
      `  ${" ".repeat(14)}First run: enter this code on the welcome page to create your owner account.`,
    );
  } else {
    lines.push(
      `  ${label("Sign in")}with your owner password (forgot it? npx pptaken reset-password)`,
    );
  }
  lines.push(`  ${label("Data")}${input.dataDir}`);
  lines.push(`  ${label("Stop")}press Ctrl+C`);
  if (input.scripts === "owner") {
    lines.push(
      `  ${label("Interactive")}on: deck scripts run in your own session after you approve them`,
    );
  }
  if (input.portNote !== undefined) lines.push(`  ${label("Note")}${input.portNote}`);
  lines.push(`  ${rule}`);
  lines.push(`  ${paint(style, "bold", `Next step: connect Claude ${arrow} ${CONNECT_DOCS}`)}`);
  lines.push(
    `  - Claude Code on this computer: works with ${input.url}/mcp and an access key from the`,
  );
  lines.push("    panel (Connect Claude, Developer).");
  lines.push(
    "  - Claude Desktop and claude.ai connect from Anthropic's cloud, so they cannot reach",
  );
  lines.push("    http://localhost: they need a public https:// address. Why and how:");
  lines.push(`    ${PUBLIC_HTTPS_DOCS}`);
  if (input.exposed) {
    lines.push("");
    lines.push(
      `  ${paint(style, "yellow", "WARNING")}  PPTaken listens on ${input.host}: other devices on your network can reach it`,
    );
    lines.push(
      "           over plain HTTP, without encryption (passwords and access keys travel in clear).",
    );
    lines.push(
      "           Use it only on a network you trust, or put it behind an HTTPS reverse proxy:",
    );
    lines.push(`           ${REVERSE_PROXY_DOCS}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** True for addresses that only this computer can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}
