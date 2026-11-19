// SPDX-License-Identifier: Apache-2.0
// Interactive mode (ADR-020), the parts testable without a browser: the scripted document and its hash-only CSP,
// the author-script wrapper, the vendored libraries, the protocol additions and the shell's key policy. The
// browser behaviour (lockdown, port, watchdog, forgery) is covered by browser/scripts.mjs in three engines.

import { createHash } from "node:crypto";
import { type Deck, LIB_CATALOG, parseDeck } from "@pptaken/schema";
import { describe, expect, it } from "vitest";
import {
  buildDeckDocument,
  contentHeaders,
  contentSecurityPolicy,
  FORBIDDEN_ELEMENTS,
  FORBIDDEN_MARKUP,
  isHelloMessage,
  KEY_CODES,
  LIB_SOURCES,
  LOCKED_GLOBALS,
  offlineStateOf,
  parseContentMessage,
  parseSyncMessage,
  RUNTIME_SHA256,
  RUNTIME_SOURCE,
  scriptHash,
  wrapAuthorScript,
} from "../dist/index.js";
import { FRAME_KEYS_IN_SCRIPT_MODE } from "../dist/shell.js";

const BASE = "https://content.example/c/asset/";
const NONCE = "q1w2e3r4t5y6u7i8o9p0aA==";

function deck(input: unknown): Deck {
  const result = parseDeck(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.deck;
}

const scripted = deck({
  schemaVersion: 1,
  title: "Qubits",
  libs: ["uplot@1"],
  slides: [
    { id: "intro", html: "<h1>Intro</h1>" },
    {
      id: "sim",
      html: "<canvas width='800' height='600'></canvas>",
      script: "slide.onEnter(function(){ slide.root.dataset.on = '1'; });\r\nslide.setSteps(3);",
    },
    { id: "end", html: "<p>End</p>", script: "slide.onStep(function(n){});" },
  ],
});

const b64 = (text: string) => createHash("sha256").update(text, "utf8").digest("base64");

describe("scripted deck document", () => {
  const { html, csp } = buildDeckDocument(scripted, { scripts: true, assetBaseUrl: BASE });

  it("has no nonce anywhere and marks the document and the scripted slides", () => {
    expect(html).not.toMatch(/nonce/i);
    expect(csp).not.toMatch(/nonce/i);
    expect(html).toMatch(/^<!doctype html>\n<html data-pptaken-scripts>/);
    expect(html).toContain('<section data-slide="sim" data-pptaken-script role="group"');
    expect(html).toContain('<section data-slide="end" data-pptaken-script role="group"');
    expect(html).not.toContain('<section data-slide="intro" data-pptaken-script');
  });

  it("runs the runtime first (head), then the libraries, then one wrapped script per slide at the end", () => {
    const scripts = [
      ...html.matchAll(
        /<script(?: data-pptaken-for="[^"]*" data-pptaken-line="\d+")?>([\s\S]*?)<\/script>/g,
      ),
    ].map((m) => m[1] as string);
    expect(scripts).toHaveLength(4);
    expect(scripts[0]).toBe(RUNTIME_SOURCE);
    expect(scripts[1]).toBe(LIB_SOURCES["uplot@1"]?.js);
    expect(scripts[2]).toBe(wrapAuthorScript("sim", scripted.slides[1]?.script ?? ""));
    expect(scripts[3]).toBe(wrapAuthorScript("end", scripted.slides[2]?.script ?? ""));
    expect(html.indexOf(RUNTIME_SOURCE)).toBeLessThan(html.indexOf("<body>"));
    expect(html.indexOf(scripts[1] as string)).toBeGreaterThan(html.indexOf("</div>\n<script>"));
    expect(html.trimEnd().endsWith("</script>\n</body>\n</html>")).toBe(true);
  });

  it("tags author scripts with their slide and the document line their text starts on (ADR-023)", () => {
    const lines = html.split("\n");
    for (const id of ["sim", "end"]) {
      const m = new RegExp(`<script data-pptaken-for="${id}" data-pptaken-line="(\\d+)">`).exec(
        html,
      );
      const line = Number(m?.[1]);
      expect(lines[line - 1]?.startsWith(`<script data-pptaken-for="${id}"`)).toBe(true);
      expect(lines[line - 1]).toContain(`pptaken.register("${id}",function(slide){`);
    }
  });

  it("serves a hash-only policy listing exactly those scripts", () => {
    const scripts = [
      ...html.matchAll(
        /<script(?: data-pptaken-for="[^"]*" data-pptaken-line="\d+")?>([\s\S]*?)<\/script>/g,
      ),
    ].map((m) => m[1] as string);
    const src = /script-src ([^;]+);/.exec(csp)?.[1] ?? "";
    expect(src.split(" ").sort()).toEqual(scripts.map((s) => `'sha256-${b64(s)}'`).sort());
    expect(src).toContain(`'sha256-${RUNTIME_SHA256}'`);
    for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "http", "*"]) {
      expect(src).not.toContain(forbidden);
    }
    for (const directive of [
      "script-src-attr 'none'",
      "worker-src 'none'",
      "object-src 'none'",
      "webrtc 'block'",
      "require-trusted-types-for 'script'",
      "trusted-types default",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "sandbox allow-scripts",
      "default-src 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
  });

  it("normalizes line breaks before hashing, as the HTML parser does", () => {
    const wrapped = wrapAuthorScript("sim", "a();\r\nb();\rc();");
    expect(wrapped).toBe('pptaken.register("sim",function(slide){\na();\nb();\nc();\n});');
    expect(scriptHash(wrapped)).toBe(b64(wrapped));
  });

  it("refuses script text that could leave its element, and refuses a nonce", () => {
    for (const bad of ["x='</script>'", "<!-- x", "y='<SCRIPT src=x>'", "a\u0000b", "\ud800"]) {
      expect(() => wrapAuthorScript("sim", bad)).toThrow(TypeError);
    }
    expect(() => wrapAuthorScript("Bad Id", "x()")).toThrow(TypeError);
    expect(() => buildDeckDocument(scripted, { scripts: true, nonce: NONCE })).toThrow(TypeError);
  });

  it("matches the browser's SHA-256 for non-ASCII scripts", () => {
    for (const text of ["", "ñandú ü 漢字 🎉", "x".repeat(70_000), "  "]) {
      expect(scriptHash(text)).toBe(b64(text));
    }
  });
});

describe("static rendering of a scripted deck", () => {
  it("never emits author scripts, libraries or the script-mode marker", () => {
    const { html, csp } = buildDeckDocument(scripted, { nonce: NONCE, assetBaseUrl: BASE });
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain("pptaken.register");
    expect(html).not.toMatch(/<section[^>]*data-pptaken-script/);
    expect(html).not.toMatch(/<html[^>]*data-pptaken-scripts/);
    expect(html).not.toContain(LIB_SOURCES["uplot@1"]?.js.slice(0, 40));
    expect(csp).toContain(`script-src 'nonce-${NONCE}'`);
  });
});

describe("content security policy options", () => {
  it("takes exactly one of nonce and scriptHashes, and only valid hashes", () => {
    expect(() => contentSecurityPolicy({})).toThrow(TypeError);
    expect(() => contentSecurityPolicy({ nonce: NONCE, scriptHashes: [RUNTIME_SHA256] })).toThrow();
    expect(() => contentSecurityPolicy({ scriptHashes: [] })).toThrow(TypeError);
    expect(() => contentSecurityPolicy({ scriptHashes: ["'unsafe-inline'"] })).toThrow(TypeError);
    expect(() => contentSecurityPolicy({ scriptHashes: ["x' https://evil"] })).toThrow(TypeError);
  });

  it("turns DNS prefetching off on every content document", () => {
    expect(contentHeaders({ nonce: NONCE })["X-DNS-Prefetch-Control"]).toBe("off");
    expect(contentHeaders({ scriptHashes: [RUNTIME_SHA256] })["X-DNS-Prefetch-Control"]).toBe(
      "off",
    );
  });
});

describe("vendored libraries", () => {
  it("embed exactly the files pinned in the schema catalog", () => {
    expect(Object.keys(LIB_SOURCES).sort()).toEqual(Object.keys(LIB_CATALOG).sort());
    for (const [id, lib] of Object.entries(LIB_SOURCES)) {
      const pinned = LIB_CATALOG[id as keyof typeof LIB_CATALOG];
      expect(createHash("sha256").update(lib.js, "utf8").digest("hex")).toBe(pinned.sha256);
      expect(createHash("sha256").update(lib.css, "utf8").digest("hex")).toBe(pinned.cssSha256);
      expect(lib.jsSha256).toBe(b64(lib.js));
      expect(lib.js).not.toMatch(/<\/?script|<!--/i);
    }
  });
});

describe("protocol additions", () => {
  it("validates beat, error and hello", () => {
    expect(parseContentMessage({ v: 1, type: "beat" })).toEqual({ v: 1, type: "beat" });
    expect(parseContentMessage({ v: 1, type: "beat", x: 1 })).toBeNull();
    const error = {
      v: 1,
      type: "error",
      slide: 3,
      kind: "setup",
      name: "ReferenceError",
      message: "root is not defined",
      stack: "at slide sim, line 1:1",
      count: 1,
    };
    expect(parseContentMessage(error)).toEqual(error);
    expect(parseContentMessage({ ...error, slide: -1 })).toMatchObject({ slide: -1 });
    expect(parseContentMessage({ ...error, slide: 200 })).toBeNull();
    expect(parseContentMessage({ ...error, slide: -2 })).toBeNull();
    expect(parseContentMessage({ ...error, extra: "x" })).toBeNull();
    expect(parseContentMessage({ v: 1, type: "error", slide: 1 })).toBeNull();
    expect(parseContentMessage({ ...error, kind: "watchdog" })).toBeNull();
    expect(parseContentMessage({ ...error, count: 0 })).toBeNull();
    expect(parseContentMessage({ ...error, count: 2_000_000 })).toBeNull();
    expect(parseContentMessage({ ...error, message: { toString: () => "x" } })).toBeNull();
    expect(parseContentMessage({ ...error, message: "x".repeat(601) })).toBeNull();
    // Text is cleaned again by the shell: control and bidi characters, URLs (signed tokens) and length.
    const dirty = parseContentMessage({
      ...error,
      message: `a\u202eb\u0000c ${"x".repeat(400)}`,
      stack: "at https://c.example/c/D/1?ct=TOKEN:9:3\n\u2066\n",
    });
    expect(dirty?.type === "error" && dirty.message.startsWith("abc x")).toBe(true);
    expect(dirty?.type === "error" && dirty.message.length).toBe(300);
    expect(dirty?.type === "error" && dirty.stack).toBe("at <deck>:9:3");
    expect(isHelloMessage({ v: 1, type: "hello" }, [{}])).toBe(true);
    expect(isHelloMessage({ v: 1, type: "hello" }, [])).toBe(false);
    expect(isHelloMessage({ v: 1, type: "hello" }, [{}, {}])).toBe(false);
    expect(isHelloMessage({ v: 1, type: "hello", port: 1 }, [{}])).toBe(false);
    expect(parseContentMessage({ v: 1, type: "hello" })).toBeNull();
  });

  it("relays script errors to the presenter window, validated", () => {
    expect(parseSyncMessage({ v: 1, type: "script-error", slide: 2 })).toEqual({
      v: 1,
      type: "script-error",
      slide: 2,
    });
    expect(parseSyncMessage({ v: 1, type: "script-error", slide: -1 })).toEqual({
      v: 1,
      type: "script-error",
      slide: -1,
    });
    expect(parseSyncMessage({ v: 1, type: "script-error", slide: -2 })).toBeNull();
    expect(parseSyncMessage({ v: 1, type: "script-stopped" })).toEqual({
      v: 1,
      type: "script-stopped",
    });
    expect(parseSyncMessage({ v: 1, type: "script-stopped", why: "x" })).toBeNull();
    expect(parseSyncMessage({ v: 1, type: "script-error", slide: 2, text: "<b>" })).toBeNull();
  });

  it("marks a preload report from a scripted document as unverified", () => {
    const report = {
      v: 1 as const,
      type: "preload" as const,
      ok: true,
      images: 9999,
      fonts: 1,
      failed: [],
    };
    expect(offlineStateOf(report, false, true)).toBe("unverified");
    expect(offlineStateOf(report, true, true)).toBe("unverified");
    expect(offlineStateOf(null, false, true)).toBe("loading");
    expect(offlineStateOf(report, false)).toBe("ready");
  });
});

describe("shell key policy in script mode", () => {
  it("accepts only navigation, black screen and Escape from the frame", () => {
    const allowed = [...FRAME_KEYS_IN_SCRIPT_MODE].sort();
    expect(allowed).toEqual(
      [
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "Backspace",
        "End",
        "Escape",
        "Home",
        "KeyB",
        "PageDown",
        "PageUp",
        "Period",
        "ShiftSpace",
        "Space",
      ].sort(),
    );
    const dropped = KEY_CODES.filter((k: string) => !FRAME_KEYS_IN_SCRIPT_MODE.has(k as never));
    expect(dropped.sort()).toEqual(
      [
        "Enter",
        "KeyF",
        "KeyK",
        "KeyO",
        "KeyP",
        "KeyR",
        "KeyS",
        "KeyT",
        "Question",
        "ShiftKeyR",
      ].sort(),
    );
  });
});

describe("lockdown lists", () => {
  it("cover the channels of spike S5 and the integrity-hash finding", () => {
    for (const name of [
      "RTCPeerConnection",
      "webkitRTCPeerConnection",
      "RTCDataChannel",
      "WebTransport",
      "WebSocket",
      "EventSource",
      "XMLHttpRequest",
      "fetch",
      "Worker",
      "SharedWorker",
      "open",
      "customElements",
      "XSLTProcessor",
    ]) {
      expect(LOCKED_GLOBALS).toContain(name);
    }
    for (const tag of ["script", "link", "meta", "base", "iframe", "object", "embed", "form"]) {
      expect(FORBIDDEN_ELEMENTS).toContain(tag);
    }
    for (const markup of [
      "<script>",
      "<SCRIPT src=x>",
      "< link rel=preload>",
      "<svg><script href=x>",
      "<iframe srcdoc=x>",
      "<frame>",
      "<meta http-equiv=refresh>",
      "<base href=x>",
      "<form>",
    ]) {
      expect(FORBIDDEN_MARKUP.test(markup)).toBe(true);
    }
    for (const fine of ["<div>", "<linear>", "<p>scripts</p>", "&lt;script&gt;", "<metadata>"]) {
      expect(FORBIDDEN_MARKUP.test(fine)).toBe(false);
    }
  });
});

describe("vendored scripts (ADR-020 §2)", () => {
  const js = "window.tiny = 42;";
  const sha = createHash("sha256").update(js, "utf8").digest("hex");
  const withLib = deck({
    schemaVersion: 1,
    title: "V",
    libs: [{ name: "tiny", version: "1.0.0", sha256: sha, source: "https://cdn.example/tiny.js" }],
    slides: [{ id: "a", html: "<p>a</p>", script: "slide.onEnter(function(){});" }],
  });

  it("inlines a stored script by hash and lists its hash in script-src", () => {
    const { html, csp } = buildDeckDocument(withLib, {
      scripts: true,
      vendoredScripts: new Map([[sha, { js }]]),
    });
    expect(html).toContain(`<script>${js}</script>`);
    expect(csp).toContain(`'sha256-${b64(js)}'`);
  });

  it("refuses a missing script or bytes that do not match the reference", () => {
    expect(() => buildDeckDocument(withLib, { scripts: true })).toThrow(/not available/);
    expect(() =>
      buildDeckDocument(withLib, {
        scripts: true,
        vendoredScripts: new Map([[sha, { js: `${js} evil();` }]]),
      }),
    ).toThrow(/hash mismatch/);
    // ADR-022: NUL cannot be embedded (the HTML parser would change it, and the hash with it).
    expect(() =>
      buildDeckDocument(deck({ ...withLib, libs: [{ name: "x", sha256: b64hex("a\u0000b") }] }), {
        scripts: true,
        vendoredScripts: new Map([[b64hex("a\u0000b"), { js: "a\u0000b" }]]),
      }),
    ).toThrow(/cannot be inlined/);
  });

  it("escapes </script and <script inside CDN code and hashes the embedded text (ADR-022)", () => {
    const js = 'var a="</script><script>x()</script>";var r=/<script/i;';
    const built = buildDeckDocument(
      deck({ ...withLib, libs: [{ name: "x", sha256: b64hex(js) }] }),
      {
        scripts: true,
        vendoredScripts: new Map([[b64hex(js), { js }]]),
      },
    );
    const embedded = 'var a="<\\/script><\\u0073cript>x()<\\/script>";var r=/<\\u0073cript/i;';
    expect(built.html).toContain(`<script>${embedded}</script>`);
    expect(built.csp).toContain(
      `'sha256-${createHash("sha256").update(embedded).digest("base64")}'`,
    );
    // The document has exactly one closing tag per script element (nothing escaped its element).
    expect(built.html.match(/<\/script>/g)?.length).toBe(built.html.match(/<script[ >]/g)?.length);
  });

  it("runs the deck-level script after the libraries and before the slide scripts (ADR-022)", () => {
    const built = buildDeckDocument(
      deck({
        ...withLib,
        script: "window.shared = 1;",
        slides: [{ id: "a", title: "", html: "<p>a</p>", script: "slide.root;" }],
      }),
      { scripts: true, vendoredScripts: new Map([[sha, { js }]]) },
    );
    const lib = built.html.indexOf(js);
    const shared = built.html.indexOf("window.shared = 1;");
    const slide = built.html.indexOf('pptaken.register("a"');
    expect(lib).toBeGreaterThan(0);
    expect(shared).toBeGreaterThan(lib);
    expect(slide).toBeGreaterThan(shared);
    expect(built.csp).toContain(
      `'sha256-${createHash("sha256").update("window.shared = 1;").digest("base64")}'`,
    );
  });
});

function b64hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
