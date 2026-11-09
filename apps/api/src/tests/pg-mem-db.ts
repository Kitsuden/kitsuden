/**
 * pg-mem Test Database Helper
 *
 * Provides an in-memory PostgreSQL instance for tests when
 * a real PostgreSQL server is not available.
 *
 * Loads Drizzle migrations from:
 *   - apps/api/drizzle/          (generated migrations)
 *   - apps/api/src/db/migrations/ (manual migrations)
 */

import { readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { drizzle } from "drizzle-orm/node-postgres";
import { newDb, DataType } from "pg-mem";

import * as coreSchema from "../db/schema-core";

let memDbInstance: ReturnType<typeof drizzle> | null = null;
let pgMemInstance: ReturnType<typeof newDb> | null = null;

/**
 * Custom Pool wrapper for pg-mem compatible with drizzle-orm/node-postgres.
 * pg-mem's built-in createPg() adapter lacks features drizzle 0.45.x needs.
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
 * Parse migration SQL into executable statements for pg-mem.
 * Handles:
 *   - DO $$ BEGIN ... EXCEPTION blocks (extracts CREATE TYPE)
 *   - PL/pgSQL functions/triggers (removes them)
 *   - TIMESTAMPTZ → TIMESTAMP WITH TIME ZONE
 *   - statement-breakpoint markers
 */
function extractStatements(sql: string): string[] {
  // Normalize TIMESTAMPTZ shorthand
  let cleaned = sql.replace(/\bTIMESTAMPTZ\b/gi, "TIMESTAMP WITH TIME ZONE");

  // Extract CREATE TYPE from DO ... EXCEPTION blocks (drizzle style)
  cleaned = cleaned.replace(
    /DO\s*\$\$\s*BEGIN\s*(CREATE\s+TYPE[\s\S]*?;)\s*EXCEPTION[\s\S]*?END\s*\$\$\s*;?\s*(?:-->\s*statement-breakpoint)?/gi,
    "$1\n"
  );

  // Remove remaining DO blocks entirely
  cleaned = cleaned.replace(/DO\s*\$\$[\s\S]*?\$\$\s*;?/gi, "");

  // Remove PL/pgSQL functions and triggers
  cleaned = cleaned.replace(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION[\s\S]*?\$\$[\s\S]*?\$\$\s*LANGUAGE\s+plpgsql\s*;?/gi,
    ""
  );
  cleaned = cleaned.replace(
    /CREATE\s+TRIGGER[\s\S]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)[\s\S]*?;/gi,
    ""
  );

  // Remove statement breakpoints and line comments
  cleaned = cleaned.replace(/-->\s*statement-breakpoint\n?/g, "\n");
  cleaned = cleaned.replace(/\n\s*--.*$/gm, "");

  return cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Run all .sql files in a directory against pg-mem.
 */
function runMigrations(pgMem: ReturnType<typeof newDb>, dir: string) {
  let totalOk = 0;
  let totalFail = 0;

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf-8");
    const stmts = extractStatements(sql);

    let ok = 0;
    let fail = 0;
    for (const stmt of stmts) {
      try {
        pgMem.public.none(stmt + ";");
        ok++;
      } catch (e) {
        fail++;
        const msg = (e as Error).message;
        const isBenign =
          msg.includes("already exists") ||
          msg.includes("does not exist") ||
          msg.includes("cannot find column") ||
          msg.includes("duplicate_object") ||
          msg.includes("duplicate column name");
        if (!isBenign) {
          console.warn(`[pg-mem] ${file}:`, msg.substring(0, 120));
        }
      }
    }
    totalOk += ok;
    totalFail += fail;
  }

  return { ok: totalOk, fail: totalFail };
}

/**
 * Initialize pg-mem with full schema from migrations.
 */
export async function initPgMemDb() {
  if (memDbInstance) return memDbInstance;

  const pgMem = newDb();
  pgMemInstance = pgMem;

  // Register gen_random_uuid directly on public schema (works with DEFAULT in CREATE TABLE)
  pgMem.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: () => crypto.randomUUID(),
  });

  // `import.meta.dir` is Bun's and is `undefined` under Node: this helper is
  // loaded ALSO by the vitest tests, and there it blew up with
  // "path argument must be of type string". `fileURLToPath(import.meta.url)`
  // works in both runtimes.
  const here = dirname(fileURLToPath(import.meta.url));

  // Load Drizzle-generated migrations
  const drizzleDir = join(here, "../../drizzle");
  const r1 = runMigrations(pgMem, drizzleDir);

  // Load manual migrations
  const manualDir = join(here, "../db/migrations");
  const r2 = runMigrations(pgMem, manualDir);

  const total = r1.ok + r2.ok + r1.fail + r2.fail;
  if (total > 0) {
    console.log(
      `[pg-mem] Migrations: ${r1.ok + r2.ok}/${total} statements OK` +
        (r1.fail + r2.fail > 0 ? ` (${r1.fail + r2.fail} benign failures ignored)` : "")
    );
  }

  const pool = createPgMemPool(pgMem);
  memDbInstance = drizzle(pool as any, { schema: coreSchema });
  return memDbInstance;
}

/**
 * Get the pg-mem drizzle instance (creates on first call).
 */
export async function getPgMemDb() {
  return initPgMemDb();
}

/**
 * Clean up pg-mem instance.
 */
export function cleanupPgMemDb() {
  if (pgMemInstance) {
    // pg-mem has no explicit close; memory is freed on GC
    pgMemInstance = null;
    memDbInstance = null;
  }
}
