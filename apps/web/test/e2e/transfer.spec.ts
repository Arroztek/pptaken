// SPDX-License-Identifier: AGPL-3.0-or-later
// Export menu and import button of the presentation list, against the mock server.
import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

/** Opens the import dialog and its file picker (the dialog explains what can be imported first). */
async function openImport(page: Page) {
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import a presentation" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Choose a file" }).click();
}

test.describe("export", () => {
  test.use({ mockOptions: { installed: true, decks: 3 } });

  test("the menu offers both formats as same-origin downloads, notes off by default in HTML", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    const card = page.locator(".deck-row").first();
    await card
      .getByRole("button", { name: "More actions for Q3 results for the sales team" })
      .click();
    await page.getByRole("menuitem", { name: "Download" }).click();
    const dialog = page.getByRole("dialog", { name: "Download “Q3 results for the sales team”" });
    await expect(dialog).toBeVisible();

    const html = dialog.getByRole("link", { name: "Download file" });
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
    const archive = dialog.getByRole("link", { name: "Download backup (.pkn)" });
    await expect(archive).toHaveAttribute(
      "href",
      "/api/v1/decks/deck_001/export?format=pptaken&notes=1",
    );
    download = page.waitForEvent("download");
    await archive.click();
    expect((await download).suggestedFilename()).toBe("deck_001.pkn");
    expect(mock.state.exports).toEqual([
      { id: "deck_001", format: "html", notes: "1" },
      { id: "deck_001", format: "pptaken", notes: "1" },
    ]);

    // Escape closes the dialog; reopening resets the notes choice.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await card.getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: "Download" }).click();
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
    await expect(page.locator(".deck-row")).toHaveCount(2);
    const chooser = page.waitForEvent("filechooser");
    await openImport(page);
    await (await chooser).setFiles({
      name: "talk.pkn",
      mimeType: "",
      buffer: Buffer.from("PK WARN"),
    });
    await expect(page.getByText("Imported “Imported deck 1”.")).toBeVisible();
    await expect(page.getByText("1 thing was adjusted on the way in:")).toBeVisible();
    await expect(page.getByText(/is not used by any slide/)).toBeVisible();
    await expect(page.locator(".deck-row")).toHaveCount(3);
    await expect(page.locator(".deck-row").first()).toContainText("Imported deck 1");
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
    await openImport(page);
    await (await chooser).setFiles({
      name: "bad.pkn",
      mimeType: "",
      buffer: Buffer.from("BROKEN"),
    });
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Could not import bad.pkn.");
    // Plain words, never the server's technical message (that is under Developer details).
    await expect(alert).toContainText("The file may be damaged or from a newer version.");
    await expect(alert).not.toContainText("manifest.json");

    chooser = page.waitForEvent("filechooser");
    await openImport(page);
    await (await chooser).setFiles({
      name: "slides.html",
      mimeType: "text/html",
      buffer: Buffer.from("x"),
    });
    await expect(page.getByRole("alert")).toContainText(
      "Choose a PowerPoint .pptx file or a .pkn backup from PPTaken.",
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
    await expect(
      page.getByText(
        "Archivos .ppt antiguos: ábrelos en PowerPoint y guárdalos como .pptx primero.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Elegir un archivo" }).click();
    await (await chooser).setFiles({
      name: "charla.pkn",
      mimeType: "",
      buffer: Buffer.from("PK"),
    });
    await expect(page.getByText("«Imported deck 1» importada.")).toBeVisible();
    await expect(page.getByText("Todo llegó tal como estaba.")).toBeVisible();
  });
});

test.describe("PowerPoint import", () => {
  test.use({ mockOptions: { installed: true, decks: 1 } });

  test("explains what comes along, uploads the .pptx and summarizes the warnings by group", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import a presentation" });
    await expect(dialog.getByText(/Not carried over: charts, SmartArt, video/)).toBeVisible();
    await expect(
      dialog.getByText("Old .ppt files: open them in PowerPoint and save them as .pptx first."),
    ).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose a file" }).click();
    await (await chooser).setFiles({
      name: "Quarterly review.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from("PK slides"),
    });
    await expect(page.getByText("Imported “Quarterly review”.")).toBeVisible();
    await expect(page.getByText("3 things were adjusted on the way in:")).toBeVisible();
    // Groups: the first is open, the others collapsed until clicked.
    const dropped = page.locator("details", { hasText: "Not carried over (2)" });
    await expect(dropped.getByText(/Slide 4: charts are not imported/)).toBeVisible();
    const fonts = page.locator("details", { hasText: "Fonts replaced (1)" });
    await expect(fonts.getByText(/Calibri/)).toBeHidden();
    await fonts.locator("summary").click();
    await expect(fonts.getByText(/Calibri/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the presentation" })).toHaveAttribute(
      "href",
      "/decks/deck_pptx_1",
    );
    await expect(page.locator(".deck-row").first()).toContainText("Quarterly review");
    const post = mock.state.log.find((r) => r.method === "POST" && r.path === "/decks/import-pptx");
    expect(post?.csrf).toBe("1");
  });

  test("refuses .ppt files before uploading and shows the server's reason for others", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    let chooser = page.waitForEvent("filechooser");
    await openImport(page);
    await (await chooser).setFiles({ name: "old.ppt", mimeType: "", buffer: Buffer.from("x") });
    await expect(page.getByRole("alert")).toContainText("This is an old PowerPoint file (.ppt).");
    expect(mock.state.imports).toHaveLength(0);

    chooser = page.waitForEvent("filechooser");
    await openImport(page);
    await (await chooser).setFiles({
      name: "renamed.pptx",
      mimeType: "",
      buffer: Buffer.from("LEGACY"),
    });
    await expect(page.getByRole("alert")).toContainText("Could not import renamed.pptx.");
    await expect(page.getByRole("alert")).not.toContainText("97-2003");
  });
});
