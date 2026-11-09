/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL FEATURES INTEGRATION
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Integration of critical features:
 * - Rate Limiting (protection against abuse)
 * - Search Engine (full-text + vector)
 * - Observability (real metrics)
 */

import type { Hono } from "hono";

import type { AppVariables } from "../types/hono";

import { observabilityRoutes } from "./observability";
import { globalRateLimit, limiterEnabled, rateLimitRoutes } from "./rate-limiter";
import { searchRoutes } from "./search";

/**
 * Registers all critical routes in the Hono app
 */
export function registerCriticalFeatures(app: Hono<{ Variables: AppVariables }>) {
  console.log("\n🔒 Initializing Critical Features...\n");

  // ═══════════════════════════════════════════════════════════════════════════════
  // 1. RATE LIMITING - Global middleware
  // ═══════════════════════════════════════════════════════════════════════════════

  // Apply global rate limiting to all API routes. `RATE_LIMIT_ENABLED=false`
  // turns it off (on by default): it was read in config and nobody looked at it, so
  // there was no way to remove it for a test bench such as Schemathesis.
  // Turning it off ALSO removes the login and signup limits (RATE_LIMIT_CONFIGS).
  if (limiterEnabled()) {
    app.use("/api/*", globalRateLimit());
  } else {
    console.warn(
      "  ⚠️  Rate Limiting: OFF (RATE_LIMIT_ENABLED=false) — no brute-force limit on login"
    );
  }

  // The route-specific limits (login, signup, MCP, search…) are applied by
  // `globalRateLimit` reading `RATE_LIMIT_CONFIGS`. There used to be, in addition, a
  // per-route `rateLimit()` with the SAME Valkey key: each request counted
  // twice (MCP and search ran at half their quota), and the login and
  // signup ones pointed to paths that better-auth does not have.

  // Admin routes to manage rate limits
  app.route("/api/admin/rate-limits", rateLimitRoutes);

  console.log("  ✅ Rate Limiting: Global protection enabled");
  console.log("     - /api/*: 300 req/min default");
  console.log("     - /api/auth/*: Strict limits for brute force protection");
  console.log("     - /api/mcp: 200 req/min for AI workloads");

  // ═══════════════════════════════════════════════════════════════════════════════
  // 2. SEARCH ENGINE - Full-text + Vector
  // ═══════════════════════════════════════════════════════════════════════════════

  app.route("/api/search", searchRoutes);

  console.log("  ✅ Search Engine: Full-text + Vector search enabled");
  console.log("     - POST /api/search (hybrid/fulltext/vector)");
  console.log("     - GET /api/search/suggestions (autocomplete)");
  console.log("     - POST /api/search/index (vector indexing)");
  console.log("     - POST /api/search/init (setup extensions)");

  // ═══════════════════════════════════════════════════════════════════════════════
  // 3. OBSERVABILITY - Real metrics
  // ═══════════════════════════════════════════════════════════════════════════════

  // Mount observability routes (replaces the basic /api/health)
  app.route("/", observabilityRoutes);

  console.log("  ✅ Observability: Real-time metrics enabled");
  console.log("     - GET /api/health (comprehensive health checks)");
  console.log("     - GET /api/admin/stats (system statistics)");
  console.log("     - GET /api/admin/activity (recent activity)");
  console.log("     - GET /api/admin/metrics (time-series data)");
  console.log("     - GET /api/admin/realtime (websocket stats)");

  console.log("\n✨ Critical Features Ready\n");
}

// Re-exports for direct use
export { rateLimit, globalRateLimit } from "./rate-limiter";
export { search, searchFullText, searchVector, searchHybrid } from "./search";
export { getSystemStats, getHealthStatus, getMetrics } from "./observability";
