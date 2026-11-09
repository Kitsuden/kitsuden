import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Against a running API (scripts/sdk/integration.mjs starts one on a test DB).
export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["**/*.it.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
