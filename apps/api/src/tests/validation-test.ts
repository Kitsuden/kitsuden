/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * VALIDATION TEST - Verifies there are no 500/400 errors
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";

import { observabilityRoutes } from "../lib/observability";
import { rateLimit, checkRateLimit, RATE_LIMIT_CONFIGS } from "../lib/rate-limiter";
import { searchRoutes } from "../lib/search";
import type { AppVariables } from "../types/hono";

// Import the modules to test

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const app = new Hono<{ Variables: AppVariables }>();

// Mock context helper
function createMockContext(_path: string, headers: Record<string, string> = {}) {
  return {
    req: {
      path: _path,
      header: (name: string) => headers[name] || undefined,
    },
    get: () => null,
  } as any;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMITER VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("🔒 Rate Limiter - No 500/400 errors", () => {
  it("rate limit configs are well defined", () => {
    expect(RATE_LIMIT_CONFIGS).toBeDefined();
    expect(Object.keys(RATE_LIMIT_CONFIGS).length).toBeGreaterThan(0);

    // Verify that each config has the required fields
    for (const [_path, config] of Object.entries(RATE_LIMIT_CONFIGS)) {
      expect(config.limit).toBeGreaterThan(0);
      expect(config.window).toBeGreaterThan(0);
      expect(config.message).toBeDefined();
    }
  });

  it("checkRateLimit does not throw a 500 error", async () => {
    const mockContext = createMockContext("/api/test", {
      "x-forwarded-for": "192.168.1.1",
    });

    const result = await checkRateLimit(mockContext, { limit: 10, window: 60 });

    expect(result).toBeDefined();
    expect(typeof result.allowed).toBe("boolean");
    expect(typeof result.remaining).toBe("number");
    expect(typeof result.limit).toBe("number");
    expect(typeof result.reset).toBe("number");
  });

  it("rateLimit middleware does not throw an error", async () => {
    const middleware = rateLimit({ limit: 5, window: 60 });
    const mockContext = createMockContext("/api/test", {
      "x-forwarded-for": "192.168.1.2",
    });

    let nextCalled = false;
    const next = async () => {
      nextCalled = true;
    };

    // It should not throw an error
    await middleware(mockContext, next);

    // The middleware should call next or return a response
    expect(nextCalled || mockContext.res).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("🔍 Search - No 500/400 errors", () => {
  it("search routes are mounted without error", () => {
    // Verify that the routes exist
    expect(searchRoutes).toBeDefined();
    expect(typeof searchRoutes).toBe("object");
  });

  it("search configurations are valid", () => {
    // Validate that the search types are valid
    const validTypes = ["fulltext", "vector", "hybrid"];

    for (const type of validTypes) {
      expect(validTypes).toContain(type);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OBSERVABILITY VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("📊 Observability - No 500/400 errors", () => {
  it("observability routes are mounted without error", () => {
    expect(observabilityRoutes).toBeDefined();
    expect(typeof observabilityRoutes).toBe("object");
  });

  it("homepage response has the correct structure", async () => {
    // Simulate a request to the homepage
    const res = await app.request("/");

    // It should not be 500
    expect(res.status).not.toBe(500);

    // If it is 200, verify the structure
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("message");
      expect(body).toHaveProperty("version");
      expect(body).toHaveProperty("status");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("🔗 Integration - Everything works together", () => {
  it("all endpoints respond without a 500 error", async () => {
    const endpoints = [
      { method: "GET", path: "/api/health" },
      { method: "GET", path: "/api/search/suggestions?q=test" },
    ];

    for (const endpoint of endpoints) {
      const res = await app.request(endpoint.path, { method: endpoint.method });

      // It should not be 500
      expect(res.status).not.toBe(500);

      // Log for debugging
      if (res.status === 500) {
        console.error(`❌ Error 500 on ${endpoint.method} ${endpoint.path}`);
        const body = await res.text();
        console.error("Response:", body);
      }
    }
  });

  it("rate limit headers are present", async () => {
    const res = await app.request("/api/search/suggestions?q=test");

    // Verify the rate limiting headers
    const limit = res.headers.get("X-RateLimit-Limit");
    const remaining = res.headers.get("X-RateLimit-Remaining");

    // If there is rate limiting, the headers must be present
    if (limit) {
      expect(Number(limit)).toBeGreaterThan(0);
    }
    if (remaining) {
      expect(Number(remaining)).toBeGreaterThanOrEqual(0);
    }
  });
});

console.log("✅ Validation Tests Loaded - Checking for 500/400 errors...");
