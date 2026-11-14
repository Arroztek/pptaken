// SPDX-License-Identifier: AGPL-3.0-or-later
// Core tests use the in-memory ports of @pptaken/testing. Both packages are resolved from source so that there
// is a single copy of every core class (no dist/source identity split) and no package-level dependency cycle.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@pptaken/core": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      "@pptaken/testing": fileURLToPath(new URL("../testing/src/index.ts", import.meta.url)),
    },
  },
});
