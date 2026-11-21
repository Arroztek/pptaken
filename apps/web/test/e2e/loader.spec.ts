// SPDX-License-Identifier: AGPL-3.0-or-later
// The app loader (@pptaken/ui Loader): the cue (lamp, signal, lit slide) while the panel boots, while a page or a
// list loads, and a silent inline version inside busy buttons. Checked with requests held open on purpose: the
// loader shows with its spoken text, after its short delay, and is gone once the content is in; under reduced
// motion nothing travels.
import type { Page, Route } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

/** Holds every request matching `match` until `release()` is called. */
async function hold(page: Page, match: (url: URL) => boolean): Promise<{ release: () => void }> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => match(url),
    async (route: Route) => {
      await gate;
      await route.continue();
    },
  );
  return { release };
}

const isList = (url: URL) => url.pathname === "/api/v1/decks" && !url.searchParams.has("trash");

test.describe("app loader", () => {
  test.use({ mockOptions: { installed: true, decks: 3 } });

  test("boot: the full-page cue with its caption and spoken text, then the page", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    const held = await hold(page, (url) => url.pathname === "/api/v1/auth/me");
    await page.goto(`${mock.url}/decks`);
    const loader = page.locator('[data-loader="page"]');
    await expect(loader).toBeVisible();
    await expect(loader).toHaveAttribute("role", "status");
    await expect(loader).toHaveAttribute("aria-live", "polite");
    await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(1);
    await expect(loader.locator(".ppt-loader__caption")).toHaveText("Setting the stage…");
    // Faded in after the short delay.
    await expect.poll(() => loader.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    held.release();
    await expect(page.getByRole("heading", { level: 1, name: "Presentations" })).toBeVisible();
    await expect(page.locator(".ppt-loader")).toHaveCount(0);
  });

  test("a list: the section cue while the request is pending, gone when the rows arrive", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    const held = await hold(page, isList);
    await page.goto(`${mock.url}/decks`);
    const loader = page.locator('[data-loader="section"]');
    await expect(loader).toBeVisible();
    await expect(loader).toContainText("Loading");
    await expect(page.locator(".deck-row")).toHaveCount(0);
    held.release();
    await expect(page.locator(".deck-row")).toHaveCount(3);
    await expect(loader).toHaveCount(0);
  });

  test("starts invisible: a load faster than the delay never shows it", async ({ page, mock }) => {
    await signIn(page, mock);
    const held = await hold(page, isList);
    await page.goto(`${mock.url}/decks`);
    const loader = page.locator('[data-loader="section"]');
    await loader.waitFor({ state: "attached" });
    // The fade-in waits 180 ms and holds opacity 0 until then (fill mode both); rewound to its start, the loader
    // is fully transparent.
    const start = await loader.evaluate((el) => {
      const s = getComputedStyle(el);
      const fade = el
        .getAnimations()
        .find((a) => (a as CSSAnimation).animationName === "ppt-loader-in");
      fade?.pause();
      if (fade) fade.currentTime = 0;
      return {
        delay: s.animationDelay,
        fill: s.animationFillMode,
        opacity: getComputedStyle(el).opacity,
      };
    });
    expect(start).toEqual({ delay: "0.18s", fill: "both", opacity: "0" });
    held.release();
    await expect(page.locator(".deck-row")).toHaveCount(3);
  });

  test("Spanish: the spoken text follows the panel language", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.addInitScript(() => localStorage.setItem("pptaken.lang", "es"));
    const held = await hold(page, isList);
    await page.goto(`${mock.url}/decks`);
    await expect(page.locator('[data-loader="section"]')).toContainText("Cargando");
    held.release();
    await expect(page.locator(".deck-row")).toHaveCount(3);
  });

  test("busy buttons carry the inline slide, silent (the button says busy)", async ({
    page,
    mock,
  }) => {
    const held = await hold(page, (url) => url.pathname === "/api/v1/auth/login");
    await page.goto(`${mock.url}/login`);
    await page.getByLabel("Password").fill("anything at all");
    await page.getByRole("button", { name: "Sign in" }).click();
    const button = page.locator('button[aria-busy="true"]');
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleName("Sign in");
    const inline = button.locator('[data-loader="inline"]');
    await expect(inline).toHaveAttribute("aria-hidden", "true");
    await expect(inline).not.toHaveAttribute("role", "status");
    held.release();
  });

  test("reduced motion: nothing travels, the lit slide only breathes", async ({ page, mock }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, mock);
    const held = await hold(page, isList);
    await page.goto(`${mock.url}/decks`);
    const loader = page.locator('[data-loader="section"]');
    await expect(loader).toBeVisible();
    const names = await loader.evaluate((el) =>
      Object.fromEntries(
        ["signal", "lamp", "halo", "fill"].map((part) => [
          part,
          getComputedStyle(el.querySelector(`.ppt-loader__${part}`) as Element).animationName,
        ]),
      ),
    );
    expect(names).toEqual({ signal: "none", lamp: "none", halo: "none", fill: "ppt-cue-rest" });
    held.release();
    await expect(page.locator(".deck-row")).toHaveCount(3);
  });
});
