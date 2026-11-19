// SPDX-License-Identifier: AGPL-3.0-or-later
// Screenshots of every screen at 360, 768 and 1280 px, light and dark, English and Spanish (Chromium only).
// Also checks for horizontal overflow on each. Files go to test/.screenshots (git-ignored).
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { makeApps, makeOAuthRequests } from "../mock-server.mjs";
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
const THEMES = ["light", "dark"] as const;
const LANGS = ["en", "es"] as const;

interface Screen {
  name: string;
  options?: MockOptions;
  /** Only these widths (default: all). */
  widths?: readonly number[];
  /** Capture only this element (a block of a long page) instead of the page. */
  element?: string;
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
    name: "welcome-connect-code",
    options: { installed: true, connectDelayMs: 600_000 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/welcome`);
      await page.locator(".ppt-copyblock .ppt-btn--primary").click();
      await expect(page.locator(".secret-field")).toBeVisible();
    },
  },
  {
    name: "welcome-connected",
    options: { installed: true, connectDelayMs: 0 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/welcome`);
      await page.locator(".ppt-copyblock .ppt-btn--primary").click();
      await expect(page.locator(".next-card")).toBeVisible({ timeout: 10_000 });
    },
  },
  {
    name: "welcome-web",
    options: { installed: true, connectDelayMs: 600_000 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/welcome`);
      await page.getByRole("tab").nth(1).click();
      await expect(page.locator(".ppt-notice--warning")).toBeVisible();
    },
  },
  {
    name: "welcome-other",
    options: { installed: true, connectDelayMs: 600_000 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/welcome`);
      await page.getByRole("tab").nth(2).click();
      await page.locator(".ppt-tabpanel .ppt-btn--primary").click();
      await expect(page.locator(".secret-field")).toBeVisible();
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
    options: { installed: true, decks: 14 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks`);
      await expect(page.locator("article.ppt-deck")).toHaveCount(6);
    },
  },
  {
    name: "decks-empty",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks`);
      await expect(page.locator(".ppt-empty__art")).toBeVisible();
    },
  },
  {
    name: "tokens",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/tokens`);
      await page.locator("input[name=name]").fill("Old laptop");
      await page.locator("form .ppt-btn--primary").click();
      await page.getByRole("button", { name: /^(Done|Listo)$/ }).click();
      await page.locator("input[name=name]").fill("Claude Code on my laptop");
      await page.locator("form .ppt-btn--primary").click();
      await expect(page.locator(".secret-field")).toBeVisible();
      await page.locator("table .ppt-btn").first().click();
      await page.locator("dialog[open] .ppt-btn--danger").click();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
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
    name: "not-found",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/nowhere`);
      await expect(page.locator(".ppt-empty")).toBeVisible();
    },
  },
  {
    name: "tokens-apps",
    options: { installed: true, apps: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/tokens`);
      await page.locator("input[name=name]").fill("Laptop");
      await page.locator("form .ppt-btn--primary").click();
      await page.getByRole("button", { name: /^(Done|Listo)$/ }).click();
      await expect(page.locator("table")).toHaveCount(2);
    },
  },
  {
    name: "tokens-revoke-dialog",
    options: { installed: true, apps: 1 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/tokens`);
      await page.locator("input[name=name]").fill("Laptop");
      await page.locator("form .ppt-btn--primary").click();
      await page.getByRole("button", { name: /^(Done|Listo)$/ }).click();
      await page.locator("table .ppt-btn").first().click();
      await expect(page.locator("dialog[open]")).toBeVisible();
    },
  },
  {
    name: "decks-import-dialog",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks`);
      await expect(page.locator("article.ppt-deck")).toHaveCount(3);
      await page.locator(".page-head__actions .ppt-btn").last().click();
      await expect(page.locator("dialog[open]")).toBeVisible();
    },
  },
  {
    name: "security-done",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/security`);
      await page.locator("input[name=current-password]").fill(mock.state.password ?? "");
      await page.locator("input[name=new-password]").fill(mock.state.password ?? "");
      await page.locator("section[aria-labelledby=password-title] form .ppt-btn--primary").click();
      await expect(page.locator(".ppt-notice--success")).toBeVisible();
    },
  },
  {
    name: "security-error",
    options: { installed: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/security`);
      await page.locator("input[name=current-password]").fill("not the password");
      await page.locator("input[name=new-password]").fill("a new long passphrase");
      await page.locator("input[type=checkbox]").check();
      await page.locator("section[aria-labelledby=password-title] form .ppt-btn--primary").click();
      await expect(page.locator(".ppt-field__error")).toBeVisible();
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
    name: "deck-pending",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await expect(page.locator("[data-testid=freeze-warning]")).toBeVisible();
      await expect(page.locator(".script")).toHaveCount(2);
    },
  },
  {
    name: "deck-approved",
    options: {
      installed: true,
      decks: 3,
      contentOrigin: "separate-site",
      presenterPassword: "lantern folds 9 maps",
    },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_002`);
      await expect(page.locator("[data-testid=deck-status]")).toContainText(/approved|aprobada/);
    },
  },
  {
    // Ingest-time vendoring (ADR-022): the "Vendored resources" section with a failed resource.
    name: "deck-vendored",
    options: { installed: true, decks: 3, vendored: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await expect(page.locator("[data-testid=vendored-list] > li")).toHaveCount(5);
      await expect(page.locator("[data-testid=vendor-failed]")).toBeVisible();
    },
  },
  {
    name: "deck-vendor-off",
    options: { installed: true, decks: 3, vendorFetch: "off" },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_003`);
      await expect(
        page.locator('[aria-labelledby="vendored-title"] .ppt-notice--warning'),
      ).toBeVisible();
    },
  },
  {
    name: "deck-static",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_003`);
      await expect(page.locator("[data-testid=static-deck]")).toBeVisible();
    },
  },
  {
    name: "deck-off",
    options: { installed: true, decks: 3, scriptsEnabled: false },
    widths: [360, 1280],
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await expect(page.getByText("PPTAKEN_SCRIPTS=owner", { exact: false })).toBeVisible();
    },
  },
  {
    name: "deck-approve-dialog",
    options: { installed: true, decks: 3 },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await page.locator(".meaning__actions .ppt-btn--primary").click();
      await expect(page.locator("dialog[open]")).toBeVisible();
    },
  },
  // Script error visibility (ADR-023): the errors block in its three states, the static checks, the extra
  // confirmation for code with a syntax error, and the amber badge in the list.
  {
    name: "deck-errors-none",
    options: { installed: true, decks: 3 },
    element: "[data-testid=script-errors]",
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_002#script-errors`);
      await expect(page.locator("[data-testid=script-errors]")).toHaveAttribute(
        "data-status",
        "no_errors",
      );
    },
  },
  {
    name: "deck-errors-reported",
    options: { installed: true, decks: 3, scriptErrors: "errors" },
    element: "[data-testid=script-errors]",
    prepare: async (page, mock) => {
      mock.state.clearedErrors.clear();
      await page.goto(`${mock.url}/decks/deck_002#script-errors`);
      await expect(page.locator("[data-testid=script-errors-list] > li")).toHaveCount(4);
    },
  },
  {
    name: "deck-errors-previous",
    options: { installed: true, decks: 3, scriptErrors: "previous" },
    element: "[data-testid=script-errors]",
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_002#script-errors`);
      await expect(page.locator("[data-testid=script-errors-previous] > li")).toHaveCount(2);
    },
  },
  {
    name: "deck-checks",
    options: { installed: true, decks: 3, scriptChecks: true },
    element: "[data-testid=script-checks]",
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await expect(page.locator("[data-testid=script-checks] li")).toHaveCount(2);
    },
  },
  {
    name: "deck-approve-syntax-dialog",
    options: { installed: true, decks: 3, scriptChecks: true },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/decks/deck_001`);
      await page.locator(".meaning__actions .ppt-btn--primary").click();
      await expect(page.locator("[data-testid=confirm-syntax]")).toBeVisible();
    },
  },
  {
    name: "decks-script-errors",
    options: { installed: true, decks: 3, scriptErrors: "errors" },
    prepare: async (page, mock) => {
      mock.state.clearedErrors.clear();
      await page.goto(`${mock.url}/decks`);
      await expect(page.locator("[data-script-errors]")).toHaveCount(1);
    },
  },
  {
    name: "security-presenter",
    options: { installed: true, presenterPassword: "lantern folds 9 maps" },
    prepare: async (page, mock) => {
      await page.goto(`${mock.url}/security`);
      await expect(page.locator("[data-testid=presenter-status]")).toHaveAttribute(
        "data-set",
        "true",
      );
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
