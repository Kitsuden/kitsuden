// spec: specs/kitsuden-full-coverage.md — Section 1: Authentication
// seed: tests/seed.spec.ts

import { test, expect } from "@playwright/test";

const ADMIN = process.env.ADMIN_URL || "http://localhost:5173";

test.describe("Authentication Flow", () => {
  test("1.1 Successful admin login", async ({ page }) => {
    await page.goto(ADMIN);
    await page.waitForURL(/\/(login|setup)/, { timeout: 15_000 });

    if (page.url().includes("/setup")) {
      test.skip(true, "Fresh install — setup page shown");
      return;
    }

    // Login form uses input[type=email] and input[type=password]
    await page.locator('input[type="email"]').fill("admin@kitsuden.gg");
    await page.locator('input[type="password"]').fill("kitsuden123");
    await page.locator('button[type="submit"]').click();

    // Dashboard
    await page.waitForURL(/\/$/, { timeout: 15_000 });
    await expect(page.locator("text=Welcome back")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=API Connected")).toBeVisible({ timeout: 5_000 });
  });

  test("1.2 Failed login with wrong password", async ({ page }) => {
    await page.goto(`${ADMIN}/login`);
    await page.waitForLoadState("networkidle");

    if (page.url().includes("/setup")) {
      test.skip(true, "Fresh install");
      return;
    }

    await page.locator('input[type="email"]').fill("admin@kitsuden.gg");
    await page.locator('input[type="password"]').fill("wrongpassword");
    await page.locator('button[type="submit"]').click();

    // Should stay on login — wait a bit for any redirect
    await page.waitForTimeout(3000);
    expect(page.url()).toContain("/login");
  });

  test("1.3 Session persists on reload", async ({ page }) => {
    await page.goto(ADMIN);
    await page.waitForURL(/\/(login|setup)/, { timeout: 15_000 });

    if (page.url().includes("/setup")) {
      test.skip(true, "Fresh install");
      return;
    }

    // Login
    await page.locator('input[type="email"]').fill("admin@kitsuden.gg");
    await page.locator('input[type="password"]').fill("kitsuden123");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });

    // Navigate to games
    await page.locator("aside").locator("text=Games").first().click();
    await page.waitForURL("**/games", { timeout: 5_000 });

    // Reload
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Should NOT redirect to login
    expect(page.url()).not.toContain("/login");
    expect(page.url()).toContain("/games");
  });
});
