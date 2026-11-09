/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEST SANDBOX - Core of the Testing Framework
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { KonDefinition } from "@kitsuden/shared";

import { createTestAssertions } from "./assertions.js";
import { createTestContext } from "./context.js";
import { createTestDatabase } from "./database.js";
import { createTestEvents } from "./events.js";
import { loadFixtures } from "./fixtures.js";
import { createTestHttpClient } from "./http.js";
import type { SandboxConfig, TestSandbox, TestKon, TestKonContext } from "./types.js";

let sandboxCounter = 0;

/**
 * Create a test sandbox for kon testing
 *
 * Usage:
 * ```typescript
 * const sandbox = createTestSandbox({
 *   kons: ["kon-blog"],
 *   fixtures: "blog-seed"
 * });
 *
 * beforeAll(() => sandbox.setup());
 * afterAll(() => sandbox.teardown());
 * afterEach(() => sandbox.reset());
 * ```
 */
export async function createTestSandbox(config: SandboxConfig): Promise<TestSandbox> {
  const sandboxId = `sandbox-${Date.now()}-${++sandboxCounter}`;

  // Create isolated test context (like production but isolated)
  const context = await createTestContext(sandboxId, config.database);

  // Track events
  const events = createTestEvents();

  // Database helpers
  const db = createTestDatabase(context);

  // Load kons
  const kons: Record<string, TestKon> = {};

  for (const konId of config.kons) {
    const kon = await loadKon(konId, context, events);
    if (kon) {
      kons[konId] = kon;
    }
  }

  // HTTP client
  const http = createTestHttpClient(kons, context);

  // Assertions
  const assert = createTestAssertions(db, events);

  // Sandbox instance
  const sandbox: TestSandbox = {
    id: sandboxId,
    context,
    kons,
    fixtures: {},
    http,
    db,
    events,
    assert,

    setup: async () => {
      // Load fixtures if specified
      if (config.fixtures) {
        sandbox.fixtures = await loadFixtures(config.fixtures, context);
      }

      // Call kon onStartup hooks
      for (const kon of Object.values(kons)) {
        if (kon.definition.hooks?.onStartup) {
          await kon.definition.hooks.onStartup(context);
        }
      }
    },

    teardown: async () => {
      // Call kon onDisable hooks
      for (const kon of Object.values(kons)) {
        if (kon.definition.hooks?.onDisable) {
          await kon.definition.hooks.onDisable(context);
        }
      }

      // Cleanup database
      await db.truncate("*");
    },

    reset: async () => {
      // Clear events
      events.clear();

      // Truncate data but keep schema
      const tables = Object.values(kons).flatMap((g) => g.definition.tables || []);

      if (tables.length > 0) {
        await db.truncate(...tables);
      }

      // Reload fixtures
      if (config.fixtures) {
        sandbox.fixtures = await loadFixtures(config.fixtures, context);
      }
    },
  };

  return sandbox;
}

/**
 * Load a kon for testing
 */
async function loadKon(
  konId: string,
  context: TestKonContext,
  events: ReturnType<typeof createTestEvents>
): Promise<TestKon | null> {
  try {
    // Try to load from packages/kons/
    const path = `../../../packages/kons/${konId}/index.ts`;
    const module = await import(path);
    const definition: KonDefinition = module.kon || module.default;

    if (!definition) {
      console.warn(`Kon ${konId} not found or missing export`);
      return null;
    }

    // Wrap context to capture events
    const contextWithEventTracking = {
      ...context,
      events: {
        ...(context as any).events,
        emit: (name: string, data: any) => {
          events.all.push({ name, data, timestamp: new Date() });
          return (context as any).events.emit(name, data);
        },
      },
    } as TestKonContext;

    // Create router
    const router = definition.createRouter(contextWithEventTracking);

    // Invoke helper for direct function access
    const invoke = async <T>(method: string, ..._args: any[]): Promise<T> => {
      // This is a placeholder - in a real implementation,
      // you'd expose internal kon functions
      throw new Error(`Direct method invocation not implemented for ${method}`);
    };

    return {
      definition,
      router,
      invoke,
    };
  } catch (error) {
    console.warn(`Failed to load kon ${konId}:`, error);
    return null;
  }
}

export default { createTestSandbox };
