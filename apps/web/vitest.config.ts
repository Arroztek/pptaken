// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests cover the framework-free logic in src/lib; the UI itself is exercised by Playwright.
// The Svelte plugin is here only because @pptaken/ui's entry re-exports its components.
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
