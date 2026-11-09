/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * VITEST INTEGRATION - Helpers for using with Vitest
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createTestSandbox } from "./sandbox.js";
import type { SandboxConfig, TestSandbox } from "./types.js";

/**
 * Create a Vitest test suite with sandbox lifecycle
 *
 * Usage:
 * ```typescript
 * import { describeKon } from "@kitsuden/testing/vitest";
 *
 * describeKon("kon-blog", {
 *   kons: ["kon-blog"],
 *   fixtures: "blog-seed"
 * }, (sandbox) => {
 *
 *   it("creates posts", async () => {
 *     const response = await sandbox.http.post("/api/blog/posts", {...});
 *     expect(response.status).toBe(201);
 *   });
 *
 * });
 * ```
 */
export function describeKon(
  name: string,
  config: SandboxConfig,
  fn: (sandbox: TestSandbox) => void
): void {
  // This is a helper that should be called inside a describe block
  // It handles setup/teardown automatically

  let sandbox: TestSandbox;

  // Note: This expects to be run in a Vitest environment
  // where describe/beforeAll/afterAll/afterEach are available

  (globalThis as any).describe(name, () => {
    (globalThis as any).beforeAll(async () => {
      sandbox = await createTestSandbox(config);
      await sandbox.setup();
    });

    (globalThis as any).afterAll(async () => {
      await sandbox.teardown();
    });

    (globalThis as any).afterEach(async () => {
      if (config.autoReset !== false) {
        await sandbox.reset();
      }
    });

    fn(sandbox);
  });
}

/**
 * Setup function for Vitest config
 *
 * Usage in vitest.config.ts:
 * ```typescript
 * import { defineConfig } from "vitest/config";
 * import { kitsudenTesting } from "@kitsuden/testing/vitest";
 *
 * export default defineConfig({
 *   plugins: [kitsudenTesting()]
 * });
 * ```
 */
export function kitsudenTesting() {
  return {
    name: "kitsuden-testing",

    config: () => ({
      test: {
        // Global setup for Kitsuden testing
        globalSetup: [],

        // Environment setup
        setupFiles: [],

        // Alias for @kitsuden/testing
        alias: {
          "@kitsuden/testing": "@kitsuden/testing/dist/index.js",
        },
      },
    }),
  };
}

/**
 * Type-safe helper for writing kon tests
 */
export function createKonTest<T extends Record<string, any>>(
  konId: string,
  options: {
    fixtures?: string;
    beforeEach?: (sandbox: TestSandbox) => Promise<void>;
  } = {}
) {
  return {
    describe: (
      name: string,
      fn: (helpers: {
        sandbox: TestSandbox;
        http: TestSandbox["http"];
        db: TestSandbox["db"];
        assert: TestSandbox["assert"];
        fixtures: T;
      }) => void
    ) => {
      let sandbox: TestSandbox;

      (globalThis as any).describe(`${konId} - ${name}`, () => {
        (globalThis as any).beforeAll(async () => {
          sandbox = await createTestSandbox({
            kons: [konId],
            fixtures: options.fixtures,
          });
          await sandbox.setup();
        });

        (globalThis as any).afterAll(async () => {
          await sandbox.teardown();
        });

        (globalThis as any).beforeEach(async () => {
          if (options.beforeEach) {
            await options.beforeEach(sandbox);
          }
        });

        (globalThis as any).afterEach(async () => {
          await sandbox.reset();
        });

        fn({
          sandbox,
          http: sandbox.http,
          db: sandbox.db,
          assert: sandbox.assert,
          fixtures: sandbox.fixtures as T,
        });
      });
    },
  };
}

export default { describeKon, kitsudenTesting, createKonTest };
