/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEST CONTEXT - Creates isolated KonContext for testing
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { TestKonContext } from "./types.js";

/**
 * Create a mock KonContext for testing
 * This mimics the real context but with isolated/in-memory implementations
 */
export async function createTestContext(
  sandboxId: string,
  _databaseStrategy: "memory" | "transaction" | "postgres" = "memory"
): Promise<TestKonContext> {
  // In-memory storage for this sandbox
  const memoryStore = new Map<string, any>();
  const eventListeners = new Map<string, Array<(data: any) => void>>();

  const context = {
    sandboxId,

    // Mock database - in real implementation this would connect to test DB
    db: {
      instance: createMockDrizzle(memoryStore),
      execute: async (sql: string) => {
        console.log(`[TestDB:${sandboxId}] Execute:`, sql);
        return [];
      },
      tableExists: async (tableName: string) => {
        return memoryStore.has(`table:${tableName}`);
      },
    },

    // Mock cache
    cache: {
      get: async <T>(key: string): Promise<T | null> => {
        const value = memoryStore.get(`cache:${key}`);
        return value ? JSON.parse(value) : null;
      },
      set: async <T>(key: string, value: T, _ttlSeconds?: number): Promise<void> => {
        memoryStore.set(`cache:${key}`, JSON.stringify(value));
      },
      invalidate: async (pattern: string): Promise<void> => {
        // Simple implementation - in real would use pattern matching
        for (const key of memoryStore.keys()) {
          if (key.startsWith(`cache:${pattern.replace("*", "")}`)) {
            memoryStore.delete(key);
          }
        }
      },
    },

    // Event system
    events: {
      emit: (event: string, data: unknown): void => {
        const listeners = eventListeners.get(event) || [];
        listeners.forEach((fn) => fn(data));
      },
      on: (event: string, handler: (data: unknown) => void): void => {
        if (!eventListeners.has(event)) {
          eventListeners.set(event, []);
        }
        eventListeners.get(event)!.push(handler);
      },
    },

    // Mock realtime
    realtime: {
      broadcast: (_channel: string, _message: unknown): void => {
        // No-op in tests
      },
      sendToUser: (_userId: string, _message: unknown): void => {
        // No-op in tests
      },
    },

    // Mock auth
    auth: {
      requireAuth: async (c: any, next: any) => {
        const user = c.get("testUser");
        if (!user) {
          return c.json({ error: "Unauthorized" }, 401);
        }
        await next();
      },
      requireRole: (roles: string[]) => async (c: any, next: any) => {
        const user = c.get("testUser");
        if (!user || !roles.includes(user.role)) {
          return c.json({ error: "Forbidden" }, 403);
        }
        await next();
      },
      optionalAuth: async (_c: any, next: any) => {
        await next();
      },
      getSession: async (_headers: Headers) => {
        return null;
      },
    },

    // Mock storage
    storage: {
      getSignedUploadUrl: async (key: string, _contentType: string) => {
        return `https://test-storage.kitsuden.local/upload/${key}`;
      },
      getSignedDownloadUrl: async (key: string) => {
        return `https://test-storage.kitsuden.local/download/${key}`;
      },
      delete: async (_key: string) => {
        // No-op
      },
    },

    // Mock content publishing
    contentPublishing: {
      getAvailableTargets: () => [],
      hasTarget: () => false,
      register: () => {},
      unregister: () => {},
      promote: async () => ({
        contentId: "test",
        targetId: "test",
        slug: "test",
        url: "/test",
        status: "published",
        createdAt: new Date(),
      }),
      unpublish: async () => {},
      getPublishedUrl: () => "/test",
    },

    // Logger
    logger: {
      info: (message: string, meta?: Record<string, unknown>) => {
        console.log(`[Test:${sandboxId}] INFO:`, message, meta || "");
      },
      warn: (message: string, meta?: Record<string, unknown>) => {
        console.log(`[Test:${sandboxId}] WARN:`, message, meta || "");
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        console.log(`[Test:${sandboxId}] ERROR:`, message, meta || "");
      },
      debug: (message: string, meta?: Record<string, unknown>) => {
        // Silent in tests unless DEBUG=true
        if (process.env.DEBUG) {
          console.log(`[Test:${sandboxId}] DEBUG:`, message, meta || "");
        }
      },
    },

    // Config
    config: {
      siteName: "Test Site",
      siteUrl: "http://localhost:3001",
      environment: "test",
    },
  } as TestKonContext;

  return context;
}

/**
 * Create a mock Drizzle instance
 * In production, this would be a real database connection
 */
function createMockDrizzle(memoryStore: Map<string, any>): any {
  return {
    select: () => ({
      from: (_table: any) => ({
        where: (_condition: any) => ({
          limit: (_n: number) => ({
            orderBy: () => Promise.resolve([]),
          }),
          orderBy: () => Promise.resolve([]),
        }),
        limit: (_n: number) => Promise.resolve([]),
        orderBy: () => Promise.resolve([]),
      }),
    }),
    insert: (table: any) => ({
      values: (data: any) => ({
        returning: () => {
          const id = `mock-${Date.now()}`;
          const record = { id, ...data };
          const tableName = typeof table === "object" ? table.name : table;

          if (!memoryStore.has(`table:${tableName}`)) {
            memoryStore.set(`table:${tableName}`, []);
          }
          memoryStore.get(`table:${tableName}`).push(record);

          return Promise.resolve([record]);
        },
      }),
    }),
    update: (_table: any) => ({
      set: (data: any) => ({
        where: (_condition: any) => ({
          returning: () => Promise.resolve([{ id: "mock", ...data }]),
        }),
      }),
    }),
    delete: (_table: any) => ({
      where: (_condition: any) => Promise.resolve({ count: 1 }),
    }),
  };
}

export default { createTestContext };
