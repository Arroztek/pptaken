// SPDX-License-Identifier: AGPL-3.0-or-later
import { clipboardText, expect, OWNER_PASSWORD, signIn, test } from "./fixtures";

test.describe("first run", () => {
  test.use({ mockOptions: { connectDelayMs: 1500 } });

  test("install code → password → connect → prompt copied → waiting → connected", async ({
    page,
    mock,
  }) => {
    // The whole first run in one test (with a real 2.5 s polling check): WebKit in parallel can pass 30 s.
    test.setTimeout(60_000);
    await page.goto(`${mock.url}/`);
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByText("Step 1 of 2")).toBeVisible();
    await expect(page).toHaveTitle("Set up · PPTaken");

    // Client-side validation first.
    await page.getByRole("button", { name: "Create owner" }).click();
    await expect(page.getByText("Enter the install code.")).toBeVisible();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();

    // Wrong code is reported on its field.
    await page.getByLabel("Install code").fill("AAAA-BBBB");
    await page.getByLabel("Owner password").fill(OWNER_PASSWORD);
    await page.getByLabel("Confirm password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Create owner" }).click();
    await expect(
      page.getByText("That install code does not match. Check the server logs."),
    ).toBeVisible();

    // A common password comes back with the server hint.
    await page.getByLabel("Install code").fill("7K2M-9QXD");
    await page.getByLabel("Owner password").fill("password1234");
    await page.getByLabel("Confirm password").fill("password1234");
    await page.getByRole("button", { name: "Create owner" }).click();
    await expect(page.getByText("This password is too common. Try a short phrase.")).toBeVisible();

    // Show passwords toggles the input type.
    await page.getByLabel("Show passwords").check();
    await expect(page.getByLabel("Owner password")).toHaveAttribute("type", "text");
    await page.getByLabel("Show passwords").uncheck();

    await page.getByLabel("Owner password").fill(OWNER_PASSWORD);
    await page.getByLabel("Confirm password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Create owner" }).click();

    // Step 2: Connect your agent.
    await expect(
      page.getByRole("heading", { level: 1, name: "Connect your agent." }),
    ).toBeVisible();
    await expect(page.getByText("Step 2 of 2")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Claude Code" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByText("Waiting for your agent's first call…")).toBeVisible();

    // The prompt preview shows the real URL but no secret.
    const preview = page.getByRole("region", { name: "Setup prompt" });
    await expect(preview).toContainText(`"${mock.url}/mcp"`);
    expect(await page.content()).not.toMatch(/ppt_[A-Za-z0-9_-]{43}/);

    await page.getByRole("button", { name: "Copy setup prompt" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

    const prompt = (await clipboardText(page)) ?? "";
    const secret = mock.state.tokens[0] ? prompt.match(/ppt_[A-Za-z0-9_-]{43}/)?.[0] : undefined;
    expect(mock.state.tokens).toHaveLength(1);
    expect(mock.state.tokens[0]?.name).toBe("Claude Code");
    expect(secret).toBeTruthy();
    expect(prompt).toContain(
      `claude mcp add --transport http pptaken "${mock.url}/mcp" --header "Authorization: Bearer ${secret}" --scope user`,
    );
    expect(prompt).toContain("whoami");

    // The secret is in memory only: not in the DOM until revealed, never in storage.
    expect(await page.content()).not.toContain(secret);
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(storage).not.toContain(secret);
    await page.getByRole("button", { name: "Show Token" }).click();
    await expect(page.getByText(secret ?? "")).toBeVisible();
    await page.getByRole("button", { name: "Hide" }).click();
    expect(await page.content()).not.toContain(secret);

    // Copying again reuses the same token.
    await page.getByRole("button", { name: "Copy setup prompt" }).click();
    expect(mock.state.tokens).toHaveLength(1);

    // The status flips without a reload.
    await expect(page.getByText("Claude connected.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Claude Code called whoami/)).toBeVisible();

    await page.getByRole("button", { name: "Copy example prompt" }).click();
    await expect.poll(() => clipboardText(page)).toContain("Create a 5-slide presentation about");

    // Every mutation carried the CSRF header and the app origin.
    const mutations = mock.state.log.filter((r) => r.method !== "GET");
    expect(mutations.length).toBeGreaterThanOrEqual(3);
    for (const r of mutations) {
      expect(r.csrf).toBe("1");
      expect(r.origin).toBe(mock.url);
    }

    // Polling stopped once connected.
    const polls = mock.state.log.filter((r) => r.path === "/connect/status").length;
    await page.waitForTimeout(2500);
    expect(mock.state.log.filter((r) => r.path === "/connect/status").length).toBe(polls);

    await page.getByRole("link", { name: "Go to presentations" }).click();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(page.getByText("No presentations yet.")).toBeVisible();
  });
});

test.describe("connect tabs", () => {
  test.use({ mockOptions: { installed: true, connectDelayMs: 600_000 } });

  test("claude.ai tab warns when the instance is not public HTTPS", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    await expect(page.getByText("Step 2 of 2")).toHaveCount(0);
    await page.getByRole("tab", { name: "Claude (web, desktop, mobile)" }).click();
    await expect(page.getByText("claude.ai cannot reach this server.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Read the publishing guide" })).toHaveAttribute(
      "href",
      "#publish-guide",
    );
    await expect(
      page.getByText("Settings → Customize → Connectors → Add → Add custom connector"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect.poll(() => clipboardText(page)).toBe(`${mock.url}/mcp`);
    await expect(page.getByText("Copied to clipboard.").first()).toBeAttached();
  });

  test("claude.ai tab confirms a public HTTPS instance", async ({ page, mock }) => {
    mock.state.https = true;
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    await page.getByRole("tab", { name: "Claude (web, desktop, mobile)" }).click();
    await expect(page.getByText("Your server is public and uses HTTPS. Good.")).toBeVisible();
  });

  test("other MCP client: token on demand and a JSON example", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    await page.getByRole("tab", { name: "Other MCP client" }).click();
    const config = page.getByRole("region", { name: "Client configuration" });
    await expect(config).toContainText('"Authorization": "Bearer ppt_••••');
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByRole("button", { name: "Show Client configuration" })).toBeVisible();
    expect(mock.state.tokens.map((t) => t.name)).toEqual(["MCP client"]);
    expect(await page.content()).not.toMatch(/ppt_[A-Za-z0-9_-]{43}/);

    await page.getByRole("button", { name: "Show Client configuration" }).click();
    await expect(page.getByRole("region", { name: "Client configuration" })).toContainText(
      /Bearer ppt_[\w-]{43}/,
    );

    const copyButtons = page.getByRole("button", { name: "Copy", exact: true });
    await copyButtons.last().click();
    const parsed = JSON.parse((await clipboardText(page)) ?? "{}");
    expect(parsed.mcpServers.pptaken.url).toBe(`${mock.url}/mcp`);
    expect(parsed.mcpServers.pptaken.headers.Authorization).toMatch(/^Bearer ppt_[\w-]{43}$/);
  });

  test("tabs work with the keyboard alone", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    const code = page.getByRole("tab", { name: "Claude Code" });
    await expect(code).toBeVisible();

    // Tab from the top of the page until the selected tab has focus.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      if (await code.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(code).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const web = page.getByRole("tab", { name: "Claude (web, desktop, mobile)" });
    await expect(web).toBeFocused();
    await expect(web).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Copy the connector URL.")).toBeVisible();
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "Other MCP client" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(code).toBeFocused();
    await page.keyboard.press("Home");
    await expect(code).toHaveAttribute("aria-selected", "true");
    // Only the selected tab is in the tab order; Tab moves into the panel.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tabpanel")).toBeFocused();
  });

  test("secrets are dropped when leaving the page", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    await page.getByRole("button", { name: "Copy setup prompt" }).click();
    await expect(page.getByRole("button", { name: "Show Token" })).toBeVisible();
    await page.getByRole("link", { name: "Presentations" }).first().click();
    await expect(page).toHaveURL(/\/decks$/);
    await page.goBack();
    await expect(page.getByRole("button", { name: "Copy setup prompt" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show Token" })).toHaveCount(0);
    await page.getByRole("button", { name: "Copy setup prompt" }).click();
    await expect.poll(() => mock.state.tokens.length).toBe(2);
  });
});
