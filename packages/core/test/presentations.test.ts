// SPDX-License-Identifier: AGPL-3.0-or-later
import { agentPrincipal, createTestCore, makeSlideInputs, ownerPrincipal } from "@pptaken/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { type DomainError, isDomainError } from "../src/errors.js";
import type { CreatePresentationInput } from "../src/usecases/presentations.js";

const agent = agentPrincipal();
const owner = ownerPrincipal();
const reader = agentPrincipal(["decks:read"]);

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error("Expected a DomainError");
}

const basic = (extra: Partial<CreatePresentationInput> = {}): CreatePresentationInput => ({
  title: "Quarterly review",
  slides: [
    { id: "intro", title: "Intro", html: "<h1>Hello</h1>", notes: "Say hi" },
    {
      id: "plan",
      title: "Plan",
      html: '<ul><li data-step="1">A</li><li data-step="2">B</li></ul>',
      section: "Body",
    },
  ],
  ...extra,
});

let t: ReturnType<typeof createTestCore>;
beforeEach(() => {
  t = createTestCore();
});

describe("createPresentation", () => {
  it("creates revision 1 and returns a compact result", async () => {
    const result = await t.core.createPresentation(agent, basic());
    expect(result).toMatchObject({ revision: 1, slideCount: 2, warnings: [], replayed: false });
    expect(result.presentationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const deck = await t.store.decks.get("default", result.presentationId);
    expect(deck).toMatchObject({
      title: "Quarterly review",
      currentRevision: 1,
      slideCount: 2,
      deletedAt: null,
      createdBy: { actor: "agent", tokenId: "tok_agent" },
    });
    const rev = await t.store.revisions.get("default", result.presentationId, 1);
    expect(rev?.document.slides.map((s) => s.id)).toEqual(["intro", "plan"]);
    expect(rev?.createdBy).toEqual({ actor: "agent", tokenId: "tok_agent" });
  });

  it("generates missing slide ids without colliding with given ones", async () => {
    const { presentationId } = await t.core.createPresentation(agent, {
      title: "Ids",
      slides: [{ html: "<p>a</p>" }, { id: "slide-1", html: "<p>b</p>" }, { html: "<p>c</p>" }],
    });
    const view = await t.core.getPresentation(agent, { presentationId });
    expect(view.outline?.map((s) => s.id)).toEqual(["slide-2", "slide-1", "slide-3"]);
  });

  it("applies the instance default language", async () => {
    const t2 = createTestCore({ config: { defaultLang: "es" } });
    const { presentationId } = await t2.core.createPresentation(agent, basic());
    expect((await t2.core.getPresentation(agent, { presentationId })).lang).toBe("es");
  });

  it("sanitizes content and returns warnings with paths and slide ids", async () => {
    const result = await t.core.createPresentation(agent, {
      title: "XSS",
      slides: [
        { id: "ok", html: "<p>fine</p>" },
        {
          id: "bad",
          html: '<p onclick="steal()">x</p><script>alert(1)</script>',
          css: "@import url(http://evil)",
        },
      ],
      theme: { css: "body{background:url(http://evil/x.png)}" },
    });
    const codes = result.warnings.map((w) => `${w.code}@${w.path}`);
    expect(codes).toContain("REMOVED_ATTRIBUTE@slides[1].html");
    expect(codes).toContain("REMOVED_ELEMENT@slides[1].html");
    expect(codes).toContain("REMOVED_CSS_RULE@slides[1].css");
    expect(codes.some((c) => c.endsWith("@theme.css"))).toBe(true);
    expect(result.warnings.find((w) => w.path === "slides[1].html")?.slideId).toBe("bad");
    const view = await t.core.getPresentation(agent, {
      presentationId: result.presentationId,
      include: ["slides", "theme"],
    });
    const stored = JSON.stringify(view);
    expect(stored).not.toContain("script");
    expect(stored).not.toContain("onclick");
    expect(stored).not.toContain("evil");
  });

  it("warns about asset references that are not assets of the presentation", async () => {
    const result = await t.core.createPresentation(agent, {
      title: "Refs",
      slides: [{ id: "a", html: `<img src="asset:${"a".repeat(64)}" alt="x">` }],
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "UNKNOWN_ASSET_REF", path: "slides[0].html", slideId: "a" }),
    ]);
  });

  it("is idempotent with idempotencyKey (per principal)", async () => {
    const input = basic({ idempotencyKey: "key-1" });
    const first = await t.core.createPresentation(agent, input);
    const again = await t.core.createPresentation(agent, input);
    expect(again).toEqual({ ...first, replayed: true });
    expect((await t.core.listPresentations(agent)).items).toHaveLength(1);
    // Same key, different request.
    const conflict = await failure(
      t.core.createPresentation(agent, { ...input, title: "Something else" }),
    );
    expect(conflict).toMatchObject({ code: "VALIDATION_ERROR", path: "idempotencyKey" });
    // Another principal with the same key gets its own presentation.
    const otherAgent = { ...agent, tokenId: "tok_other" };
    const other = await t.core.createPresentation(otherAgent, input);
    expect(other.presentationId).not.toBe(first.presentationId);
  });

  it("is idempotent under concurrent identical calls", async () => {
    const input = basic({ idempotencyKey: "race" });
    const results = await Promise.all([1, 2, 3].map(() => t.core.createPresentation(agent, input)));
    expect(new Set(results.map((r) => r.presentationId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it("reports validation errors with the first path and every issue", async () => {
    const error = await failure(
      t.core.createPresentation(agent, {
        title: "",
        slides: [{ id: "Bad Id", html: "<p>x</p>" }],
      }),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.path).toBe("title");
    expect((error.details?.issues as unknown[]).length).toBe(2);
    expect(error.retryable).toBe(false);
  });

  it("gives an actionable hint for oversized slide HTML", async () => {
    const error = await failure(
      t.core.createPresentation(agent, {
        title: "Big",
        slides: [{ id: "a", html: "x".repeat(256 * 1024 + 1) }],
      }),
    );
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", path: "slides[0].html" });
    expect(error.hint).toContain("add_asset");
  });

  it("rejects duplicate slide ids", async () => {
    const error = await failure(
      t.core.createPresentation(agent, {
        title: "Dup",
        slides: [
          { id: "a", html: "<p>1</p>" },
          { id: "a", html: "<p>2</p>" },
        ],
      }),
    );
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", path: "slides[1].id" });
  });

  it("enforces the slide limit with LIMIT_EXCEEDED", async () => {
    const error = await failure(
      t.core.createPresentation(agent, { title: "Too many", slides: makeSlideInputs(201) }),
    );
    expect(error).toMatchObject({
      code: "LIMIT_EXCEEDED",
      path: "slides",
      details: { limit: 200, received: 201 },
    });
    const small = createTestCore({ config: { limits: { maxSlides: 5 } } });
    const e2 = await failure(
      small.core.createPresentation(agent, { title: "x", slides: makeSlideInputs(6) }),
    );
    expect(e2).toMatchObject({ code: "LIMIT_EXCEEDED", details: { limit: 5, received: 6 } });
  });

  it("requires decks:write and audits the denial", async () => {
    const error = await failure(t.core.createPresentation(reader, basic()));
    expect(error).toMatchObject({
      code: "FORBIDDEN_SCOPE",
      details: { requiredScope: "decks:write" },
    });
    const log = await t.core.listAuditLog(owner);
    expect(log.items[0]).toMatchObject({
      action: "presentation.create",
      result: "denied",
      detail: { code: "FORBIDDEN_SCOPE" },
    });
  });

  it("rejects non-object input", async () => {
    const error = await failure(
      t.core.createPresentation(agent, null as unknown as CreatePresentationInput),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });
});

describe("getPresentation", () => {
  it("returns the outline by default, never notes or HTML", async () => {
    const { presentationId } = await t.core.createPresentation(agent, basic());
    const view = await t.core.getPresentation(reader, { presentationId });
    expect(view).toMatchObject({
      presentationId,
      title: "Quarterly review",
      revision: 1,
      slideCount: 2,
    });
    expect(view.outline).toEqual([
      { id: "intro", title: "Intro", steps: 0, hasNotes: true },
      { id: "plan", title: "Plan", section: "Body", steps: 2, hasNotes: false },
    ]);
    expect(view.slides).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("Say hi");
  });

  it("returns slides without notes, notes separately, filtered by slideIds", async () => {
    const { presentationId } = await t.core.createPresentation(agent, basic());
    const view = await t.core.getPresentation(agent, {
      presentationId,
      include: ["slides", "notes"],
      slideIds: ["intro"],
    });
    expect(view.slides).toEqual([{ id: "intro", title: "Intro", html: "<h1>Hello</h1>" }]);
    expect(view.notes).toEqual([{ id: "intro", notes: "Say hi" }]);
    expect(view.outline).toBeUndefined();
  });

  it("reports unknown slide ids and include parts", async () => {
    const { presentationId } = await t.core.createPresentation(agent, basic());
    expect(
      await failure(t.core.getPresentation(agent, { presentationId, slideIds: ["nope"] })),
    ).toMatchObject({ code: "NOT_FOUND", path: "slideIds[0]" });
    expect(
      await failure(
        t.core.getPresentation(agent, { presentationId, include: ["quiz" as "outline"] }),
      ),
    ).toMatchObject({ code: "VALIDATION_ERROR", path: "include[0]" });
  });

  it("reads an older revision on request", async () => {
    const { presentationId } = await t.core.createPresentation(agent, basic());
    await t.core.updatePresentation(agent, {
      presentationId,
      expectedRevision: 1,
      title: "Renamed",
    });
    const old = await t.core.getPresentation(agent, { presentationId, revision: 1 });
    expect(old).toMatchObject({ title: "Quarterly review", revision: 1, currentRevision: 2 });
    expect(
      await failure(t.core.getPresentation(agent, { presentationId, revision: 9 })),
    ).toMatchObject({
      code: "NOT_FOUND",
      path: "revision",
    });
  });

  it("returns NOT_FOUND for unknown ids, other workspaces and the trash", async () => {
    const { presentationId } = await t.core.createPresentation(agent, basic());
    const e1 = await failure(
      t.core.getPresentation(agent, { presentationId: "01JDXXXXXXXXXXXXXXXXXXXXXX" }),
    );
    expect(e1).toMatchObject({ code: "NOT_FOUND", path: "presentationId" });
    expect(e1.hint).toContain("list_presentations");
    const foreign = agentPrincipal(["decks:read"], "elsewhere");
    expect((await failure(t.core.getPresentation(foreign, { presentationId }))).code).toBe(
      "NOT_FOUND",
    );
    await t.core.trashPresentation(agent, { presentationId });
    expect((await failure(t.core.getPresentation(agent, { presentationId }))).code).toBe(
      "NOT_FOUND",
    );
  });

  it("requires decks:read", async () => {
    const { presentationId } = await t.core.createPresentation(agent, basic());
    const none = agentPrincipal([]);
    expect(await failure(t.core.getPresentation(none, { presentationId }))).toMatchObject({
      code: "FORBIDDEN_SCOPE",
    });
  });
});

describe("listPresentations", () => {
  it("paginates newest first with a cursor and searches titles", async () => {
    for (const title of ["Alpha talk", "Beta talk", "Gamma", "Delta talk", "Epsilon"]) {
      await t.core.createPresentation(agent, { title, slides: makeSlideInputs(1) });
      t.clock.advance(1000);
    }
    const p1 = await t.core.listPresentations(agent, { limit: 2 });
    expect(p1.items.map((i) => i.title)).toEqual(["Epsilon", "Delta talk"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await t.core.listPresentations(agent, { limit: 2, cursor: p1.nextCursor as string });
    expect(p2.items.map((i) => i.title)).toEqual(["Gamma", "Beta talk"]);
    const p3 = await t.core.listPresentations(agent, { limit: 2, cursor: p2.nextCursor as string });
    expect(p3.items.map((i) => i.title)).toEqual(["Alpha talk"]);
    expect(p3.nextCursor).toBeNull();
    const search = await t.core.listPresentations(agent, { query: "TALK" });
    expect(search.items.map((i) => i.title)).toEqual(["Delta talk", "Beta talk", "Alpha talk"]);
  });

  it("excludes the trash; listing the trash is owner only", async () => {
    const a = await t.core.createPresentation(agent, basic());
    await t.core.createPresentation(agent, basic({ title: "Kept" }));
    await t.core.trashPresentation(agent, { presentationId: a.presentationId });
    expect((await t.core.listPresentations(agent)).items.map((i) => i.title)).toEqual(["Kept"]);
    expect(await failure(t.core.listPresentations(agent, { trashed: true }))).toMatchObject({
      code: "FORBIDDEN_ACTOR",
    });
    const trash = await t.core.listPresentations(owner, { trashed: true });
    expect(trash.items.map((i) => i.presentationId)).toEqual([a.presentationId]);
  });

  it("validates cursor and limit", async () => {
    expect((await failure(t.core.listPresentations(agent, { cursor: "garbage" }))).code).toBe(
      "VALIDATION_ERROR",
    );
    expect((await failure(t.core.listPresentations(agent, { limit: 1000 }))).code).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("updatePresentation", () => {
  it("updates metadata and theme in a new immutable revision", async () => {
    const { presentationId } = await t.core.createPresentation(
      agent,
      basic({ lang: "en", targetMinutes: 30 }),
    );
    const result = await t.core.updatePresentation(agent, {
      presentationId,
      expectedRevision: 1,
      title: "New title",
      lang: null,
      targetMinutes: null,
      theme: { css: "h1 { color: red }", fonts: ["Inter"] },
    });
    expect(result).toMatchObject({ presentationId, revision: 2, slideCount: 2, warnings: [] });
    const view = await t.core.getPresentation(agent, { presentationId, include: ["theme"] });
    expect(view).toMatchObject({
      title: "New title",
      lang: null,
      targetMinutes: null,
      revision: 2,
    });
    expect(view.theme?.fonts).toEqual(["Inter"]);
    const old = await t.core.getRevision(agent, { presentationId, revision: 1 });
    expect(old.document.title).toBe("Quarterly review");
    expect((await t.store.decks.get("default", presentationId))?.title).toBe("New title");
  });

  it("reorders slides only with exactly the current ids", async () => {
    const { presentationId } = await t.core.createPresentation(agent, basic());
    await t.core.updatePresentation(agent, {
      presentationId,
      expectedRevision: 1,
      slideOrder: ["plan", "intro"],
    });
    const view = await t.core.getPresentation(agent, { presentationId });
    expect(view.outline?.map((s) => s.id)).toEqual(["plan", "intro"]);
    for (const slideOrder of [["plan"], ["plan", "plan"], ["plan", "intro", "x"]]) {
      expect(
        await failure(
          t.core.updatePresentation(agent, { presentationId, expectedRevision: 2, slideOrder }),
        ),
      ).toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("returns REVISION_CONFLICT with the current revision", async () => {
    const { presentationId } = await t.core.createPresentation(agent, basic());
    await t.core.updatePresentation(agent, { presentationId, expectedRevision: 1, title: "v2" });
    const error = await failure(
      t.core.updatePresentation(agent, { presentationId, expectedRevision: 1, title: "stale" }),
    );
    expect(error).toMatchObject({
      code: "REVISION_CONFLICT",
      retryable: true,
      details: { currentRevision: 2, expectedRevision: 1 },
    });
    expect(error.hint).toContain("The current revision is 2");
  });

  it("rejects empty updates and invalid values", async () => {
    const { presentationId } = await t.core.createPresentation(agent, basic());
    expect(
      (await failure(t.core.updatePresentation(agent, { presentationId, expectedRevision: 1 })))
        .code,
    ).toBe("VALIDATION_ERROR");
    expect(
      await failure(
        t.core.updatePresentation(agent, {
          presentationId,
          expectedRevision: 1,
          lang: "not a lang!",
        }),
      ),
    ).toMatchObject({ code: "VALIDATION_ERROR", path: "lang" });
    expect(
      await failure(
        t.core.updatePresentation(agent, { presentationId, expectedRevision: 0, title: "x" }),
      ),
    ).toMatchObject({ code: "VALIDATION_ERROR", path: "expectedRevision" });
    expect(
      await failure(
        t.core.updatePresentation(agent, {
          presentationId,
          expectedRevision: 1,
          theme: { fonts: ["Comic Sans" as "Inter"] },
        }),
      ),
    ).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("updateSlides", () => {
  async function created() {
    return (await t.core.createPresentation(agent, basic())).presentationId;
  }

  it("replaces only the fields sent and keeps slide ids stable", async () => {
    const id = await created();
    const r = await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "intro", html: "<h1>Changed</h1>" }],
    });
    expect(r.revision).toBe(2);
    const view = await t.core.getPresentation(agent, {
      presentationId: id,
      include: ["slides", "notes"],
    });
    expect(view.slides?.[0]).toEqual({ id: "intro", title: "Intro", html: "<h1>Changed</h1>" });
    expect(view.notes?.[0]).toEqual({ id: "intro", notes: "Say hi" });
  });

  it("inserts at start, end and after a slide, in order, then removes", async () => {
    const id = await created();
    await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [
        { id: "first", after: "start", html: "<p>first</p>" },
        { html: "<p>generated</p>" },
        { id: "mid", after: "intro", html: "<p>mid</p>" },
        { id: "mid2", after: "mid", html: "<p>after mid (inserted in this call)</p>" },
      ],
      remove: ["plan"],
    });
    const view = await t.core.getPresentation(agent, { presentationId: id });
    expect(view.outline?.map((s) => s.id)).toEqual(["first", "intro", "mid", "mid2", "slide-1"]);
    const revs = await t.core.listRevisions(agent, { presentationId: id });
    expect(revs.items[0]?.summary).toContain("removed plan");
  });

  it("moves an existing slide when `after` is given and clears fields with null", async () => {
    const id = await created();
    await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "intro", after: "end", notes: null }],
    });
    const view = await t.core.getPresentation(agent, { presentationId: id });
    expect(view.outline).toEqual([
      expect.objectContaining({ id: "plan" }),
      expect.objectContaining({ id: "intro", hasNotes: false }),
    ]);
  });

  it("re-sanitizes the resulting deck and propagates warnings", async () => {
    const id = await created();
    const r = await t.core.updateSlides(agent, {
      presentationId: id,
      expectedRevision: 1,
      upsert: [{ id: "plan", html: "<iframe src=//evil></iframe><p>ok</p>" }],
    });
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: "REMOVED_ELEMENT", path: "slides[1].html", slideId: "plan" }),
    ]);
  });

  it("validates references and new slides", async () => {
    const id = await created();
    const cases: [Parameters<typeof t.core.updateSlides>[1], string][] = [
      [{ presentationId: id, expectedRevision: 1, upsert: [{ id: "new" }] }, "upsert[0].html"],
      [
        { presentationId: id, expectedRevision: 1, upsert: [{ html: "<p/>", after: "ghost" }] },
        "upsert[0].after",
      ],
      [{ presentationId: id, expectedRevision: 1, remove: ["ghost"] }, "remove[0]"],
      [{ presentationId: id, expectedRevision: 1, remove: ["intro", "plan"] }, "slides"],
      [
        { presentationId: id, expectedRevision: 1, upsert: [{ id: "Bad!", html: "<p/>" }] },
        "slides[2].id",
      ],
      [{ presentationId: id, expectedRevision: 1 }, ""],
    ];
    for (const [input, path] of cases) {
      const error = await failure(t.core.updateSlides(agent, input));
      expect(error.code).toBe("VALIDATION_ERROR");
      if (path) expect(error.path).toBe(path);
    }
    // Nothing was written.
    expect((await t.store.decks.get("default", id))?.currentRevision).toBe(1);
  });

  it("enforces the slide limit", async () => {
    const small = createTestCore({ config: { limits: { maxSlides: 3 } } });
    const { presentationId } = await small.core.createPresentation(agent, basic());
    const error = await failure(
      small.core.updateSlides(agent, {
        presentationId,
        expectedRevision: 1,
        upsert: [{ html: "<p>3</p>" }, { html: "<p>4</p>" }],
      }),
    );
    expect(error).toMatchObject({ code: "LIMIT_EXCEEDED", details: { limit: 3, received: 4 } });
  });

  it("lets exactly one of two concurrent writers win", async () => {
    const id = await created();
    const write = (html: string) =>
      t.core.updateSlides(agent, {
        presentationId: id,
        expectedRevision: 1,
        upsert: [{ id: "intro", html }],
      });
    const results = await Promise.allSettled([write("<p>A</p>"), write("<p>B</p>")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { currentRevision: 2 },
    });
  });

  it("audits successful writes with the revision", async () => {
    const id = await created();
    await t.core.updateSlides(
      agent,
      { presentationId: id, expectedRevision: 1, remove: ["plan"] },
      { ip: "198.51.100.4" },
    );
    const log = await t.core.listAuditLog(owner, { target: `deck:${id}` });
    expect(log.items.map((e) => e.action)).toEqual([
      "presentation.update_slides",
      "presentation.create",
    ]);
    expect(log.items[0]).toMatchObject({
      actor: "agent",
      tokenId: "tok_agent",
      ip: "198.51.100.4",
      result: "ok",
      detail: { revision: 2, removed: 1 },
    });
  });
});

describe("unexpected errors", () => {
  it("are wrapped as INTERNAL with the request id, and audited", async () => {
    const broken = createTestCore();
    broken.store.transaction = () => Promise.reject(new Error("disk on fire"));
    const error = await failure(
      broken.core.createPresentation(agent, basic(), { requestId: "req-42" }),
    );
    expect(error).toMatchObject({
      code: "INTERNAL",
      retryable: true,
      details: { requestId: "req-42" },
    });
    expect(error.message).not.toContain("disk");
    expect(JSON.stringify(error.toJSON())).not.toContain("disk");
    const log = await broken.core.listAuditLog(owner);
    expect(log.items[0]).toMatchObject({ result: "error", detail: { code: "INTERNAL" } });
  });
});
