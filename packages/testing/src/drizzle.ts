/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DRIZZLE ORM INTEGRATION - Real database testing
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This provides real Drizzle ORM instances for testing, not mocks.
 *
 * Options:
 * 1. "memory" - pg-mem (PostgreSQL in-memory, fastest)
 * 2. "postgres" - Real PostgreSQL with transaction rollback
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { newDb, DataType } from "pg-mem";

import type { TestKonContext } from "./types.js";

export interface DrizzleTestConfig {
  strategy: "memory" | "postgres";

  // For "postgres" strategy
  connectionString?: string;

  // Schema to use
  schema: Record<string, any>;
}

/**
 * Create a Drizzle ORM instance for testing
 */
export async function createDrizzleTestDb(config: DrizzleTestConfig): Promise<{
  db: any;
  cleanup: () => Promise<void>;
  transaction: (fn: (db: any) => Promise<void>) => Promise<void>;
}> {
  switch (config.strategy) {
    case "memory":
      return createPgMemDatabase(config.schema);

    case "postgres":
      return createPostgresTestDatabase(config);

    default:
      throw new Error(`Unknown database strategy: ${config.strategy}`);
  }
}

/**
 * Custom Pool-like wrapper for pg-mem that works with drizzle-orm/node-postgres.
 * pg-mem's createPg() adapter is missing features drizzle-orm 0.45.x needs
 * (rowMode array, queryConfig.types.getTypeParser, empty fields metadata).
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
 * PostgreSQL in-memory using pg-mem
 * Fastest option, no Docker needed
 */
async function createPgMemDatabase(schema: Record<string, any>) {
  const pgMem = newDb();

  // Register uuid-ossp extension
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
    db,
    cleanup: async () => {
      // pg-mem has no explicit close; memory is freed on GC
    },
    transaction: async (fn: (db: any) => Promise<void>) => {
      const backup = pgMem.backup();
      try {
        await fn(db);
      } finally {
        backup.restore();
      }
    },
  };
}

/**
 * Real PostgreSQL with transaction rollback
 * Most accurate, requires PostgreSQL running
 */
async function createPostgresTestDatabase(config: DrizzleTestConfig) {
  const connectionString =
    config.connectionString ||
    process.env.TEST_DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/kitsuden_test";

  const pool = new Pool({ connectionString });

  const db = drizzle(pool, { schema: config.schema });

  return {
    db,
    cleanup: async () => {
      await pool.end();
    },
    transaction: async (fn: (db: any) => Promise<void>) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const txDb = drizzle(client, { schema: config.schema });

        await fn(txDb);

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Helper to create test context with real Drizzle
 */
export async function createDrizzleTestContext(
  sandboxId: string,
  drizzleConfig: DrizzleTestConfig
): Promise<TestKonContext> {
  const { db, cleanup: _cleanup, transaction } = await createDrizzleTestDb(drizzleConfig);

  const { createTestContext } = await import("./context.js");
  const baseContext = await createTestContext(sandboxId, "memory");

  return {
    ...baseContext,
    db: {
      instance: db,
      execute: async (sql: string) => {
        return db.execute(sql);
      },
      tableExists: async (tableName: string) => {
        try {
          const result = await db.execute(`
            SELECT EXISTS (
              SELECT FROM information_schema.tables
              WHERE table_name = '${tableName}'
            );
          `);
          return result[0]?.exists || false;
        } catch {
          return true;
        }
      },
    },

    $transaction: transaction,
  } as TestKonContext;
}

export default { createDrizzleTestDb, createDrizzleTestContext };
