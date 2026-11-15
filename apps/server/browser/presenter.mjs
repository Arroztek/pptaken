// SPDX-License-Identifier: AGPL-3.0-or-later
// Presenter view against the real server (used by run.mjs): `s` opens /p/:id/presenter in a second window with the
// owner session; both windows follow each other; the notes are shown there and are absent from every content
// document (the content origin never receives them).

const position = (p) =>
  p.evaluate(() => `${document.body.dataset.slide}/${document.body.dataset.step}`);

/** Runs the checks; pushes labels to `checks`; throws on failure. */
export async function checkPresenter({ page, context, content, notesOf, checks }) {
  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: 10_000 }),
    page.keyboard.press("s"),
  ]);
  await popup.waitForSelector('body[data-state="ready"]', { timeout: 15_000 });
  checks.push(`presenter ${new URL(popup.url()).pathname.replace(/[A-Z0-9]{26}/, ":id")}`);

  const converge = async () => {
    for (let i = 0; i < 40; i++) {
      const [a, b] = [await position(page), await position(popup)];
      if (a === b && !a.includes("undefined")) return a;
      await page.waitForTimeout(100);
    }
    throw new Error(`windows out of sync: ${await position(page)} vs ${await position(popup)}`);
  };
  await converge();
  checks.push("presenter follows the main window");
  await popup.bringToFront();
  await popup.keyboard.press("ArrowRight");
  await popup.keyboard.press("ArrowRight");
  const after = await converge();
  checks.push(`main window follows the presenter (${after})`);

  const slide = Number(after.split("/")[0]);
  const shown = await popup.evaluate(() => document.querySelector(".pp-notes")?.textContent ?? "");
  const snippet = notesOf(slide);
  if (snippet && !shown.includes(snippet))
    throw new Error(`notes not shown: ${shown.slice(0, 80)}`);
  checks.push("notes shown in the presenter");

  for (const p of [page, popup]) {
    for (const f of p.frames().filter((f) => f.url().startsWith(`${content}/c/`))) {
      const html = await f.evaluate(() => document.documentElement.outerHTML);
      if (snippet && html.includes(snippet))
        throw new Error("notes leaked into a content document");
    }
  }
  checks.push("notes absent from the content documents");
  await popup.close();
}
