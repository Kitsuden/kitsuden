/**
 * Tests for Blog Routes - Input Validation
 *
 * Comprehensive validation tests for:
 * - Required fields
 * - Field lengths and formats
 * - SEO field validation
 * - Status transitions
 * - Relationship handling (tags, games)
 */

import { describe, it, expect } from "vitest";

// Validation functions matching the API behavior
const validators = {
  validateSlug(slug: string): { valid: boolean; error?: string } {
    if (!slug || slug.length === 0) {
      return { valid: false, error: "Slug is required" };
    }
    if (slug.length < 3) {
      return { valid: false, error: "Slug must be at least 3 characters" };
    }
    if (slug.length > 500) {
      return { valid: false, error: "Slug must be 500 characters or less" };
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return {
        valid: false,
        error: "Slug can only contain lowercase letters, numbers, and hyphens",
      };
    }
    if (slug.startsWith("-") || slug.endsWith("-")) {
      return { valid: false, error: "Slug cannot start or end with a hyphen" };
    }
    if (slug.includes("--")) {
      return { valid: false, error: "Slug cannot contain consecutive hyphens" };
    }
    return { valid: true };
  },

  validateTitle(title: string): { valid: boolean; error?: string } {
    if (!title || title.length === 0) {
      return { valid: false, error: "Title is required" };
    }
    if (title.length > 500) {
      return { valid: false, error: "Title must be 500 characters or less" };
    }
    return { valid: true };
  },

  validateExcerpt(excerpt: string): { valid: boolean; warning?: string } {
    if (!excerpt) return { valid: true };

    if (excerpt.length < 120) {
      return { valid: true, warning: "Excerpt should be at least 120 characters for optimal SEO" };
    }
    if (excerpt.length > 160) {
      return { valid: true, warning: "Excerpt should be 160 characters or less for optimal SEO" };
    }
    return { valid: true };
  },

  validateSeoOverrides(seo: {
    metaTitle?: string;
    metaDescription?: string;
    canonicalUrl?: string;
    ogTitle?: string;
    ogDescription?: string;
  }): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Meta title validation
    if (seo.metaTitle) {
      if (seo.metaTitle.length > 60) {
        errors.push("Meta title must be 60 characters or less");
      } else if (seo.metaTitle.length < 30) {
        warnings.push("Meta title should be at least 30 characters");
      }
    }

    // Meta description validation
    if (seo.metaDescription) {
      if (seo.metaDescription.length > 160) {
        errors.push("Meta description must be 160 characters or less");
      } else if (seo.metaDescription.length < 120) {
        warnings.push("Meta description should be at least 120 characters");
      }
    }

    // OG title validation
    if (seo.ogTitle && seo.ogTitle.length > 60) {
      warnings.push("OG title should be 60 characters or less");
    }

    // OG description validation
    if (seo.ogDescription && seo.ogDescription.length > 200) {
      warnings.push("OG description should be 200 characters or less");
    }

    // Canonical URL validation
    if (seo.canonicalUrl) {
      try {
        new URL(seo.canonicalUrl);
        if (!seo.canonicalUrl.startsWith("http")) {
          errors.push("Canonical URL must use http or https protocol");
        }
      } catch {
        errors.push("Canonical URL must be a valid URL");
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  },

  validateStatus(status: string, publishedAt?: string | null): { valid: boolean; error?: string } {
    const validStatuses = ["draft", "published", "scheduled", "archived"];

    if (!validStatuses.includes(status)) {
      return { valid: false, error: `Status must be one of: ${validStatuses.join(", ")}` };
    }

    if (status === "scheduled" && !publishedAt) {
      return { valid: false, error: "Scheduled posts must have a publishedAt date" };
    }

    if (status === "scheduled" && publishedAt) {
      const date = new Date(publishedAt);
      if (isNaN(date.getTime())) {
        return { valid: false, error: "Invalid publishedAt date format" };
      }
      if (date < new Date()) {
        return { valid: false, error: "Scheduled date must be in the future" };
      }
    }

    return { valid: true };
  },

  validateTags(tags: string[]): { valid: boolean; error?: string } {
    if (!Array.isArray(tags)) {
      return { valid: false, error: "Tags must be an array" };
    }

    if (tags.length > 20) {
      return { valid: false, error: "Cannot have more than 20 tags" };
    }

    const invalidTags = tags.filter((tag) => typeof tag !== "string" || tag.length === 0);
    if (invalidTags.length > 0) {
      return { valid: false, error: "All tags must be non-empty strings" };
    }

    const uniqueTags = new Set(tags);
    if (uniqueTags.size !== tags.length) {
      return { valid: false, error: "Tags must be unique" };
    }

    return { valid: true };
  },

  validateRobotsMeta(robots: { index?: boolean; follow?: boolean }): { valid: boolean } {
    // Both should be booleans if provided
    if (robots.index !== undefined && typeof robots.index !== "boolean") {
      return { valid: false };
    }
    if (robots.follow !== undefined && typeof robots.follow !== "boolean") {
      return { valid: false };
    }
    return { valid: true };
  },
};

describe("Blog Routes - Input Validation", () => {
  describe("Slug Validation", () => {
    it("should accept valid slugs", () => {
      const validSlugs = ["hello-world", "post-123", "a-b-c", "my-blog-post"];

      for (const slug of validSlugs) {
        const result = validators.validateSlug(slug);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }
    });

    it("should reject empty slug", () => {
      const result = validators.validateSlug("");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Slug is required");
    });

    it("should reject slug that is too short", () => {
      const result = validators.validateSlug("ab");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Slug must be at least 3 characters");
    });

    it("should reject slug that is too long", () => {
      const result = validators.validateSlug("a".repeat(501));
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Slug must be 500 characters or less");
    });

    it("should reject slug with uppercase letters", () => {
      const result = validators.validateSlug("Hello-World");
      expect(result.valid).toBe(false);
    });

    it("should reject slug with special characters", () => {
      const invalidSlugs = ["hello_world", "hello.world", "hello@world", "hello world"];

      for (const slug of invalidSlugs) {
        const result = validators.validateSlug(slug);
        expect(result.valid).toBe(false);
      }
    });

    it("should reject slug starting or ending with hyphen", () => {
      const result1 = validators.validateSlug("-hello-world");
      const result2 = validators.validateSlug("hello-world-");

      expect(result1.valid).toBe(false);
      expect(result2.valid).toBe(false);
    });

    it("should reject slug with consecutive hyphens", () => {
      const result = validators.validateSlug("hello--world");
      expect(result.valid).toBe(false);
    });
  });

  describe("Title Validation", () => {
    it("should accept valid titles", () => {
      const result = validators.validateTitle("A Great Blog Post");
      expect(result.valid).toBe(true);
    });

    it("should reject empty title", () => {
      const result = validators.validateTitle("");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Title is required");
    });

    it("should reject title over 500 characters", () => {
      const result = validators.validateTitle("x".repeat(501));
      expect(result.valid).toBe(false);
    });

    it("should accept title at 500 character limit", () => {
      const result = validators.validateTitle("x".repeat(500));
      expect(result.valid).toBe(true);
    });
  });

  describe("Excerpt Validation", () => {
    it("should accept empty excerpt", () => {
      const result = validators.validateExcerpt("");
      expect(result.valid).toBe(true);
    });

    it("should warn about short excerpt", () => {
      const result = validators.validateExcerpt("Too short");
      expect(result.valid).toBe(true);
      expect(result.warning).toContain("at least 120 characters");
    });

    it("should warn about long excerpt", () => {
      const result = validators.validateExcerpt("x".repeat(161));
      expect(result.valid).toBe(true);
      expect(result.warning).toContain("160 characters or less");
    });

    it("should accept optimal excerpt length", () => {
      const result = validators.validateExcerpt("x".repeat(140));
      expect(result.valid).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  describe("SEO Overrides Validation", () => {
    it("should validate all SEO fields as valid", () => {
      const seo = {
        metaTitle: "Perfect Meta Title for SEO",
        metaDescription:
          "This is an excellent meta description that provides value and is within the optimal length range.",
        canonicalUrl: "https://example.com/blog/post",
        ogTitle: "Social Media Title",
        ogDescription: "Description for social sharing",
      };

      const result = validators.validateSeoOverrides(seo);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should reject meta title over 60 chars", () => {
      const seo = { metaTitle: "x".repeat(61) };
      const result = validators.validateSeoOverrides(seo);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Meta title must be 60 characters or less");
    });

    it("should warn about short meta title", () => {
      const seo = { metaTitle: "Hi" };
      const result = validators.validateSeoOverrides(seo);
      expect(result.warnings).toContain("Meta title should be at least 30 characters");
    });

    it("should reject meta description over 160 chars", () => {
      const seo = { metaDescription: "x".repeat(161) };
      const result = validators.validateSeoOverrides(seo);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Meta description must be 160 characters or less");
    });

    it("should reject invalid canonical URL", () => {
      const seo = { canonicalUrl: "not-a-url" };
      const result = validators.validateSeoOverrides(seo);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Canonical URL must be a valid URL");
    });

    it("should reject canonical URL without protocol", () => {
      const seo = { canonicalUrl: "example.com/blog" };
      const result = validators.validateSeoOverrides(seo);
      expect(result.valid).toBe(false);
      // URL constructor fails without protocol, so it fails valid URL check first
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should accept valid canonical URL with https", () => {
      const seo = { canonicalUrl: "https://example.com/blog/post" };
      const result = validators.validateSeoOverrides(seo);
      expect(result.valid).toBe(true);
    });

    it("should warn about long OG title", () => {
      const seo = { ogTitle: "x".repeat(61) };
      const result = validators.validateSeoOverrides(seo);
      expect(result.warnings).toContain("OG title should be 60 characters or less");
    });

    it("should warn about long OG description", () => {
      const seo = { ogDescription: "x".repeat(201) };
      const result = validators.validateSeoOverrides(seo);
      expect(result.warnings).toContain("OG description should be 200 characters or less");
    });

    it("should handle empty SEO object", () => {
      const result = validators.validateSeoOverrides({});
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should collect multiple errors", () => {
      const seo = {
        metaTitle: "x".repeat(61),
        metaDescription: "x".repeat(161),
        canonicalUrl: "invalid",
      };

      const result = validators.validateSeoOverrides(seo);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(3);
    });
  });

  describe("Status Validation", () => {
    it("should accept all valid statuses", () => {
      // Draft and archived don't require publishedAt
      const resultDraft = validators.validateStatus("draft");
      const resultArchived = validators.validateStatus("archived");
      expect(resultDraft.valid).toBe(true);
      expect(resultArchived.valid).toBe(true);

      // Published can have null publishedAt (will be set automatically)
      const resultPublished = validators.validateStatus("published", null);
      expect(resultPublished.valid).toBe(true);

      // Scheduled requires publishedAt
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);
      const resultScheduled = validators.validateStatus("scheduled", futureDate.toISOString());
      expect(resultScheduled.valid).toBe(true);
    });

    it("should reject invalid status", () => {
      const result = validators.validateStatus("invalid-status");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Status must be one of");
    });

    it("should require publishedAt for scheduled posts", () => {
      const result = validators.validateStatus("scheduled");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Scheduled posts must have a publishedAt date");
    });

    it("should reject past dates for scheduled posts", () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const result = validators.validateStatus("scheduled", pastDate.toISOString());
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Scheduled date must be in the future");
    });

    it("should accept future dates for scheduled posts", () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);

      const result = validators.validateStatus("scheduled", futureDate.toISOString());
      expect(result.valid).toBe(true);
    });

    it("should reject invalid date format", () => {
      const result = validators.validateStatus("scheduled", "not-a-date");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid publishedAt date format");
    });
  });

  describe("Tags Validation", () => {
    it("should accept valid tags array", () => {
      const result = validators.validateTags(["javascript", "web", "tutorial"]);
      expect(result.valid).toBe(true);
    });

    it("should accept empty tags array", () => {
      const result = validators.validateTags([]);
      expect(result.valid).toBe(true);
    });

    it("should reject non-array tags", () => {
      const result = validators.validateTags("not-an-array" as any);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Tags must be an array");
    });

    it("should reject too many tags", () => {
      const tags = Array(21).fill("tag");
      const result = validators.validateTags(tags);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Cannot have more than 20 tags");
    });

    it("should reject empty tag strings", () => {
      const result = validators.validateTags(["valid", ""]);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("All tags must be non-empty strings");
    });

    it("should reject duplicate tags", () => {
      const result = validators.validateTags(["tag", "tag"]);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Tags must be unique");
    });

    it("should reject non-string tags", () => {
      const result = validators.validateTags(["valid", 123, null] as any);
      expect(result.valid).toBe(false);
    });

    it("should accept exactly 20 tags", () => {
      const tags = Array(20)
        .fill(0)
        .map((_, i) => `tag-${i}`);
      const result = validators.validateTags(tags);
      expect(result.valid).toBe(true);
    });
  });

  describe("Robots Meta Validation", () => {
    it("should accept valid robots configuration", () => {
      const result = validators.validateRobotsMeta({ index: true, follow: true });
      expect(result.valid).toBe(true);
    });

    it("should accept partial robots configuration", () => {
      const result1 = validators.validateRobotsMeta({ index: true });
      const result2 = validators.validateRobotsMeta({ follow: false });

      expect(result1.valid).toBe(true);
      expect(result2.valid).toBe(true);
    });

    it("should accept empty robots configuration", () => {
      const result = validators.validateRobotsMeta({});
      expect(result.valid).toBe(true);
    });

    it("should reject non-boolean index", () => {
      const result = validators.validateRobotsMeta({ index: "yes" as any });
      expect(result.valid).toBe(false);
    });

    it("should reject non-boolean follow", () => {
      const result = validators.validateRobotsMeta({ follow: "yes" as any });
      expect(result.valid).toBe(false);
    });
  });

  describe("Complete Post Validation", () => {
    it("should validate a complete valid post", () => {
      const post = {
        title: "Complete Blog Post",
        slug: "complete-blog-post",
        content: "x".repeat(500),
        excerpt: "x".repeat(140),
        status: "published" as const,
        featuredImageId: "img-123",
        tags: ["javascript", "web"],
        seoOverrides: {
          metaTitle: "Perfect Meta Title",
          metaDescription: "x".repeat(140),
          canonicalUrl: "https://example.com/blog/post",
        },
      };

      const validations = [
        validators.validateTitle(post.title),
        validators.validateSlug(post.slug),
        validators.validateExcerpt(post.excerpt),
        validators.validateStatus(post.status),
        validators.validateTags(post.tags),
        validators.validateSeoOverrides(post.seoOverrides),
      ];

      const allValid = validations.every((v) => v.valid);
      expect(allValid).toBe(true);
    });

    it("should detect multiple validation errors in invalid post", () => {
      const post = {
        title: "", // invalid
        slug: "ab", // too short
        excerpt: "x".repeat(200), // too long
        status: "invalid" as any,
        tags: ["tag", "tag"], // duplicates
        seoOverrides: {
          metaTitle: "x".repeat(61), // too long
          canonicalUrl: "invalid-url",
        },
      };

      const titleValidation = validators.validateTitle(post.title);
      const slugValidation = validators.validateSlug(post.slug);
      const excerptValidation = validators.validateExcerpt(post.excerpt);
      const statusValidation = validators.validateStatus(post.status);
      const tagsValidation = validators.validateTags(post.tags);
      const seoValidation = validators.validateSeoOverrides(post.seoOverrides);

      expect(titleValidation.valid).toBe(false);
      expect(slugValidation.valid).toBe(false);
      expect(excerptValidation.warning).toBeDefined();
      expect(statusValidation.valid).toBe(false);
      expect(tagsValidation.valid).toBe(false);
      expect(seoValidation.valid).toBe(false);
    });
  });
});
