// SPDX-License-Identifier: AGPL-3.0-or-later
// The presentation page and its approval screen (ADR-021), the list badges and the presenter password card,
// against the mock server, in every engine.
import { expect, noHorizontalOverflow, signIn, test } from "./fixtures";

test.describe("presentation page", () => {
  test.use({ mockOptions: { installed: true, decks: 3 } });

  test("the list links to the page and shows the interactive badges", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    const cards = page.locator("article.ppt-deck");
    await expect(cards.nth(0).locator("[data-scripts=pending]")).toHaveText(
      "Interactive · pending approval",
    );
    await expect(cards.nth(1).locator("[data-scripts=approved]")).toHaveText(
      "Interactive · approved",
    );
    await expect(cards.nth(2).locator(".deck-interactive")).toHaveCount(0);
    const title = cards.first().getByRole("link", { name: "Q3 results for the sales team" });
    await expect(title).toHaveAttribute("href", "/decks/deck_001");
    await expect(title).not.toHaveAttribute("target", "_blank");
    await title.click();
    await expect(page).toHaveURL(/\/decks\/deck_001$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Q3 results for the sales team" }),
    ).toBeVisible();
    await expect(page.locator(".nav-link[aria-current=page]")).toContainText("Presentations");
  });

  test("shows the code, fingerprint, libraries, warnings and the warnings that matter", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_001#scripts`);
    await expect(page.getByText("14 slides · Revision 1")).toBeVisible();
    const present = page.getByRole("link", { name: "Present (opens in a new tab)" });
    await expect(present).toHaveAttribute("href", "/p/deck_001");
    await expect(present).toHaveAttribute("target", "_blank");
    await expect(page.locator("[data-testid=deck-status]")).toHaveText(
      "Interactive · pending approval",
    );
    await expect(page.locator("[data-state=pending]")).toHaveText("Waiting for your review");
    await expect(page.getByText("Scripts can run")).toBeVisible();
    await expect(
      page.getByText(
        "A runaway script can freeze the presenter tab in Firefox and Safari. For stronger isolation serve content from a separate site (PPTAKEN_CONTENT_URL).",
      ),
    ).toBeVisible();
    await expect(page.locator(".meaning__text")).toHaveText(
      "This code will run in your browser when you present this deck. It cannot reach the network. Approve only code you or your agent wrote and you have read.",
    );
    await expect(page.locator("[data-testid=digest-full]")).toBeVisible();
    const review = mock.state.reviews.get("deck_001");
    if (!review?.digest) throw new Error("no review");
    await expect(page.locator("[data-testid=digest-full]")).toHaveText(review.digest);
    await expect(page.locator("[data-testid=digest-short]")).toHaveText(
      `${review.digest.slice(0, 8)}…${review.digest.slice(-8)}`,
    );
    await page.getByRole("button", { name: "Copy fingerprint" }).click();
    await expect.poll(() => page.evaluate(() => window.__clip.text)).toBe(review.digest);

    // Two scripts with line numbers, sizes and hashes; the long one is capped until "Show all".
    const scripts = page.locator("article.script");
    await expect(scripts).toHaveCount(2);
    await expect(scripts.nth(0)).toContainText("Slide 2 · intro-demo");
    await expect(scripts.nth(0)).toContainText("3 lines");
    await expect(scripts.nth(0).locator(".code__gutter")).toHaveText("1\n2\n3");
    const long = scripts.nth(1);
    await expect(long).toContainText("245 lines");
    await expect(long.locator(".code__gutter")).toContainText("200");
    await expect(long.locator(".code__gutter")).not.toContainText("201");
    await long.getByRole("button", { name: "Show all 245 lines" }).click();
    await expect(long.locator(".code__gutter")).toContainText("245");
    await long.getByRole("button", { name: "Hide code" }).click();
    await expect(long.locator(".script__code")).toBeHidden();
    await long.getByRole("button", { name: "Show code" }).click();
    await expect(long.locator(".script__code")).toBeVisible();

    await expect(page.locator(".lib")).toContainText("uPlot");
    await expect(page.locator(".lib")).toContainText("Version 1.6.32");
    await expect(page.locator(".lib")).toContainText("https://cdn.jsdelivr.net/npm/uplot@1.6.32");
    await expect(page.locator(".warnings li")).toHaveCount(2);
    await noHorizontalOverflow(page);
  });

  test("approve needs an explicit confirmation and sends the digest that was shown", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page.locator("[data-testid=digest-full]")).toBeVisible();
    const digest = mock.state.reviews.get("deck_001")?.digest ?? "";
    await page.getByRole("button", { name: "Approve these scripts" }).click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog.locator("[data-testid=confirm-digest]")).toHaveText(
      `${digest.slice(0, 8)}…${digest.slice(-8)}`,
    );
    const confirm = dialog.getByRole("button", { name: "Approve", exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await confirm.click();
    await expect(page.getByText("Scripts approved.")).toBeVisible();
    await expect(page.locator("[data-state=approved]")).toHaveText("Approved");
    await expect(page.locator("[data-testid=deck-status]")).toHaveText("Interactive · approved");
    expect(mock.state.log.filter((r) => r.path === "/decks/deck_001/scripts/approve")).toHaveLength(
      1,
    );

    // Revoke: back to pending.
    await page.getByRole("button", { name: "Stop running scripts" }).click();
    await page
      .locator("dialog[open]")
      .getByRole("button", { name: "Stop running scripts" })
      .click();
    await expect(page.getByText("Approval withdrawn.", { exact: false })).toBeVisible();
    await expect(page.locator("[data-state=pending]")).toBeVisible();
  });

  test("a deck changed during review is not approved: the page says so and shows the new code", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_001`);
    await page.getByRole("button", { name: "Approve these scripts" }).click();
    // The agent edits the scripts while the dialog is open.
    const review = mock.state.reviews.get("deck_001");
    if (!review) throw new Error("no review");
    review.digest = "e".repeat(64);
    await page.locator("dialog[open]").getByRole("checkbox").check();
    await page
      .locator("dialog[open]")
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await expect(
      page.getByText("The scripts changed while you were reviewing them. Review them again."),
    ).toBeVisible();
    await expect(page.locator("[data-testid=digest-full]")).toHaveText("e".repeat(64));
    expect(review.state).toBe("pending");
  });

  test("stale approval, static decks and unknown decks", async ({ page, mock }) => {
    await signIn(page, mock);
    const deck = mock.state.decks[0];
    if (!deck) throw new Error("no deck");
    const { makeReview } = await import("../mock-server.mjs");
    mock.state.reviews.set(deck.id, makeReview(deck, { version: 2, staleDigest: "d".repeat(64) }));
    await page.goto(`${mock.url}/decks/${deck.id}`);
    await expect(page.locator("[data-state=stale]")).toHaveText("Changed since you approved it");
    await expect(page.getByRole("button", { name: "Stop running scripts" })).toBeVisible();

    await page.goto(`${mock.url}/decks/deck_003`);
    await expect(page.getByText("Static deck")).toBeVisible();
    await expect(page.locator("[data-testid=deck-status]")).toHaveText("Static");
    await expect(page.getByRole("button", { name: "Approve these scripts" })).toHaveCount(0);

    await page.goto(`${mock.url}/decks/nope`);
    await expect(
      page.getByRole("heading", { name: "This presentation is not here." }),
    ).toBeVisible();
  });

  test("signing in from an agent's link returns to the page", async ({ page, mock }) => {
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page).toHaveURL(/\/login\?next=%2Fdecks%2Fdeck_001$/);
    await page.locator("input[name=password]").fill(mock.state.password ?? "");
    await page.locator("form .ppt-btn--primary").click();
    await expect(page).toHaveURL(/\/decks\/deck_001$/);
  });
});

test.describe("scripts off", () => {
  test.use({ mockOptions: { installed: true, decks: 2, scriptsEnabled: false } });

  test("explains how to enable them and offers no approval", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_001`);
    await expect(page.getByText("Scripts are off").first()).toBeVisible();
    await expect(page.getByText(/sets PPTAKEN_SCRIPTS=owner and restarts it/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve these scripts" })).toHaveCount(0);
    await expect(page.locator("[data-testid=freeze-warning]")).toHaveCount(0);
    // The code can still be read.
    await expect(page.locator("article.script")).toHaveCount(2);
  });
});

test.describe("presenter password", () => {
  test.use({ mockOptions: { installed: true } });

  test("set, change, refuse the owner password, remove", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/security`);
    const card = page.locator("section[aria-labelledby=presenter-title]");
    await expect(card).toContainText(
      "It is not your owner password and it cannot open this panel.",
    );
    await expect(card.locator("[data-testid=presenter-status]")).toHaveAttribute(
      "data-set",
      "false",
    );
    const next = card.locator("input[name=presenter-password]");
    const again = card.locator("input[name=presenter-password-again]");

    await next.fill("lantern folds 9 maps");
    await again.fill("lantern folds 9 mapz");
    await card.getByRole("button", { name: "Set presenter password" }).click();
    await expect(card.getByText("The passwords do not match.")).toBeVisible();

    await next.fill(mock.state.password ?? "");
    await again.fill(mock.state.password ?? "");
    await card.getByRole("button", { name: "Set presenter password" }).click();
    await expect(
      card.getByText("Use a different password from your owner password."),
    ).toBeVisible();

    await next.fill("lantern folds 9 maps");
    await again.fill("lantern folds 9 maps");
    await card.getByRole("button", { name: "Set presenter password" }).click();
    await expect(card.getByText("Presenter password set.")).toBeVisible();
    expect(mock.state.presenterPassword).toBe("lantern folds 9 maps");
    await expect(next).toHaveValue("");

    await next.fill("second lantern phrase 2");
    await again.fill("second lantern phrase 2");
    await card.getByRole("button", { name: "Change presenter password" }).click();
    await expect(card.getByText(/Presenter password changed/)).toBeVisible();

    // The owner password cannot become the presenter password.
    await page.locator("input[name=current-password]").fill(mock.state.password ?? "");
    await page.locator("input[name=new-password]").fill("second lantern phrase 2");
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    await expect(
      page.getByText("That is your presenter password. Choose a different owner password."),
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
