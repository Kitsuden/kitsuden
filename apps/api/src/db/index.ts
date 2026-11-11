import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
// @ts-ignore - NodePgTransaction is the correct export name but TS complains
import type {
  NodePgDatabase,
  NodePgTransaction,
  NodePgQueryResultHKT,
} from "drizzle-orm/node-postgres";
import pg from "pg";

// Deep import of the pure submodule (not the engine facade, which imports this db).
import { withLazyTransactions } from "../../../../packages/engine/src/rls-request";
import { inTesting } from "../lib/environment";
import { poolConfiguration, watchPool } from "../lib/pool-exhausted";

import * as coreSchema from "./schema-core";

const { Pool } = pg;

/**
 * LITE MODE (`KITSUDEN_LITE=true` or `DATABASE_URL=lite`)
 * ─────────────────────────────────────────────────────────────────────────────
 * Starts with EMBEDDED PostgreSQL (PGlite/WASM) — zero install, zero Docker.
 * It is what makes `kitsuden init my-app --lite && kitsuden dev` work in 30 seconds.
 *
 * Why PGlite and NOT SQLite: Kitsuden's isolation relies on Row-Level
 * Security, which SQLite does not have. PGlite IS Postgres, so the SAME schema,
 * the SAME migrations and the SAME RLS policies work without rewriting
 * anything — going from lite to production is just changing DATABASE_URL.
 *
 * Data persists in `.kitsuden/data` (configurable with KITSUDEN_LITE_DIR).
 */
export const isLiteMode =
  process.env.KITSUDEN_LITE === "true" || process.env.DATABASE_URL === "lite";

const connectionString = process.env.DATABASE_URL;
if (!connectionString && !isLiteMode) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and configure your PostgreSQL connection, " +
      "or run in lite mode (KITSUDEN_LITE=true) to use the embedded database — no Docker required. " +
      "To run tests, use pnpm test:api: it reads .env.test."
  );
}

let _mergedSchema: any;
let _dbInstance: NodePgDatabase<any> | null = null;
export let isPgMem = false;
/** The pg pool of the normal path (dev/prod); `null` in tests, lite and pg-mem. */
let _pool: pg.Pool | null = null;

/**
 * How the pool is RIGHT NOW (for `/metrics` and the benchmarks): open
 * connections, idle ones and requests waiting for one. `null` without a pg pool.
 */
export function poolStatus(): { total: number; idle: number; waiting: number; max: number } | null {
  if (!_pool) return null;
  return {
    total: _pool.totalCount,
    idle: _pool.idleCount,
    waiting: _pool.waitingCount,
    max: _pool.options.max ?? 10,
  };
}

/**
 * Determine which database backend to use for tests.
 *
 * - KITSUDEN_TEST_DB=memory (default) → pg-mem in-memory
 * - KITSUDEN_TEST_DB=postgres         → Real PostgreSQL, or an error
 *
 * Trimmed, because `. .env.test` from a CRLF file leaves the CR in the value. And
 * anything else is an error: treating a typo as "memory" means a suite that looks
 * green while it never touched Postgres.
 */
function getTestDbMode(): "postgres" | "memory" {
  const mode = process.env.KITSUDEN_TEST_DB?.trim().toLowerCase();
  if (mode === "postgres") return "postgres";
  if (!mode || mode === "memory") return "memory";
  throw new Error(`KITSUDEN_TEST_DB must be "postgres" or "memory", not "${mode}".`);
}

/** A connection string for a log or an error, without its password. */
function maskPassword(url: string | undefined): string {
  return (url ?? "").replace(/\/\/([^:/@]*):[^@]*@/, "//$1:***@");
}

/**
 * Is this connection string, evidently, a TEST database?
 * ─────────────────────────────────────────────────────────────────────────────
 * The suite does not limit itself to reading: `clearTestData()` runs `DELETE FROM data_entries`
 * and `DELETE FROM data_sets` **without a WHERE**. And the database it points at is not chosen
 * by the suite, but by whatever `DATABASE_URL` is in the environment — which on a
 * development machine is, quite naturally, the project's real database.
 *
 * That is: `pnpm test:api` with the usual `.env` loaded emptied the
 * site's content. It was a narrow escape: that database was not up.
 *
 * So the name has to declare itself as a test one. It is a cheap convention
 * (`kitsuden_test`, `myapp_test`) and the cost of getting it wrong cannot be undone. With
 * `KITSUDEN_ALLOW_UNSAFE_TEST_DB=1` it can be skipped, for
 * anyone who really has a test database with another name.
 */
function looksLikeTestDatabase(url: string | undefined): boolean {
  if (!url) return false;
  if (process.env.KITSUDEN_ALLOW_UNSAFE_TEST_DB === "1") return true;
  try {
    const name = new URL(url).pathname.replace(/^\//, "");
    return /test/i.test(name);
  } catch {
    return false;
  }
}

async function initDb(): Promise<NodePgDatabase<any>> {
  const isTest = inTesting();

  if (isTest) {
    const mode = getTestDbMode();

    if (mode === "memory") {
      console.log("📋 Test mode: KITSUDEN_TEST_DB=memory — using pg-mem");
      const { getPgMemDb } = await import("../tests/pg-mem-db");
      isPgMem = true;
      return await getPgMemDb();
    }

    // --- PostgreSQL real (default for tests) ---
    if (!looksLikeTestDatabase(connectionString)) {
      throw new Error(
        "DATABASE_URL does not look like a TEST database, so it was not used: the suite deletes " +
          "whole tables without a WHERE. Use a database whose name contains 'test' (pnpm test:db:up " +
          "starts one), or force it with KITSUDEN_ALLOW_UNSAFE_TEST_DB=1."
      );
    }

    // Lazy as in production: the suite tests the same path.
    const testPool = withLazyTransactions(
      new Pool({
        connectionString,
        max: 5,
        idleTimeoutMillis: 5000,
        connectionTimeoutMillis: 3000,
      })
    );

    try {
      await testPool.query("SELECT 1");
      console.log("📋 Test mode: KITSUDEN_TEST_DB=postgres — using real PostgreSQL");

      const { buildMergedSchema } = await import("../lib/schema-merger");
      _mergedSchema = await buildMergedSchema();
      return drizzle(testPool, { schema: _mergedSchema as Record<string, unknown> });
    } catch (err) {
      // No fallback to pg-mem: Postgres was asked for by name, and a suite that skips
      // everything or a migration that dies on pg-mem's parser both hide this error.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `KITSUDEN_TEST_DB=postgres, but ${maskPassword(connectionString)} failed: ${message}. ` +
          "Run 'pnpm test:db:up', or set KITSUDEN_TEST_DB=memory to use pg-mem on purpose."
      );
    }
  }

  // --- LITE mode: embedded PostgreSQL (PGlite), no Docker ---
  if (isLiteMode) {
    const dataDir = process.env.KITSUDEN_LITE_DIR ?? ".kitsuden/data";
    console.log(`⚡ Lite mode: embedded PostgreSQL (PGlite) at ${dataDir}`);

    // PGlite does not create intermediate directories: if `.kitsuden/data` does not exist with
    // all its parents, it fails with ENOENT in a freshly created project.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir, { recursive: true });

    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");

    // PGlite ships no extensions by default: the module has to be loaded
    // at construction. Without this, the migration chain's `CREATE EXTENSION`
    // fails and with it similarity search and everything vector-related.
    //
    // THE CEILING OF LITE MODE: NO pgvector
    //
    // The `vector` module (pgvector compiled to WASM) exists in PGlite 0.2 and
    // 0.3, and disappeared from 0.4 on. With 0.5.x, lite mode cannot
    // create a single VECTOR column: brain, semantic search and the semantic
    // cache cannot be migrated here.
    //
    // IT WAS TRIED to downgrade to 0.3.16: pgvector works (with hnsw and ivfflat) and the
    // migration chain applies IN FULL. But the downgrade shifts the
    // type resolution of drizzle in the monorepo and produces **100 TypeScript
    // errors** in the query layer (query, translator, brain).
    // The cost outweighs the benefit, so it was reverted.
    //
    // To recover it there are two paths, neither free: wait for PGlite
    // to bring the module back, or align drizzle-orm across the whole monorepo and absorb
    // those 100 errors at once.
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const client = await PGlite.create({ dataDir, extensions: { pg_trgm } });

    const { buildMergedSchema } = await import("../lib/schema-merger");
    _mergedSchema = await buildMergedSchema();

    // The PGlite driver exposes the same Drizzle API as node-postgres;
    // the cast keeps a single `db` type throughout the code.
    return drizzlePglite(client, {
      schema: _mergedSchema as Record<string, unknown>,
    }) as unknown as NodePgDatabase<any>;
  }

  // --- Normal path (dev / prod) ---
  // Size and timeouts per environment (DB_POOL_*); an exhausted pool answers 503 +
  // Retry-After instead of 500 (see lib/pool-exhausted.ts).
  //
  // Each request's RLS transaction is LAZY (`withLazyTransactions`):
  // it does not ask for a connection until the first query, so a route that calls
  // an external service before touching the database, or that does not touch it, holds none.
  const pool = withLazyTransactions(
    watchPool(
      new Pool({
        connectionString,
        ...poolConfiguration(),
      })
    )
  );
  _pool = pool;

  const { buildMergedSchema } = await import("../lib/schema-merger");
  console.log("📋 Building merged schema...");
  _mergedSchema = await buildMergedSchema();
  return drizzle(pool, { schema: _mergedSchema as Record<string, unknown> });
}

/**
 * Lazily initialize the database singleton.
 * This avoids re-initialization when multiple test files import `../db`.
 */
async function getDbInstance(): Promise<NodePgDatabase<any>> {
  if (!_dbInstance) {
    _dbInstance = await initDb();
  }
  return _dbInstance;
}

export const db = await getDbInstance();
export const mergedSchema = _mergedSchema ?? coreSchema;

export type Database = typeof db;

// Type for database transactions
// @ts-ignore - NodePgTransaction type arguments vary by drizzle-orm version
export type DatabaseTransaction = NodePgTransaction<
  NodePgQueryResultHKT,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;
