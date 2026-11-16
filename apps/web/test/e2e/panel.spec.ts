// SPDX-License-Identifier: AGPL-3.0-or-later
import { clipboardText, expect, OWNER_PASSWORD, signIn, test } from "./fixtures";

test.describe("sign in", () => {
  test.use({ mockOptions: { installed: true, decks: 3 } });

  test("redirects to login, rejects a wrong password, signs in and out", async ({ page, mock }) => {
    await page.goto(`${mock.url}/tokens`);
    await expect(page).toHaveURL(/\/login\?next=%2Ftokens$/);
    await expect(page.getByRole("heading", { name: "Sign in." })).toBeVisible();

    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter your password.")).toBeVisible();

    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("That password is not right. Try again.")).toBeVisible();

    await page.getByLabel("Password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/tokens$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Access & connections" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(mock.state.sessions.size).toBe(0);
    await page.goto(`${mock.url}/decks`);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("shows the rate limit with its wait time", async ({ page, mock }) => {
    mock.state.loginLimit = 2;
    await page.goto(`${mock.url}/login`);
    for (let i = 0; i < 2; i++) {
      await page.getByLabel("Password").fill(`wrong ${i}`);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByText("That password is not right. Try again.")).toBeVisible();
    }
    await page.getByLabel("Password").fill("wrong again");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Too many attempts. Try again in 30 seconds.",
    );
    await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  test("a signed-in owner skips login and the root goes to the list", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/login`);
    await expect(page).toHaveURL(/\/decks$/);
    await page.goto(`${mock.url}/`);
    await expect(page).toHaveURL(/\/decks$/);
    await page.goto(`${mock.url}/somewhere`);
    await expect(page.getByText("This page is not on the program.")).toBeVisible();
  });
});

test.describe("presentations", () => {
  test("empty state with the illustration and the example prompt", async ({ page, mock }) => {
    mock.state.installed = true;
    mock.state.password = OWNER_PASSWORD;
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await expect(page.getByRole("heading", { name: "No presentations yet." })).toBeVisible();
    await expect(page.locator(".ppt-empty__art")).toBeVisible();
    const copy = page.getByRole("button", { name: "Copy example prompt" });
    await expect(copy).toHaveClass(/ppt-btn--primary/);
    await copy.click();
    await expect.poll(() => clipboardText(page)).toMatch(/^Create a 5-slide presentation/);
    await expect(page.getByRole("link", { name: "Connect another agent" })).toHaveAttribute(
      "href",
      "/welcome",
    );
  });

  test.describe("populated", () => {
    test.use({ mockOptions: { installed: true, decks: 14 } });

    test("cards, pagination, search and Present", async ({ page, mock }) => {
      await signIn(page, mock);
      await page.goto(`${mock.url}/decks`);
      const cards = page.locator("article.ppt-deck");
      await expect(cards).toHaveCount(6);
      await expect(page.getByText("6+ presentations")).toBeVisible();
      const first = cards.first();
      await expect(
        first.getByRole("heading", { name: "Q3 results for the sales team" }),
      ).toBeVisible();
      await expect(first).toContainText("14 slides · r1 · edited 2 hours ago");
      await expect(first).toContainText("By your agent");
      await expect(cards.nth(2)).toContainText("By you");

      await page.getByRole("button", { name: "Load more" }).click();
      await expect(cards).toHaveCount(12);
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(cards).toHaveCount(14);
      await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
      await expect(page.getByText("14 presentations")).toBeVisible();

      await page.getByRole("searchbox", { name: "Search presentations" }).fill("garden");
      await expect(cards).toHaveCount(1);
      await expect(page.getByText("1 presentation", { exact: true })).toBeVisible();
      expect(mock.state.log.some((r) => r.path === "/decks" && r.method === "GET")).toBe(true);

      await page.getByRole("searchbox", { name: "Search presentations" }).fill("zzz");
      await expect(page.getByText("Nothing matches “zzz”.")).toBeVisible();
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(cards).toHaveCount(6);

      const present = cards.first().getByRole("link", { name: "Present" });
      await expect(present).toHaveAttribute("href", "/p/deck_001");
      // The player opens in a new tab (it has no way back to the panel other than the presenter's link).
      await expect(present).toHaveAttribute("target", "_blank");
      const [player] = await Promise.all([page.context().waitForEvent("page"), present.click()]);
      await expect(player).toHaveURL(/\/p\/deck_001$/);
      await expect(player.getByRole("heading", { name: "Player placeholder" })).toBeVisible();
      await player.close();
    });
  });
});

test.describe("tokens", () => {
  test.use({ mockOptions: { installed: true } });

  test("create with a one-time secret, then revoke with confirmation", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/tokens`);
    await expect(page.getByText("No tokens yet.")).toBeVisible();

    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByText("Give the token a name.")).toBeVisible();
    await page.getByLabel("Token name").fill("Laptop");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByText("Token created. Copy it now.")).toBeVisible();
    expect(await page.content()).not.toMatch(/ppt_[A-Za-z0-9_-]{43}/);

    await page.getByRole("button", { name: "Copy", exact: true }).click();
    const secret = (await clipboardText(page)) ?? "";
    expect(secret).toMatch(/^ppt_[A-Za-z0-9_-]{43}$/);
    await page.getByRole("button", { name: "Show New token" }).click();
    await expect(page.getByText(secret)).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    expect(await page.content()).not.toContain(secret);

    const row = page.getByRole("row", { name: /Laptop/ });
    await expect(row).toContainText("decks:read decks:write quiz:draft");
    await expect(row).toContainText("Active");
    await expect(row).toContainText("Never");

    await row.getByRole("button", { name: "Revoke Laptop" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke “Laptop”?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(mock.state.tokens[0]?.revokedAt).toBeNull();

    await row.getByRole("button", { name: "Revoke Laptop" }).click();
    await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Token revoked.")).toBeVisible();
    await expect(row).toContainText("Revoked");
    await expect(row.getByRole("button", { name: "Revoke Laptop" })).toHaveCount(0);
    expect(mock.state.tokens[0]?.revokedAt).not.toBeNull();
  });

  test("the password form lives on Security, not on Access & connections", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/tokens`);
    await expect(page.getByText("No tokens yet.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Agent tokens" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Change password" })).toHaveCount(0);

    await page.getByRole("link", { name: "Security" }).first().click();
    await expect(page).toHaveURL(/\/security$/);
    await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
    await expect(page.getByLabel("Current password")).toBeVisible();
    await expect(page.getByLabel("New password")).toBeVisible();
    await expect(page).toHaveTitle("Security · PPTaken");
  });

  test("Connect your agent says where sign-in connections are managed", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    await expect(
      page.getByText(/managed in Access & connections › Connected applications/),
    ).toBeVisible();
  });

  test("an expired session sends the owner back to sign in", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/tokens`);
    await expect(page.getByText("No tokens yet.")).toBeVisible();
    mock.state.sessions.clear();
    await page.getByLabel("Token name").fill("Laptop");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Ftokens$/);
    await expect(page.getByText("Your session ended. Sign in again.")).toBeVisible();
  });
});

test.describe("preferences", () => {
  test.use({ mockOptions: { installed: true, decks: 2 } });

  test("language switch persists and keeps focus", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await expect(page.getByRole("heading", { level: 1, name: "Presentations" })).toBeVisible();
    await page.getByRole("radio", { name: "Español" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Presentaciones" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.getByRole("radio", { name: "Español" })).toBeFocused();
    await expect(page.getByRole("link", { name: "Acceso y conexiones" }).first()).toBeAttached();
    await expect(page.getByRole("link", { name: "Seguridad" }).first()).toBeAttached();
    await expect(page).toHaveTitle("Presentaciones · PPTaken");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Presentaciones" })).toBeVisible();
    // Keyboard: arrows move within the radio group.
    await page.getByRole("radio", { name: "Español" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("heading", { level: 1, name: "Presentations" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "English" })).toBeFocused();
  });

  test("theme toggle applies and persists", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    const html = page.locator("html");
    await expect(html).not.toHaveAttribute("data-theme", /.+/);
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bg);
    await page.getByRole("radio", { name: "System" }).click();
    await expect(html).not.toHaveAttribute("data-theme", /.+/);
  });
});
