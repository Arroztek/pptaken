// SPDX-License-Identifier: AGPL-3.0-or-later
// Public links (ADR-026) in the panel: the Share dialog (two plain choices, the notes warning, the presenter
// password line, expiry, name, freeze), the ready state with Copy and a QR code, the list with Stop sharing (asked
// inline), Stop all, extending an expired link, the off states, the quiet "Shared" chip, and the trash confirmations
// that mention links. Runs in Chromium, Firefox and WebKit against the mock server.
import { clipboardText, expect, noHorizontalOverflow, signIn, test } from "./fixtures";

test.describe("share a presentation", () => {
  test.use({ mockOptions: { installed: true, decks: 4 } });

  test("create a view link, copy it, show its QR, then stop sharing it", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_003`);
    await page.getByTestId("share-button").click();
    const dialog = page.getByRole("dialog", {
      name: "Share “A short history of the printing press”",
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("No links yet. Only you can open this presentation."),
    ).toBeVisible();
    // The view choice is the default, and says plainly what the audience sees.
    await expect(
      dialog.getByRole("radio", { name: /Anyone with the link can watch/ }),
    ).toBeChecked();
    await expect(dialog).toContainText("They do not see your notes");
    await dialog.locator("input[name=share-label]").fill("Board, Friday");
    await dialog.locator("select[name=share-expiry]").selectOption("7d");
    await dialog.getByRole("button", { name: "Create link" }).click();
    const ready = dialog.getByTestId("share-ready");
    await expect(ready).toContainText("Link ready. Anyone who has it can watch.");
    const created = mock.state.links.get("deck_003")?.[0];
    expect(created).toMatchObject({ kind: "view", label: "Board, Friday" });
    const url = `${mock.url}/s/${created?.secret}`;
    await expect(ready).toContainText(url);
    await ready.getByRole("button", { name: "Copy link" }).click();
    expect(await clipboardText(page)).toBe(url);
    await ready.getByRole("button", { name: "Show QR code" }).click();
    await expect(ready.locator("figure.ppt-qr svg path")).toHaveAttribute("d", /^M\d/);
    // The CSRF header went with the creation; no hash or token is shown in the normal view.
    expect(
      mock.state.log.some(
        (r) => r.method === "POST" && r.path === "/decks/deck_003/links" && r.csrf === "1",
      ),
    ).toBe(true);
    await expect(dialog).not.toContainText(/token|hash|digest/i);
    // The list shows it; stopping asks once, inline.
    const row = dialog.locator(".share-link").first();
    await expect(row).toContainText("Board, Friday");
    await expect(row).toContainText("Watch");
    await expect(row).toContainText("Not opened yet");
    await row.getByRole("button", { name: "Stop sharing “Board, Friday”" }).click();
    await expect(row).toContainText("It stops working right away");
    await row.getByRole("button", { name: "Cancel" }).click();
    expect(mock.state.links.get("deck_003")).toHaveLength(1);
    await row.getByRole("button", { name: "Stop sharing “Board, Friday”" }).click();
    await row.locator(".share-confirm").getByRole("button", { name: "Stop sharing" }).click();
    await expect(page.getByText("That link no longer works.")).toBeVisible();
    expect(mock.state.links.get("deck_003")).toEqual([]);
    await noHorizontalOverflow(page);
  });

  test("a presenter link says it includes the notes and needs the presenter password", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_003`);
    await page.getByTestId("share-button").click();
    const dialog = page.locator("dialog[open]");
    await dialog.getByRole("radio", { name: /For the person who will present/ }).check();
    await expect(dialog).toContainText("Includes your notes");
    await expect(dialog).toContainText("Anyone who has this link can read your notes.");
    const note = dialog.getByTestId("share-password-note");
    await expect(note).toContainText(
      "Interactive parts need a presenter password on that computer.",
    );
    await expect(note.getByRole("link", { name: "Set a presenter password" })).toHaveAttribute(
      "href",
      "/security#presenter",
    );
    await dialog.locator("input[name=share-freeze]").check();
    await dialog.getByRole("button", { name: "Create link" }).click();
    await expect(dialog.getByTestId("share-ready")).toContainText(
      "Link ready. Send it only to the person who will present.",
    );
    expect(mock.state.links.get("deck_003")?.[0]).toMatchObject({
      kind: "presenter",
      pinnedRevision: 3,
    });
    await dialog.getByRole("button", { name: "Make another link" }).click();
    await expect(dialog.getByRole("button", { name: "Create link" })).toBeVisible();
    await expect(dialog.locator(".share-link").first()).toContainText("Frozen version");
  });

  test("a custom end date must be within a year", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_003`);
    await page.getByTestId("share-button").click();
    const dialog = page.locator("dialog[open]");
    await dialog.locator("select[name=share-expiry]").selectOption("custom");
    await dialog.getByRole("button", { name: "Create link" }).click();
    await expect(dialog.getByText("Pick a day within the next 12 months.")).toBeVisible();
    expect(mock.state.links.get("deck_003") ?? []).toEqual([]);
  });

  test("the deck page opens Share from the list's chip; the delete confirmation mentions the links", async ({
    page,
    mock,
  }) => {
    mock.state.links.set("deck_003", [
      {
        id: "01JLINK0000000000000000001",
        kind: "view",
        label: "",
        secret: "AAAAAAAAAAAAAAAAAAAAAA",
        state: "active",
        createdAt: new Date().toISOString(),
        expiresAt: null,
        pinnedRevision: null,
        lastOpenedAt: null,
        openCount: 0,
      },
      {
        id: "01JLINK0000000000000000002",
        kind: "presenter",
        label: "Ana",
        secret: "BBBBBBBBBBBBBBBBBBBBBB",
        state: "active",
        createdAt: new Date().toISOString(),
        expiresAt: null,
        pinnedRevision: null,
        lastOpenedAt: null,
        openCount: 0,
      },
    ]);
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    const chip = page.locator('.deck-row[data-id="deck_003"] [data-chip="shared"]');
    await expect(chip).toHaveText("Shared");
    await expect(chip).toHaveAttribute("aria-label", "Shared with 2 links");
    // At most one chip per row: a deck that needs the owner's OK shows that one, not "Shared".
    await expect(page.locator(".deck-row").first().locator(".deck-chip")).toHaveCount(1);
    await chip.click();
    await expect(page.getByRole("dialog", { name: /^Share “/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("share-button")).toContainText("2");
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    await expect(page.getByTestId("delete-links")).toHaveText(
      "This also turns off 2 shared links.",
    );
  });

  test("stop all links; extend an expired one", async ({ page, mock }) => {
    await signIn(page, mock);
    mock.state.links.set("deck_003", (await import("../mock-server.mjs")).makeLinks(3));
    await page.goto(`${mock.url}/decks/deck_003`);
    await page.getByTestId("share-button").click();
    const dialog = page.locator("dialog[open]");
    const expired = dialog.locator('.share-link[data-state="expired"]');
    await expect(expired).toContainText("Stopped working");
    await expired.getByRole("button", { name: "Turn it on for 7 more days" }).click();
    await expect(page.getByText("The link works again for 7 days.")).toBeVisible();
    await expect(dialog.locator('.share-link[data-state="expired"]')).toHaveCount(0);
    await dialog.getByRole("button", { name: "Stop sharing all links" }).click();
    await dialog.locator(".share-confirm").getByRole("button", { name: "Stop all" }).click();
    await expect(page.getByText("Every link of this presentation stopped working.")).toBeVisible();
    expect(mock.state.links.get("deck_003")).toEqual([]);
  });
});

test.describe("sharing turned off", () => {
  test.use({ mockOptions: { installed: true, decks: 3, publicLinks: false } });

  test("the owner's switch: the dialog explains it and Settings turns it on", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_003`);
    await page.getByTestId("share-button").click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toContainText("Sharing is turned off.");
    await expect(dialog).toContainText("Allow links that open without an account");
    await dialog.getByRole("link", { name: "Open Settings" }).click();
    await expect(page).toHaveURL(/\/settings#sharing$/);
    const box = page.locator("input[name=public-links]");
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(page.getByText("Shared links work.")).toBeVisible();
    expect(mock.state.publicLinks).toBe(true);
  });
});

test.describe("sharing turned off by the operator", () => {
  test.use({ mockOptions: { installed: true, decks: 3, publicLinksInstance: "off" } });

  test("the dialog names the server setting; the Settings switch is disabled", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_003`);
    await page.getByTestId("share-button").click();
    await expect(page.locator("dialog[open]")).toContainText("PPTAKEN_PUBLIC_LINKS=on");
    await page.goto(`${mock.url}/settings`);
    await expect(page.locator("input[name=public-links]")).toBeDisabled();
    await expect(page.getByTestId("links-instance-off")).toBeVisible();
  });
});

test.describe("trash and shared links", () => {
  test.use({ mockOptions: { installed: true, decks: 4, links: 2, linksDeck: "deck_004" } });

  test("restoring asks before turning the links back on (off by default)", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks/deck_004`);
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    await expect(page.getByTestId("delete-links")).toHaveText(
      "This also turns off 2 shared links.",
    );
    await page.locator("dialog[open]").getByRole("button", { name: "Move to trash" }).click();
    await expect(page).toHaveURL(/\/decks$/);
    await page.goto(`${mock.url}/trash`);
    await page.getByRole("button", { name: "Restore" }).click();
    const dialog = page.getByRole("dialog", { name: "Restore “Garden club: spring plan”?" });
    await expect(dialog.getByTestId("restore-links")).toContainText("It had 2 shared links.");
    await expect(dialog.locator("input[name=restore-links]")).not.toBeChecked();
    await dialog.locator("input[name=restore-links]").check();
    await dialog.getByRole("button", { name: "Restore" }).click();
    await expect(
      page.getByText("“Garden club: spring plan” is back, with its shared links."),
    ).toBeVisible();
    expect(mock.state.restoredLinks).toBe(true);
    expect(mock.state.links.get("deck_004")).toHaveLength(2);
  });
});
