// SPDX-License-Identifier: AGPL-3.0-or-later
// Export menu and import button of the presentation list, against the mock server.
import { expect, signIn, test } from "./fixtures";

test.describe("export", () => {
  test.use({ mockOptions: { installed: true, decks: 3 } });

  test("the menu offers both formats as same-origin downloads, notes off by default in HTML", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    const card = page.locator("article.ppt-deck").first();
    await card
      .getByRole("button", { name: "More actions for Q3 results for the sales team" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Export “Q3 results for the sales team”" });
    await expect(dialog).toBeVisible();

    const html = dialog.getByRole("link", { name: "Download HTML" });
    await expect(html).toHaveAttribute("href", "/api/v1/decks/deck_001/export?format=html&notes=0");
    await expect(html).toHaveAttribute("download", "");
    const notes = dialog.getByRole("checkbox", { name: "Include speaker notes" });
    await expect(notes).not.toBeChecked();
    await notes.check();
    await expect(dialog.getByText("Anyone who gets the file can read them.")).toBeVisible();
    await expect(html).toHaveAttribute("href", "/api/v1/decks/deck_001/export?format=html&notes=1");

    let download = page.waitForEvent("download");
    await html.click();
    expect((await download).suggestedFilename()).toBe("deck_001.html");
    const archive = dialog.getByRole("link", { name: "Download .pptaken" });
    await expect(archive).toHaveAttribute(
      "href",
      "/api/v1/decks/deck_001/export?format=pptaken&notes=1",
    );
    download = page.waitForEvent("download");
    await archive.click();
    expect((await download).suggestedFilename()).toBe("deck_001.pptaken");
    expect(mock.state.exports).toEqual([
      { id: "deck_001", format: "html", notes: "1" },
      { id: "deck_001", format: "pptaken", notes: "1" },
    ]);

    // Escape closes the dialog; reopening resets the notes choice.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await card.getByRole("button", { name: /More actions/ }).click();
    await expect(page.getByRole("checkbox", { name: "Include speaker notes" })).not.toBeChecked();
  });
});

test.describe("import", () => {
  test.use({ mockOptions: { installed: true, decks: 2 } });

  test("uploads with the CSRF header, refreshes the list and shows warnings", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await expect(page.locator("article.ppt-deck")).toHaveCount(2);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Import" }).click();
    await (await chooser).setFiles({
      name: "talk.pptaken",
      mimeType: "",
      buffer: Buffer.from("PK WARN"),
    });
    await expect(page.getByText("Imported “Imported deck 1”.")).toBeVisible();
    await expect(page.getByText("1 thing was adjusted on the way in:")).toBeVisible();
    await expect(page.getByText(/is not used by any slide/)).toBeVisible();
    await expect(page.locator("article.ppt-deck")).toHaveCount(3);
    await expect(page.locator("article.ppt-deck").first()).toContainText("Imported deck 1");
    const post = mock.state.log.find((r) => r.method === "POST" && r.path === "/decks/import");
    expect(post?.csrf).toBe("1");
    expect(post?.origin).toBe(mock.url);
  });

  test("shows the server's reason for a refused archive and checks the file first", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    let chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Import" }).click();
    await (await chooser).setFiles({
      name: "bad.pptaken",
      mimeType: "",
      buffer: Buffer.from("BROKEN"),
    });
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Could not import bad.pptaken.");
    await expect(alert).toContainText("manifest.json is missing");

    chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Import" }).click();
    await (await chooser).setFiles({
      name: "slides.html",
      mimeType: "text/html",
      buffer: Buffer.from("x"),
    });
    await expect(page.getByRole("alert")).toContainText(
      "Choose a .pptaken file exported from PPTaken.",
    );
    expect(mock.state.imports).toHaveLength(1); // the HTML file never left the browser
  });

  test("works in Spanish too", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await page.evaluate(() => localStorage.setItem("pptaken.lang", "es"));
    await page.reload();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Importar" }).click();
    await (await chooser).setFiles({
      name: "charla.pptaken",
      mimeType: "",
      buffer: Buffer.from("PK"),
    });
    await expect(page.getByText("“Imported deck 1” importada.")).toBeVisible();
    await expect(page.getByText("Todo llegó tal como estaba.")).toBeVisible();
  });
});
