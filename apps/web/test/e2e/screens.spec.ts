// SPDX-License-Identifier: AGPL-3.0-or-later
// Screenshots of every screen at 360 and 1280 px, light and dark, English and Spanish (Chromium only).
// Also checks for horizontal overflow on each. Files go to test/.screenshots (git-ignored).
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  expect,
  type Mock,
  type MockOptions,
  noHorizontalOverflow,
  signIn,
  test,
} from "./fixtures";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", ".screenshots");
mkdirSync(OUT, { recursive: true });

const WIDTHS = [360, 1280] as const;
const THEMES = ["light", "dark"] as const;
const LANGS = ["en", "es"] as const;

interface Screen {
  name: string;
  options?: MockOptions;
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
];

for (const screen of screens) {
  test.describe(screen.name, () => {
    if (screen.options) test.use({ mockOptions: screen.options });

    test(`${screen.name} in every size, theme and language`, async ({ page, mock }) => {
      test.setTimeout(120_000);
      for (const lang of LANGS) {
        for (const theme of THEMES) {
          for (const width of WIDTHS) {
            // Reset the instance so each variant starts from the same state.
            mock.state.sessions.clear();
            mock.state.tokens = [];
            mock.state.firstTokenAt = null;
            if (screen.name === "welcome-setup") mock.state.installed = false;
            await page.context().clearCookies();
            if (mock.state.installed && !screen.name.startsWith("login")) await signIn(page, mock);
            await page.setViewportSize({ width, height: width === 360 ? 780 : 860 });
            await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
            await page.goto(`${mock.url}/api/v1/setup/status`); // same origin, no markup
            await page.evaluate((l) => localStorage.setItem("pptaken.lang", l), lang);
            await page.evaluate(() => localStorage.removeItem("pptaken.theme"));
            await screen.prepare(page, mock);
            await expect(page.locator("html")).toHaveAttribute("lang", lang);
            await page.evaluate(() => document.fonts.ready);
            await page.evaluate(() => window.scrollTo(0, 0));
            await noHorizontalOverflow(page);
            await page.screenshot({
              path: join(OUT, `${screen.name}-${width}-${theme}-${lang}.png`),
              fullPage: true,
              animations: "disabled",
            });
          }
        }
      }
    });
  });
}
