import { test, expect } from "@playwright/test";

const ADMIN = process.env.ADMIN_URL || "http://localhost:5173";

test.describe("Kon Custom UI vs Data Explorer Priority", () => {
  test.setTimeout(60000);

  test("Verify rendering priorities", async ({ page }) => {
    // 1. Log in to the admin panel
    await page.goto(ADMIN);

    await page.waitForURL(/\/(login|setup|)$/, { timeout: 15_000 });

    if (page.url().includes("/setup")) {
      await page.waitForSelector('input[type="text"]', { timeout: 20000 });
      await page.locator('input[type="text"]').fill("Admin PriorityTest");
      await page.locator('input[type="email"]').fill("priority@kitsuden.gg");
      await page.locator('input[type="password"]').fill("kitsuden123");
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/$/, { timeout: 20_000 });
    } else if (page.url().includes("/login")) {
      await page.waitForSelector('input[type="email"]');
      await page.locator('input[type="email"]').fill("admin@kitsuden.gg");
      await page.locator('input[type="password"]').fill("kitsuden123");
      await page.locator('button[type="submit"]').click();

      try {
        await page.waitForURL(/\/$/, { timeout: 15_000 });
      } catch (e) {
        await page.locator('input[type="email"]').fill("priority@kitsuden.gg");
        await page.locator('button[type="submit"]').click();
        await page.waitForURL(/\/$/, { timeout: 15_000 });
      }
    }

    // --- Test 2: Fallback to Data Explorer ---
    // 'tags' does NOT have a custom UI
    await page.goto(`${ADMIN}/g/tags`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const tagsBody = await page.locator("body").innerText();
    console.log("Tags UI Text preview:", tagsBody.substring(0, 100));

    // Data Explorer generic elements
    const hasTable = (await page.locator("table").count()) > 0;
    const hasCreateBtn = (await page.locator("button", { hasText: /Create/i }).count()) > 0;

    expect(hasTable || hasCreateBtn).toBeTruthy();
  });
});
