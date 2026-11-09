// E2E Test Configuration for MCP + Vector Search Integration Tests

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.spec.ts",
  fullyParallel: false, // Sequential: MCP session stateful
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.API_URL || "http://localhost:3001",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "mcp-vector-search",
      use: {
        extraHTTPHeaders: {
          "Content-Type": "application/json",
        },
      },
    },
  ],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
});
