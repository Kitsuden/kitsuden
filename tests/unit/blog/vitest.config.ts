// Vitest Configuration for Blog Unit Tests

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/blog/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "tests/"],
    },
  },
  resolve: {
    alias: {
      "@admin": path.resolve(__dirname, "../../../packages/admin/src"),
      "@api": path.resolve(__dirname, "../../../apps/api/src"),
      "@kons": path.resolve(__dirname, "../../../packages/kons"),
    },
  },
});
