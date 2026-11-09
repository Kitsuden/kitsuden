import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The SDK's own suite (mocked server). `pnpm test:sdk` from the root.
// The integration suite (`tests/integration/**`) needs a running API: see
// scripts/sdk/integration.mjs.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "**/node_modules/**"],
    environment: "node",
  },
});
