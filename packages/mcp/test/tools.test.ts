// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract tests: the SDK's own client over an in-memory transport, against a core on in-memory ports. Every tool,
// every error code the tools can produce, the tools/list snapshot and response sizes.
import { readFileSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Principal } from "@pptaken/core";
import { agentPrincipal, createTestCore, pngBytes } from "@pptaken/testing";
import { describe, expect, it } from "vitest";
import {
  AUTHORING_GUIDE,
  createMcpServer,
  GUIDE_EXAMPLE,
  type McpServerConfig,
  SERVER_INSTRUCTIONS,
  scriptsGuide,
  TOOL_NAMES,
  vendoringGuide,
} from "../src/index.js";

/** Rough token estimate: about 4 characters per token for English prose and JSON. */
const tokens = (text: string) => Math.ceil(text.length / 4);

const talk = JSON.parse(
  readFileSync(new URL("../../schema/examples/talk-20-slides.json", import.meta.url), "utf8"),
) as {
  title: string;
  lang: string;
  theme: { css: string; fonts: string[] };
  targetMinutes: number;
  slides: {
    id: string;
    title: string;
    html: string;
    css?: string;
    notes?: string;
    section?: string;
    durationHintSec?: number;
  }[];
};

/** The 20-slide example as `create_presentation` arguments (snake_case). */
export function talkArgs() {
  return {
    title: talk.title,
    lang: talk.lang,
    theme: talk.theme,
    target_minutes: talk.targetMinutes,
    slides: talk.slides.map(({ durationHintSec, ...s }) => ({
      ...s,
      ...(durationHintSec === undefined ? {} : { duration_hint_sec: durationHintSec }),
    })),
  };
}

async function connect(
  principal: Principal = agentPrincipal(),
  extra: Partial<McpServerConfig> = {},
  t = createTestCore(),
) {
  const server = createMcpServer({
    core: t.core,
    principal,
    config: { version: "0.1.0-test", baseUrl: "https://slides.example.com/", ...extra },
    call: { requestId: "req-1" },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
    return { isError: r.isError === true, text, body: JSON.parse(text) as Record<string, any> };
  };
  return { client, call, t };
}

describe("server metadata", () => {
  it("has seven lines of instructions and lists the eleven tools in a fixed order", async () => {
    const { client } = await connect();
    expect(SERVER_INSTRUCTIONS.split("\n")).toHaveLength(7);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const tool of list.tools) {
      expect(tool.description?.length).toBeGreaterThan(80);
      expect(tool.annotations?.readOnlyHint).toBeTypeOf("boolean");
      expect(tool.annotations?.destructiveHint).toBeTypeOf("boolean");
      expect(tool.annotations?.idempotentHint).toBeTypeOf("boolean");
      expect(tool.inputSchema.type).toBe("object");
    }
    expect(
      list.tools.find((t) => t.name === "delete_presentation")?.annotations?.destructiveHint,
    ).toBe(true);
    await expect(JSON.stringify(list.tools, null, 2)).toMatchFileSnapshot(
      "./__snapshots__/tools-list.json.snap",
    );
    expect(tokens(JSON.stringify(list.tools))).toBeLessThan(8000);
  });
});

describe("authoring guide", () => {
  it("is under 2,500 tokens and covers the essentials", async () => {
    expect(tokens(AUTHORING_GUIDE)).toBeLessThan(2500);
    for (const fact of [
      "1920×1080",
      "data-step",
      "add_asset",
      "asset:",
      "Inter",
      "No `<script>`",
      "256 KB",
    ]) {
      expect(AUTHORING_GUIDE).toContain(fact);
    }
    const { call } = await connect();
    const r = await call("get_authoring_guide");
    expect(r.isError).toBe(false);
    expect(r.body.guide).toBe(AUTHORING_GUIDE + vendoringGuide(false) + scriptsGuide("off"));
  });

  it("its example renders without sanitizer warnings", async () => {
    const { call } = await connect();
    const r = await call("create_presentation", GUIDE_EXAMPLE);
    expect(r.isError).toBe(false);
    expect(r.body.warnings).toEqual([]);
  });
});

describe("tools", () => {
  it("whoami reports scopes, limits and the base URL", async () => {
    const { call } = await connect();
    const r = await call("whoami");
    expect(r.body).toMatchObject({
      instance: "PPTaken",
      base_url: "https://slides.example.com",
      actor: "agent",
      scopes: ["decks:read", "decks:write", "quiz:draft"],
      token_id: "tok_agent",
    });
    expect(r.body.limits.asset_bytes_per_call).toBe(1024 * 1024);
  });

  it("create → list → get → update_slides → update_presentation → links → delete", async () => {
    const { call } = await connect();
    const created = await call("create_presentation", { ...talkArgs(), idempotency_key: "k1" });
    expect(created.isError).toBe(false);
    const id = created.body.presentation_id as string;
    expect(created.body).toMatchObject({
      revision: 1,
      slide_count: 20,
      urls: {
        present: `https://slides.example.com/p/${id}`,
        manage: `https://slides.example.com/decks/${id}`,
      },
      warnings: [],
    });
    expect(tokens(created.text)).toBeLessThan(2000);

    const replay = await call("create_presentation", { ...talkArgs(), idempotency_key: "k1" });
    expect(replay.body).toMatchObject({ presentation_id: id, replayed: true });

    const list = await call("list_presentations", { query: "taken care" });
    expect(
      list.body.presentations.map((p: { presentation_id: string }) => p.presentation_id),
    ).toEqual([id]);
    expect(list.body.next_cursor).toBeNull();

    const outline = await call("get_presentation", { presentation_id: id });
    expect(outline.body.revision).toBe(1);
    expect(outline.body.outline).toHaveLength(20);
    expect(outline.body.outline[1]).toMatchObject({ id: "agenda", steps: 4, has_notes: true });
    expect(outline.body.slides).toBeUndefined();
    expect(tokens(outline.text)).toBeLessThan(2000);

    const one = await call("get_presentation", {
      presentation_id: id,
      include: ["slides", "notes"],
      slide_ids: ["agenda"],
    });
    expect(one.body.slides).toHaveLength(1);
    expect(one.body.slides[0].notes).toBeUndefined();
    expect(one.body.notes[0].id).toBe("agenda");

    const edited = await call("update_slides", {
      presentation_id: id,
      expected_revision: 1,
      upsert: [
        { id: "agenda", title: "New agenda", notes: null },
        {
          id: "extra",
          after: "start",
          html: "<h1 style='font-size:120px'>Hi</h1><script>alert(1)</script>",
        },
      ],
      remove: ["cover"],
    });
    expect(edited.isError).toBe(false);
    expect(edited.body).toMatchObject({ revision: 2, slide_count: 20 });
    expect(edited.body.warnings[0]).toMatchObject({ code: "REMOVED_ELEMENT", slide_id: "extra" });

    const meta = await call("update_presentation", {
      presentation_id: id,
      expected_revision: 2,
      title: "Renamed",
      target_minutes: null,
    });
    expect(meta.body).toMatchObject({ revision: 3 });

    const links = await call("get_presentation_links", { presentation_id: id });
    expect(links.body).toMatchObject({ title: "Renamed", revision: 3, share_links: [] });

    const del = await call("delete_presentation", { presentation_id: id });
    expect(del.body).toMatchObject({ presentation_id: id, trashed: true });
    expect(Date.parse(del.body.restorable_until)).toBeGreaterThan(0);
    const gone = await call("get_presentation", { presentation_id: id });
    expect(gone.body.code).toBe("NOT_FOUND");
  });

  it("add_asset uploads base64 and the ref is usable in slides", async () => {
    const { call } = await connect();
    const { body } = await call("create_presentation", {
      title: "Img",
      slides: [{ html: "<p>x</p>" }],
    });
    const png = Buffer.from(pngBytes(800, 600)).toString("base64");
    const r = await call("add_asset", {
      presentation_id: body.presentation_id,
      filename: "a.png",
      source: { base64: png, media_type: "image/png" },
    });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ media_type: "image/png", width: 800, height: 600 });
    expect(r.body.ref).toMatch(/^asset:[0-9a-f]{64}$/);
    const again = await call("add_asset", {
      presentation_id: body.presentation_id,
      source: { base64: png, media_type: "image/png" },
    });
    expect(again.body.deduplicated).toBe(true);
    const used = await call("update_slides", {
      presentation_id: body.presentation_id,
      expected_revision: 1,
      upsert: [
        { id: "slide-1", html: `<img src="${r.body.ref}" alt="a" width="800" height="600">` },
      ],
    });
    expect(used.body.warnings).toEqual([]);
  });
});

describe("errors are actionable", () => {
  const shape = (body: Record<string, unknown>) => {
    expect(typeof body.code).toBe("string");
    expect(typeof body.message).toBe("string");
    expect(typeof body.hint).toBe("string");
    expect(typeof body.retryable).toBe("boolean");
  };

  it("VALIDATION_ERROR with snake_case paths and hints", async () => {
    const { call } = await connect();
    const missing = await call("create_presentation", { title: "x" });
    expect(missing.isError).toBe(true);
    shape(missing.body);
    expect(missing.body).toMatchObject({ code: "VALIDATION_ERROR", path: "slides" });

    const big = await call("create_presentation", {
      title: "x",
      slides: [{ html: "x" }, { html: "y" }, { html: "z".repeat(300 * 1024) }],
    });
    expect(big.body).toMatchObject({ code: "VALIDATION_ERROR", path: "slides[2].html" });
    expect(big.body.hint).toContain("add_asset");

    const camel = await call("update_slides", { presentationId: "x", expected_revision: 1 });
    expect(camel.body.code).toBe("VALIDATION_ERROR");
    expect(camel.body.hint).toContain("snake_case");

    const nothing = await call("create_presentation", { title: "t", slides: [{ html: "a" }] });
    const empty = await call("update_slides", {
      presentation_id: nothing.body.presentation_id,
      expected_revision: 1,
    });
    expect(empty.body.code).toBe("VALIDATION_ERROR");

    const badB64 = await call("add_asset", {
      presentation_id: nothing.body.presentation_id,
      source: { base64: "@@@", media_type: "image/png" },
    });
    expect(badB64.body).toMatchObject({ code: "VALIDATION_ERROR", path: "source.base64" });

    const order = await call("update_presentation", {
      presentation_id: nothing.body.presentation_id,
      expected_revision: 1,
      slide_order: ["nope"],
    });
    expect(order.body).toMatchObject({ code: "VALIDATION_ERROR", path: "slide_order[0]" });
  });

  it("NOT_FOUND, REVISION_CONFLICT, LIMIT_EXCEEDED, UNSUPPORTED_MEDIA, FETCH_BLOCKED", async () => {
    const { call } = await connect();
    const nf = await call("get_presentation", { presentation_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" });
    shape(nf.body);
    expect(nf.body).toMatchObject({ code: "NOT_FOUND", path: "presentation_id" });
    expect(nf.body.hint).toContain("list_presentations");

    const { body } = await call("create_presentation", { title: "t", slides: [{ html: "a" }] });
    const id = body.presentation_id;
    await call("update_slides", {
      presentation_id: id,
      expected_revision: 1,
      upsert: [{ html: "b" }],
    });
    const conflict = await call("update_slides", {
      presentation_id: id,
      expected_revision: 1,
      upsert: [{ html: "c" }],
    });
    expect(conflict.body).toMatchObject({
      code: "REVISION_CONFLICT",
      path: "expected_revision",
      retryable: true,
    });
    expect(conflict.body.hint).toContain("current revision is 2");

    const tooBig = Buffer.alloc(1024 * 1024 + 3).toString("base64");
    const limit = await call("add_asset", {
      presentation_id: id,
      source: { base64: tooBig, media_type: "image/png" },
    });
    expect(limit.body).toMatchObject({ code: "LIMIT_EXCEEDED", path: "source.base64" });

    const media = await call("add_asset", {
      presentation_id: id,
      source: {
        base64: Buffer.from("not an image at all").toString("base64"),
        media_type: "image/png",
      },
    });
    expect(media.body.code).toBe("UNSUPPORTED_MEDIA");

    const url = await call("add_asset", {
      presentation_id: id,
      source: { url: "https://example.com/a.png" },
    });
    expect(url.body).toMatchObject({ code: "FETCH_BLOCKED", path: "source.url" });
    expect(url.body.hint).toContain("base64");

    const tooMany = await call("create_presentation", {
      title: "t",
      slides: Array.from({ length: 201 }, () => ({ html: "a" })),
    });
    expect(tooMany.body.code).toBe("VALIDATION_ERROR");
    expect(tooMany.body.hint).toContain("200");
  });

  it("FORBIDDEN_SCOPE for a read-only token, RATE_LIMITED from the limiter, INTERNAL with request id", async () => {
    const reader = await connect(agentPrincipal(["decks:read"]));
    const denied = await reader.call("create_presentation", {
      title: "t",
      slides: [{ html: "a" }],
    });
    expect(denied.body).toMatchObject({
      code: "FORBIDDEN_SCOPE",
      details: { requiredScope: "decks:write" },
    });
    expect((await reader.call("list_presentations")).isError).toBe(false);
    const none = await connect(agentPrincipal([]));
    expect((await none.call("get_authoring_guide")).body.code).toBe("FORBIDDEN_SCOPE");
    expect((await none.call("whoami")).isError).toBe(false);

    const limited = await connect(agentPrincipal(), {
      rateLimit: ({ write }) =>
        write ? { ok: false, retryAfterSec: 7 } : { ok: true, retryAfterSec: 0 },
    });
    const rl = await limited.call("create_presentation", { title: "t", slides: [{ html: "a" }] });
    expect(rl.body).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      details: { retry_after_sec: 7 },
    });
    expect((await limited.call("whoami")).isError).toBe(false);

    const t = createTestCore();
    const broken = {
      ...t.core,
      listPresentations: () => Promise.reject(new Error("boom /secret/path")),
    };
    const internal = await connect(agentPrincipal(), {}, { ...t, core: broken });
    const r = await internal.call("list_presentations");
    expect(r.body).toMatchObject({
      code: "INTERNAL",
      retryable: true,
      details: { request_id: "req-1" },
    });
    expect(r.text).not.toContain("boom");
  });

  it("reports activity with the client name", async () => {
    const seen: { tool: string; clientName: string | null }[] = [];
    const { call } = await connect(agentPrincipal(), {
      onActivity: ({ tool, clientName }) => {
        seen.push({ tool, clientName });
        throw new Error("ignored");
      },
    });
    expect((await call("whoami")).isError).toBe(false);
    expect(seen).toEqual([{ tool: "whoami", clientName: "test-client 1.0.0" }]);
  });
});
