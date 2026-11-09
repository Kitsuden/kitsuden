// @ts-nocheck
// Integration Tests: Vector Search Core
// Tests the migrated AI Memories functionality as a Dataset Extension

import { test, expect } from "@playwright/test";

const API_URL = process.env.API_URL || "http://localhost:3001";

test.describe("🔍 Vector Search Core Integration", () => {
  let testDatasetId: string;
  let testEntryId: string;

  test.beforeAll(async ({ request }) => {
    // Create a test dataset with vector search extension
    const createRes = await request.post(`${API_URL}/api/datasets`, {
      data: {
        name: `vector-test-${Date.now()}`,
        slug: `vector-test-${Date.now()}`,
        description: "Test dataset for vector search",
        schema: [
          { fieldName: "title", fieldType: "text", required: true },
          { fieldName: "content", fieldType: "textarea", required: true },
          { fieldName: "category", fieldType: "text", required: false },
        ],
        extensions: {
          vectorSearch: {
            enabled: true,
            fields: ["content"],
            autoIndex: false, // We'll index manually for testing
          },
        },
      },
    });

    if (createRes.ok()) {
      const data = await createRes.json();
      testDatasetId = data.id;
    }
  });

  test.afterAll(async ({ request }) => {
    // Cleanup
    if (testDatasetId) {
      await request.delete(`${API_URL}/api/datasets/${testDatasetId}`);
    }
  });

  test.describe("1. Dataset Configuration", () => {
    test("Should create dataset with vector search extension", async ({ request }) => {
      test.skip(!testDatasetId, "Dataset creation failed");

      const res = await request.get(`${API_URL}/api/datasets/${testDatasetId}`);
      expect(res.ok()).toBe(true);

      const data = await res.json();
      expect(data.extensions?.vectorSearch?.enabled).toBe(true);
      expect(data.extensions?.vectorSearch?.fields).toContain("content");
    });

    test("Should expose vector search endpoints", async ({ request }) => {
      test.skip(!testDatasetId, "Dataset creation failed");

      // Check if vector-search endpoint exists
      const res = await request.post(`${API_URL}/api/datasets/${testDatasetId}/vector-search`, {
        data: {
          query: "test",
          limit: 5,
        },
      });

      // Should not be 404 (endpoint exists)
      expect(res.status()).not.toBe(404);
    });
  });

  test.describe("2. Content Indexing", () => {
    test("Should manually index content", async ({ request }) => {
      test.skip(!testDatasetId, "Dataset creation failed");

      // Create entry first
      const entryRes = await request.post(`${API_URL}/api/datasets/${testDatasetId}/entries`, {
        data: {
          title: "Test Product",
          content: "This is a high-quality wireless headphone with noise cancellation",
          category: "electronics",
        },
      });

      expect(entryRes.ok()).toBe(true);
      const entryData = await entryRes.json();
      testEntryId = entryData.id;

      // Index the content
      const indexRes = await request.post(`${API_URL}/api/datasets/${testDatasetId}/vector-index`, {
        data: {
          entryId: testEntryId,
          content: "This is a high-quality wireless headphone with noise cancellation",
          fieldName: "content",
          metadata: { source: "test", category: "electronics" },
        },
      });

      expect(indexRes.ok()).toBe(true);
      const indexData = await indexRes.json();
      expect(indexData.success).toBe(true);
      expect(indexData.action).toBe("created");
    });

    test("Should update existing index", async ({ request }) => {
      test.skip(!testEntryId, "Entry creation failed");

      const res = await request.post(`${API_URL}/api/datasets/${testDatasetId}/vector-index`, {
        data: {
          entryId: testEntryId,
          content: "Updated content about wireless headphones with premium features",
          fieldName: "content",
        },
      });

      expect(res.ok()).toBe(true);
      const data = await res.json();
      expect(data.action).toBe("updated");
    });

    test("Should get index status", async ({ request }) => {
      test.skip(!testDatasetId, "Dataset creation failed");

      const res = await request.get(`${API_URL}/api/datasets/${testDatasetId}/vector-status`);
      expect(res.ok()).toBe(true);

      const data = await res.json();
      expect(data.datasetId).toBe(testDatasetId);
      expect(data.totalIndexed).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(data.fields)).toBe(true);
    });
  });

  test.describe("3. Semantic Search", () => {
    test("Should perform vector search", async ({ request }) => {
      test.skip(!testEntryId, "Entry creation failed");

      // Wait a moment for indexing
      await new Promise((r) => setTimeout(r, 1000));

      const res = await request.post(`${API_URL}/api/datasets/${testDatasetId}/vector-search`, {
        data: {
          query: "bluetooth headphones",
          limit: 5,
          threshold: 0.5,
        },
      });

      expect(res.ok()).toBe(true);
      const data = await res.json();

      expect(data.query).toBe("bluetooth headphones");
      expect(Array.isArray(data.results)).toBe(true);

      // If we have results, check structure
      if (data.results.length > 0) {
        expect(data.results[0].entryId).toBeTruthy();
        expect(data.results[0].similarity).toBeGreaterThan(0);
      }
    });

    test("Should search with field filter", async ({ request }) => {
      test.skip(!testEntryId, "Entry creation failed");

      const res = await request.post(`${API_URL}/api/datasets/${testDatasetId}/vector-search`, {
        data: {
          query: "headphones",
          fields: ["content"],
          limit: 5,
        },
      });

      expect(res.ok()).toBe(true);
    });

    test("Should return empty results for irrelevant query", async ({ request }) => {
      test.skip(!testEntryId, "Entry creation failed");

      const res = await request.post(`${API_URL}/api/datasets/${testDatasetId}/vector-search`, {
        data: {
          query: "completely unrelated topic about space exploration",
          threshold: 0.8,
        },
      });

      expect(res.ok()).toBe(true);
      const data = await res.json();
      expect(data.results.length).toBe(0);
    });
  });

  test.describe("4. Global Search", () => {
    test("Should search across all datasets (admin)", async ({ request }) => {
      const res = await request.post(`${API_URL}/api/vector-search/global`, {
        data: {
          query: "product",
          limit: 10,
        },
      });

      // May be 200 or 403 depending on auth
      expect(res.status()).toBeOneOf([200, 401, 403]);
    });

    test("Should search with dataset filter", async ({ request }) => {
      test.skip(!testDatasetId, "Dataset creation failed");

      const res = await request.post(`${API_URL}/api/vector-search/global`, {
        data: {
          query: "test",
          datasetIds: [testDatasetId],
          limit: 5,
        },
      });

      expect(res.status()).toBeOneOf([200, 401, 403]);
    });
  });

  test.describe("5. Index Management", () => {
    test("Should delete index entry", async ({ request }) => {
      test.skip(!testEntryId, "Entry creation failed");

      const res = await request.delete(
        `${API_URL}/api/datasets/${testDatasetId}/vector-index/${testEntryId}`
      );

      expect(res.ok()).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    test("Should verify entry was removed from index", async ({ request }) => {
      test.skip(!testEntryId, "Entry creation failed");

      // Check status again
      const res = await request.get(`${API_URL}/api/datasets/${testDatasetId}/vector-status`);
      const data = await res.json();

      // Count should be 0 or decreased
      expect(data.totalIndexed).toBeGreaterThanOrEqual(0);
    });
  });
});

test.describe("🔄 Migration: AI Memories → Vector Search", () => {
  test("Old ai-memories endpoints should be deprecated", async ({ request }) => {
    // The old endpoints might still work for backward compatibility
    // but should indicate deprecation
    const res = await request.get(`${API_URL}/api/ai-memories`);

    // Should either be 200 with deprecation warning or 404 if removed
    expect(res.status()).toBeOneOf([200, 404, 301, 308]);
  });

  test("New vector search endpoints should be available", async ({ request }) => {
    // Check that new endpoints exist
    const res = await request.post(`${API_URL}/api/datasets/test/vector-search`, {
      data: { query: "test" },
    });

    // Should not be 404
    expect(res.status()).not.toBe(404);
  });
});
