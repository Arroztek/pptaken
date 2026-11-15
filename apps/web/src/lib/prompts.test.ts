// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  buildClientConfig,
  buildSetupPrompt,
  MASKED_SECRET,
  mcpUrlFrom,
  PromptInputError,
  safeMcpUrl,
} from "./prompts";

const SECRET = `ppt_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0-_x"}`;

describe("safeMcpUrl", () => {
  it("keeps ordinary URLs intact", () => {
    expect(safeMcpUrl("https://slides.example.com/mcp")).toBe("https://slides.example.com/mcp");
    expect(safeMcpUrl("http://192.168.1.20:8080/mcp")).toBe("http://192.168.1.20:8080/mcp");
  });

  it("percent-encodes characters a shell would interpret inside double quotes", () => {
    const out = safeMcpUrl('https://x.test/a$(rm -rf ~)`b`"c"\\d!e\'f/mcp');
    for (const ch of ["$", "`", '"', "\\", "!", "'", " ", "(", ")"]) expect(out).not.toContain(ch);
    expect(out.startsWith("https://x.test/")).toBe(true);
  });

  it("rejects non-http schemes, credentials and garbage", () => {
    expect(() => safeMcpUrl("javascript:alert(1)")).toThrow(PromptInputError);
    expect(() => safeMcpUrl("file:///etc/passwd")).toThrow(PromptInputError);
    expect(() => safeMcpUrl("https://user:pass@x.test/mcp")).toThrow(PromptInputError);
    expect(() => safeMcpUrl("not a url")).toThrow(PromptInputError);
  });
});

describe("buildSetupPrompt", () => {
  const prompt = buildSetupPrompt({ mcpUrl: "https://slides.example.com/mcp", secret: SECRET });

  it("contains the exact claude mcp add command with user scope", () => {
    expect(prompt).toContain(
      `claude mcp add --transport http pptaken "https://slides.example.com/mcp" --header "Authorization: Bearer ${SECRET}" --scope user`,
    );
  });

  it("asks to verify with whoami, report back and not store the token elsewhere", () => {
    expect(prompt).toMatch(/whoami tool of the pptaken MCP server/);
    expect(prompt).toMatch(/Tell me in one line/);
    expect(prompt).toMatch(/Do not write the token anywhere else/);
    expect(prompt).toMatch(/\.mcp\.json/);
  });

  it("includes the secret exactly once", () => {
    expect(prompt.split(SECRET).length - 1).toBe(1);
  });

  it("renders a masked preview without any secret", () => {
    const preview = buildSetupPrompt({ mcpUrl: "https://slides.example.com/mcp", secret: null });
    expect(preview).toContain(MASKED_SECRET);
    expect(preview).not.toMatch(/ppt_[A-Za-z0-9_-]{43}/);
  });

  it("rejects malformed secrets (no injection through the token)", () => {
    expect(() =>
      buildSetupPrompt({ mcpUrl: "https://x.test/mcp", secret: 'ppt_x" && curl evil' }),
    ).toThrow(PromptInputError);
    expect(() => buildSetupPrompt({ mcpUrl: "https://x.test/mcp", secret: `${SECRET}\n` })).toThrow(
      PromptInputError,
    );
  });

  it("escapes the URL inside the command", () => {
    const p = buildSetupPrompt({ mcpUrl: "https://x.test/$HOME/mcp", secret: SECRET });
    expect(p).toContain('"https://x.test/%24HOME/mcp"');
  });

  it("stays short", () => {
    expect(prompt.split("\n").length).toBeLessThanOrEqual(10);
    expect(prompt.length).toBeLessThan(900);
  });
});

describe("buildClientConfig", () => {
  it("is valid JSON with the Bearer header", () => {
    const parsed = JSON.parse(buildClientConfig({ mcpUrl: "https://x.test/mcp", secret: SECRET }));
    expect(parsed).toEqual({
      mcpServers: {
        pptaken: {
          type: "http",
          url: "https://x.test/mcp",
          headers: { Authorization: `Bearer ${SECRET}` },
        },
      },
    });
  });

  it("masks the secret when none is given", () => {
    const text = buildClientConfig({ mcpUrl: "https://x.test/mcp", secret: null });
    expect(text).toContain(MASKED_SECRET);
  });
});

describe("mcpUrlFrom", () => {
  it("appends /mcp without doubling slashes", () => {
    expect(mcpUrlFrom("http://localhost:8080")).toBe("http://localhost:8080/mcp");
    expect(mcpUrlFrom("https://slides.example.com/")).toBe("https://slides.example.com/mcp");
  });
});
