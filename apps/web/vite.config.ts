// SPDX-License-Identifier: AGPL-3.0-or-later
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const backend = process.env.PPTAKEN_DEV_BACKEND ?? "http://localhost:8080";

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // The server sends a strict CSP: keep every asset a real file (no data: URIs, no inline scripts).
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    manifest: true,
    cssCodeSplit: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/mcp": backend,
      "/p": backend,
      "/c": backend,
    },
  },
});
