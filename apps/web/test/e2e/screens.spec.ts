// SPDX-License-Identifier: AGPL-3.0-or-later
// Screenshots of every screen at 360, 768 and 1280 px, light and dark, English and Spanish (Chromium only).
// Also checks for horizontal overflow on each. Files go to test/.screenshots (git-ignored).
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { makeApps, makeDecks, makeOAuthRequests } from "../mock-server.mjs";
import {
  expect,
  type Mock,
  type MockOptions,
  noHorizontalOverflow,
  signIn,
  test,
} from "./fixtures";

const OUT =
  process.env.PPTAKEN_SCREENSHOTS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..", ".screenshots");
/** Only screens whose name matches (e.g. PPTAKEN_SCREENS=deck,security-presenter). */
const ONLY = (process.env.PPTAKEN_SCREENS ?? "").split(",").filter(Boolean);
mkdirSync(OUT, { recursive: true });

const WIDTHS = [360, 768, 1280] as const;

/**
 * Basic accessibility checks on every capture: one main landmark, one h1 (focused dialogs aside), every button,
 * link and form control has an accessible name, images have alt text, and nothing is focusable inside aria-hidden.
 */
async function basicA11y(page: Page): Promise<void> {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    if (document.querySelectorAll("main").length !== 1) out.push("main landmarks != 1");
    if (document.querySelectorAll("h1").length !== 1)
      out.push(`h1 count ${document.querySelectorAll("h1").length}`);
    const named = (el: Element) => {
      const label = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "";
      const by = el.getAttribute("aria-labelledby");
      const text = el.textContent?.trim() ?? "";
      const labels = (el as HTMLInputElement).labels;
      return Boolean(label.trim() || by || text || (labels && labels.length > 0));
    };
    for (const el of document.querySelectorAll(
      "button, a[href], input:not([type=hidden]), select, textarea",
    )) {
      if (!(el as HTMLElement).checkVisibility({ visibilityProperty: true })) continue;
      if (el.closest("[aria-hidden=true]")) continue;
      if (!named(el)) out.push(`unnamed ${el.tagName.toLowerCase()} ${el.className}`);
    }
    for (const img of document.querySelectorAll("img"))
      if (!img.hasAttribute("alt")) out.push("img without alt");
    return out;
  });
  expect(problems, "basic a11y").toEqual([]);
}
/** Decks for the grid screens: one of them has a 4:3 canvas. */
function gridDecks(n: number) {
  const decks = makeDecks(n);
  const four = decks[4];
  if (four) four.aspectRatio = "4:3";
  return decks;
}

/** Opens /decks with the grid chosen, the way a returning owner would find it. */
async function openGrid(page: Page, mock: Mock): Promise<void> {
  await page.evaluate(() => localStorage.setItem("pptaken.decks.view", "grid"));
  await page.goto(`${mock.url}/decks`);
  await expect(page.getByTestId("deck-grid")).toBeVisible();
}

/** Scrolls through the page so every cover comes near the viewport, waits until each reached `phase`, scrolls back. */
async function settleCovers(page: Page, phase: "ready" | "fallback"): Promise<void> {
  const total = await page.locator(".cover").count();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= height; y += 500) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(60);
  }
  await expect(page.locator(`.cover[data-phase="${phase}"]`)).toHaveCount(total, {
    timeout: 20_000,
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  // Frames outside the viewport are not painted by a full-page capture: make the viewport as tall as the page.
  const width = page.viewportSize()?.width ?? 1280;
  await page.setViewportSize({
    width,
    height: await page.evaluate(() => document.documentElement.scrollHeight),
  });
  await page.waitForTimeout(500);
}

const THEMES = ["light", "dark"] as const;
const LANGS = ["en", "es"] as const;

interface Screen {
  name: string;
  options?: MockOptions;
  /** Only these widths (default: all). */
  widths?: readonly number[];
  /** Capture only this element (a block of a long page) instead of the page. */
  element?: string;
  /** With Developer details on. */
  dev?: boolean;
  /** Bring the page to the state to capture. Runs once per variant on a fresh load. */
  prepare: (page: Page, mock: Mock) => Promise<void>;
}

const screens: Screen[] = [
  {
    name: "welcome-setup",
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/welcome`);
      await page.locator("form .ppt-btn--primary").click();
      await expect(page.locator(".ppt-field__error").first()).toBeVisible();
    },
  },
  {
    name: "welcome-connect",
    options: { installed: true, connectDelayMs: 600_000 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/welcome`);
      await expect(page.getByTestId("connect-steps")).toBeVisible();
    },
  },
  {
    name: "welcome-connect-public",
    options: { installed: true, https: true, connectDelayMs: 600_000 },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/welcome`);
      await expect(page.getByTestId("connect-steps")).toBeVisible();
    },
  },
  {
    name: "welcome-developer",
    options: { installed: true, connectDelayMs: 600_000 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/welcome`);
      await page.locator("[data-testid=developer-fold] summary").click();
      await page.locator(".ppt-copyblock .ppt-btn--primary").click();
      await expect(page.locator(".secret-field")).toBeVisible();
    },
  },
  {
    name: "welcome-connected",
    options: { installed: true, connectDelayMs: 0 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/welcome`);
      await page.locator("[data-testid=developer-fold] summary").click();
      await page.locator(".ppt-copyblock .ppt-btn--primary").click();
      await expect(page.locator(".next-card")).toBeVisible({ timeout: 10_000 });
    },
  },
  {
    name: "login-error",
    options: { installed: true, loginLimit: 1000 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/login`);
      await page.locator("input[name=password]").fill("wrong password");
      await page.locator("form .ppt-btn--primary").click();
      await expect(page.locator(".ppt-field__error")).toBeVisible();
    },
  },
  {
    name: "decks",
    options: { installed: true, decks: 14, scriptErrors: "errors" },
    prepare: async (page, mock) => {
      mock.state.clearedErrors.clear();
      await page.goto(`${mock.url}/decks`);
      await expect(page.locator(".deck-row")).toHaveCount(6);
      await expect(page.locator(".deck-chip")).toHaveCount(2);
    },
  },
  {
    name: "decks-menu",
    options: { installed: true, decks: 3 },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks`);
      await page.locator(".deck-row .menu__trigger").first().click();
      await expect(page.getByRole("menu")).toBeVisible();
    },
  },
  {
    name: "decks-delete-dialog",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks`);
      await page.locator(".deck-row .menu__trigger").first().click();
      await page.locator(".menu__item--danger").click();
      await expect(page.locator("dialog[open]")).toBeVisible();
    },
  },
  {
    name: "decks-grid",
    options: { installed: true, decks: gridDecks(14), scriptErrors: "errors" },
    prepare: async (page, mock) => {
      mock.state.clearedErrors.clear();
      await openGrid(page, mock);
      await expect(page.locator(".deck-card")).toHaveCount(6);
      await expect(page.locator(".deck-chip")).toHaveCount(2);
      await settleCovers(page, "ready");
    },
  },
  {
    name: "decks-grid-loading",
    options: { installed: true, decks: gridDecks(14), coverDelayMs: 600_000 },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await openGrid(page, mock);
      await expect(page.locator(".deck-card")).toHaveCount(6);
      await expect(page.locator('.cover[data-phase="loading"]').first()).toBeVisible();
    },
  },
  {
    name: "decks-grid-fallback",
    options: { installed: true, decks: gridDecks(14), covers: "none" },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await openGrid(page, mock);
      await expect(page.locator(".deck-card")).toHaveCount(6);
      await settleCovers(page, "fallback");
    },
  },
  {
    name: "decks-grid-menu",
    options: { installed: true, decks: gridDecks(6) },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await openGrid(page, mock);
      await settleCovers(page, "ready");
      await page.locator(".deck-card .menu__trigger").nth(1).click();
      await expect(page.getByRole("menu")).toBeVisible();
    },
  },
  {
    name: "decks-empty",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks`);
      await expect(page.getByTestId("example-prompt")).toBeVisible();
    },
  },
  {
    name: "decks-import-dialog",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks`);
      await expect(page.locator(".deck-row")).toHaveCount(3);
      await page.locator(".page-head__actions .ppt-btn").last().click();
      await expect(page.locator("dialog[open]")).toBeVisible();
    },
  },
  {
    name: "trash",
    options: { installed: true, decks: 2, trashed: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/trash`);
      await expect(page.locator(".trash-item")).toHaveCount(3);
    },
  },
  {
    name: "trash-forever-dialog",
    options: { installed: true, decks: 2, trashed: 1 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/trash`);
      await page.locator(".trash-item .ppt-btn--ghost").first().click();
      await expect(page.locator("dialog[open]")).toBeVisible();
    },
  },
  {
    name: "trash-empty",
    options: { installed: true },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/trash`);
      await expect(page.locator(".ppt-empty")).toBeVisible();
    },
  },
  {
    name: "deck-pending",
    options: { installed: true, decks: 3, vendored: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await expect(page.getByTestId("deck-status")).toHaveAttribute("data-kind", "needsOk");
      await expect(page.getByTestId("vendor-failed")).toBeVisible();
    },
  },
  {
    name: "deck-see-what-runs",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await page.locator("#status .link-btn").first().click();
      await expect(page.locator(".script")).toHaveCount(2);
    },
  },
  {
    name: "deck-new-library",
    options: { installed: true, decks: 3, newLib: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await expect(page.getByTestId("deck-status")).toHaveAttribute("data-reason", "newLib");
    },
  },
  {
    name: "deck-ready",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_002`);
      await expect(page.getByTestId("deck-status")).toHaveAttribute("data-kind", "interactive");
    },
  },
  {
    name: "deck-auto-changes",
    options: { installed: true, decks: 3, autoApproved: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_002`);
      await expect(page.getByTestId("auto-line")).toBeVisible();
      await page.locator("#status .link-btn").first().click();
      await expect(page.locator(".diff").first()).toBeVisible();
    },
  },
  {
    name: "deck-problems",
    options: { installed: true, decks: 3, scriptErrors: "errors" },
    prepare: async (page, mock) => {
      mock.state.clearedErrors.clear();
      await page.goto(`${mock.url}/decks/deck_002`);
      await expect(page.getByTestId("deck-status")).toHaveAttribute("data-kind", "problems");
    },
  },
  {
    name: "deck-static",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_003`);
      await expect(page.getByTestId("deck-status")).toHaveAttribute("data-kind", "ready");
    },
  },
  {
    name: "deck-off",
    options: { installed: true, decks: 3, scriptsEnabled: false },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await expect(page.getByTestId("deck-status")).toHaveAttribute("data-kind", "off");
    },
  },
  {
    name: "deck-syntax",
    options: { installed: true, decks: 3, scriptChecks: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await expect(page.getByTestId("syntax-note")).toBeVisible();
    },
  },
  {
    name: "deck-developer",
    options: { installed: true, decks: 3, vendored: true, scriptChecks: true },
    dev: true,
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await expect(page.getByTestId("dev-facts")).toBeVisible();
      await expect(page.locator("[data-testid=vendored-list] > li")).toHaveCount(5);
    },
  },
  {
    name: "deck-developer-errors",
    options: { installed: true, decks: 3, scriptErrors: "errors" },
    dev: true,
    widths: [360, 1280],
    prepare: async (page, mock) => {
      mock.state.clearedErrors.clear();
      await page.goto(`${mock.url}/decks/deck_002`);
      await expect(page.locator("[data-testid=script-errors-list] > li")).toHaveCount(4);
    },
  },
  {
    name: "approve",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001/approve`);
      await expect(page.getByTestId("approve-screen").locator(".ppt-btn--primary")).toBeVisible();
    },
  },
  {
    name: "approve-done",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      const review = mock.state.reviews.get("deck_001");
      if (review) mock.state.reviews.delete("deck_001");
      const deck = mock.state.decks[0];
      if (deck) deck.scripts = "pending";
      await page.goto(`${mock.url}/decks/deck_001/approve`);
      await page.getByTestId("approve-screen").locator(".ppt-btn--primary").click();
      await expect(page.getByTestId("approve-done")).toBeVisible();
    },
  },
  {
    name: "apps",
    options: { installed: true, apps: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/apps`);
      await expect(page.locator("table")).toHaveCount(1);
    },
  },
  {
    name: "apps-keys",
    options: { installed: true, apps: 1 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/tokens`);
      await page.locator("input[name=name]").fill("Claude Code on my laptop");
      await page.locator("form .ppt-btn--primary").click();
      await expect(page.locator(".secret-field")).toBeVisible();
    },
  },
  {
    name: "apps-empty",
    options: { installed: true },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/apps`);
      await expect(page.locator("[data-testid=connected-apps] .ppt-empty")).toBeVisible();
    },
  },
  {
    name: "security",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/security`);
      await expect(page.locator("input[name=current-password]")).toBeVisible();
    },
  },
  {
    name: "security-presenter-form",
    options: { installed: true },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/security`);
      await page.locator("section[aria-labelledby=presenter-title] .ppt-btn--secondary").click();
      await expect(page.locator("input[name=presenter-password]")).toBeVisible();
    },
  },
  {
    name: "security-error",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/security`);
      await page.locator("input[name=current-password]").fill("not the password");
      await page.locator("input[name=new-password]").fill("a new long passphrase");
      await page.locator("section[aria-labelledby=password-title] form .ppt-btn--primary").click();
      await expect(page.locator(".ppt-field__error")).toBeVisible();
    },
  },
  {
    name: "settings",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/settings`);
      await expect(page.locator("input[name=auto-approve]")).toBeEnabled();
    },
  },
  // Public links (ADR-026): the Share dialog (choices + the existing links), the ready state with its QR code, the
  // presenter choice with the password line, the off state, the "Shared" chip, and the restore question.
  {
    name: "share-dialog",
    options: { installed: true, decks: 4, links: 3, linksDeck: "deck_003" },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_003`);
      await page.getByTestId("share-button").click();
      await expect(page.locator(".share-link")).toHaveCount(3);
    },
  },
  {
    name: "share-presenter-dialog",
    options: { installed: true, decks: 4 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_003`);
      await page.getByTestId("share-button").click();
      await page.locator(".share-option[data-kind=presenter] input").check();
      await page.locator("select[name=share-expiry]").selectOption("custom");
      await expect(page.getByTestId("share-password-note")).toBeVisible();
    },
  },
  {
    name: "share-ready-dialog",
    options: { installed: true, decks: 4 },
    prepare: async (page, mock) => {
      mock.state.links.clear();
      await page.goto(`${mock.url}/decks/deck_003`);
      await page.getByTestId("share-button").click();
      await page.locator("input[name=share-label]").fill("Q3 review for Ana");
      await page.locator(".share-form .ppt-btn--primary").click();
      await page.locator(".share-ready__actions .link-btn").first().click();
      await expect(page.locator(".share-qr svg path")).toBeVisible();
    },
  },
  {
    name: "share-off-dialog",
    options: { installed: true, decks: 4, publicLinks: false },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_003`);
      await page.getByTestId("share-button").click();
      await expect(page.locator(".share-panel .ppt-notice")).toBeVisible();
    },
  },
  {
    name: "decks-shared",
    options: { installed: true, decks: 6, links: 2, linksDeck: "deck_003" },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks`);
      await expect(page.locator('[data-chip="shared"]')).toBeVisible();
    },
  },
  {
    name: "trash-restore-links-dialog",
    options: { installed: true, decks: 4, links: 2, linksDeck: "deck_004" },
    prepare: async (page, mock) => {
      if (!mock.state.trash.some((d) => d.id === "deck_004")) {
        const r = await page.request.delete(`${mock.url}/api/v1/decks/deck_004`, {
          headers: { "X-PPTaken-CSRF": "1", Origin: mock.url },
        });
        expect(r.status()).toBe(200);
      }
      await page.goto(`${mock.url}/trash`);
      await page.locator(".trash-item .ppt-btn--secondary").first().click();
      await expect(page.getByTestId("restore-links")).toBeVisible();
    },
  },
  {
    name: "consent",
    options: { installed: true, oauthRequests: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/connect/req00000000000000000000000000001`);
      await expect(page.locator("fieldset")).toBeVisible();
    },
  },
  {
    name: "nav-drawer",
    options: { installed: true, decks: 3 },
    widths: [360],
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks`);
      await page.locator(".topbar__menu").click();
      await expect(page.locator("#sidebar")).toBeVisible();
    },
  },
  {
    name: "sidebar-collapsed",
    options: { installed: true, decks: 3 },
    widths: [768, 1280],
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks`);
      await expect(page.locator(".shell--collapsed")).toBeVisible();
    },
  },
  {
    name: "not-found",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/nowhere`);
      await expect(page.locator(".ppt-empty")).toBeVisible();
    },
  },
  {
    name: "not-found-signed-out",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.context().clearCookies();
      await page.goto(`${mock.url}/nowhere`);
      await expect(page.locator(".ppt-empty")).toBeVisible();
    },
  },
];

for (const screen of screens.filter(
  (s) => ONLY.length === 0 || ONLY.some((o) => s.name.startsWith(o)),
)) {
  test.describe(screen.name, () => {
    if (screen.options) test.use({ mockOptions: screen.options });

    test(`${screen.name} in every size, theme and language`, async ({ page, mock }) => {
      test.setTimeout(240_000);
      for (const lang of LANGS) {
        for (const theme of THEMES) {
          for (const width of screen.widths ?? WIDTHS) {
            // Reset the instance so each variant starts from the same state.
            mock.state.sessions.clear();
            mock.state.tokens = [];
            if (screen.options?.apps) mock.state.apps = makeApps(screen.options.apps as number);
            if (screen.options?.oauthRequests)
              mock.state.oauthRequests = makeOAuthRequests(screen.options.oauthRequests as number);
            mock.state.firstTokenAt = null;
            if (screen.name === "welcome-setup") mock.state.installed = false;
            await page.context().clearCookies();
            if (mock.state.installed && !screen.name.startsWith("login")) await signIn(page, mock);
            await page.setViewportSize({ width, height: width === 360 ? 780 : 860 });
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
            await page.goto(`${mock.url}/api/v1/setup/status`); // same origin, no markup
            await page.evaluate((l) => localStorage.setItem("pptaken.lang", l), lang);
            await page.evaluate(() => localStorage.removeItem("pptaken.theme"));
            await page.evaluate(
              (dev) =>
                dev
                  ? localStorage.setItem("pptaken.dev", "on")
                  : localStorage.removeItem("pptaken.dev"),
              screen.dev === true,
            );
            await page.evaluate(
              (collapsed) =>
                collapsed
                  ? localStorage.setItem("pptaken.sidebar", "collapsed")
                  : localStorage.removeItem("pptaken.sidebar"),
              screen.name === "sidebar-collapsed",
            );
            await screen.prepare(page, mock);
            await expect(page.locator("html")).toHaveAttribute("lang", lang);
            await page.evaluate(() => document.fonts.ready);
            await page.evaluate(() => window.scrollTo(0, 0));
            if (screen.name.endsWith("-dialog") || screen.name === "nav-drawer")
              await page.waitForTimeout(250);
            await noHorizontalOverflow(page);
            await basicA11y(page);
            const file = join(OUT, `${screen.name}-${width}-${theme}-${lang}.png`);
            if (screen.element) {
              // The phone top bar is sticky: keep it from covering the block in an element capture.
              // (CSSOM, not a <style> tag: the panel's CSP refuses inline styles, as it should.)
              await page.evaluate(() => {
                for (const h of document.querySelectorAll("header"))
                  (h as HTMLElement).style.setProperty("position", "static", "important");
              });
              await page.locator(screen.element).screenshot({ path: file, animations: "disabled" });
              continue;
            }
            await page.screenshot({
              path: file,
              fullPage: !screen.name.endsWith("-dialog") && screen.name !== "nav-drawer",
              animations: "disabled",
            });
          }
        }
      }
    });
  });
}
