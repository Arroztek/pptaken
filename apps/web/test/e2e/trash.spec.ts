// SPDX-License-Identifier: AGPL-3.0-or-later
// Delete and restore (UX pass 2026-11): move to the trash with one short confirmation and an Undo toast, the
// Trash view with days left, Restore, and Delete forever after a confirmation that names the presentation.
import { expect, noHorizontalOverflow, signIn, test } from "./fixtures";

test.describe("trash", () => {
  test.use({ mockOptions: { installed: true, decks: 4, trashed: 1 } });

  test("move to trash from the list, undo, then from the deck page", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await page.getByRole("button", { name: "More actions for Garden club: spring plan" }).click();
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Move “Garden club: spring plan” to the trash?",
    });
    await expect(dialog).toContainText("You can restore it from the trash for 30 days.");
    await dialog.getByRole("button", { name: "Move to trash" }).click();
    await expect(page.getByText("“Garden club: spring plan” moved to the trash.")).toBeVisible();
    await expect(page.locator(".deck-row")).toHaveCount(3);
    expect(mock.state.trash.some((d) => d.id === "deck_004")).toBe(true);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("“Garden club: spring plan” is back.")).toBeVisible();
    await expect(page.locator(".deck-row")).toHaveCount(4);
    expect(mock.state.trash.some((d) => d.id === "deck_004")).toBe(false);
    expect(
      mock.state.log.some(
        (r) => r.method === "POST" && r.path === "/decks/deck_004/restore" && r.csrf === "1",
      ),
    ).toBe(true);

    await page.goto(`${mock.url}/decks/deck_003`);
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    await page.locator("dialog[open]").getByRole("button", { name: "Move to trash" }).click();
    await expect(page).toHaveURL(/\/decks$/);
    expect(mock.state.trash.some((d) => d.id === "deck_003")).toBe(true);
  });

  test("the trash: days left, restore, delete forever after naming it", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await page.getByRole("link", { name: "Trash" }).click();
    await expect(page).toHaveURL(/\/trash$/);
    await expect(page.getByRole("heading", { level: 1, name: "Trash" })).toBeVisible();
    await expect(page.locator(".nav-link[aria-current=page]")).toContainText("Presentations");
    const item = page.locator(".trash-item").first();
    await expect(item).toContainText("Old draft 1");
    await expect(item).toContainText(/29 days left|28 days left/);

    await item.getByRole("button", { name: "Delete forever" }).click();
    const dialog = page.getByRole("dialog", { name: /^Delete “Old draft 1: .*” forever\?$/ });
    await expect(dialog).toContainText("This cannot be undone.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(mock.state.purged).toEqual([]);
    await item.getByRole("button", { name: "Delete forever" }).click();
    await page.locator("dialog[open]").getByRole("button", { name: "Delete forever" }).click();
    await expect(page.getByText("Deleted for good.", { exact: true })).toBeVisible();
    expect(mock.state.purged).toEqual(["trash_001"]);
    await expect(page.getByText("The trash is empty.")).toBeVisible();
    await noHorizontalOverflow(page);
  });

  test("restore brings it back to the list", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/trash`);
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText(/is back\./)).toBeVisible();
    await page.goto(`${mock.url}/decks`);
    await expect(page.locator(".deck-row")).toHaveCount(5);
  });
});
