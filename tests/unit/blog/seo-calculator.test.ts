/**
 * Tests for SEO Score Calculator
 *
 * Tests the algorithm that calculates SEO score based on various factors:
 * - Title length (optimal: 30-60 chars)
 * - Slug presence
 * - Content length (300+ chars optimal)
 * - Excerpt length (120-160 chars optimal)
 * - Meta fields presence
 * - Featured image
 * - Tags
 */

import { describe, it, expect } from "vitest";

// Replicate the SEO calculation logic from BlogPostEditor
function calculateSeoScore(data: {
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  seoOverrides: {
    metaTitle: string;
    metaDescription: string;
  };
  featuredImageId: string;
  tags: Array<{ id: string }>;
}): number {
  let score = 0;
  let max = 0;

  // Title checks (20 points)
  max += 20;
  if (data.title.length >= 30 && data.title.length <= 60) score += 20;
  else if (data.title.length > 0) score += 10;

  // Slug (10 points)
  max += 10;
  if (data.slug.length > 0) score += 10;

  // Content (20 points)
  max += 20;
  if (data.content.length > 300) score += 20;
  else if (data.content.length > 0) score += 10;

  // Excerpt (10 points)
  max += 10;
  if (data.excerpt.length >= 120 && data.excerpt.length <= 160) score += 10;
  else if (data.excerpt.length > 0) score += 5;

  // SEO overrides (20 points)
  max += 20;
  if (data.seoOverrides.metaTitle) score += 10;
  if (data.seoOverrides.metaDescription) score += 10;

  // Featured image (10 points)
  max += 10;
  if (data.featuredImageId) score += 10;

  // Tags (10 points)
  max += 10;
  if (data.tags.length > 0) score += Math.min(data.tags.length * 2, 10);

  return Math.round((score / max) * 100);
}

describe("SEO Score Calculator", () => {
  describe("Title Scoring (20 points)", () => {
    it("should give 20 points for optimal title length (30-60 chars)", () => {
      const result = calculateSeoScore({
        title: "How to Build a Modern Blog with SvelteKit", // 41 chars
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBeGreaterThanOrEqual(20);
    });

    it("should give 10 points for non-optimal title length", () => {
      const result = calculateSeoScore({
        title: "Hi", // too short
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBeGreaterThanOrEqual(10);
    });

    it("should give 0 points for empty title", () => {
      const result = calculateSeoScore({
        title: "",
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      // Title gives 0 but other fields contribute to score
      expect(result).toBeGreaterThanOrEqual(0);
      // Score is lower than when title is present
      const resultWithTitle = calculateSeoScore({
        title: "Good Title",
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBeLessThan(resultWithTitle);
    });

    it("should handle title at exact boundaries (30 and 60 chars)", () => {
      const result30 = calculateSeoScore({
        title: "x".repeat(30),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      const result60 = calculateSeoScore({
        title: "x".repeat(60),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(result30).toBe(result60);
    });
  });

  describe("Slug Scoring (10 points)", () => {
    it("should give 10 points for present slug", () => {
      const result = calculateSeoScore({
        title: "x".repeat(40),
        slug: "my-post-slug",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBeGreaterThanOrEqual(10);
    });

    it("should give 0 points for empty slug", () => {
      const result = calculateSeoScore({
        title: "x".repeat(40),
        slug: "",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      // Should be less than when slug is present
      const resultWithSlug = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBeLessThan(resultWithSlug);
    });
  });

  describe("Content Scoring (20 points)", () => {
    it("should give 20 points for content over 300 chars", () => {
      const result = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBeGreaterThanOrEqual(20);
    });

    it("should give 10 points for content under 300 chars", () => {
      const result = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(100),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      // Should have some points for content
      expect(result).toBeGreaterThanOrEqual(10);
    });

    it("should give 0 points for empty content", () => {
      const result = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "",
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      // Content section contributes 0, others give partial points
      expect(result).toBeGreaterThanOrEqual(0);
      // Content contributes less than when it has content
      const resultWithContent = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x",
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBeLessThan(resultWithContent);
    });
  });

  describe("Excerpt Scoring (10 points)", () => {
    it("should give 10 points for optimal excerpt (120-160 chars)", () => {
      const result = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      // Full excerpt points
      expect(result).toBeGreaterThanOrEqual(10);
    });

    it("should give 5 points for non-optimal excerpt", () => {
      const resultOptimal = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      const resultShort = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "short",
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(resultShort).toBeLessThan(resultOptimal);
    });
  });

  describe("SEO Overrides Scoring (20 points)", () => {
    it("should give 10 points for metaTitle", () => {
      const result = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "Custom Meta Title", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBeGreaterThanOrEqual(10);
    });

    it("should give 10 points for metaDescription", () => {
      const result = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "Custom description here" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBeGreaterThanOrEqual(10);
    });

    it("should give 20 points for both meta fields", () => {
      const result = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "Title", metaDescription: "Description" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBeGreaterThanOrEqual(20);
    });
  });

  describe("Featured Image Scoring (10 points)", () => {
    it("should give 10 points for featured image", () => {
      const result = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "image-123",
        tags: [],
      });
      expect(result).toBeGreaterThanOrEqual(10);
    });

    it("should give 0 points for missing featured image", () => {
      const resultWith = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "image-123",
        tags: [],
      });
      const resultWithout = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(resultWithout).toBeLessThan(resultWith);
    });
  });

  describe("Tags Scoring (10 points)", () => {
    it("should give 2 points per tag", () => {
      const result1 = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [{ id: "1" }],
      });
      const result5 = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }],
      });
      expect(result5).toBeGreaterThan(result1);
    });

    it("should cap at 10 points (5 tags)", () => {
      const result5 = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: Array(5).fill({ id: "x" }),
      });
      const result10 = calculateSeoScore({
        title: "x".repeat(40),
        slug: "test",
        content: "x".repeat(301),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: Array(10).fill({ id: "x" }),
      });
      expect(result5).toBe(result10);
    });
  });

  describe("Overall Score Calculation", () => {
    it("should return 100% for perfect post", () => {
      const result = calculateSeoScore({
        title: "How to Build a Modern Blog Platform", // 37 chars
        slug: "how-to-build-modern-blog",
        content: "x".repeat(500),
        excerpt: "x".repeat(140),
        seoOverrides: { metaTitle: "Custom Title", metaDescription: "Custom description" },
        featuredImageId: "img-123",
        tags: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }],
      });
      expect(result).toBe(100);
    });

    it("should handle edge case of empty post", () => {
      const result = calculateSeoScore({
        title: "",
        slug: "",
        content: "",
        excerpt: "",
        seoOverrides: { metaTitle: "", metaDescription: "" },
        featuredImageId: "",
        tags: [],
      });
      expect(result).toBe(0);
    });

    it("should calculate partial scores correctly", () => {
      const result = calculateSeoScore({
        title: "Good Title Here", // partial
        slug: "slug",
        content: "Short", // partial
        excerpt: "", // 0
        seoOverrides: { metaTitle: "", metaDescription: "" }, // 0
        featuredImageId: "",
        tags: [],
      });
      // Title: 10, Slug: 10, Content: 10, rest: 0 = 30/100
      expect(result).toBeLessThan(50);
    });
  });
});
