import { describe, it, expect } from "bun:test";

import { config, features, rateLimitConfig, corsConfig } from "../lib/config";

describe("config", () => {
  it("exports a parsed config object", () => {
    expect(config).toBeDefined();
    expect(["development", "production", "test"]).toContain(config.NODE_ENV);
    expect(typeof config.PORT).toBe("number");
  });

  it("feature flags reflect the current environment", () => {
    expect(typeof features.isDevelopment).toBe("boolean");
    expect(typeof features.isProduction).toBe("boolean");
    expect(typeof features.isTest).toBe("boolean");
    expect(typeof features.swaggerEnabled).toBe("boolean");
    expect(typeof features.mcpEnabled).toBe("boolean");
    expect(typeof features.rateLimitEnabled).toBe("boolean");
    expect(typeof features.headless).toBe("boolean");
  });

  it("rateLimitConfig exposes expected defaults", () => {
    expect(typeof rateLimitConfig.enabled).toBe("boolean");
    expect(typeof rateLimitConfig.windowMs).toBe("number");
    expect(typeof rateLimitConfig.maxRequests).toBe("number");
    expect(typeof rateLimitConfig.authMax).toBe("number");
    expect(Array.isArray(rateLimitConfig.skipPaths)).toBe(true);
    expect(rateLimitConfig.skipPaths).toContain("/api/health");
  });

  it("corsConfig exposes origins, methods and headers", () => {
    expect(Array.isArray(corsConfig.origins)).toBe(true);
    expect(corsConfig.origins.length).toBeGreaterThan(0);
    expect(Array.isArray(corsConfig.methods)).toBe(true);
    expect(corsConfig.methods).toContain("PATCH");
    expect(Array.isArray(corsConfig.headers)).toBe(true);
    expect(corsConfig.credentials).toBe(true);
  });
});
