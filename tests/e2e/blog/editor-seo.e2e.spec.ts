/**
 * E2E Tests for Blog Editor - SEO Features
 *
 * Tests the complete user flow:
 * 1. Navigate to blog editor
 * 2. Fill all content fields
 * 3. Configure SEO settings
 * 4. Verify previews
 * 5. Save post
 * 6. Verify data persistence
 */

import { test, expect, Page } from "@playwright/test";

// Helper functions
async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.fill('input[type="email"]', "admin@example.com");
  await page.fill('input[type="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL("/");
}

async function navigateToNewPost(page: Page) {
  await page.goto("/posts");
  await page.click("text=New Post");
  await page.waitForSelector("text=New Post");
}

async function fillContentTab(page: Page) {
  // Fill title
  await page.fill(
    '[placeholder="Enter an engaging title..."]',
    "How to Build a Modern Blog with SvelteKit"
  );

  // Wait for slug auto-generation
  await page.waitForTimeout(500);

  // Fill excerpt
  await page.fill(
    '[placeholder="Brief summary of your post..."]',
    "Learn how to build a modern, SEO-friendly blog using SvelteKit and the latest web technologies."
  );

  // Fill content in MDX editor
  await page.fill(
    ".cm-content",
    `# Building a Modern Blog

This is a comprehensive guide to building blogs with SvelteKit.

## Why SvelteKit?

SvelteKit offers excellent performance and developer experience.

## Getting Started

First, create a new project...`
  );
}

async function addTags(page: Page) {
  await page.click("text=Add Tags");
  await page.waitForSelector("text=Manage Tags");

  // Create new tag
  await page.fill('[placeholder="New tag name..."]', "svelte");
  await page.click('button:has([data-lucide="plus"])');

  // Select existing tag if available
  const tagButton = page.locator("button", { hasText: /svelte|javascript|web/i }).first();
  if (await tagButton.isVisible().catch(() => false)) {
    await tagButton.click();
  }

  // Close modal
  await page.keyboard.press("Escape");
}

async function configureSEO(page: Page) {
  // Navigate to SEO tab
  await page.click("text=SEO");
  await page.waitForSelector("text=SEO Settings");

  // Fill meta title
  await page.fill(
    '[placeholder*="SEO optimized title"]',
    "Build a Modern Blog with SvelteKit - Complete Guide"
  );

  // Fill meta description
  await page.fill(
    '[placeholder*="Compelling description"]',
    "Learn how to build a fast, SEO-friendly blog using SvelteKit. Step-by-step guide with code examples and best practices."
  );

  // Fill canonical URL
  await page.fill(
    '[placeholder*="https://yoursite.com"]',
    "https://example.com/blog/sveltekit-guide"
  );

  // Configure robots
  await page.check("text=Allow search engines to index this page");
  await page.check("text=Allow search engines to follow links");

  // Fill OG fields
  await page.fill('[placeholder*="OG Title"]', "Build a Modern Blog with SvelteKit 🚀");
  await page.fill(
    '[placeholder*="OG Description"]',
    "Complete step-by-step guide to building blogs with SvelteKit"
  );
}

async function verifyPreviews(page: Page) {
  // Check Google preview
  const googlePreview = page.locator("text=Google Search");
  await expect(googlePreview).toBeVisible();

  // Verify title appears in preview
  const previewTitle = page.locator(".text-\\[#1a0dab\\]");
  await expect(previewTitle).toContainText("Build a Modern Blog");

  // Check Social preview
  const socialPreview = page.locator("text=Social Share");
  await expect(socialPreview).toBeVisible();

  // Check SEO score
  const seoScore = page.locator("text=/\\d+%/");
  await expect(seoScore).toBeVisible();
}

async function savePost(page: Page) {
  await page.click("text=Save Post");
  await page.waitForURL("/posts");
}

test.describe("Blog Editor - SEO Features", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("should create a new post with all SEO fields", async ({ page }) => {
    await navigateToNewPost(page);

    // Content tab
    await fillContentTab(page);
    await addTags(page);

    // SEO tab
    await configureSEO(page);
    await verifyPreviews(page);

    // Save
    await savePost(page);

    // Verify post appears in list
    await expect(page.locator("text=How to Build a Modern Blog")).toBeVisible();
  });

  test("should validate SEO character limits", async ({ page }) => {
    await navigateToNewPost(page);
    await page.click("text=SEO");

    // Try to enter meta title over 60 chars
    const longTitle = "a".repeat(61);
    await page.fill('[placeholder*="SEO optimized title"]', longTitle);

    // Check counter shows red
    const counter = page.locator("text=/61\\/60/");
    await expect(counter).toHaveClass(/text-kitsuden-pink/);

    // Try to enter meta description over 160 chars
    const longDesc = "b".repeat(161);
    await page.fill('[placeholder*="Compelling description"]', longDesc);

    // Check counter shows red
    const descCounter = page.locator("text=/161\\/160/");
    await expect(descCounter).toHaveClass(/text-kitsuden-pink/);
  });

  test("should update SEO score in real-time", async ({ page }) => {
    await navigateToNewPost(page);

    // Initial score should be low
    const initialScore = await page.locator("text=/\\d+%/").textContent();
    expect(parseInt(initialScore || "0")).toBeLessThan(50);

    // Fill title
    await page.fill(
      '[placeholder="Enter an engaging title..."]',
      "Complete Guide to SvelteKit Development"
    );

    // Score should increase
    await page.waitForTimeout(500);
    const newScore = await page.locator("text=/\\d+%/").textContent();
    expect(parseInt(newScore || "0")).toBeGreaterThan(parseInt(initialScore || "0"));
  });

  test("should handle featured image selection", async ({ page }) => {
    await navigateToNewPost(page);

    // Click to select image
    await page.click("text=Click to select featured image");
    await page.waitForSelector("text=Select Featured Image");

    // Select first image (if available)
    const firstImage = page.locator(".grid img").first();
    if (await firstImage.isVisible().catch(() => false)) {
      await firstImage.click();

      // Verify image appears
      await expect(page.locator('img[alt="Featured"]')).toBeVisible();

      // Test remove image
      await page.click('button:has([data-lucide="x"])');
      await expect(page.locator("text=Click to select featured image")).toBeVisible();
    }
  });

  test("should schedule post for future publication", async ({ page }) => {
    await navigateToNewPost(page);

    // Fill required fields
    await page.fill('[placeholder="Enter an engaging title..."]', "Scheduled Post Test");

    // Change status to scheduled
    await page.selectOption("select", "scheduled");

    // Date picker should appear
    await expect(page.locator('input[type="datetime-local"]')).toBeVisible();

    // Set future date
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    const dateString = futureDate.toISOString().slice(0, 16);
    await page.fill('input[type="datetime-local"]', dateString);

    // Save
    await page.click("text=Save Post");
    await page.waitForURL("/posts");

    // Verify scheduled status
    await expect(page.locator("text=Scheduled")).toBeVisible();
  });

  test("should edit existing post and update SEO", async ({ page }) => {
    // First create a post
    await navigateToNewPost(page);
    await page.fill('[placeholder="Enter an engaging title..."]', "Original Title");
    await page.click("text=Save Post");
    await page.waitForURL("/posts");

    // Open post for editing
    await page.click("text=Original Title");
    await page.waitForSelector("text=Edit Post");

    // Update title
    await page.fill('[placeholder="Enter an engaging title..."]', "Updated SEO Title");

    // Go to SEO tab and update
    await page.click("text=SEO");
    await page.fill('[placeholder*="SEO optimized title"]', "Optimized Meta Title");

    // Save
    await page.click("text=Save Changes");
    await page.waitForURL("/posts");

    // Verify updated
    await expect(page.locator("text=Updated SEO Title")).toBeVisible();
  });

  test("should show SEO checklist with all items", async ({ page }) => {
    await navigateToNewPost(page);
    await page.click("text=SEO");

    // Check all checklist items are present
    const checklistItems = [
      "Title is set",
      "Title length optimal",
      "Slug is set",
      "Content has 300+ chars",
      "Excerpt is set",
      "Meta title optimized",
      "Meta description optimized",
      "Featured image selected",
      "Has at least one tag",
    ];

    for (const item of checklistItems) {
      await expect(page.locator(`text=${item}`)).toBeVisible();
    }
  });

  test("should handle tags creation and selection", async ({ page }) => {
    await navigateToNewPost(page);

    // Open tags modal
    await page.click("text=Add Tags");
    await page.waitForSelector("text=Manage Tags");

    // Create multiple tags
    const tags = ["javascript", "webdev", "tutorial"];
    for (const tag of tags) {
      await page.fill('[placeholder="New tag name..."]', tag);
      await page.click('button:has([data-lucide="plus"])');
      await page.waitForTimeout(200);
    }

    // Select tags
    for (const tag of tags) {
      await page.click(`button:has-text("${tag}")`);
    }

    // Close modal
    await page.keyboard.press("Escape");

    // Verify tags appear in sidebar
    for (const tag of tags) {
      await expect(page.locator(`text=${tag}`)).toBeVisible();
    }
  });

  test("should display correct robots meta configuration", async ({ page }) => {
    await navigateToNewPost(page);
    await page.click("text=SEO");

    // Default should be checked
    const indexCheckbox = page.locator('label:has-text("Allow search engines to index") input');
    const followCheckbox = page.locator('label:has-text("Allow search engines to follow") input');

    await expect(indexCheckbox).toBeChecked();
    await expect(followCheckbox).toBeChecked();

    // Uncheck them
    await indexCheckbox.uncheck();
    await followCheckbox.uncheck();

    await expect(indexCheckbox).not.toBeChecked();
    await expect(followCheckbox).not.toBeChecked();
  });
});
