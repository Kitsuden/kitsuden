// spec: specs/kitsuden-full-coverage.md — Section 10: Sidebar Navigation
// seed: tests/seed.spec.ts

import { test, expect, type Page } from "@playwright/test";

const ADMIN = process.env.ADMIN_URL || "http://localhost:5173";

async function loginAsAdmin(page: Page): Promise<boolean> {
  await page.goto(ADMIN);
  await page.waitForURL(/\/(login|setup)/, { timeout: 15_000 });
  if (page.url().includes("/setup")) return false;

  await page.locator('input[type="email"]').fill("admin@kitsuden.gg");
  await page.locator('input[type="password"]').fill("kitsuden123");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/$/, { timeout: 15_000 });
  await expect(page.locator("text=Welcome back")).toBeVisible({ timeout: 10_000 });
  return true;
}

test.describe("Sidebar Navigation", () => {
  test("All core nav items present", async ({ page }) => {
    const ok = await loginAsAdmin(page);
    if (!ok) {
      test.skip(true, "Fresh install");
      return;
    }

    const sidebar = page.locator("aside");

    // Main nav items
    await expect(sidebar.locator("text=Dashboard")).toBeVisible();
    await expect(sidebar.locator("text=Games").first()).toBeVisible();
    await expect(sidebar.locator("text=Collections")).toBeVisible();
    await expect(sidebar.locator("text=Blog Posts")).toBeVisible();
    await expect(sidebar.locator("text=Media Library")).toBeVisible();
    await expect(sidebar.locator("text=Data Sets")).toBeVisible();
    await expect(sidebar.locator("text=Data Explorer")).toBeVisible();

    // System section
    await expect(sidebar.locator("text=Modules")).toBeVisible();
    await expect(sidebar.locator("text=Themes")).toBeVisible();
    await expect(sidebar.locator("text=Settings")).toBeVisible();
  });

  test("Navigate to Games", async ({ page }) => {
    const ok = await loginAsAdmin(page);
    if (!ok) {
      test.skip(true, "Fresh install");
      return;
    }

    await page.locator("aside").locator("text=Games").first().click();
    await page.waitForURL("**/games", { timeout: 5_000 });
    expect(page.url()).toContain("/games");
  });

  test("Navigate to Blog Posts", async ({ page }) => {
    const ok = await loginAsAdmin(page);
    if (!ok) {
      test.skip(true, "Fresh install");
      return;
    }

    await page.locator("aside").locator("text=Blog Posts").click();
    await page.waitForURL("**/posts", { timeout: 5_000 });
    expect(page.url()).toContain("/posts");
  });

  test("Navigate to Media Library", async ({ page }) => {
    const ok = await loginAsAdmin(page);
    if (!ok) {
      test.skip(true, "Fresh install");
      return;
    }

    await page.locator("aside").locator("text=Media Library").click();
    await page.waitForURL("**/media", { timeout: 5_000 });
    expect(page.url()).toContain("/media");
  });

  test("Navigate to Data Sets", async ({ page }) => {
    const ok = await loginAsAdmin(page);
    if (!ok) {
      test.skip(true, "Fresh install");
      return;
    }

    await page.locator("aside").locator("text=Data Sets").click();
    await page.waitForURL("**/datasets", { timeout: 5_000 });
    expect(page.url()).toContain("/datasets");
  });

  test("Navigate to Modules", async ({ page }) => {
    const ok = await loginAsAdmin(page);
    if (!ok) {
      test.skip(true, "Fresh install");
      return;
    }

    await page.locator("aside").locator("text=Modules").click();
    await page.waitForURL("**/modules", { timeout: 5_000 });
    expect(page.url()).toContain("/modules");
  });

  test("Navigate to Settings", async ({ page }) => {
    const ok = await loginAsAdmin(page);
    if (!ok) {
      test.skip(true, "Fresh install");
      return;
    }

    await page.locator("aside").locator("text=Settings").click();
    await page.waitForURL("**/settings", { timeout: 5_000 });
    expect(page.url()).toContain("/settings");
  });

  test("Sidebar collapse/expand", async ({ page }) => {
    const ok = await loginAsAdmin(page);
    if (!ok) {
      test.skip(true, "Fresh install");
      return;
    }

    const sidebar = page.locator("aside");

    // Labels visible initially
    await expect(sidebar.locator("text=Dashboard")).toBeVisible();

    // Click Collapse button
    await sidebar.locator("text=Collapse").click();
    await page.waitForTimeout(500);

    // Sidebar should be narrow (w-16 = 64px)
    const width = await sidebar.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThan(100);

    // Labels hidden
    await expect(sidebar.locator("text=Dashboard")).not.toBeVisible();

    // Click expand — the button is still there as an icon
    // PanelLeftOpen icon button at bottom of sidebar
    const expandBtn = sidebar.locator("button").last();
    await expandBtn.click();
    await page.waitForTimeout(500);

    // Labels visible again
    await expect(sidebar.locator("text=Dashboard")).toBeVisible();
  });

  test("Dashboard loads with welcome message", async ({ page }) => {
    const ok = await loginAsAdmin(page);
    if (!ok) {
      test.skip(true, "Fresh install");
      return;
    }

    await expect(page.locator("text=Welcome back")).toBeVisible();
    await expect(page.locator("text=API Connected")).toBeVisible();
  });
});
