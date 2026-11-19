// SPDX-License-Identifier: AGPL-3.0-or-later
// First run (J1): install code → password → Connect Claude (three steps; Claude Code under Developer) → connected.
import { clipboardText, expect, OWNER_PASSWORD, signIn, test } from "./fixtures";

test.describe("first run", () => {
  test.use({ mockOptions: { connectDelayMs: 1500 } });

  test("install code → password → connect → prompt copied → waiting → connected", async ({
    page,
    mock,
  }) => {
    test.setTimeout(60_000);
    await page.goto(`${mock.url}/`);
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByText("Step 1 of 2")).toBeVisible();
    await expect(page).toHaveTitle("Set up · PPTaken");

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Enter the install code.")).toBeVisible();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();

    await page.getByLabel("Install code").fill("AAAA-BBBB");
    await page.getByLabel("Your password").fill(OWNER_PASSWORD);
    await page.getByLabel("Confirm password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("That install code does not match. Check it and try again."),
    ).toBeVisible();

    // A weak password: plain words, never the server's English text.
    await page.getByLabel("Install code").fill("7K2M-9QXD");
    await page.getByLabel("Your password").fill("password1234");
    await page.getByLabel("Confirm password").fill("password1234");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Choose a stronger password.")).toBeVisible();

    await page.getByLabel("Show passwords").check();
    await expect(page.getByLabel("Your password")).toHaveAttribute("type", "text");
    await page.getByLabel("Show passwords").uncheck();

    await page.getByLabel("Your password").fill(OWNER_PASSWORD);
    await page.getByLabel("Confirm password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 2: Connect Claude, the shortest path first.
    await expect(page.getByRole("heading", { level: 1, name: "Connect Claude." })).toBeVisible();
    await expect(page.getByText("Step 2 of 2")).toBeVisible();
    await expect(page.getByTestId("connect-steps").locator("> li")).toHaveCount(3);
    await expect(page.getByText("Waiting for Claude…")).toBeVisible();
    // Developer tools are folded away.
    const fold = page.getByTestId("developer-fold");
    await expect(fold).not.toHaveAttribute("open", /.*/);
    expect(await page.locator("main").innerText()).not.toMatch(/token|MCP/);

    await fold.getByText("Developer", { exact: true }).click();
    const preview = page.getByRole("region", { name: "Setup prompt" });
    await expect(preview).toContainText(`"${mock.url}/mcp"`);
    expect(await page.content()).not.toMatch(/ppt_[A-Za-z0-9_-]{43}/);
    await page.getByRole("button", { name: "Copy setup prompt" }).click();
    const prompt = (await clipboardText(page)) ?? "";
    const secret = prompt.match(/ppt_[A-Za-z0-9_-]{43}/)?.[0];
    expect(mock.state.tokens).toHaveLength(1);
    expect(secret).toBeTruthy();
    expect(prompt).toContain(
      `claude mcp add --transport http pptaken "${mock.url}/mcp" --header "Authorization: Bearer ${secret}" --scope user`,
    );
    expect(await page.content()).not.toContain(secret);
    const storage = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(storage).not.toContain(secret);

    await expect(page.getByText("Claude is connected.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Claude Code connected/)).toBeVisible();
    await page.getByRole("button", { name: "Copy an example request" }).click();
    await expect.poll(() => clipboardText(page)).toContain("Create a 5-slide presentation about");

    const mutations = mock.state.log.filter((r) => r.method !== "GET");
    for (const r of mutations) {
      expect(r.csrf).toBe("1");
      expect(r.origin).toBe(mock.url);
    }
    const polls = mock.state.log.filter((r) => r.path === "/connect/status").length;
    await page.waitForTimeout(2500);
    expect(mock.state.log.filter((r) => r.path === "/connect/status").length).toBe(polls);

    await page.getByRole("link", { name: "Go to presentations" }).click();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(page.getByText("No presentations yet.")).toBeVisible();
  });
});

test.describe("connect claude", () => {
  test.use({ mockOptions: { installed: true, connectDelayMs: 600_000 } });

  test("three steps; a calm note when the instance is not public", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    await expect(page.getByText("Step 2 of 2")).toHaveCount(0);
    await expect(
      page.getByText("Claude on the web and Desktop cannot reach this PPTaken yet."),
    ).toBeVisible();
    await expect(page.locator(".ppt-notice--warning, .ppt-notice--danger")).toHaveCount(0);
    await expect(
      page.getByText(
        "In Claude Desktop: Settings → Customize → Connectors → Add → Add custom connector.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Copy", exact: true }).first().click();
    await expect.poll(() => clipboardText(page)).toBe(`${mock.url}/mcp`);
    await expect(page.getByText(/connected apps/i).first()).toBeVisible();
  });

  test("no public-address note on a public HTTPS instance", async ({ page, mock }) => {
    mock.state.https = true;
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    await expect(
      page.getByText("Claude on the web and Desktop cannot reach this PPTaken yet."),
    ).toHaveCount(0);
  });

  test("Developer › other MCP clients: access key on demand and a JSON example", async ({
    page,
    mock,
  }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    await page.getByTestId("developer-fold").getByText("Developer", { exact: true }).click();
    await page.getByRole("tab", { name: "Other MCP clients" }).click();
    const config = page.getByRole("region", { name: "Client configuration" });
    await expect(config).toContainText('"Authorization": "Bearer ppt_••••');
    await page.getByRole("button", { name: "Create access key" }).click();
    await expect(page.getByRole("button", { name: "Show Client configuration" })).toBeVisible();
    expect(mock.state.tokens.map((t) => t.name)).toEqual(["MCP client"]);
    expect(await page.content()).not.toMatch(/ppt_[A-Za-z0-9_-]{43}/);
    await page.getByRole("button", { name: "Show Client configuration" }).click();
    await expect(config).toContainText(/Bearer ppt_[\w-]{43}/);
    await page.getByRole("button", { name: "Copy", exact: true }).last().click();
    const parsed = JSON.parse((await clipboardText(page)) ?? "{}");
    expect(parsed.mcpServers.pptaken.url).toBe(`${mock.url}/mcp`);
  });

  test("developer tabs work with the keyboard alone", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    await page.getByTestId("developer-fold").getByText("Developer", { exact: true }).click();
    const code = page.getByRole("tab", { name: "Claude Code" });
    await code.focus();
    await page.keyboard.press("ArrowRight");
    const other = page.getByRole("tab", { name: "Other MCP clients" });
    await expect(other).toBeFocused();
    await expect(other).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(code).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tabpanel")).toBeFocused();
  });

  test("secrets are dropped when leaving the page", async ({ page, mock }) => {
    await signIn(page, mock);
    await page.goto(`${mock.url}/welcome`);
    await page.getByTestId("developer-fold").getByText("Developer", { exact: true }).click();
    await page.getByRole("button", { name: "Copy setup prompt" }).click();
    await expect(page.getByRole("button", { name: "Show Access key (token)" })).toBeVisible();
    await page.getByRole("link", { name: "Presentations" }).first().click();
    await expect(page).toHaveURL(/\/decks$/);
    await page.goBack();
    await page.getByTestId("developer-fold").getByText("Developer", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Copy setup prompt" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show Access key (token)" })).toHaveCount(0);
  });
});
