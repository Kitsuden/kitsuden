/**
 * Test Utilities for Kitsuden API
 *
 * Helper functions for testing with Bun
 */

import { db } from "../db";

/**
 * Reset database state for tests
 * Truncates test tables and reseeds minimal data
 */
export async function resetTestDatabase() {
  // Add tables that need cleanup for tests
  const tablesToClean = [
    "data_entries",
    "data_sets",
    "api_keys",
    "kitsuden_functions",
    "function_executions",
  ];

  for (const table of tablesToClean) {
    try {
      await db.execute(`TRUNCATE TABLE ${table} CASCADE`);
    } catch {
      // Table might not exist, ignore
    }
  }
}

/**
 * Create a mock authenticated context for Hono tests
 */
export function createMockContext(
  options: {
    user?: { id: string; role: string };
    body?: unknown;
    params?: Record<string, string>;
    query?: Record<string, string>;
  } = {}
) {
  return {
    get: (key: string) => {
      if (key === "user") return options.user || null;
      if (key === "tx") return null;
      return undefined;
    },
    req: {
      json: async () => options.body || {},
      param: (key: string) => options.params?.[key] || "",
      query: (key: string) => options.query?.[key] || "",
      header: () => null,
    },
    json: (data: unknown, status?: number) => ({ data, status }),
    text: (data: string, status?: number) => ({ data, status }),
    notFound: () => ({ data: { error: "Not found" }, status: 404 }),
  };
}

/**
 * Mock fetch for external API calls in tests
 */
export function mockFetch(response: unknown, status = 200) {
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    });
}
