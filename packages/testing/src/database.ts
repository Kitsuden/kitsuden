/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEST DATABASE HELPERS
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { TestDatabase, TestKonContext } from "./types.js";

/**
 * Create database helpers for testing
 *
 * In the minimal version, this uses the context's db instance.
 * In a full implementation, this would provide more sophisticated
 * query building and assertions.
 */
export function createTestDatabase(_context: TestKonContext): TestDatabase {
  const memoryStore = new Map<string, any[]>();

  return {
    has: async (table: string, where: Record<string, any>): Promise<boolean> => {
      const rows = memoryStore.get(table) || [];
      return rows.some((row) => matchesWhere(row, where));
    },

    get: async (table: string, where: Record<string, any>): Promise<any | null> => {
      const rows = memoryStore.get(table) || [];
      return rows.find((row) => matchesWhere(row, where)) || null;
    },

    count: async (table: string, where?: Record<string, any>): Promise<number> => {
      const rows = memoryStore.get(table) || [];
      if (!where) return rows.length;
      return rows.filter((row) => matchesWhere(row, where)).length;
    },

    truncate: async (...tables: string[]): Promise<void> => {
      if (tables.includes("*") || tables.length === 0) {
        memoryStore.clear();
      } else {
        for (const table of tables) {
          memoryStore.delete(table);
        }
      }
    },

    query: async (sql: string, params?: any[]): Promise<any[]> => {
      // In a real implementation, this would execute SQL
      // For the MVP, return empty array
      console.log(`[TestDB] Query:`, sql, params);
      return [];
    },

    insert: async (table: string, data: Record<string, any>): Promise<any> => {
      if (!memoryStore.has(table)) {
        memoryStore.set(table, []);
      }

      const record = {
        id: `mock-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        ...data,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      memoryStore.get(table)!.push(record);
      return record;
    },
  };
}

/**
 * Check if a row matches the where conditions
 */
function matchesWhere(row: any, where: Record<string, any>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (row[key] !== value) {
      return false;
    }
  }
  return true;
}

export default { createTestDatabase };
