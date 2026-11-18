// SPDX-License-Identifier: AGPL-3.0-or-later
// @pptaken/mcp: the MCP tools of PPTaken (architecture §5) on top of @pptaken/core, independent of the transport.

export {
  AUTHORING_GUIDE,
  AUTHORING_GUIDE_VERSION,
  GUIDE_EXAMPLE,
  type InteractiveExample,
  interactiveExamples,
  libraryCatalog,
  MAX_ASSET_BASE64_BYTES,
  type ScriptsStatusLabel,
  scriptsGuide,
} from "./guide.js";
export {
  type CreateMcpServerOptions,
  createMcpServer,
  type McpServerConfig,
  type RateLimitDecision,
  SERVER_INSTRUCTIONS,
  snakePath,
  TOOL_NAMES,
  WRITE_TOOLS,
} from "./server.js";
