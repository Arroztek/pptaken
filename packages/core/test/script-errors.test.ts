// SPDX-License-Identifier: AGPL-3.0-or-later
// Script error visibility (ADR-023) in the core: the text cleaner, hints, the digest gate on reports, strict entry
// validation, dedupe and counts, the per-digest cap, pruning when the code changes, clear (human only, audited),
// purge, and the static script check on writes.
import { agentPrincipal, createTestCore, ownerPrincipal } from "@pptaken/testing";
import { describe, expect, it } from "vitest";
import { isDomainError } from "../src/errors.js";
import { cleanErrorText, SCRIPT_ERROR_LIMITS, scriptErrorHint } from "../src/script-errors.js";

const owner = ownerPrincipal();
const agent = agentPrincipal();
const BROKEN = "var b = root.querySelector('#go'); b.id;";
const FIXED = "var root = slide.root; root.id;";

async function approvedDeck(script = BROKEN) {
  const t = createTestCore({ config: { scriptsEnabled: true } });
  const r = await t.core.createPresentation(agent, {
    title: "S",
    slides: [
      { id: "intro", title: "Intro", html: "<p>a</p>", script },
      { id: "two", title: "Two", html: "<p>b</p>" },
    ],
  });
  const digest = r.scripts.digest as string;
  await t.core.approveScripts(owner, { presentationId: r.presentationId, digest });
  return { t, id: r.presentationId, digest, created: r };
}

const err = (over: Record<string, unknown> = {}) => ({
  kind: "setup",
  slideId: "intro",
  name: "ReferenceError",
  message: "root is not defined",
  stack: "ReferenceError: root is not defined\n    at https://c.example/c/X/1?ct=SECRET.TOKEN:4:9",
  count: 1,
  ...over,
});

describe("cleanErrorText", () => {
  it("keeps only strings, strips control/bidi/invisible characters and truncates", () => {
    expect(cleanErrorText(42, 10)).toBe("");
    expect(cleanErrorText({ toString: () => "x" }, 10)).toBe("");
    expect(cleanErrorText("a\u0000b\u202ec\u2066d\u200be\u0007", 50)).toBe("abcde");
    expect(cleanErrorText("x".repeat(400), SCRIPT_ERROR_LIMITS.message)).toHaveLength(300);
    expect(cleanErrorText("line1\nline2", 50)).toBe("line1 line2");
    expect(cleanErrorText("line1\n\u0001line2\n\n", 50, true)).toBe("line1\nline2");
    expect(cleanErrorText("\ud800 lone", 50)).toBe("lone");
  });

  it("redacts URLs (they carry the signed content token) but keeps line:column", () => {
    expect(cleanErrorText("at https://c.example/c/X/1?ct=AAA.BBB:4:9)", 200)).toBe(
      "at <deck>:4:9)",
    );
    expect(cleanErrorText("@blob:https://x/uuid:1:2", 200)).toBe("@<deck>:1:2");
    expect(cleanErrorText("Warning about: nothing", 200)).toBe("Warning about: nothing");
  });
});

describe("scriptErrorHint", () => {
  it("maps the common mistakes", () => {
    const h = (message: string, name = "TypeError", kind = "setup") =>
      scriptErrorHint({ kind, name, message });
    expect(h("root is not defined", "ReferenceError")).toBe("declare-root");
    expect(h("Can't find variable: root", "ReferenceError")).toBe("declare-root");
    expect(h("Cannot read properties of null (reading 'addEventListener')")).toBe(
      "selector-missed",
    );
    expect(h("fetch is not a function")).toBe("network-disabled");
    expect(h("onEnter is not defined", "ReferenceError")).toBe("slide-api");
    expect(h("Refused to evaluate a string as JavaScript", "EvalError")).toBe(null);
    expect(h("x", "SyntaxError", "script-load")).toBe("syntax");
    expect(h("", "Watchdog", "watchdog")).toBe("frozen");
  });
});

describe("reportScriptErrors", () => {
  it("stores, dedupes and counts errors for the approved current digest", async () => {
    const { t, id, digest } = await approvedDeck();
    const r = await t.core.reportScriptErrors(owner, {
      presentationId: id,
      digest,
      errors: [err(), err({ count: 2 }), err({ kind: "handler", slideId: "two", message: "boom" })],
    });
    expect(r).toEqual({ accepted: 2, dropped: 0 });
    await t.core.reportScriptErrors(owner, { presentationId: id, digest, errors: [err()] });
    const view = await t.core.getScriptErrors(agent, { presentationId: id });
    expect(view.status).toBe("errors");
    const first = view.current.find((e) => e.kind === "setup");
    expect(first).toMatchObject({
      slideId: "intro",
      slideTitle: "Intro",
      slideIndex: 0,
      name: "ReferenceError",
      count: 4,
      hint: "declare-root",
    });
    expect(first?.stack).not.toContain("SECRET");
    expect(first?.stack).toContain("<deck>:4:9");
  });

  it("ignores reports for another digest or an unapproved deck", async () => {
    const { t, id, digest } = await approvedDeck();
    const other = "b".repeat(64);
    expect(
      await t.core.reportScriptErrors(owner, {
        presentationId: id,
        digest: other,
        errors: [err()],
      }),
    ).toMatchObject({ accepted: 0, ignored: "digest_mismatch" });
    await t.core.revokeScripts(owner, { presentationId: id });
    expect(
      await t.core.reportScriptErrors(owner, { presentationId: id, digest, errors: [err()] }),
    ).toMatchObject({ accepted: 0, ignored: "not_approved" });
    expect((await t.core.getScriptErrors(owner, { presentationId: id })).current).toEqual([]);
  });

  it("refuses agents (human only)", async () => {
    const { t, id, digest } = await approvedDeck();
    const failure = await t.core
      .reportScriptErrors(agent, { presentationId: id, digest, errors: [err()] })
      .catch((e: unknown) => e);
    expect(isDomainError(failure) && failure.code).toBe("FORBIDDEN_ACTOR");
  });

  it("drops entries with wrong types, unknown keys, unknown slides or bad counts", async () => {
    const { t, id, digest } = await approvedDeck();
    const r = await t.core.reportScriptErrors(owner, {
      presentationId: id,
      digest,
      errors: [
        null,
        "x",
        [],
        err({ kind: "evil" }),
        err({ slideId: "nope" }),
        err({ message: { toString: "x" } }),
        err({ count: 0 }),
        err({ count: 1.5 }),
        err({ count: 1e9 }),
        { ...err(), extra: 1 },
        { __proto__: { kind: "setup" } },
        err({ slideId: "deck", kind: "script-load", message: "<img src=x onerror=alert(1)>" }),
      ],
    });
    expect(r).toEqual({ accepted: 1, dropped: 11 });
    const view = await t.core.getScriptErrors(owner, { presentationId: id });
    // Stored as plain text, unchanged apart from the cleaner: the UI escapes it.
    expect(view.current[0]?.message).toBe("<img src=x onerror=alert(1)>");
  });

  it("caps a report and keeps at most 30 distinct errors per digest (least recently seen evicted)", async () => {
    const { t, id, digest } = await approvedDeck();
    for (let batch = 0; batch < 3; batch++) {
      const errors = Array.from({ length: 25 }, (_, i) => err({ message: `e${batch}-${i}` }));
      const r = await t.core.reportScriptErrors(owner, { presentationId: id, digest, errors });
      expect(r).toEqual({ accepted: 20, dropped: 5 });
      t.clock.advance(1000);
    }
    const view = await t.core.getScriptErrors(owner, { presentationId: id });
    expect(view.current).toHaveLength(SCRIPT_ERROR_LIMITS.perDigest);
    expect(view.current.some((e) => e.message === "e2-19")).toBe(true);
    expect(view.current.some((e) => e.message === "e0-0")).toBe(false);
  });

  it("prunes stale digests on a code change but keeps the previous version", async () => {
    const { t, id, digest } = await approvedDeck();
    await t.core.reportScriptErrors(owner, { presentationId: id, digest, errors: [err()] });
    const v1 = await t.core.getPresentation(agent, { presentationId: id });
    const w = await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: v1.revision,
      upsert: [{ id: "intro", script: FIXED }],
    });
    expect(w.warnings.filter((x) => x.code.startsWith("SCRIPT_"))).toEqual([]);
    let view = await t.core.getScriptErrors(agent, { presentationId: id });
    expect(view.status).toBe("previous_only");
    expect(view.previous).toHaveLength(1);
    expect(view.previousDigest).toBe(digest);
    // Approve and report under the second digest, then change again: the first digest goes.
    await t.core.approveScripts(owner, { presentationId: id, digest: w.scripts.digest as string });
    await t.core.reportScriptErrors(owner, {
      presentationId: id,
      digest: w.scripts.digest as string,
      errors: [err({ message: "second" })],
    });
    const w2 = await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: w.revision,
      upsert: [{ id: "intro", script: `${FIXED} root.title;` }],
    });
    view = await t.core.getScriptErrors(agent, { presentationId: id });
    expect(view.previousDigest).toBe(w.scripts.digest);
    expect(view.previous.map((e) => e.message)).toEqual(["second"]);
    expect(w2.scripts.digest).not.toBe(w.scripts.digest);
  });

  it("clear is owner only and audited; purge deletes the rows", async () => {
    const { t, id, digest } = await approvedDeck();
    await t.core.reportScriptErrors(owner, { presentationId: id, digest, errors: [err()] });
    const denied = await t.core.clearScriptErrors(agent, { presentationId: id }).catch((e) => e);
    expect(isDomainError(denied) && denied.code).toBe("FORBIDDEN_ACTOR");
    expect(await t.core.clearScriptErrors(owner, { presentationId: id })).toEqual({ deleted: 1 });
    const log = await t.core.listAuditLog(owner, { target: `deck:${id}` });
    expect(log.items.map((e) => `${e.action}:${e.result}`)).toEqual(
      expect.arrayContaining([
        "presentation.script_errors_clear:ok",
        "presentation.script_errors_clear:denied",
      ]),
    );
    await t.core.reportScriptErrors(owner, { presentationId: id, digest, errors: [err()] });
    await t.core.trashPresentation(owner, { presentationId: id });
    await t.core.purgePresentation(owner, { presentationId: id });
    expect(await t.store.scriptErrors.list("default", id)).toEqual([]);
  });

  it("decks without scripts report status none", async () => {
    const t = createTestCore();
    const r = await t.core.createPresentation(agent, {
      title: "x",
      slides: [{ html: "<p>x</p>" }],
    });
    const view = await t.core.getScriptErrors(agent, { presentationId: r.presentationId });
    expect(view).toMatchObject({ status: "none", digest: null, current: [], previous: [] });
  });
});

describe("static script check on writes", () => {
  it("returns non-fatal warnings with stable codes and never blocks the write", async () => {
    const t = createTestCore({ config: { scriptsEnabled: true } });
    const r = await t.core.createPresentation(agent, {
      title: "S",
      slides: [
        { id: "a", html: "<p>a</p>", script: BROKEN },
        { id: "b", html: "<p>b</p>", script: "if (x {" },
        { id: "c", html: "<p>c</p>", script: "fetch('/x');" },
      ],
    });
    const found = r.warnings
      .filter((w) => w.code.startsWith("SCRIPT_"))
      .map((w) => [w.code, w.slideId, w.path]);
    expect(found).toEqual([
      ["SCRIPT_UNDECLARED_ROOT", "a", "slides[0].script"],
      ["SCRIPT_SYNTAX_ERROR", "b", "slides[1].script"],
      ["SCRIPT_BLOCKED_API", "c", "slides[2].script"],
    ]);
    expect(r.revision).toBe(1);
  });
});
