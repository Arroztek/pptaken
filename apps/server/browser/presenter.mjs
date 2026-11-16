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

  // Back to panel: the owner's presenter view links to /decks in a new tab, without an opener.
  const link = await popup.evaluate(() => {
    const a = document.querySelector("a[data-pptaken-panel-link]");
    return a
      ? { href: a.getAttribute("href"), target: a.target, rel: a.rel, text: a.textContent }
      : null;
  });
  if (
    !link ||
    new URL(link.href, popup.url()).pathname !== "/decks" ||
    link.target !== "_blank" ||
    !link.rel.split(" ").includes("noopener")
  )
    throw new Error(`back to panel link: ${JSON.stringify(link)}`);
  if (await page.locator("a[data-pptaken-panel-link]").count())
    throw new Error("the audience view has a panel link");
  checks.push("Back to panel link in the presenter view (new tab, noopener)");

  // End of the talk: the cue shows in the presenter view only, then Esc finishes (black, window closed).
  const cueShown = (p) =>
    p.evaluate(() => {
      const el = document.querySelector("[data-pptaken-end-cue]");
      return el !== null && !el.hidden && el.offsetParent !== null;
    });
  if (await cueShown(popup)) throw new Error("end cue shown before the end");
  await popup.keyboard.press("End");
  await popup.waitForSelector('body[data-end="true"]', { timeout: 5000 });
  await converge();
  if (!(await cueShown(popup))) throw new Error("end cue missing at the last slide");
  for (const f of page.frames()) {
    const html = await f.evaluate(() => document.documentElement.outerHTML).catch(() => "");
    if (html.includes("pptaken-end-cue") || html.includes("End of presentation"))
      throw new Error("end cue on the audience view");
  }
  checks.push("end cue in the presenter view, absent from the audience view");

  await Promise.all([
    popup.waitForEvent("close", { timeout: 5000 }),
    popup.keyboard.press("Escape"),
  ]);
  await page.waitForSelector('body[data-black="true"]', { timeout: 5000 });
  checks.push("Esc at the end closes the presenter and blacks the audience screen");
}
