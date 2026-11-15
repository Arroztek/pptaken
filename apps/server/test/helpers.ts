// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createServer, type PPTakenServer } from "../src/app.js";
import { loadConfig } from "../src/config.js";

declare global {
  // Test convenience: JSON bodies are inspected loosely in assertions.
  interface Response {
    json(): Promise<any>;
  }
}

export const ORIGIN = "http://localhost:8080";
export const PASSWORD = "violet otter climbs 7 dunes";

export class TestClock {
  t = Date.UTC(2026, 10, 14, 12, 0, 0);
  now() {
    return this.t;
  }
}

export interface Harness {
  server: PPTakenServer;
  logs: string[];
  clock: TestClock;
  dataDir: string;
  /** A request through `app.request` with the panel's usual headers (Origin, CSRF, JSON). */
  api(
    method: string,
    path: string,
    options?: { body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: string },
  ): Promise<Response>;
  cleanup(): Promise<void>;
}

export async function makeHarness(env: Record<string, string> = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "pptaken-server-"));
  const logs: string[] = [];
  const clock = new TestClock();
  const config = loadConfig({
    PPTAKEN_DATA_DIR: dataDir,
    PPTAKEN_WEB_DIR: join(dataDir, "no-web"),
    ...env,
  });
  const server = await createServer(config, {
    logSink: (line) => logs.push(line),
    clock,
    scrypt: { ln: 10, r: 8, p: 1 },
  });
  return {
    server,
    logs,
    clock,
    dataDir,
    api: (method, path, options = {}) => {
      const headers: Record<string, string> = { Origin: ORIGIN, "X-PPTaken-CSRF": "1" };
      if (options.body !== undefined || options.raw !== undefined)
        headers["Content-Type"] = "application/json";
      if (options.cookie !== undefined) headers.Cookie = options.cookie;
      Object.assign(headers, options.headers);
      for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
      return Promise.resolve(
        server.app.request(`${ORIGIN}${path}`, {
          method,
          headers,
          ...(options.raw !== undefined
            ? { body: options.raw }
            : options.body !== undefined
              ? { body: JSON.stringify(options.body) }
              : {}),
        }),
      );
    },
    async cleanup() {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** `name=value` of the session cookie set by a response. */
export function sessionCookie(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  const m = /((?:__Host-)?pptaken_session)=([^;]+)/.exec(set);
  if (m === null) throw new Error(`no session cookie in ${set}`);
  return `${m[1]}=${m[2]}`;
}

/** Runs setup with the install code and returns the owner's cookie. */
export async function setupOwner(h: Harness): Promise<string> {
  const res = await h.api("POST", "/api/v1/setup", {
    body: { installCode: h.server.installCode, password: PASSWORD },
  });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  return sessionCookie(res);
}

export async function createToken(
  h: Harness,
  cookie: string,
  body: Record<string, unknown> = { name: "test" },
) {
  const res = await h.api("POST", "/api/v1/tokens", { body, cookie });
  if (res.status !== 201) throw new Error(`token failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { token: { id: string; scopes: string[] }; secret: string };
}

/** Listens on a random local port. */
export async function listen(
  server: PPTakenServer,
): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const s = serve(
      { fetch: server.fetch, port: 0, hostname: "127.0.0.1" },
      (info: AddressInfo) => {
        resolve({
          base: `http://127.0.0.1:${info.port}`,
          close: () =>
            new Promise<void>((done) => {
              (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
              s.close(() => done());
            }),
        });
      },
    );
  });
}

export async function mcpClient(base: string, secret: string) {
  const client = new Client({ name: "pptaken-test-agent", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    return { isError: r.isError === true, body: JSON.parse(text) as Record<string, any>, text };
  };
  return { client, call };
}

const talk = JSON.parse(
  readFileSync(
    new URL("../../../packages/schema/examples/talk-20-slides.json", import.meta.url),
    "utf8",
  ),
) as {
  title: string;
  lang: string;
  theme: unknown;
  targetMinutes: number;
  slides: Record<string, unknown>[];
};

/** The 20-slide example deck as `create_presentation` arguments. */
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
