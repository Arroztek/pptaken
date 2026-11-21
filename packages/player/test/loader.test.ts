// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  LABELS,
  LOADER_CSS,
  LOADER_DELAY_MS,
  LOADER_ID,
  LOADER_LOOP_MS,
  loaderHtml,
} from "../dist/index.js";

describe("presentation loader", () => {
  it("is a polite live region with the label as hidden text", () => {
    const html = loaderHtml(LABELS.es.loading);
    expect(html).toMatch(
      new RegExp(
        `^<div id="${LOADER_ID}" class="pptaken-loader" role="status" aria-live="polite">`,
      ),
    );
    expect(html).toContain(
      `<span class="pptaken-loader__label" data-loader-label>Cargando…</span>`,
    );
    // The drawing itself is decorative.
    expect(html).toContain(
      '<svg class="pptaken-loader__art" viewBox="0 0 240 150" aria-hidden="true"',
    );
    expect(html).not.toContain("<script");
  });

  it("escapes the label", () => {
    expect(loaderHtml('<b>"x" & y</b>')).toContain("&#60;b&#62;&#34;x&#34; &#38; y&#60;/b&#62;");
  });

  it("makes no request: no URL in the markup or the styles except the in-document clip path", () => {
    const html = loaderHtml("Loading…");
    expect(html.match(/url\(([^)]*)\)/g)).toEqual([`url(#${LOADER_ID}-stage)`]);
    expect(html).not.toMatch(/\b(?:href|src)=/);
    expect(LOADER_CSS).not.toMatch(/url\(|@import|data:/);
  });

  it("waits before it appears and can be hidden", () => {
    expect(LOADER_DELAY_MS).toBeGreaterThanOrEqual(150);
    expect(LOADER_DELAY_MS).toBeLessThanOrEqual(200);
    expect(LOADER_CSS).toContain(
      `animation:pptaken-loader-in 200ms ease-out ${LOADER_DELAY_MS}ms both`,
    );
    expect(LOADER_CSS).toContain(".pptaken-loader[hidden]{display:none}");
    // An overlay: no layout, no pointer events.
    expect(LOADER_CSS).toMatch(
      /\.pptaken-loader\{[^}]*position:fixed;inset:0;[^}]*pointer-events:none/,
    );
  });

  it("holds still under reduced motion: only the lit screen breathes", () => {
    const reduced = LOADER_CSS.slice(LOADER_CSS.indexOf("@media (prefers-reduced-motion:reduce)"));
    expect(reduced).toContain(
      ".pptaken-loader__spot,.pptaken-loader__pool{animation:none;transform:none",
    );
    expect(reduced).toContain(".pptaken-loader__slide{animation:pptaken-loader-rest");
    expect(LOADER_CSS).toContain(`${LOADER_LOOP_MS}ms linear infinite`);
  });

  it("has the loading text in every player language", () => {
    expect(LABELS.en.loading).toBe("Loading…");
    expect(LABELS.es.loading).toBe("Cargando…");
  });
});
