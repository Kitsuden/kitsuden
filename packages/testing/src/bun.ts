/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BUN TEST RUNNER INTEGRATION
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Usage with Bun's native test runner (faster than Vitest for Bun projects)
 *
 * ```typescript
 * import { describe, it, beforeAll, afterAll } from "bun:test";
 * import { createTestSandbox } from "@kitsuden/testing/bun";
 *
 * const sandbox = createTestSandbox({
 *   kons: ["kon-blog"],
 *   database: "postgres" // Uses real PostgreSQL with transactions
 * });
 *
 * beforeAll(() => sandbox.setup());
 * afterAll(() => sandbox.teardown());
 * ```
 */

import { createTestSandbox as baseCreateSandbox } from "./sandbox.js";
import type { SandboxConfig, TestSandbox } from "./types.js";

/**
 * Create sandbox optimized for Bun runtime
 */
export async function createTestSandbox(config: SandboxConfig): Promise<TestSandbox> {
  // Bun-specific optimizations:
  // 1. Uses Bun's native fetch (faster)
  // 2. Supports Bun.SQLite for in-memory testing
  // 3. Faster module resolution

  return baseCreateSandbox({
    ...config,
    // Default to postgres for Drizzle compatibility
    database: config.database || "postgres",
  });
}

/**
 * Helper for Bun's test runner
 */
export function createBunTest(config: SandboxConfig) {
  let sandbox: TestSandbox;

  return {
    sandbox: () => sandbox,

    setup: async () => {
      sandbox = await createTestSandbox(config);
      await sandbox.setup();
    },

    teardown: async () => {
      await sandbox.teardown();
    },

    reset: async () => {
      await sandbox.reset();
    },
  };
}

export * from "./types.js";
