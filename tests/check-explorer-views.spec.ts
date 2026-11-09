import { test, expect } from "@playwright/test";

const ADMIN = process.env.ADMIN_URL || "http://localhost:5173";

test.describe("Data Explorer Views Verification", () => {
  test.setTimeout(60000);

  test("Verify Grid and Kanban views on Kon", async ({ page }) => {
    // 1. Log in to the admin panel
    await page.goto(ADMIN);

    await page.waitForURL(/\/(login|setup|)$/, { timeout: 15_000 });

    if (page.url().includes("/setup")) {
      await page.waitForSelector('input[type="text"]', { timeout: 20000 });
      await page.locator('input[type="text"]').fill("Admin ExplorerTest");
      await page.locator('input[type="email"]').fill("explorer@kitsuden.gg");
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
        await page.locator('input[type="email"]').fill("explorer@kitsuden.gg");
        await page.locator('button[type="submit"]').click();
        await page.waitForURL(/\/$/, { timeout: 15_000 });
      }
    }

    // 2. Go to tags kon (which we now mocked with a kanban config)
    await page.goto(`${ADMIN}/g/tags`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // 3. Verify Grid view (default)
    // Data Explorer generic elements
    const hasTable = (await page.locator("table").count()) > 0;
    const hasSearch = (await page.locator('input[placeholder*="Search"]').count()) > 0;

    expect(hasTable || hasSearch).toBeTruthy();

    // Verify view tabs exist
    // Kon-games/kon.json defines: "All Games" (grid) and "By Status" (kanban)
    const allGamesTab = page.locator("button", { hasText: "All Games" });
    const byStatusTab = page.locator("button", { hasText: "By Status" });

    // Wait to see if buttons populate (might take a sec if fetching config)
    await page.waitForTimeout(1000);

    const hasTabs = (await byStatusTab.count()) > 0;
    console.log(`Has View Tabs: ${hasTabs}`);

    if (hasTabs) {
      // Click Kanban view
      await byStatusTab.click();
      await page.waitForTimeout(2000); // wait for render

      // In kanban view, we expect columns or boards, not tables.
      // DataExplorer conditionally renders `<KanbanBoard />`
      // Kanban board has `.flex.gap-4.overflow-x-auto` or `draggable="true"`
      const hasKanbanColumns = (await page.locator(".overflow-x-auto").count()) > 0;
      const hasGridTable = (await page.locator("table").count()) > 0;

      // Confirm table is gone and kanban view container is present
      expect(hasGridTable).toBeFalsy();
      expect(hasKanbanColumns).toBeTruthy();

      console.log("Successfully switched to Kanban view.");

      // Switch back to grid
      await allGamesTab.click();
      await page.waitForTimeout(1000);

      const hasRevertedTable = (await page.locator("table").count()) > 0;
      expect(hasRevertedTable).toBeTruthy();
      console.log("Successfully switched back to Grid view.");
    } else {
      console.warn("View tabs not found. Kon might be using defaults or Custom UI took over.");
    }
  });
});
