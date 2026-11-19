// SPDX-License-Identifier: AGPL-3.0-or-later
// ADR-024 in the panel: the one-click approval screen (the agents' approve_url) and approval automation (first
// approval, an automatically allowed edit with "Review changes", the new-library exception, the setting off, revoke).
// The mock mirrors the server's trust-lineage rule (agentEdit); the rule itself is tested in core and server.
import { agentEdit } from "../mock-server.mjs";
import { expect, noHorizontalOverflow, signIn, test } from "./fixtures";

test.describe("one-click approval link", () => {
  test.use({ mockOptions: { installed: true, decks: 3 } });

  test("signed out: sign in, come back to the screen, Allow, then Present", async ({
    page,
    mock,
  }) => {
    await page.goto(`${mock.url}/decks/deck_001/approve`);
    await expect(page).toHaveURL(/\/login\?next=%2Fdecks%2Fdeck_001%2Fapprove$/);
    await page.locator("input[name=password]").fill(mock.state.password ?? "");
    await page.locator("form .ppt-btn--primary").click();
    await expect(page).toHaveURL(/\/decks\/deck_001\/approve$/);

    const screen = page.getByTestId("approve-screen");
    await expect(screen.getByRole("heading", { level: 1 })).toHaveText(
      "Allow the interactive parts of “Q3 results for the sales team”?",
    );
    // No sidebar, one primary button, a quiet "See what will run".
    await expect(page.locator("#sidebar")).toHaveCount(0);
    await expect(screen.locator(".ppt-btn--primary")).toHaveCount(1);
    await expect(screen.getByRole("button", { name: "Allow", exact: true })).toHaveClass(
      /ppt-btn--primary/,
    );
    await screen.getByRole("button", { name: "See what will run" }).click();
    await expect(screen.locator("article.script")).toHaveCount(2);
    await expect(screen).not.toContainText("SHA-256");

    await screen.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByTestId("approve-done")).toContainText("Done. You can present.");
    const present = screen.getByRole("link", { name: /Present/ });
    await expect(present).toHaveAttribute("href", "/p/deck_001");
    await expect(present).toHaveClass(/ppt-btn--primary/);
    expect(mock.state.approvals).toBe(1);
    await noHorizontalOverflow(page);
  });

  test("nothing to allow, and a deck that changed meanwhile", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_002/approve`);
    await expect(page.getByTestId("approve-nothing")).toContainText("Nothing to allow.");

    await page.goto(`${mock.url}/decks/deck_001/approve`);
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
    const review = mock.state.reviews.get("deck_001");
    if (!review) throw new Error("no review");
    review.digest = "f".repeat(64);
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(
      page.getByText("Claude changed this presentation a moment ago. Check it again, then allow."),
    ).toBeVisible();
    expect(review.state).toBe("pending");
  });

  test("a new outside piece says so in one plain sentence", async ({ page, mock }) => {
    await signIn(page, mock);
    // First approval, then the agent adds a new library: the link explains the new piece.
    await page.goto(`${mock.url}/decks/deck_001/approve`);
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByTestId("approve-done")).toBeVisible();
    agentEdit(mock.state, "deck_001", { newLibrary: true });
    await page.goto(`${mock.url}/decks/deck_001/approve`);
    await expect(page.getByText(/needs one new piece from an outside site/)).toBeVisible();
  });
});

test.describe("approval automation", () => {
  test.use({ mockOptions: { installed: true, decks: 3 } });

  test("first approval, an automatic update with Review changes, a new library, setting off, revoke", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    // 1. First approval (one click).
    await page.goto(`${mock.url}/decks/deck_001`);
    await page.getByRole("button", { name: "Allow the interactive parts" }).click();
    await expect(page.getByTestId("deck-status")).toHaveAttribute("data-kind", "interactive");

    // 2. Claude edits the code: allowed automatically, nothing alarming, Review changes shows before/now.
    agentEdit(mock.state, "deck_001");
    await page.reload();
    const status = page.getByTestId("deck-status");
    await expect(status).toHaveAttribute("data-kind", "interactive");
    await expect(page.getByTestId("auto-line")).toContainText("allowed automatically");
    await expect(page.locator(".ppt-notice--warning, .ppt-notice--danger")).toHaveCount(0);
    await status.getByRole("button", { name: "Review changes" }).click();
    const changes = page.locator("section[aria-labelledby=changes-title]");
    await expect(changes.getByText("Before", { exact: true })).toBeVisible();
    await expect(changes.getByText("Now", { exact: true })).toBeVisible();
    await expect(changes.locator("article.script").nth(1)).toContainText("// edit");

    // 3. A new outside library: never automatic.
    agentEdit(mock.state, "deck_001", { newLibrary: true });
    await page.reload();
    await expect(status).toHaveAttribute("data-kind", "needsOk");
    await expect(status).toHaveAttribute("data-reason", "newLib");
    await expect(status).toContainText("new piece from an outside site");
    await page.getByRole("button", { name: "Allow the interactive parts" }).click();
    await expect(status).toHaveAttribute("data-kind", "interactive");

    // 4. Setting off: every change asks.
    await page.goto(`${mock.url}/settings`);
    const auto = page.getByRole("checkbox", { name: "Allow interactive updates automatically" });
    await expect(auto).toBeChecked();
    await auto.uncheck();
    await expect(page.getByText("You will be asked for every change.")).toBeVisible();
    expect(mock.state.autoApproveUpdates).toBe(false);
    agentEdit(mock.state, "deck_001");
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(status).toHaveAttribute("data-kind", "needsOk");
    await expect(status).toHaveAttribute("data-reason", "changed");
    await page.getByRole("button", { name: "Allow the interactive parts" }).click();
    await expect(status).toHaveAttribute("data-kind", "interactive");

    // 5. Revoke: interactive parts off for this deck; the next edit waits even with the setting back on.
    await page
      .getByRole("button", { name: "Turn interactive parts off for this presentation" })
      .click();
    await page.locator("dialog[open]").getByRole("button", { name: "Turn off" }).click();
    await expect(status).toHaveAttribute("data-kind", "needsOk");
    mock.state.autoApproveUpdates = true;
    agentEdit(mock.state, "deck_001");
    await page.reload();
    await expect(status).toHaveAttribute("data-kind", "needsOk");
  });
});
