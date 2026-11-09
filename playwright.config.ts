import { defineConfig, devices } from "@playwright/test";

/**
 * Kitsuden — Playwright E2E Configuration
 *
 * Setup:
 *   pnpm add -Dw @playwright/test
 *   npx playwright install chromium
 *   npx playwright init-agents --loop=vscode
 *
 * Run:
 *   npx playwright test
 *   npx playwright test --ui
 *
 * Requires: pnpm dev running (API :3001, Admin :5173)
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["html", { open: "never" }], ["list"]],
  timeout: 30_000,

  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
