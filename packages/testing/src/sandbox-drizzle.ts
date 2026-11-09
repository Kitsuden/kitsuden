/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DRIZZLE-INTEGRATED TEST SANDBOX
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Sandbox optimized for Bun + Drizzle + Hono stack
 * Uses REAL Drizzle ORM with pg-mem or PostgreSQL transactions
 */

import type { KonDefinition } from "@kitsuden/shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { newDb, DataType } from "pg-mem";

import { createTestAssertions } from "./assertions.js";
import { createTestContext as createBaseContext } from "./context.js";
import { createTestEvents } from "./events.js";
import { loadFixtures } from "./fixtures.js";
import { createTestHttpClient } from "./http.js";
import type { SandboxConfig, TestSandbox, TestKon, TestKonContext, TestDatabase } from "./types.js";

export interface DrizzleSandboxConfig extends SandboxConfig {
  /** Database strategy - defaults to pg-mem for speed */
  database?: "memory" | "transaction" | "postgres";

  /** PostgreSQL connection string (for postgres strategy) */
  databaseUrl?: string;

  /** Drizzle schema definition */
  schema: Record<string, any>;

  /** Migrations folder path */
  migrationsFolder?: string;
}

let sandboxCounter = 0;

/**
 * Custom Pool-like wrapper for pg-mem that works with drizzle-orm/node-postgres.
 */
function createPgMemPool(pgMemDb: ReturnType<typeof newDb>) {
  const schema = pgMemDb.public;

  const client = {
    async query(queryConfig: any, params?: any[]) {
      const sqlText = typeof queryConfig === "string" ? queryConfig : queryConfig.text;
      const values = params ?? [];
      const hadRowMode = typeof queryConfig === "object" && queryConfig.rowMode === "array";

      const prepared = schema.prepare(sqlText);
      const bound = prepared.bind(values);
      const result = bound.executeAll();

      const pgResult = Array.isArray(result) ? result.at(-1)! : result;

      let rows = pgResult.rows;
      if (hadRowMode && Array.isArray(pgResult.fields)) {
        const fieldNames = pgResult.fields.map((f: any) => f.name);
        rows = rows.map((row: any) => fieldNames.map((name: string) => row[name]));
      }

      return {
        rows,
        fields: pgResult.fields ?? [],
        rowCount: pgResult.rowCount ?? rows.length,
        command: pgResult.command ?? "",
      };
    },

    async connect() {
      return client;
    },
    release() {},
    end() {},
  };

  return {
    query: client.query.bind(client),
    connect: async () => client,
    end: async () => {},
  };
}

/**
 * Create a test sandbox with REAL Drizzle ORM
 */
export async function createDrizzleSandbox(
  config: DrizzleSandboxConfig
): Promise<
  TestSandbox & { drizzle: any; transaction: <T>(fn: (db: any) => Promise<T>) => Promise<T> }
> {
  const sandboxId = `drizzle-sandbox-${Date.now()}-${++sandboxCounter}`;
  const dbStrategy = config.database || "memory";

  // 1. Create REAL Drizzle instance
  const {
    drizzle: drizzleInstance,
    cleanup,
    transaction,
  } = await createDrizzleInstance(dbStrategy, config.schema, config.databaseUrl);

  // 2. Create base context with real Drizzle
  const baseContext = await createBaseContext(sandboxId, "memory");

  const context = {
    ...baseContext,
    db: {
      instance: drizzleInstance,
      execute: async (sql: string) => {
        return drizzleInstance.execute(sql);
      },
      tableExists: async (tableName: string) => {
        try {
          const result = await drizzleInstance.execute(`
            SELECT EXISTS (
              SELECT FROM information_schema.tables
              WHERE table_name = '${tableName}'
            );
          `);
          return result[0]?.exists || false;
        } catch {
          // pg-mem might not support information_schema
          return true;
        }
      },
    },
  } as TestKonContext;

  // 3. Track events
  const events = createTestEvents();

  // 4. Database helpers using Drizzle
  const db: TestDatabase = {
    has: async (table: string, where: Record<string, any>) => {
      const result = await drizzleInstance
        .select()
        .from(config.schema[table])
        .where(buildWhereClause(where))
        .limit(1);
      return result.length > 0;
    },

    get: async (table: string, where: Record<string, any>) => {
      const result = await drizzleInstance
        .select()
        .from(config.schema[table])
        .where(buildWhereClause(where))
        .limit(1);
      return result[0] || null;
    },

    count: async (table: string, where?: Record<string, any>) => {
      const { sql } = await import("drizzle-orm");
      const result = await drizzleInstance
        .select({ count: sql`count(*)` })
        .from(config.schema[table])
        .where(where ? buildWhereClause(where) : undefined);
      return Number(result[0]?.count || 0);
    },

    truncate: async (...tables: string[]) => {
      for (const table of tables) {
        if (table === "*") {
          for (const tableName of Object.keys(config.schema)) {
            await drizzleInstance.delete(config.schema[tableName]);
          }
        } else if (config.schema[table]) {
          await drizzleInstance.delete(config.schema[table]);
        }
      }
    },

    query: async (sqlStr: string, params?: any[]) => {
      return drizzleInstance.execute(sqlStr, params);
    },

    insert: async (table: string, data: Record<string, any>) => {
      const [result] = await drizzleInstance.insert(config.schema[table]).values(data).returning();
      return result;
    },
  };

  // 5. Load kons
  const kons: Record<string, TestKon> = {};

  for (const konId of config.kons) {
    const kon = await loadKon(konId, context, events, drizzleInstance);
    if (kon) {
      kons[konId] = kon;
    }
  }

  // 6. HTTP client
  const http = createTestHttpClient(kons, context);

  // 7. Assertions
  const assert = createTestAssertions(db, events);

  // 8. Sandbox instance
  const sandbox = {
    id: sandboxId,
    context,
    kons,
    fixtures: {},
    http,
    db,
    events,
    assert,
    drizzle: drizzleInstance,
    transaction,

    setup: async () => {
      if (config.fixtures) {
        sandbox.fixtures = await loadFixtures(config.fixtures, context);
      }

      for (const kon of Object.values(kons)) {
        if (kon.definition.hooks?.onStartup) {
          await kon.definition.hooks.onStartup(context);
        }
      }
    },

    teardown: async () => {
      for (const kon of Object.values(kons)) {
        if (kon.definition.hooks?.onDisable) {
          await kon.definition.hooks.onDisable(context);
        }
      }

      await cleanup();
    },

    reset: async () => {
      events.clear();

      for (const tableName of Object.keys(config.schema)) {
        await drizzleInstance.delete(config.schema[tableName]);
      }

      if (config.fixtures) {
        sandbox.fixtures = await loadFixtures(config.fixtures, context);
      }
    },
  };

  return sandbox;
}

/**
 * Create Drizzle instance based on strategy
 */
async function createDrizzleInstance(
  strategy: string,
  schema: Record<string, any>,
  databaseUrl?: string
): Promise<{
  drizzle: any;
  cleanup: () => Promise<void>;
  transaction: <T>(fn: (db: any) => Promise<T>) => Promise<T>;
}> {
  switch (strategy) {
    case "pg-mem":
      return createPgMemInstance(schema);

    case "postgres":
    case "postgres-transaction":
      return createPostgresInstance(schema, databaseUrl);

    default:
      throw new Error(`Unknown database strategy: ${strategy}`);
  }
}

/**
 * Create pg-mem instance (fastest, in-memory)
 */
async function createPgMemInstance(schema: Record<string, any>) {
  const pgMem = newDb();

  pgMem.registerExtension("uuid-ossp", (schema) => {
    schema.registerFunction({
      name: "gen_random_uuid",
      returns: DataType.uuid,
      implementation: () => crypto.randomUUID(),
    });
  });

  const pool = createPgMemPool(pgMem);
  const db = drizzle(pool as any, { schema });

  return {
    drizzle: db,
    cleanup: async () => {
      // pg-mem has no explicit close
    },
    transaction: async <T>(fn: (db: any) => Promise<T>): Promise<T> => {
      const backup = pgMem.backup();
      try {
        return await fn(db);
      } finally {
        backup.restore();
      }
    },
  };
}

/**
 * Create PostgreSQL instance with transaction support
 */
async function createPostgresInstance(schema: Record<string, any>, databaseUrl?: string) {
  const url =
    databaseUrl ||
    process.env.TEST_DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/kitsuden_test";

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  return {
    drizzle: db,
    cleanup: async () => {
      await pool.end();
    },
    transaction: async <T>(fn: (db: any) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const txDb = drizzle(client, { schema });

        const result = await fn(txDb);

        await client.query("ROLLBACK");
        return result;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Load kon with real Drizzle
 */
async function loadKon(
  konId: string,
  context: TestKonContext,
  events: ReturnType<typeof createTestEvents>,
  _drizzleInstance: any
): Promise<TestKon | null> {
  try {
    const path = `../../../packages/kons/${konId}/index.ts`;
    const module = await import(path);
    const definition: KonDefinition = module.kon || module.default;

    if (!definition) {
      console.warn(`Kon ${konId} not found`);
      return null;
    }

    const contextWithEvents = {
      ...context,
      events: {
        ...(context as any).events,
        emit: (name: string, data: any) => {
          events.all.push({ name, data, timestamp: new Date() });
          return (context as any).events.emit(name, data);
        },
      },
    } as TestKonContext;

    const router = definition.createRouter(contextWithEvents);

    return {
      definition,
      router,
      invoke: async <T>(method: string, ..._args: any[]): Promise<T> => {
        throw new Error(`Direct invocation not implemented: ${method}`);
      },
    };
  } catch (error) {
    console.warn(`Failed to load kon ${konId}:`, error);
    return null;
  }
}

/**
 * Build Drizzle where clause from object
 */
function buildWhereClause(where: Record<string, any>): any {
  const { eq, and } = require("drizzle-orm");

  const conditions = Object.entries(where).map(([key, value]) => {
    return eq((row: any) => row[key], value);
  });

  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

export default { createDrizzleSandbox };
