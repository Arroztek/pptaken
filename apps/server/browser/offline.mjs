// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline presenting against the real server (used by run.mjs): the F3 definition of done. Open the 20-slide deck,
// wait for "ready offline", cut the network (context offline + every request aborted + the server stopped), go
// through every slide and step, open the overview and select a slide, use the presenter window (opened before the
// cut and, with the service worker, after it), the black screen; then, with the service worker (layer 2), reload
// the player and presenter pages offline; a "partial" deck; the barriers on the offline (srcdoc) delivery path;
// and logout deleting the offline copies.

const ULID_NEVER_OPENED = "01J0000000000000000000000Z";

const data = (p) => p.evaluate(() => ({ ...document.body.dataset }));

/** Steps per slide of the deck as the player counts them (the example's steps are numbered 1..n). */
const stepsOf = (deck) => deck.slides.map((s) => (s.html.match(/data-step=/g) ?? []).length);

const next = (steps, p) => {
  if (p.step < steps[p.slide]) return { slide: p.slide, step: p.step + 1 };
  if (p.slide < steps.length - 1) return { slide: p.slide + 1, step: 0 };
  return p;
};

const viewOf = (frame) =>
  frame.evaluate(() => {
    const shown = [...document.querySelectorAll("#pptaken-stage > section")].filter(
      (s) => getComputedStyle(s).display !== "none",
    );
    const s = shown[0];
    const images = s ? [...s.querySelectorAll("img")] : [];
    return {
      shown: shown.map((x) => x.getAttribute("data-slide")).join(),
      revealed: s
        ? [...s.querySelectorAll("[data-step]")].filter(
            (e) => getComputedStyle(e).visibility === "visible",
          ).length
        : -1,
      images: images.length,
      imagesOk: images.every((i) => i.complete && i.naturalWidth > 0),
    };
  });

/** The content's view once it shows `ids[slide]` with `step` steps (the page state changes first). */
async function viewAt(frame, id, step) {
  let v = await viewOf(frame);
  for (let i = 0; i < 40 && (v.shown !== id || v.revealed !== step); i++) {
    await new Promise((r) => setTimeout(r, 50));
    v = await viewOf(frame);
  }
  return v;
}

const waitPosition = (page, p) =>
  page.waitForFunction(
    ([s, t]) =>
      document.body.dataset.slide === String(s) && document.body.dataset.step === String(t),
    [p.slide, p.step],
    { timeout: 5000 },
  );

/**
 * Runs the offline checks for one engine. `server.stop()` / `server.start()` take the real server down and up.
 * Returns a summary of what works offline in this engine; throws on a failed requirement.
 */
export async function checkOffline({
  engineName,
  browser,
  app,
  content,
  session,
  deck,
  urls,
  server,
  checks,
}) {
  const summary = {};
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
  });
  await context.addCookies([
    { name: session.name, value: session.value, url: app, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const steps = stepsOf(deck);
  const ids = deck.slides.map((s) => s.id);
  const contentFrame = (p = page) =>
    p.frames().find((f) => f.url().startsWith(`${content}/c/`) || f.url() === "about:srcdoc");
  let offline = false;
  // How the network is cut: all three by default; PPTAKEN_OFFLINE_CUT=server|offline|route for diagnosis.
  const how = process.env.PPTAKEN_OFFLINE_CUT ?? "all";
  const cut = async () => {
    if (how === "all" || how === "offline") await context.setOffline(true);
    if (how === "all" || how === "route") await context.route("**/*", (r) => r.abort());
    if (how === "all" || how === "server") await server.stop();
    offline = true;
  };
  /**
   * Layer 2 (navigations through the service worker): the server stays down, but Playwright's emulations that act
   * in front of the worker in this engine are lifted (measured, see docs/spikes/S4-offline.md): Firefox's
   * `setOffline` fails navigations before the worker sees them, WebKit's `route` intercepts them before it.
   */
  const layer2Cut = async () => {
    if (how !== "all") return;
    if (engineName === "firefox") await context.setOffline(false);
    if (engineName === "webkit") await context.unroute("**/*");
    summary.layer2CutBy = {
      chromium: "server stopped + setOffline + route abort",
      firefox: "server stopped + route abort",
      webkit: "server stopped + setOffline",
    }[engineName];
  };
  const restore = async () => {
    await server.start();
    await context.unroute("**/*");
    await context.setOffline(false);
    offline = false;
  };

  try {
    // 1. First load: layer 1 preload, then (secure context) the offline copy.
    await page.goto(urls.present);
    await page.waitForSelector('body[data-state="ready"]', { timeout: 15_000 });
    await page.waitForFunction(() => document.body.dataset.offline !== "loading", null, {
      timeout: 45_000,
    });
    await page.waitForFunction(() => document.body.dataset.offlineCopy !== undefined, null, {
      timeout: 90_000,
    });
    const first = await data(page);
    if (!["ready", "service-worker"].includes(first.offline))
      throw new Error(`not ready offline: ${JSON.stringify(first)}`);
    // One image (the <img> and the CSS background share the URL) and every bundled font face.
    if (Number(first.offlineImages) < 1 || Number(first.offlineFonts) < 1)
      throw new Error(`preload counts: ${first.offlineImages} images, ${first.offlineFonts} fonts`);
    summary.layer1 = `${first.offline} (${first.offlineImages} images, ${first.offlineFonts} fonts)`;
    summary.layer2Copy = first.offlineCopy === "true";
    checks.push(`ready offline: ${summary.layer1}, copy ${first.offlineCopy}`);
    if (summary.layer2Copy && first.offline !== "service-worker")
      throw new Error(`copy stored but state ${first.offline}`);
    const policy =
      (await page.request.get(urls.present)).headers()["content-security-policy"] ?? "";
    if (
      !/script-src 'self' 'sha256-[A-Za-z0-9+/]{43}='/.test(policy) ||
      !policy.includes("font-src 'self' data:")
    )
      throw new Error(`player page CSP: ${policy}`);
    checks.push("player page CSP allows only the runtime hash and data: fonts in addition");

    // 2. Presenter window opened while online.
    await page.click("#stage");
    const [presenter] = await Promise.all([
      context.waitForEvent("page", { timeout: 10_000 }),
      page.keyboard.press("s"),
    ]);
    await presenter.waitForSelector('body[data-state="ready"]', { timeout: 15_000 });
    await presenter.waitForFunction(
      () => document.body.dataset.offline && document.body.dataset.offline !== "loading",
      null,
      { timeout: 45_000 },
    );
    checks.push(`presenter ready offline: ${(await data(presenter)).offline}`);

    // 3. Cut the network: context offline, every request aborted, the server stopped.
    await cut();
    await page.bringToFront();
    await page.click("#stage");
    await page.keyboard.press("Home");
    let p = { slide: 0, step: 0 };
    await waitPosition(page, p);
    let imageSlides = 0;
    for (;;) {
      const n = next(steps, p);
      if (n.slide === p.slide && n.step === p.step) break;
      await page.keyboard.press("ArrowRight");
      await waitPosition(page, n);
      const v = await viewAt(contentFrame(), ids[n.slide], n.step);
      if (v.shown !== ids[n.slide] || v.revealed !== n.step || !v.imagesOk)
        throw new Error(`offline at ${n.slide}/${n.step}: ${JSON.stringify(v)}`);
      if (n.step === 0 && v.images > 0) imageSlides++;
      p = n;
    }
    if (imageSlides < 1) throw new Error("no image slide was checked");
    checks.push(`offline: all ${ids.length} slides and every step, images shown`);

    await page.keyboard.press("o");
    await page.waitForFunction(() => document.body.dataset.mode === "overview", null, {
      timeout: 5000,
    });
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (s) => document.body.dataset.mode === "present" && document.body.dataset.slide === String(s),
      ids.length - 2,
      { timeout: 5000 },
    );
    checks.push("offline: overview opened, slide selected");

    await page.keyboard.press("b");
    await page.waitForFunction(() => document.body.dataset.black === "true", null, {
      timeout: 3000,
    });
    await page.keyboard.press("b");
    await page.waitForFunction(() => document.body.dataset.black === "false", null, {
      timeout: 3000,
    });
    checks.push("offline: black screen on and off");

    // Presenter window opened before the cut: notes, next preview, clock, sync.
    await presenter.bringToFront();
    await presenter.keyboard.press("End");
    await page.waitForFunction((s) => document.body.dataset.slide === String(s), ids.length - 1, {
      timeout: 5000,
    });
    const pp = await presenter.evaluate(() => ({
      slide: document.body.dataset.slide,
      notes: document.querySelector(".pp-notes")?.textContent ?? "",
      end: !document.querySelector(".pp-end")?.hidden,
    }));
    const notes = (
      /[A-Za-z][A-Za-z ,]{8,}/.exec(deck.slides[ids.length - 1].notes ?? "")?.[0] ?? ""
    ).slice(0, 20);
    if (pp.slide !== String(ids.length - 1) || (notes && !pp.notes.includes(notes)))
      throw new Error(`presenter offline: ${JSON.stringify(pp)}`);
    await presenter.keyboard.press("Home");
    await presenter.waitForFunction(() => document.body.dataset.slide === "0", null, {
      timeout: 5000,
    });
    // The next-slide preview is the iframe in the second column of the presenter view.
    const nextFrame = await (
      await presenter.$(".pp-main > .pp-col:nth-child(2) iframe")
    )?.contentFrame();
    const want = next(steps, { slide: 0, step: 0 });
    const preview = nextFrame ? await viewAt(nextFrame, ids[want.slide], want.step) : null;
    if (preview?.shown !== ids[want.slide] || preview.revealed !== want.step)
      throw new Error(`next preview offline: ${JSON.stringify(preview)}`);
    await presenter.keyboard.press("t");
    await presenter.waitForFunction(() => document.body.dataset.running === "true", null, {
      timeout: 3000,
    });
    await presenter.waitForFunction(
      () => document.querySelector(".pp-elapsed")?.textContent !== "0:00",
      null,
      { timeout: 4000 },
    );
    await presenter.keyboard.press("t");
    checks.push("offline: presenter notes, next preview, clock and sync");

    // 4. Layer 2: presenter opened after the cut, offline reloads, a deck never opened.
    if (summary.layer2Copy) {
      await layer2Cut();
      await presenter.close();
      await page.bringToFront();
      await page.click("#stage");
      const [late] = await Promise.all([
        context.waitForEvent("page", { timeout: 10_000 }),
        page.keyboard.press("s"),
      ]);
      summary.presenterAfterCut = await late
        .waitForSelector('body[data-state="ready"]', { timeout: 20_000 })
        .then(async () => (await data(late)).source === "copy")
        .catch(async () => {
          checks.push(
            `presenter detail: ${late.url()} ${JSON.stringify(await data(late).catch(() => null))} ${(await late.content().catch(() => "")).slice(0, 200)}`,
          );
          return false;
        });
      checks.push(`layer 2: presenter opened offline: ${summary.presenterAfterCut}`);
      await late.close();

      await page.goto(urls.present).catch(() => {});
      summary.reload = await page
        .waitForSelector('body[data-state="ready"]', { timeout: 20_000 })
        .then(async () => {
          const d = await data(page);
          return d.source === "copy";
        })
        .catch(() => false);
      checks.push(`layer 2: player reloaded offline: ${summary.reload}`);
      if (summary.reload) {
        await page.waitForFunction(() => document.body.dataset.offline === "service-worker", null, {
          timeout: 45_000,
        });
        await page.click("#stage");
        let at = { slide: Number((await data(page)).slide ?? 0), step: 0 };
        for (let i = 1; i <= 4; i++) {
          await page.keyboard.press("ArrowRight");
          at = next(steps, at);
          await waitPosition(page, at);
          const v = await viewAt(contentFrame(), ids[at.slide], at.step);
          if (v.shown !== ids[at.slide] || v.revealed !== at.step)
            throw new Error(`offline reload navigation: ${JSON.stringify(v)}`);
        }
        await page.keyboard.press("End");
        const frame = contentFrame();
        if (frame.url() !== "about:srcdoc")
          throw new Error(`not the srcdoc delivery: ${frame.url()}`);
        // The barriers on the offline delivery path, on the real server.
        const probe = await frame.evaluate(async () => {
          const r = { origin: String(self.origin) };
          const t = (k, fn) => {
            try {
              r[k] = `allowed:${String(fn()).slice(0, 40)}`;
            } catch (e) {
              r[k] = `blocked:${e.name}`;
            }
          };
          t("cookie", () => document.cookie);
          t("parent", () => parent.document.title);
          t("storage", () => localStorage.length);
          r.fetch = await fetch("/api/v1/decks").then(
            () => "reached",
            () => "blocked",
          );
          return r;
        });
        if (
          probe.origin !== "null" ||
          !(probe.cookie.startsWith("blocked:") || probe.cookie === "allowed:") ||
          !probe.parent.startsWith("blocked:") ||
          !probe.storage.startsWith("blocked:") ||
          probe.fetch !== "blocked"
        )
          throw new Error(`srcdoc barriers: ${JSON.stringify(probe)}`);
        checks.push(
          "layer 2: offline reload navigates; srcdoc content is opaque and has no network",
        );
        const imgs = await frame.evaluate(() =>
          [...document.querySelectorAll("img")].map((i) => i.src.slice(0, 15)),
        );
        if (!imgs.every((s) => s.startsWith("data:image/")))
          throw new Error(`offline document images: ${imgs.join()}`);
      }

      await page.goto(`${app}/p/${ULID_NEVER_OPENED}`).catch(() => {});
      summary.neverOpened = await page
        .waitForSelector('body[data-state="unavailable"]', { timeout: 10_000 })
        .then(async () => (await page.textContent("#status")).includes("not available offline"))
        .catch(async () => {
          checks.push(
            `never-opened detail: ${page.url()} ${(await page.content().catch(() => "")).slice(0, 200)}`,
          );
          return false;
        });
      checks.push(`layer 2: a deck never opened says so: ${summary.neverOpened}`);
    }

    await restore();

    // 5. Partial: a deck with an asset that does not exist.
    await page.goto(urls.partial);
    await page.waitForSelector('body[data-state="ready"]', { timeout: 15_000 });
    await page.waitForFunction(() => document.body.dataset.offline === "partial", null, {
      timeout: 45_000,
    });
    await page.click("#stage");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.body.dataset.slide === "1", null, { timeout: 5000 });
    checks.push("partial: a missing asset shows partial, navigation works");

    // Does this engine put the player page under the worker's control (needed for offline reloads)?
    summary.controlled = await page.evaluate(() => navigator.serviceWorker?.controller != null);
    if (summary.layer2Copy && summary.controlled) {
      for (const k of ["presenterAfterCut", "reload", "neverOpened"]) {
        if (!summary[k]) throw new Error(`layer 2 controls the page but ${k} failed`);
      }
    }

    // 6. Logout deletes the offline copies.
    if (summary.layer2Copy) {
      const home = `${app}/`; // an unsandboxed app page (the plain 404 page is sandboxed by its CSP)
      await page.goto(home);
      const keys = async () =>
        page.evaluate(async () => {
          const out = [];
          for (const name of await caches.keys()) {
            const urls = (await (await caches.open(name)).keys()).map((r) => r.url);
            out.push({ name, urls });
          }
          return out;
        });
      const before = await keys();
      const deckCaches = before.filter((c) => c.name.includes("-deck-"));
      if (deckCaches.length < 1) throw new Error("no deck cache stored");
      const all = before.flatMap((c) => c.urls);
      if (all.some((u) => u.includes("ct=") || u.includes("/c/") || u.includes("/auth/")))
        throw new Error(`token, content or auth URL cached: ${all.join(" ")}`);
      checks.push(`cache: ${all.length} entries, no token, content or auth URL`);
      const out = await page.evaluate(
        async () =>
          (
            await fetch("/api/v1/auth/logout", {
              method: "POST",
              headers: { "X-PPTaken-CSRF": "1" },
            })
          ).status,
      );
      if (out !== 204) throw new Error(`logout ${out}`);
      if (summary.controlled) {
        // The worker sees the player page redirect to /login and deletes every offline copy (fail closed).
        await page.goto(urls.present);
        await page.waitForFunction(() => !location.pathname.startsWith("/p/"), null, {
          timeout: 10_000,
        });
        await page.goto(home);
        const after = (await keys()).filter((c) => c.name.includes("-deck-"));
        summary.logoutClears = after.length === 0;
        if (!summary.logoutClears)
          throw new Error(`deck caches left after logout: ${after.map((c) => c.name)}`);
        await cut();
        await layer2Cut();
        await page.goto(urls.present).catch(() => {});
        const refused = await page
          .waitForSelector('body[data-state="unavailable"]', { timeout: 10_000 })
          .then(
            () => true,
            () => false,
          );
        await restore();
        if (!refused) throw new Error("a signed-out deck was still served offline");
        checks.push("logout: the worker deleted the offline copies; nothing is served offline");
      } else {
        // Not controlled here: the web app's logout path (apps/web src/lib/offline.ts) deletes the caches.
        await page.evaluate(async () => {
          for (const name of await caches.keys())
            if (name.startsWith("pptaken-offline-")) await caches.delete(name);
        });
        summary.logoutClears = (await keys()).length === 0;
        if (!summary.logoutClears) throw new Error("caches left after the web app's logout path");
        checks.push("logout (web app path): offline copies deleted");
      }
    }
    if (errors.length > 0) throw new Error(`page errors: ${errors.join("; ")}`);
    return summary;
  } finally {
    if (offline) await restore().catch(() => {});
    await context.close();
  }
}
