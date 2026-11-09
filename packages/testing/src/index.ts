/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GREDIUS TESTING FRAMEWORK - Minimalist Kon Testing
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Usage:
 * ```typescript
 * import { createTestSandbox, defineFixture } from "@kitsuden/testing";
 *
 * const sandbox = createTestSandbox({
 *   kons: ["kon-blog"],
 *   fixtures: "blog-seed"
 * });
 *
 * beforeAll(() => sandbox.setup());
 * afterAll(() => sandbox.teardown());
 * afterEach(() => sandbox.reset());
 *
 * describe("kon-blog", () => {
 *   it("creates posts", async () => {
 *     const response = await sandbox.http
 *       .asUser("admin")
 *       .post("/api/blog/posts", { title: "Test" });
 *
 *     expect(response.status).toBe(201);
 *     await sandbox.assert.database.has("posts", { title: "Test" });
 *   });
 * });
 * ```
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kitsuden TESTING FRAMEWORK - Optimized for Bun + Drizzle + Hono
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * RECOMMENDED IMPORTS for your stack:
 *
 * 1. Full sandbox with Drizzle:
 *    import { createDrizzleSandbox } from "@kitsuden/testing/sandbox-drizzle"
 *
 * 2. Bun test runner helpers:
 *    import { createTestSandbox } from "@kitsuden/testing/bun"
 *
 * 3. Raw Drizzle test DB:
 *    import { createDrizzleTestDb } from "@kitsuden/testing/drizzle"
 */

// ═══════════════════════════════════════════════════════════════════════════════
// RECOMMENDED: Drizzle-integrated sandbox (Bun + Drizzle + Hono)
// ═══════════════════════════════════════════════════════════════════════════════

export { createDrizzleSandbox, type DrizzleSandboxConfig } from "./sandbox-drizzle.js";

// ═══════════════════════════════════════════════════════════════════════════════
// ALTERNATIVES
// ═══════════════════════════════════════════════════════════════════════════════

export { createTestSandbox } from "./sandbox.js";
export { createTestContext } from "./context.js";

// Helpers
export { createTestHttpClient } from "./http.js";
export { createTestDatabase } from "./database.js";
export { createTestEvents } from "./events.js";
export { createTestAssertions } from "./assertions.js";
export { loadFixtures, defineFixture, createDataFixture } from "./fixtures.js";

// Types
export type {
  SandboxConfig,
  TestSandbox,
  TestKonContext,
  TestKon,
  TestHttpClient,
  TestResponse,
  TestUser,
  TestDatabase,
  TestEvents,
  TestAssertions,
  Fixture,
} from "./types.js";

// Version
export const VERSION = "0.1.0";

// ═══════════════════════════════════════════════════════════════════════════════
// PLATFORM-SPECIFIC EXPORTS (use these for better integration)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bun users: import from "@kitsuden/testing/bun"
 *
 * Uses Bun's native test runner and fetch
 */

/**
 * Drizzle ORM users: import from "@kitsuden/testing/drizzle"
 *
 * Provides real Drizzle instances with:
 * - pg-mem (in-memory PostgreSQL)
 * - Transaction rollback for test isolation
 * - Schema migrations support
 */
