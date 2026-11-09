// @ts-nocheck
import { test, expect } from "@playwright/test";

const ADMIN = process.env.ADMIN_URL || "http://localhost:5173";

test.describe("Data Explorer Isolated View Verification", () => {
  test.setTimeout(60000);

  test("Mock response for /api/admin/registry to test view rendering", async ({ page }) => {
    // Log in
    await page.goto(ADMIN);
    await page.waitForURL(/\/(login|setup|)$/, { timeout: 15_000 });

    if (page.url().includes("/setup")) {
      await page.waitForSelector('input[type="text"]', { timeout: 20000 });
      await page.locator('input[type="text"]').fill("Admin MockTest");
      await page.locator('input[type="email"]').fill("mock@kitsuden.gg");
      await page.locator('input[type="password"]').fill("kitsuden123");
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/$/, { timeout: 20_000 });
    } else if (page.url().includes("/login")) {
      await page.waitForSelector('input[type="email"]');
      await page.locator('input[type="email"]').fill("admin@kitsuden.gg");
      await page.locator('input[type="password"]').fill("kitsuden123");
      await page.locator('button[type="submit"]').click();

      // Wait for dashboard or successful login
      await page.waitForURL(/\/$/, { timeout: 15_000 });
    }

    // Wait to make sure we are fully loaded on dashboard
    await page.waitForTimeout(1000);

    // NOW Intercept the registry API to return our mock kon with Kanban and Calendar
    await page.route("**/api/admin/registry*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          total: 1,
          withCustomViews: 0,
          generatedAt: new Date().toISOString(),
          kons: [
            {
              id: "kon-mocktest",
              name: "MockTest",
              category: "system",
              hasCustomView: false,
              tables: [{ name: "mocktest", label: "MockTest" }],
              defaultView: "grid",
              views: [
                { id: "grid", type: "grid", title: "All Grid", table: "mocktest" },
                {
                  id: "kanban",
                  type: "kanban",
                  title: "Kanban Board",
                  table: "mocktest",
                  groupBy: "status",
                },
                {
                  id: "calendar",
                  type: "calendar",
                  title: "Calendar Mode",
                  table: "mocktest",
                  dateField: "created_at",
                  titleField: "name",
                },
              ],
            },
          ],
        }),
      });
    });

    // Intercept the schema and data endpoints to return mock grid data
    await page.route("**/api/explorer/mocktest*", async (route) => {
      const url = route.request().url();
      if (url.includes("/schema/json")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              status: { type: "string" },
              created_at: { type: "string", format: "date-time" },
            },
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: [
              { id: "1", name: "Mock 1", status: "Open", created_at: new Date().toISOString() },
              { id: "2", name: "Mock 2", status: "Closed", created_at: new Date().toISOString() },
            ],
            pagination: { total: 2 },
          }),
        });
      }
    });

    // Navigate to our mocked kon
    await page.goto(`${ADMIN}/g/kon-mocktest`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    // 1. GRID TEST
    const hasTable = (await page.locator("table").count()) > 0;
    const bodyText = await page.locator("body").innerText();
    console.log("Body text on Grid attempt:", bodyText.substring(0, 300));

    expect(await page.locator("table").count()).toBeGreaterThan(0);
    console.log("Grid View generated successfully.");

    // 2. KANBAN TEST
    const kanbanTab = page.locator("button", { hasText: "Kanban Board" });
    await kanbanTab.click();
    await page.waitForTimeout(1000);

    // DataExplorer conditionally renders `<KanbanBoard />` -> `.flex.gap-4.overflow-x-auto` or `draggable="true"`
    const hasKanbanColumns = await page.locator(".overflow-x-auto").count();
    expect(hasKanbanColumns).toBeGreaterThan(0);
    console.log("Kanban View rendered successfully with drag columns.");

    // 3. CALENDAR TEST
    const calendarTab = page.locator("button", { hasText: "Calendar Mode" });
    await calendarTab.click();
    await page.waitForTimeout(1000);

    // Calendar component renders week days like "Mon", "Tue" and chevron buttons
    const hasCalendarNav = await page.locator("button", { hasText: "Today" }).count();
    const hasDaysGrid = await page.locator("div.grid.grid-cols-7").count();
    expect(hasCalendarNav).toBeGreaterThan(0);
    expect(hasDaysGrid).toBeGreaterThan(0);
    console.log("Calendar View rendered successfully with day grids.");
  });
});
