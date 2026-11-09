/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TESTS: Critical Features (Rate Limiting, Search, Observability)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";

import { registerCriticalFeatures } from "../lib/critical-features";
import { checkRateLimit } from "../lib/rate-limiter";
import { isValkeyAvailable } from "../lib/valkey";
import type { AppVariables } from "../types/hono";

import { isDatabaseAvailable } from "./setup";

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════════════

let valkeyAvailable = false;
let dbAvailable = false;
const app = new Hono<{ Variables: AppVariables }>();

beforeAll(async () => {
  // Valkey check with short timeout to avoid hanging when Valkey is not running
  valkeyAvailable = await Promise.race([
    isValkeyAvailable(),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  dbAvailable = await isDatabaseAvailable();
  // Register features
  registerCriticalFeatures(app);
  // Mock auth endpoint for rate-limit testing
  app.post("/api/auth/sign-in/email", (c) => c.json({ success: true }));
  // Mock context
  createMockContext(app);
});

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("🔒 Rate Limiting", () => {
  it("should track rate limits per identifier", async () => {
    if (!valkeyAvailable) {
      console.log("⏭️ Skipping rate limit tests — Valkey not available");
      return;
    }
    const mockContext = {
      req: {
        path: "/api/test",
        header: (name: string) => {
          if (name === "x-forwarded-for") return "192.168.1.1";
          return undefined;
        },
      },
      get: () => null,
    } as any;

    const result = await checkRateLimit(mockContext, { limit: 5, window: 60 });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeLessThan(5);
    expect(result.limit).toBe(5);
    expect(result.reset).toBeGreaterThan(Date.now());
  });

  it("should block when limit exceeded", async () => {
    if (!valkeyAvailable) return;
    const mockContext = {
      req: {
        path: "/api/test",
        header: (name: string) => {
          if (name === "x-forwarded-for") return "192.168.1.2";
          return undefined;
        },
      },
      get: () => null,
    } as any;

    // Exhaust limit
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(mockContext, { limit: 2, window: 60 });
    }

    const result = await checkRateLimit(mockContext, { limit: 2, window: 60 });

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeDefined();
  });

  it("should return 429 on rate limited endpoint", async () => {
    if (!valkeyAvailable) return;

    // Use a unique IP so previous test runs do not pollute the rate-limit window.
    const testIp = `192.168.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
    let blocked = false;

    // /api/auth/sign-in/email (the real better-auth path) allows 10 per 5-minute window.
    for (let i = 0; i < 12; i++) {
      const res = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": testIp,
        },
        body: JSON.stringify({ email: "test@test.com", password: "test" }),
      });

      if (res.status === 429) {
        blocked = true;
        break;
      }
    }

    expect(blocked).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("🔍 Search Engine", () => {
  it("should return empty suggestions when no matches exist", async () => {
    const res = await requestWithTimeout(app, "/api/search/suggestions?q=testxyz");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: any[] };
    expect(body).toHaveProperty("suggestions");
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions.length).toBe(0);
  });

  it("should validate search query length", async () => {
    const res = await requestWithTimeout(app, "/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "a" }), // Too short
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("at least 2 characters");
  });

  it("should provide autocomplete suggestions for valid queries", async () => {
    const res = await requestWithTimeout(app, "/api/search/suggestions?q=test");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: any[] };
    expect(Array.isArray(body.suggestions)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OBSERVABILITY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("📊 Observability", () => {
  it("should return health status", async () => {
    const res = await requestWithTimeout(app, "/health");

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("checks");
    expect(body).toHaveProperty("latency");
    expect(body).toHaveProperty("timestamp");
  });

  it("should require auth for admin stats", async () => {
    const res = await requestWithTimeout(app, "/admin/stats");
    expect(res.status).toBe(401);
  });

  it("should return homepage with status", async () => {
    const res = await requestWithTimeout(app, "/");

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.message).toBe("Kitsuden API");
    expect(body).toHaveProperty("status");
    // Without a session, only «it is alive»: the counts and activity belong to the panel.
    expect(body).not.toHaveProperty("stats");
    expect(body).not.toHaveProperty("activity");
  });

  it("should require auth for realtime stats", async () => {
    const res = await requestWithTimeout(app, "/admin/realtime");
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("🔗 Integration", () => {
  it("should have rate limit headers on protected endpoints", async () => {
    const res = await requestWithTimeout(app, "/api/search/suggestions?q=test");

    expect(res.headers.get("X-RateLimit-Limit")).toBeDefined();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
    expect(res.headers.get("X-RateLimit-Reset")).toBeDefined();
  });

  it("should return 404 for unknown routes", async () => {
    const res = await requestWithTimeout(app, "/api/unknown-route");
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function createMockContext(app: Hono<{ Variables: AppVariables }>) {
  // Add middleware to set mock user context
  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    await next();
  });
}

/**
 * Helper to make Hono requests with a timeout.
 * Prevents tests from hanging when Valkey middleware is unreachable.
 */
async function requestWithTimeout(
  app: Hono<{ Variables: AppVariables }>,
  path: string,
  opts?: RequestInit,
  timeoutMs = 8000
): Promise<Response> {
  return Promise.race([
    app.request(path, opts),
    new Promise<Response>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Request timeout after ${timeoutMs}ms: ${path}`)),
        timeoutMs
      )
    ),
  ]);
}

console.log("✅ Critical Features Tests Loaded");
