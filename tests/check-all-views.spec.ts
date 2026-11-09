import { test, expect } from "@playwright/test";

const ADMIN = process.env.ADMIN_URL || "http://localhost:5173";

const routesToTest = [
  "/",
  "/academy",
  "/booking",
  "/builder",
  "/collections",
  "/dashboard",
  "/data",
  "/datasets",
  "/directory",
  "/dms",
  "/editor",
  "/games",
  "/kitsuden-crm",
  "/kons",
  "/matches",
  "/mcp",
  "/media",
  "/platforms",
  "/players",
  "/posts",
  "/blog",
  "/grimoires",
  "/settings",
  "/streamers",
  "/tags",
  "/teams",
  "/tournaments",
  "/webhooks",
  "/workers",
  // Test some specific kon views (auto-detected)
  "/g/tags",
  "/g/games",
  "/g/blog",
  "/g/academy",
];

test.describe("Test all views for 404/500", () => {
  test.setTimeout(120000); // 2 minutes for testing all routes

  test("Visit each view and check status", async ({ page }) => {
    // 1. Log in to the admin panel
    await page.goto(ADMIN);

    await page.waitForURL(/\/(login|setup|)$/, { timeout: 15_000 });

    if (page.url().includes("/setup")) {
      await page.waitForSelector('input[type="text"]', { timeout: 20000 });
      await page.locator('input[type="text"]').fill("Admin ViewTester");
      await page.locator('input[type="email"]').fill("tester@kitsuden.gg");
      await page.locator('input[type="password"]').fill("kitsuden123");
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/$/, { timeout: 20_000 });
    } else if (page.url().includes("/login")) {
      // Try default admin credentials
      await page.waitForSelector('input[type="email"]');
      await page.locator('input[type="email"]').fill("admin@kitsuden.gg");
      await page.locator('input[type="password"]').fill("kitsuden123");
      await page.locator('button[type="submit"]').click();

      try {
        await page.waitForURL(/\/$/, { timeout: 15_000 });
      } catch (e) {
        // Try testing admin if default fails
        await page.locator('input[type="email"]').fill("tester@kitsuden.gg");
        await page.locator('button[type="submit"]').click();
        await page.waitForURL(/\/$/, { timeout: 15_000 });
      }
    }

    const failedRoutes: { route: string; status: number }[] = [];

    // 2. Iterate through routes and check responses
    for (const route of routesToTest) {
      const url = `${ADMIN}${route}`;
      console.log(`Testing route: ${url}`);

      // We use page.goto and look at the response status.
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });

      if (response) {
        const status = response.status();
        console.log(`Route ${route} returned status: ${status}`);

        // Track 404s and 500s
        if (status === 404 || status >= 500) {
          failedRoutes.push({ route, status });
        }

        // Sometimes frontend routing causes 404s to visually display a 'Not Found' text
        // in the body while the HTTP status might be 200 for SPAs. Let's check the body text too.
        const bodyText = await page.locator("body").innerText();
        if (bodyText.includes("404") && bodyText.toLowerCase().includes("not found")) {
          console.log(`Route ${route} shows 404 Not Found text visually.`);
          // We only add if it's not already tracked
          if (!failedRoutes.find((r) => r.route === route)) {
            failedRoutes.push({ route, status: 404 });
          }
        }
      } else {
        console.log(`Failed to get response for ${route}`);
      }

      // Add a small delay so we don't overwhelm the dev server
      await page.waitForTimeout(500);
    }

    // 3. Report failures
    if (failedRoutes.length > 0) {
      console.error("The following routes failed:", failedRoutes);
    }

    expect(
      failedRoutes.length,
      `Expected 0 failing routes, but found ${failedRoutes.length}: ${JSON.stringify(failedRoutes)}`
    ).toBe(0);
  });
});
