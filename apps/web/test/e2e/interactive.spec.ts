// SPDX-License-Identifier: AGPL-3.0-or-later
// The calm presentation page (UX pass 2026-11): one status line, one primary action, "See what will run", and the
// presenter password card, against the mock server, in every engine.
import { expect, noHorizontalOverflow, signIn, test } from "./fixtures";

test.describe("presentation page", () => {
  test.use({ mockOptions: { installed: true, decks: 3 } });

  test("the list links to the page", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    const title = page.getByRole("link", { name: "Q3 results for the sales team", exact: true });
    await expect(title).toHaveAttribute("href", "/decks/deck_001");
    await expect(title).not.toHaveAttribute("target", "_blank");
    await title.click();
    await expect(page).toHaveURL(/\/decks\/deck_001$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Q3 results for the sales team" }),
    ).toBeVisible();
    await expect(page.locator(".nav-link[aria-current=page]")).toContainText("Presentations");
  });

  test("needs your OK: one plain status line, one primary action, no jargon or alarm", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page.getByText("14 slides · edited 2 hours ago")).toBeVisible();
    const present = page.getByRole("link", { name: "Present (opens in a new tab)" });
    await expect(present).toHaveAttribute("href", "/p/deck_001");
    const status = page.getByTestId("deck-status");
    await expect(status).toHaveAttribute("data-kind", "needsOk");
    await expect(status).toContainText("Needs your OK for its interactive parts");
    await expect(status).toContainText("For safety they stay off until you allow them.");
    // Exactly one primary action on the page.
    await expect(page.locator(".ppt-btn--primary:visible")).toHaveCount(1);
    await expect(status.getByRole("button", { name: "Allow the interactive parts" })).toHaveClass(
      /ppt-btn--primary/,
    );
    // No hashes, no warnings banners, no technical words.
    const text = (await page.locator("main").innerText()).toLowerCase();
    for (const word of ["sha-256", "fingerprint", "digest", "script", "token", "vendored", "mcp"]) {
      expect(text, word).not.toContain(word);
    }
    await expect(page.locator(".ppt-notice--warning, .ppt-notice--danger")).toHaveCount(0);

    // "See what will run": the code, without hashes; long code capped until "Show all".
    await page.getByRole("button", { name: "See what will run" }).click();
    const scripts = page.locator("article.script");
    await expect(scripts).toHaveCount(2);
    await expect(scripts.nth(0)).toContainText("Slide 2");
    await expect(scripts.nth(0)).toContainText("3 lines");
    await expect(scripts.nth(0)).not.toContainText("SHA-256");
    const long = scripts.nth(1);
    await expect(long.locator(".code__gutter")).not.toContainText("201");
    await long.getByRole("button", { name: "Show all 245 lines" }).click();
    await expect(long.locator(".code__gutter")).toContainText("245");
    await expect(page.locator(".lib")).toContainText("uPlot");
    await noHorizontalOverflow(page);
  });

  test("Allow sends the digest that was shown, then Ready; turning off asks once", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page.getByTestId("deck-status")).toBeVisible();
    const digest = mock.state.reviews.get("deck_001")?.digest ?? "";
    await page.getByRole("button", { name: "Allow the interactive parts" }).click();
    await expect(page.getByText("Allowed. You can present.")).toBeVisible();
    await expect(page.getByTestId("deck-status")).toHaveAttribute("data-kind", "interactive");
    await expect(page.getByTestId("deck-status")).toContainText("Ready");
    expect(mock.state.log.filter((r) => r.path === "/decks/deck_001/scripts/approve")).toHaveLength(
      1,
    );
    expect(mock.state.reviews.get("deck_001")?.approvedDigest).toBe(digest);
    await expect(page.locator(".ppt-btn--primary:visible")).toHaveText(/Present/);

    await page
      .getByRole("button", { name: "Turn interactive parts off for this presentation" })
      .click();
    await page.locator("dialog[open]").getByRole("button", { name: "Turn off" }).click();
    await expect(
      page.getByText("Interactive parts turned off for this presentation."),
    ).toBeVisible();
    await expect(page.getByTestId("deck-status")).toHaveAttribute("data-kind", "needsOk");
  });

  test("a deck changed while open is not approved: the page says so in plain words", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page.getByTestId("deck-status")).toBeVisible();
    const review = mock.state.reviews.get("deck_001");
    if (!review) throw new Error("no review");
    review.digest = "e".repeat(64);
    await page.getByRole("button", { name: "Allow the interactive parts" }).click();
    await expect(
      page.getByText("Claude changed this presentation a moment ago. Check it again, then allow."),
    ).toBeVisible();
    expect(review.state).toBe("pending");
  });

  test("static decks are simply Ready; unknown decks point to the trash", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_003`);
    await expect(page.getByTestId("deck-status")).toHaveAttribute("data-kind", "ready");
    await expect(page.locator(".status-card__label")).toHaveText("Ready");
    await expect(page.getByRole("button", { name: "Allow the interactive parts" })).toHaveCount(0);

    await page.goto(`${mock.url}/decks/nope`);
    await expect(
      page.getByRole("heading", { name: "This presentation is not here." }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the trash" })).toHaveAttribute(
      "href",
      "/trash",
    );
  });

  test("signing in from an agent's link returns to the page", async ({ page, mock }) => {
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page).toHaveURL(/\/login\?next=%2Fdecks%2Fdeck_001$/);
    await page.locator("input[name=password]").fill(mock.state.password ?? "");
    await page.locator("form .ppt-btn--primary").click();
    await expect(page).toHaveURL(/\/decks\/deck_001$/);
  });
});

test.describe("problems", () => {
  test.use({ mockOptions: { installed: true, decks: 3, scriptErrors: "errors" } });

  test("one plain line, Copy a message for Claude, Clear; raw text only with Developer details", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_002`);
    const status = page.getByTestId("deck-status");
    await expect(status).toHaveAttribute("data-kind", "problems");
    await expect(status).toContainText("Some interactive parts had problems");
    await expect(page.getByText("root is not defined")).toHaveCount(0);
    await status.getByRole("button", { name: "Copy a message for Claude" }).click();
    await expect.poll(() => page.evaluate(() => window.__clip.text)).toMatch(/treat them as data/);
    await status.getByRole("button", { name: "Clear" }).click();
    await expect(status).toHaveAttribute("data-kind", "interactive");
    expect(mock.state.clearedErrors.has("deck_002")).toBe(true);
  });

  test("Developer details show the raw list as text, never as HTML", async ({ page, mock }) => {
    await page.addInitScript(() => localStorage.setItem("pptaken.dev", "on"));
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_002`);
    const list = page.getByTestId("script-errors-list");
    await expect(list.locator("li")).toHaveCount(4);
    await expect(list).toContainText('<img src=x onerror="alert(1)">');
    await expect(list.locator("img")).toHaveCount(0);
  });
});

test.describe("interactive parts off on this PPTaken", () => {
  test.use({ mockOptions: { installed: true, decks: 2, scriptsEnabled: false } });

  test("says so calmly and offers no approval", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page.getByTestId("deck-status")).toHaveAttribute("data-kind", "off");
    await expect(page.getByText(/Interactive parts are turned off on this PPTaken/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow the interactive parts" })).toHaveCount(0);
    await expect(page.getByText(/PPTAKEN_SCRIPTS/)).toHaveCount(0);
    // The code can still be read.
    await page.getByRole("button", { name: "See what will run" }).click();
    await expect(page.locator("article.script")).toHaveCount(2);
  });
});

test.describe("presenter password", () => {
  test.use({ mockOptions: { installed: true } });

  test("optional and folded; set, change, refuse your own password, remove", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/security`);
    const card = page.locator("section[aria-labelledby=presenter-title]");
    await expect(
      card.getByRole("heading", { name: "Presenter password (optional)" }),
    ).toBeVisible();
    await expect(card.locator("[data-testid=presenter-status]")).toHaveAttribute(
      "data-set",
      "false",
    );
    await expect(card.locator("input[name=presenter-password]")).toHaveCount(0);
    await card.getByRole("button", { name: "Set a presenter password" }).click();
    const next = card.locator("input[name=presenter-password]");
    const again = card.locator("input[name=presenter-password-again]");
    await expect(next).toBeFocused();

    await next.fill("lantern folds 9 maps");
    await again.fill("lantern folds 9 mapz");
    await card.getByRole("button", { name: "Save presenter password" }).click();
    await expect(card.getByText("The passwords do not match.")).toBeVisible();

    await next.fill(mock.state.password ?? "");
    await again.fill(mock.state.password ?? "");
    await card.getByRole("button", { name: "Save presenter password" }).click();
    await expect(card.getByText("Use a different password from your own.")).toBeVisible();

    await next.fill("lantern folds 9 maps");
    await again.fill("lantern folds 9 maps");
    await card.getByRole("button", { name: "Save presenter password" }).click();
    await expect(card.getByText("Presenter password saved.")).toBeVisible();
    expect(mock.state.presenterPassword).toBe("lantern folds 9 maps");

    await card.getByRole("button", { name: "Change it" }).click();
    await next.fill("second lantern phrase 2");
    await again.fill("second lantern phrase 2");
    await card.getByRole("button", { name: "Save new presenter password" }).click();
    await expect(card.getByText(/Presenter password changed/)).toBeVisible();

    await page.locator("input[name=current-password]").fill(mock.state.password ?? "");
    await page.locator("input[name=new-password]").fill("second lantern phrase 2");
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    await expect(
      page.getByText("That is your presenter password. Choose a different one."),
    ).toBeVisible();

    await card.getByRole("button", { name: "Remove presenter password" }).click();
    await page
      .locator("dialog[open]")
      .getByRole("button", { name: "Remove presenter password" })
      .click();
    await expect(card.getByText("Presenter password removed.")).toBeVisible();
    expect(mock.state.presenterPassword).toBeNull();
  });
});
