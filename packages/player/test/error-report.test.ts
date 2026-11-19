// SPDX-License-Identifier: Apache-2.0
// The owner page's script error reporter (ADR-023): batching, growth-only counts, caps, 429 back-off, keepalive on
// page hide, and the exact request it sends.
import { describe, expect, it } from "vitest";
import {
  createErrorReporter,
  REPORT_FIRST_DELAY_MS,
  REPORT_MAX_ENTRIES,
  REPORT_MAX_REQUESTS,
  REPORT_MIN_INTERVAL_MS,
} from "../dist/error-report.js";
import { labelsFor } from "../dist/i18n.js";
import { agentMessage } from "../dist/presenter.js";

const DECK = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const DIGEST = "a".repeat(64);

function harness(status = 204, headers: Record<string, string> = {}) {
  let time = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const reporter = createErrorReporter({
    deckId: DECK,
    digest: DIGEST,
    now: () => time,
    setTimeout: (fn, ms) => timers.push({ at: time + ms, fn }),
    fetch: async (url, init) => {
      calls.push({ url, init: init as RequestInit });
      return new Response(null, { status, headers });
    },
  });
  if (!reporter) throw new Error("no reporter");
  const advance = async (ms: number) => {
    time += ms;
    for (;;) {
      const next = timers.findIndex((t) => t.at <= time);
      if (next < 0) break;
      const [timer] = timers.splice(next, 1);
      timer?.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { reporter, calls, advance, timers };
}

const report = (over: Record<string, unknown> = {}) => ({
  kind: "setup" as const,
  slideId: "intro",
  slideIndex: 0,
  name: "ReferenceError",
  message: "root is not defined",
  stack: "",
  count: 1,
  ...over,
});

const body = (call: { init: RequestInit }) => JSON.parse(String(call.init.body));

describe("createErrorReporter", () => {
  it("refuses invalid deck ids and digests", () => {
    expect(createErrorReporter({ deckId: "../x", digest: DIGEST })).toBeNull();
    expect(createErrorReporter({ deckId: DECK, digest: "nope" })).toBeNull();
  });

  it("batches the first report, then sends growth only, at most every 5 s", async () => {
    const h = harness();
    h.reporter.add(report());
    h.reporter.add(report({ count: 3 }));
    h.reporter.add(report({ count: 2 })); // older news: ignored
    await h.advance(REPORT_FIRST_DELAY_MS - 1);
    expect(h.calls).toHaveLength(0);
    await h.advance(1);
    expect(h.calls).toHaveLength(1);
    const first = h.calls[0];
    expect(first?.url).toBe(`/api/v1/decks/${DECK}/script-errors`);
    expect(first?.init.method).toBe("POST");
    expect(first?.init.credentials).toBe("same-origin");
    expect((first?.init.headers as Record<string, string>)["X-PPTaken-CSRF"]).toBe("1");
    expect(body(first as { init: RequestInit })).toEqual({
      digest: DIGEST,
      errors: [
        {
          kind: "setup",
          slideId: "intro",
          name: "ReferenceError",
          message: "root is not defined",
          stack: "",
          count: 3,
        },
      ],
    });
    h.reporter.add(report({ count: 10 }));
    await h.advance(REPORT_MIN_INTERVAL_MS - 100);
    expect(h.calls).toHaveLength(1);
    await h.advance(100);
    expect(h.calls).toHaveLength(2);
    expect(body(h.calls[1] as { init: RequestInit }).errors[0].count).toBe(7);
  });

  it("caps entries per request and requests per page", async () => {
    const h = harness();
    for (let i = 0; i < 45; i++) h.reporter.add(report({ message: `m${i}` }));
    await h.advance(REPORT_FIRST_DELAY_MS);
    expect(body(h.calls[0] as { init: RequestInit }).errors).toHaveLength(REPORT_MAX_ENTRIES);
    for (let i = 0; i < 200; i++) {
      h.reporter.add(report({ message: `m${i % 45}`, count: i + 2 }));
      await h.advance(REPORT_MIN_INTERVAL_MS);
    }
    expect(h.calls.length).toBeLessThanOrEqual(REPORT_MAX_REQUESTS);
  });

  it("pauses after a 429 for Retry-After seconds", async () => {
    const h = harness(429, { "Retry-After": "60" });
    h.reporter.add(report());
    await h.advance(REPORT_FIRST_DELAY_MS);
    h.reporter.add(report({ count: 2 }));
    await h.advance(30_000);
    expect(h.calls).toHaveLength(1);
    await h.advance(31_000);
    expect(h.calls).toHaveLength(2);
  });

  it("flushes with keepalive on page hide", async () => {
    const h = harness();
    h.reporter.add(report());
    h.reporter.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.init.keepalive).toBe(true);
  });
});

describe("agentMessage", () => {
  it("is plain text with the cleaned title and the id, and no error text", () => {
    const t = labelsFor("en");
    const text = agentMessage(t, "Qubits\u202e <b>live</b>\n", DECK);
    expect(text).toContain('"Qubits <b>live</b>"');
    expect(text).toContain(`(${DECK})`);
    expect(text).toContain("get_presentation");
    expect(text).not.toContain("\u202e");
    expect(agentMessage(t, "x", "bad id with spaces")).toContain("(?)");
    expect(agentMessage(labelsFor("es"), "x", DECK)).toContain("script_errors");
  });
});
