// spec: specs/kitsuden-full-coverage.md
// seed: tests/seed.spec.ts

import { test, expect } from "@playwright/test";

const ADMIN = process.env.ADMIN_URL || "http://localhost:5173";
const API = process.env.API_URL || "http://localhost:3001";

test("seed — bootstrap admin panel", async ({ page }) => {
  // 1. Verify API is healthy
  const healthRes = await page.request.get(`${API}/api/health`);
  expect(healthRes.ok()).toBeTruthy();

  // 2. Navigate to admin panel
  await page.goto(ADMIN);
  await page.waitForURL(/\/(login|setup)/, { timeout: 15_000 });

  // 3. If on setup page, fresh install
  if (page.url().includes("/setup")) {
    await expect(page.locator("text=Setup")).toBeVisible();
    return;
  }

  // 4. Login as admin
  await page.locator('input[type="email"]').fill("admin@kitsuden.gg");
  await page.locator('input[type="password"]').fill("kitsuden123");
  await page.locator('button[type="submit"]').click();

  // 5. Should arrive at dashboard
  await page.waitForURL("**/", { timeout: 15_000 });
  await expect(page.locator("text=Welcome back")).toBeVisible({ timeout: 10_000 });

  // 6. API indicator
  await expect(page.locator("text=API Connected")).toBeVisible({ timeout: 5_000 });
});
