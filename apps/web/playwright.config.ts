// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser tests run the built app (dist) against test/mock-server.mjs; each test starts its own server.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 800 } },
      testIgnore: /screens\.spec\.ts/,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } },
      testIgnore: /screens\.spec\.ts/,
    },
  ],
});
