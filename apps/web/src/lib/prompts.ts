// SPDX-License-Identifier: AGPL-3.0-or-later
// Text the owner copies into an agent. Pure functions: easy to test, no DOM, no secrets kept.

export const SECRET_PATTERN = /^ppt_[A-Za-z0-9_-]{43}$/;

/** What the page shows instead of the secret until the owner reveals it. */
export const MASKED_SECRET = "ppt_••••••••••••••••";

export class PromptInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptInputError";
  }
}

/**
 * Normalize an MCP URL so it is safe inside a double-quoted argument in bash, zsh, PowerShell and cmd:
 * http(s) only, no credentials, and every character outside a conservative set is percent-encoded
 * (this covers $, `, ", \, !, spaces and quotes, which shells would interpret).
 */
export function safeMcpUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PromptInputError("The MCP URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PromptInputError("The MCP URL must use http or https.");
  }
  if (url.username || url.password)
    throw new PromptInputError("The MCP URL must not contain credentials.");
  return url.href.replace(/[^A-Za-z0-9\-._~:/?#[\]@&+,;=%]/g, (ch) =>
    Array.from(new TextEncoder().encode(ch))
      .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  );
}

function checkSecret(secret: string): string {
  if (!SECRET_PATTERN.test(secret))
    throw new PromptInputError("The token does not have the expected format.");
  return secret;
}

export interface SetupPromptInput {
  mcpUrl: string;
  /** The real secret, or null to render the masked preview shown before the owner reveals it. */
  secret: string | null;
}

/**
 * The Claude Code setup prompt. User scope keeps the token in Claude Code's own config,
 * never in a project's .mcp.json that could end up in git.
 */
export function buildSetupPrompt({ mcpUrl, secret }: SetupPromptInput): string {
  const url = safeMcpUrl(mcpUrl);
  const token = secret === null ? MASKED_SECRET : checkSecret(secret);
  return [
    "Connect PPTaken to Claude Code so you can create presentations for me.",
    "",
    "1. Run this command once, exactly as written. The user scope keeps the token out of project files such as .mcp.json:",
    `   claude mcp add --transport http pptaken "${url}" --header "Authorization: Bearer ${token}" --scope user`,
    "2. Call the whoami tool of the pptaken MCP server to check the connection. If its tools are not loaded yet, ask me to restart Claude Code first.",
    "3. Tell me in one line whether it works.",
    "",
    "Do not write the token anywhere else: no files, notes, commits or memory.",
  ].join("\n");
}

/** Generic MCP client configuration (the "mcpServers" shape most clients accept). */
export function buildClientConfig({ mcpUrl, secret }: SetupPromptInput): string {
  const url = safeMcpUrl(mcpUrl);
  const token = secret === null ? MASKED_SECRET : checkSecret(secret);
  return JSON.stringify(
    {
      mcpServers: {
        pptaken: { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
      },
    },
    null,
    2,
  );
}

/** The MCP endpoint derived from the public URL, used until /connect/status answers. */
export function mcpUrlFrom(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/mcp`;
}
