/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEST ASSERTIONS - Helper functions for common assertions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { TestAssertions, TestDatabase, TestEvents } from "./types.js";

/**
 * Create test assertions
 *
 * These helpers throw descriptive errors when assertions fail.
 * They work with any test runner (Vitest, Jest, etc.)
 */
export function createTestAssertions(db: TestDatabase, events: TestEvents): TestAssertions {
  return {
    database: {
      has: async (table: string, where: Record<string, any>, message?: string): Promise<void> => {
        const exists = await db.has(table, where);
        if (!exists) {
          const whereStr = JSON.stringify(where);
          throw new Error(
            message || `Expected database to have row in "${table}" matching ${whereStr}`
          );
        }
      },

      missing: async (
        table: string,
        where: Record<string, any>,
        message?: string
      ): Promise<void> => {
        const exists = await db.has(table, where);
        if (exists) {
          const whereStr = JSON.stringify(where);
          throw new Error(
            message || `Expected database to NOT have row in "${table}" matching ${whereStr}`
          );
        }
      },

      count: async (
        table: string,
        expected: number,
        where?: Record<string, any>,
        message?: string
      ): Promise<void> => {
        const actual = await db.count(table, where);
        if (actual !== expected) {
          const whereStr = where ? ` matching ${JSON.stringify(where)}` : "";
          throw new Error(
            message ||
              `Expected "${table}" to have ${expected} rows${whereStr}, but found ${actual}`
          );
        }
      },
    },

    events: {
      emitted: (name: string, data?: Record<string, any>, message?: string): void => {
        const wasEmitted = events.wasEmitted(name, data);
        if (!wasEmitted) {
          const dataStr = data ? ` with data ${JSON.stringify(data)}` : "";
          throw new Error(
            message ||
              `Expected event "${name}" to be emitted${dataStr}\n` +
                `Events emitted: ${events.all.map((e) => e.name).join(", ") || "(none)"}`
          );
        }
      },

      notEmitted: (name: string, message?: string): void => {
        const wasEmitted = events.wasEmitted(name);
        if (wasEmitted) {
          throw new Error(message || `Expected event "${name}" NOT to be emitted, but it was`);
        }
      },
    },
  };
}

export default { createTestAssertions };
