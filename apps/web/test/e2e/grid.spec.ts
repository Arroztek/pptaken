// SPDX-License-Identifier: AGPL-3.0-or-later
// The Presentations page as a grid of covers (mock server): the view switch and its memory, one covers request per
// page, lazy and capped loading, the sandboxed frames, the fallback and keyboard reach. Runs in all three engines.
import { expect, noHorizontalOverflow, signIn, test } from "./fixtures";

test.use({ mockOptions: { installed: true, decks: 14 } });

const STORE_KEY = "pptaken.decks.view";

test.describe("view switch", () => {
  test("starts as the list, switches to the grid and remembers the choice", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await expect(page.getByTestId("deck-list")).toBeVisible();
    const group = page.getByRole("group", { name: "View" });
    const list = group.getByRole("button", { name: "List" });
    const grid = group.getByRole("button", { name: "Grid" });
    await expect(list).toHaveAttribute("aria-pressed", "true");
    await expect(grid).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate((k) => localStorage.getItem(k), STORE_KEY)).toBeNull();

    await grid.click();
    await expect(page.getByTestId("deck-grid")).toBeVisible();
    await expect(page.getByTestId("deck-list")).toHaveCount(0);
    await expect(grid).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate((k) => localStorage.getItem(k), STORE_KEY)).toBe("grid");

    await page.reload();
    await expect(page.getByTestId("deck-grid")).toBeVisible();
    await group.getByRole("button", { name: "List" }).click();
    await expect(page.getByTestId("deck-list")).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), STORE_KEY)).toBe("list");
    await page.reload();
    await expect(page.getByTestId("deck-list")).toBeVisible();
  });

  test("works by keyboard and is named in Spanish", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/api/v1/setup/status`);
    await page.evaluate(() => localStorage.setItem("pptaken.lang", "es"));
    await page.goto(`${mock.url}/decks`);
    const group = page.getByRole("group", { name: "Vista" });
    const grid = group.getByRole("button", { name: "Cuadrícula" });
    await grid.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("deck-grid")).toBeVisible();
    await expect(grid).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Space");
    await expect(page.getByTestId("deck-list")).toBeVisible();
  });

  test("a stored value that is not 'grid' means the list", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/api/v1/setup/status`);
    await page.evaluate((k) => localStorage.setItem(k, "cards"), STORE_KEY);
    await page.goto(`${mock.url}/decks`);
    await expect(page.getByTestId("deck-list")).toBeVisible();
  });

  test("still works when storage is blocked", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
    });
    await page.goto(`${mock.url}/decks`);
    await expect(page.getByTestId("deck-list")).toBeVisible();
    await page.getByRole("button", { name: "Grid" }).click();
    await expect(page.getByTestId("deck-grid")).toBeVisible();
  });
});

test.describe("grid of covers", () => {
  test.beforeEach(async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/api/v1/setup/status`);
    await page.evaluate((k) => localStorage.setItem(k, "grid"), STORE_KEY);
  });

  test("asks once for the whole page and shows every first slide in a sandboxed frame", async ({
    page,
    mock,
  }) => {
    await page.goto(`${mock.url}/decks`);
    await expect(page.locator(".deck-card")).toHaveCount(6);
    await expect(page.locator('.cover[data-phase="ready"]')).toHaveCount(6);
    expect(mock.state.coverAsks).toHaveLength(1);
    expect(mock.state.coverAsks[0]).toHaveLength(6);
    const frames = page.locator(".cover iframe");
    await expect(frames).toHaveCount(6);
    for (let i = 0; i < 6; i++) {
      const frame = frames.nth(i);
      expect(await frame.getAttribute("sandbox")).toBe("");
      expect(await frame.getAttribute("aria-hidden")).toBe("true");
      expect(await frame.getAttribute("tabindex")).toBe("-1");
      expect(await frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(await frame.getAttribute("src")).toMatch(/\/c\/deck_00\d\/\d\/cover\?ct=/);
      expect(await frame.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    }
    // The cover shows the real first slide, scaled from its 1920x1080 canvas.
    const first = page.locator(".cover").first();
    const box = await first.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs((box?.width ?? 0) / (box?.height ?? 1) - 16 / 9)).toBeLessThan(0.05);
    const scale = await first
      .locator("iframe")
      .evaluate((el) => (el as HTMLElement).style.transform);
    expect(scale).toMatch(/^scale\(0\.\d+\)$/);
    const inner = page.frameLocator(".cover iframe").first();
    await expect(inner.locator("section")).toContainText("Q3 results");
    await noHorizontalOverflow(page);
  });

  test("loads covers only near the viewport and never more than four at once", async ({
    page,
    mock,
  }) => {
    mock.state.coverDelayMs = 400;
    await page.setViewportSize({ width: 360, height: 700 });
    let live = 0;
    let peak = 0;
    page.on("request", (r) => {
      if (/\/c\/[^/]+\/\d+\/cover/.test(r.url())) peak = Math.max(peak, ++live);
    });
    page.on("requestfinished", (r) => {
      if (/\/c\/[^/]+\/\d+\/cover/.test(r.url())) live--;
    });
    await page.goto(`${mock.url}/decks`);
    await expect(page.locator(".deck-card")).toHaveCount(6);
    await expect(page.locator('.cover[data-phase="ready"]').first()).toBeVisible();
    // One column of tall cards: the last ones are far below the fold and have not started.
    const before = mock.state.coverLog.length;
    expect(before).toBeLessThan(6);
    expect(await page.locator('.cover[data-phase="idle"]').count()).toBeGreaterThan(0);
    await page.locator(".deck-card").last().scrollIntoViewIfNeeded();
    await expect(page.locator('.cover[data-phase="ready"]')).toHaveCount(
      await page.locator(".cover").count(),
    );
    expect(mock.state.coverLog).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(4);
  });

  test("shows the title on a neutral surface when there is no cover", async ({ page, mock }) => {
    mock.state.covers = "none";
    await page.goto(`${mock.url}/decks`);
    await expect(page.locator('.cover[data-phase="fallback"]')).toHaveCount(6);
    await expect(page.locator(".cover iframe")).toHaveCount(0);
    await expect(page.locator(".cover__title").first()).toContainText("Q3 results");
    expect(mock.state.coverLog).toEqual([]);
  });

  test("falls back, quietly, when the covers request fails", async ({ page, mock }) => {
    mock.state.covers = "error";
    await page.goto(`${mock.url}/decks`);
    await expect(page.locator('.cover[data-phase="fallback"]')).toHaveCount(6);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("keeps Present, the More menu and the title link reachable by keyboard", async ({
    page,
    mock,
  }) => {
    await page.goto(`${mock.url}/decks`);
    const card = page.locator(".deck-card").first();
    await expect(card.locator('.cover[data-phase="ready"]')).toBeVisible();
    // The decorative frame is never a tab stop.
    const stops: string[] = [];
    await card.locator(".deck-card__title a").focus();
    for (let i = 0; i < 4; i++) {
      stops.push(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.tagName ??
            "",
        ),
      );
      await page.keyboard.press("Tab");
    }
    expect(stops.join("|")).not.toContain("IFRAME");
    const more = card.getByRole("button", { name: /More actions for/ });
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Details" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    const present = card.getByRole("link", { name: /Present/ });
    await expect(present).toHaveAttribute("href", /^\/p\/deck_001$/);
    await expect(present).toHaveAttribute("target", "_blank");
  });

  test("the title link covers the card and goes to the presentation", async ({ page, mock }) => {
    await page.goto(`${mock.url}/decks`);
    const card = page.locator(".deck-card").first();
    await expect(card.locator('.cover[data-phase="ready"]')).toBeVisible();
    // The title link is stretched over the whole card, so a click anywhere on the cover lands on it.
    const box = await card.locator(".cover").boundingBox();
    await page.mouse.click((box?.x ?? 0) + 20, (box?.y ?? 0) + 20);
    await expect(page).toHaveURL(/\/decks\/deck_001$/);
  });

  test("keeps the chip only where something needs attention", async ({ page, mock }) => {
    await page.goto(`${mock.url}/decks`);
    await expect(page.locator(".deck-card")).toHaveCount(6);
    await expect(page.locator(".deck-card .deck-chip")).toHaveCount(1);
    await expect(page.locator(".deck-card").first().locator(".deck-chip")).toContainText(
      "Needs your OK",
    );
  });

  test("columns follow the width: 1 at 360, 2 at 768, 3 from 1100", async ({ page, mock }) => {
    await page.goto(`${mock.url}/decks`);
    await expect(page.locator(".deck-card")).toHaveCount(6);
    const columns = () =>
      page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector(".deck-cards") as Element,
          ).gridTemplateColumns.split(" ").length,
      );
    for (const [width, expected] of [
      [360, 1],
      [768, 2],
      [1100, 3],
      [1280, 3],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      expect(await columns(), `columns at ${width}`).toBe(expected);
      await noHorizontalOverflow(page);
    }
  });

  test("a deck with a 4:3 canvas keeps its shape inside the 16:9 frame", async ({ page, mock }) => {
    const four = mock.state.decks[3];
    if (four) four.aspectRatio = "4:3";
    await page.goto(`${mock.url}/decks`);
    const frame = page.locator(".deck-card").nth(3).locator(".cover iframe");
    await expect(
      page.locator(".deck-card").nth(3).locator('.cover[data-phase="ready"]'),
    ).toBeVisible();
    const size = await frame.evaluate((el) => ({
      w: parseFloat((el as HTMLElement).style.width),
      h: parseFloat((el as HTMLElement).style.height),
    }));
    expect(size).toEqual({ w: 1440, h: 1080 });
  });

  test("covers add no request outside the app and no CSP violation (fixture checks)", async ({
    page,
    mock,
  }) => {
    await page.goto(`${mock.url}/decks`);
    await expect(page.locator('.cover[data-phase="ready"]')).toHaveCount(6);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.locator(".deck-card")).toHaveCount(12);
    await expect(page.locator('.cover[data-phase="ready"]')).toHaveCount(12);
    // Page two came in one more request, for the six new decks only.
    expect(mock.state.coverAsks.at(-1)?.length).toBeLessThanOrEqual(12);
  });
});
