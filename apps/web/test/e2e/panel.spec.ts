// SPDX-License-Identifier: AGPL-3.0-or-later
import { clipboardText, expect, OWNER_PASSWORD, signIn, test } from "./fixtures";

test.describe("sign in", () => {
  test.use({ mockOptions: { installed: true, decks: 3 } });

  test("redirects to login, rejects a wrong password, signs in and out", async ({ page, mock }) => {
    await page.goto(`${mock.url}/apps`);
    await expect(page).toHaveURL(/\/login\?next=%2Fapps$/);
    await expect(page.getByRole("heading", { name: "Sign in." })).toBeVisible();

    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter your password.")).toBeVisible();

    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("That password is not right. Try again.")).toBeVisible();

    await page.getByLabel("Password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/apps$/);
    await expect(page.getByRole("heading", { level: 1, name: "Connected apps" })).toBeVisible();

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
  test("empty state teaches the next step with a concrete request", async ({ page, mock }) => {
    mock.state.installed = true;
    mock.state.password = OWNER_PASSWORD;
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await expect(page.getByRole("heading", { name: "No presentations yet." })).toBeVisible();
    await expect(page.getByText(/Ask Claude to create a presentation/)).toBeVisible();
    await expect(page.getByTestId("example-prompt")).toHaveText(/^Create a 5-slide presentation/);
    const copy = page.getByRole("button", { name: "Copy this request" });
    await expect(copy).toHaveClass(/ppt-btn--primary/);
    await copy.click();
    await expect.poll(() => clipboardText(page)).toMatch(/^Create a 5-slide presentation/);
    await expect(page.getByRole("link", { name: "Connect Claude first" })).toHaveAttribute(
      "href",
      "/welcome",
    );
  });

  test.describe("populated", () => {
    test.use({ mockOptions: { installed: true, decks: 14 } });

    test("a quiet list: one chip only when needed, pagination, search and Present", async ({
      page,
      mock,
    }) => {
      await signIn(page, mock);
      await page.goto(`${mock.url}/decks`);
      const rows = page.locator(".deck-row");
      await expect(rows).toHaveCount(6);
      await expect(page.getByText("6+ presentations")).toBeVisible();
      const first = rows.first();
      await expect(
        first.getByRole("heading", { name: "Q3 results for the sales team" }),
      ).toBeVisible();
      await expect(first).toContainText("14 slides · edited 2 hours ago");
      // Deck 1 waits for the owner (one chip); deck 2 is fine (no chip); no "by your agent" noise.
      await expect(first.locator(".deck-chip")).toHaveText("Needs your OK");
      await expect(rows.nth(1).locator(".deck-chip")).toHaveCount(0);
      await expect(page.locator(".deck-chip")).toHaveCount(1);
      await expect(page.getByText("By your agent")).toHaveCount(0);
      await expect(first.locator(".deck-chip")).toHaveAttribute("href", "/decks/deck_001/approve");

      await page.getByRole("button", { name: "Load more" }).click();
      await expect(rows).toHaveCount(12);
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(rows).toHaveCount(14);
      await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
      await expect(page.getByText("14 presentations")).toBeVisible();

      await page.getByRole("searchbox", { name: "Search presentations" }).fill("garden");
      await expect(rows).toHaveCount(1);
      await expect(page.getByText("1 presentation", { exact: true })).toBeVisible();

      await page.getByRole("searchbox", { name: "Search presentations" }).fill("zzz");
      await expect(page.getByText("Nothing matches “zzz”.")).toBeVisible();
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(rows).toHaveCount(6);

      const present = rows.first().getByRole("link", { name: /^Present/ });
      await expect(present).toHaveAttribute("href", "/p/deck_001");
      await expect(present).toHaveAttribute("target", "_blank");
      const [player] = await Promise.all([page.context().waitForEvent("page"), present.click()]);
      await expect(player).toHaveURL(/\/p\/deck_001$/);
      await player.close();
    });

    test("More menu: keyboard, Download and Details", async ({ page, mock }) => {
      await signIn(page, mock);
      await page.goto(`${mock.url}/decks`);
      const more = page.getByRole("button", {
        name: "More actions for Q3 results for the sales team",
      });
      await more.focus();
      await page.keyboard.press("ArrowDown");
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem")).toHaveText(["Details", "Download", "Move to trash"]);
      await expect(menu.getByRole("menuitem", { name: "Details" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(more).toBeFocused();
      await more.click();
      await page.getByRole("menuitem", { name: "Download" }).click();
      await expect(
        page.getByRole("dialog", { name: "Download “Q3 results for the sales team”" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await more.click();
      await page.getByRole("menuitem", { name: "Details" }).click();
      await expect(page).toHaveURL(/\/decks\/deck_001$/);
    });
  });
});

test.describe("access keys", () => {
  test.use({ mockOptions: { installed: true } });

  test("live under Advanced; create once, then remove with confirmation", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/apps`);
    const fold = page.getByTestId("keys-fold");
    await expect(fold).not.toHaveAttribute("open", /.*/);
    await fold.getByText("Advanced: access keys").click();
    await expect(page.getByText("No access keys.")).toBeVisible();

    await page.getByRole("button", { name: "Create access key" }).click();
    await expect(page.getByText("Give the key a name.")).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Laptop");
    await page.getByRole("button", { name: "Create access key" }).click();
    await expect(page.getByText("Access key created. Copy it now.")).toBeVisible();
    expect(await page.content()).not.toMatch(/ppt_[A-Za-z0-9_-]{43}/);

    await page.getByRole("button", { name: "Copy", exact: true }).click();
    const secret = (await clipboardText(page)) ?? "";
    expect(secret).toMatch(/^ppt_[A-Za-z0-9_-]{43}$/);
    await page.getByRole("button", { name: "Done" }).click();
    expect(await page.content()).not.toContain(secret);

    const row = page.getByRole("row", { name: /Laptop/ });
    await expect(row).toContainText("Active");
    // Permissions (scopes) only with Developer details.
    await expect(row).not.toContainText("decks:read");

    await row.getByRole("button", { name: "Remove Laptop" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove “Laptop”?" });
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Access key removed.")).toBeVisible();
    await expect(row).toContainText("Removed");
    expect(mock.state.tokens[0]?.revokedAt).not.toBeNull();
  });

  test("the old /tokens address opens the fold", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/tokens`);
    await expect(page.getByTestId("keys-fold")).toHaveAttribute("open", "");
    await expect(page.getByRole("heading", { level: 1, name: "Connected apps" })).toBeVisible();
  });

  test("an expired session sends the owner back to sign in", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/tokens`);
    await expect(page.getByText("No access keys.")).toBeVisible();
    mock.state.sessions.clear();
    await page.getByLabel("Name", { exact: true }).fill("Laptop");
    await page.getByRole("button", { name: "Create access key" }).click();
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
    await expect(page.getByRole("link", { name: "Apps conectadas" }).first()).toBeAttached();
    await expect(page.getByRole("link", { name: "Configuración" }).first()).toBeAttached();
    await expect(page).toHaveTitle("Presentaciones · PPTaken");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Presentaciones" })).toBeVisible();
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

  test("Settings: Developer details is opt-in per browser and shows the technical detail", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page.getByTestId("digest-full")).toHaveCount(0);
    await expect(page.getByText(/SHA-256|fingerprint/i)).toHaveCount(0);
    await page.goto(`${mock.url}/settings`);
    const dev = page.getByRole("checkbox", { name: "Show developer details" });
    await expect(dev).not.toBeChecked();
    await dev.check();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pptaken.dev"))).toBe("on");
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page.getByTestId("digest-full")).toBeVisible();
    await expect(page.getByTestId("dev-facts")).toContainText("PPTAKEN_SCRIPTS=owner");
    await expect(page.getByTestId("instance-status")).toContainText("Version 0.1.0");
    await page.goto(`${mock.url}/settings`);
    await page.getByRole("checkbox", { name: "Show developer details" }).uncheck();
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page.getByTestId("digest-full")).toHaveCount(0);
  });
});
