// SPDX-License-Identifier: AGPL-3.0-or-later
// The dashboard shell: sidebar landmarks, keyboard order, collapse to icons, the mobile drawer, contrast of the
// navigation states, focused pages without a sidebar, and no sideways scrolling at 360, 768 and 1280 px.
import type { Page } from "@playwright/test";
import { expect, noHorizontalOverflow, signIn, test } from "./fixtures";

const NAV = ["Presentations", "Connect your agent", "Access & connections", "Security"];

/** WCAG contrast ratio of two computed CSS colors (opaque rgb/rgba). */
async function contrast(page: Page, selector: string, fg: string, bgSelector: string, bg: string) {
  return page.evaluate(
    ({ selector, fg, bgSelector, bg }) => {
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (c: string) => {
        const [r, g, b] = parse(c).map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
      };
      const read = (sel: string, prop: string) => {
        const [el, pseudo] = sel.split("::");
        const node = document.querySelector(el ?? "");
        if (!node) throw new Error(`missing ${sel}`);
        return getComputedStyle(node, pseudo ? `::${pseudo}` : null).getPropertyValue(prop);
      };
      const a = lum(read(selector, fg));
      const b = lum(read(bgSelector, bg));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    },
    { selector, fg, bgSelector, bg },
  );
}

test.describe("desktop sidebar", () => {
  test.use({ mockOptions: { installed: true, decks: 3 } });

  test("landmarks, grouped links with icons and the current page", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/tokens`);
    await expect(page.getByRole("main")).toHaveCount(1);
    const nav = page.getByRole("navigation", { name: "Panel" });
    await expect(nav).toHaveCount(1);
    await expect(nav.getByRole("list", { name: "Workspace" }).getByRole("link")).toHaveText([
      "Presentations",
      "Connect your agent",
    ]);
    await expect(nav.getByRole("list", { name: "Account" }).getByRole("link")).toHaveText([
      "Access & connections",
      "Security",
    ]);
    await expect(nav.locator("a[aria-current=page]")).toHaveText("Access & connections");
    await expect(nav.locator("a svg")).toHaveCount(4);
    // Instance, health and preferences live at the bottom of the sidebar.
    await expect(page.locator(".instance")).toContainText(new URL(mock.url).host);
    await expect(page.locator(".instance")).toContainText("Online");
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    // No top bar on desktop.
    await expect(page.locator(".topbar")).toBeHidden();

    await nav.getByRole("link", { name: "Security" }).click();
    await expect(page).toHaveURL(/\/security$/);
    await expect(nav.locator("a[aria-current=page]")).toHaveText("Security");
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("keyboard order: skip link, logo, collapse, then the links in order", async ({
    page,
    mock,
    browserName,
  }) => {
    // Safari moves Tab between form controls only (links need Option+Tab), so the order is checked elsewhere.
    test.skip(browserName === "webkit", "WebKit does not Tab to links by default");
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await expect(page.getByRole("heading", { level: 1, name: "Presentations" })).toBeVisible();
    const names: string[] = [];
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press("Tab");
      names.push(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent?.trim() ??
            "",
        ),
      );
    }
    expect(names).toEqual(["Skip to content", "PPTaken home", "Collapse sidebar", ...NAV]);
    // The focus ring is visible on a nav link.
    const outline = await page.evaluate(
      () => getComputedStyle(document.activeElement as Element).outlineStyle,
    );
    expect(outline).toBe("solid");
  });

  test("collapses to icons, keeps names and remembers it", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    const toggle = page.getByRole("button", { name: "Collapse sidebar" });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const wide = await page.locator("#sidebar").evaluate((el) => el.getBoundingClientRect().width);
    await toggle.click();
    const expand = page.getByRole("button", { name: "Expand sidebar" });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("pptaken.sidebar")))
      .toBe("collapsed");
    const narrow = await page
      .locator("#sidebar")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(narrow).toBeLessThan(wide / 2);
    // Labels are visually hidden but still name the links (and a tooltip shows them).
    const security = page.getByRole("link", { name: "Security" });
    await expect(security).toHaveAttribute("title", "Security");
    await page.reload();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("pptaken.sidebar")))
      .toBe("expanded");
  });

  test("survives blocked storage", async ({ page, mock }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("blocked");
        },
      });
    });
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`navigation states keep their contrast (${theme})`, async ({ page, mock }) => {
      await page.emulateMedia({ colorScheme: theme });
      await signIn(page, mock);
      await page.goto(`${mock.url}/decks`);
      const current = ".nav-link[aria-current=page]";
      const other = ".nav-link:not([aria-current])";
      await expect(page.locator(current)).toBeVisible();
      // Text: 4.5:1. The cue bar and the focus ring: 3:1 (non-text contrast).
      expect(
        await contrast(page, other, "color", ".shell::before", "background-color"),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        await contrast(page, current, "color", current, "background-color"),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        await contrast(page, `${current}::before`, "background-color", current, "background-color"),
      ).toBeGreaterThanOrEqual(3);
      await page.locator(other).first().focus();
      expect(
        await contrast(
          page,
          ".nav-link:focus",
          "outline-color",
          ".shell::before",
          "background-color",
        ),
      ).toBeGreaterThanOrEqual(3);
    });
  }
});

test.describe("mobile drawer", () => {
  test.use({ mockOptions: { installed: true, decks: 3 }, viewport: { width: 360, height: 780 } });

  test("opens from the top bar, traps focus, closes with Escape", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    const menu = page.getByRole("button", { name: "Open menu" });
    await expect(page.getByRole("banner")).toContainText("Presentations");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    // Closed: the drawer is out of the way and out of the tab order.
    await expect(page.getByRole("navigation", { name: "Panel" })).toBeHidden();
    await expect(page.locator("#sidebar")).toHaveAttribute("inert", "");

    await menu.click();
    const drawer = page.getByRole("dialog", { name: "Panel" });
    await expect(drawer).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".shell__content")).toHaveAttribute("inert", "");
    const first = drawer.getByRole("link", { name: "PPTaken home" });
    const last = drawer.getByRole("button", { name: "Sign out" });
    await expect(first).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(menu).toBeFocused();

    // Following a link closes the drawer.
    await menu.click();
    await drawer.getByRole("link", { name: "Security" }).click();
    await expect(page).toHaveURL(/\/security$/);
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("banner")).toContainText("Security");

    // The scrim closes it too.
    await menu.click();
    await page.mouse.click(350, 400);
    await expect(drawer).toBeHidden();
  });

  test("the language switch inside the drawer keeps it open", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/decks`);
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("radio", { name: "Español" }).click();
    await expect(page.getByRole("dialog", { name: "Panel" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Español" })).toBeFocused();
    await expect(page.getByRole("link", { name: "Seguridad" })).toBeVisible();
  });
});

test.describe("focused pages", () => {
  test.use({ mockOptions: { installed: true, oauthRequests: 1 } });

  test("sign-in, consent and signed-out pages have no sidebar", async ({ page, mock }) => {
    await page.goto(`${mock.url}/login`);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in." })).toBeVisible();
    await expect(page.locator("#sidebar")).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);

    await signIn(page, mock);
    await page.goto(`${mock.url}/connect/req00000000000000000000000000000`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("claude.ai");
    await expect(page.locator("#sidebar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Allow access" })).toBeVisible();
  });

  test("setup has no sidebar", async ({ page, mock }) => {
    mock.state.installed = false;
    await page.goto(`${mock.url}/welcome`);
    await expect(page.getByText("Step 1 of 2")).toBeVisible();
    await expect(page.locator("#sidebar")).toHaveCount(0);
  });
});

test.describe("security", () => {
  test.use({ mockOptions: { installed: true, apps: 2 } });

  test("change password: field error, then success with disconnected apps", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/security`);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Enter both passwords.").first()).toBeVisible();

    await page.getByLabel("Current password").fill("not the password");
    await page.getByLabel("New password").fill("a brand new passphrase");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("That password is not right. Try again.")).toBeVisible();

    const checkbox = page.getByRole("checkbox", {
      name: "Also disconnect every connected application",
    });
    await expect(checkbox).toHaveAccessibleDescription(
      "Do this if someone else may have known your password.",
    );
    await page.getByLabel("Current password").fill(mock.state.password ?? "");
    await checkbox.check();
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "2 applications were disconnected" }),
    ).toBeVisible();
    expect(mock.state.apps).toHaveLength(0);
    await expect(checkbox).not.toBeChecked();
  });
});

test.describe("no sideways scrolling", () => {
  test.use({ mockOptions: { installed: true, decks: 8, apps: 3, oauthRequests: 1 } });

  test("every page at 360, 768 and 1280 px", async ({ page, mock }) => {
    test.setTimeout(90_000);
    const signedIn = [
      "/decks",
      "/welcome",
      "/tokens",
      "/security",
      "/nowhere",
      "/connect/req00000000000000000000000000000",
    ];
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.context().clearCookies();
      await page.goto(`${mock.url}/login`);
      await expect(page.locator("input[name=password]")).toBeVisible();
      await noHorizontalOverflow(page);
      await signIn(page, mock);
      for (const path of signedIn) {
        await page.goto(`${mock.url}${path}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await noHorizontalOverflow(page);
      }
    }
  });
});
