/**
 * Schema verification: what is declared has to exist
 * ============================================================================
 *
 * Compares the tables the code declares (`src/db/schema-core.ts`) with those
 * the database really has, and fails if any is missing.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * `auth_accounts` was declared and **no migration created it**. On a clean
 * database that made it impossible to create the first administrator: the
 * «System Init» screen returned 500 and the log said `relation "auth_accounts" does not
 * exist`. Worse: better-auth writes the user to `auth_users` and the credential
 * to `auth_accounts`, so the operation failed HALFWAY — the user was left
 * created with no password, and retrying no longer fixed anything.
 *
 * It went undetected for months because existing installations had those
 * tables from before the schema was moved to migrations. The failure only
 * appears on a NEW installation — that is, exactly on a freshly set up
 * production server, at the worst possible moment.
 *
 * ── WHY AT STARTUP AND NOT IN A TEST ───────────────────────────────────────
 *
 * It was tried with pg-mem, the tests' in-memory database, and it does not work: it does not
 * understand part of the migrations' SQL —52 statements failed to
 * parse— and reported tables as absent that exist in Postgres. A check
 * with false positives ends up ignored.
 *
 * So this runs against the REAL database, right after migrating and before
 * serving. If anything is missing, the container does not start. A deployment that does not start
 * gets fixed; one that half-starts is discovered when a user cannot
 * sign in.
 */

import "./lib/real-postgres-only";

import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { db } from "../src/db";
import * as schemaCore from "../src/db/schema-core";

import { activeKonSchemas } from "./lib/kon-schemas";

/**
 * Every declared table, with its name in the database and its columns.
 *
 * The columns matter as much as the table: `auth_sessions` EXISTED and was
 * missing `token`. The first version of this script only looked at tables, judged the
 * schema good, and creating the first administrator kept returning 500
 * — this time with `column "token" of relation "auth_sessions" does not exist`.
 * Half a check is the kind that lets the failure through with an approved stamp.
 */
function moduleTables(
  mod: Record<string, unknown>,
  origin: string
): { code: string; table: string; columns: string[] }[] {
  return Object.entries(mod)
    .filter(([, value]) => is(value, PgTable))
    .map(([code, value]) => ({
      code: `${origin}: ${code}`,
      table: getTableName(value as PgTable),
      columns: Object.values(getTableColumns(value as PgTable)).map((c) => c.name),
    }));
}

/**
 * Everything declared: the core and the ACTIVE kons.
 *
 * ── WHY THE KONS TOO ───────────────────────────────────────────────────────
 *
 * Because the first version only looked at `schema-core.ts` and judged the schema
 * good —«29/29 tables, 0 with missing columns»— while
 * `game_collections` was missing TWO columns that its Drizzle schema has declared
 * for a long time. The query that asked for them answered
 *
 *     ERROR:  column "description" does not exist
 *
 * on a public route. The verification said everything was fine because it was
 * looking at something else.
 *
 * Only the ACTIVE ones: an off kon need not have its tables, and requiring
 * the schema of the twenty-odd in the repo would prevent starting over something
 * nobody uses.
 */
async function declaredTables(): Promise<{ code: string; table: string; columns: string[] }[]> {
  const all = [
    ...moduleTables(schemaCore as Record<string, unknown>, "schema-core.ts"),
    ...(await activeKonSchemas()).flatMap(({ kon, mod: mod }) => moduleTables(mod, kon)),
  ];

  // The same table name can be declared in two places (the core and a kon
  // that re-exports it). The declaration with MORE columns is kept: it is the one that
  // imposes the stronger requirement, and accepting the laxer one would let through the
  // drift this is looking for.
  const byTable = new Map<string, { code: string; table: string; columns: string[] }>();
  for (const d of all) {
    const earlier = byTable.get(d.table);
    if (!earlier || d.columns.length > earlier.columns.length) byTable.set(d.table, d);
  }

  return [...byTable.values()].sort((a, b) => a.table.localeCompare(b.table));
}

/** Rows of a drizzle result, which vary by driver. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const withRows = result as { rows?: unknown };
  return Array.isArray(withRows?.rows) ? (withRows.rows as Record<string, unknown>[]) : [];
}

async function main(): Promise<void> {
  const declaredMany = await declaredTables();

  const result = await db.execute(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'` as never
  );
  const existingOnes = new Set(rowsOf(result).map((f) => String(f.tablename)));

  const absent = declaredMany.filter((d) => !existingOnes.has(d.table));

  // Real columns, in a single query: asking table by table would be 29
  // round trips on every startup.
  const realColumns = await db.execute(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'` as never
  );
  const byTable = new Map<string, Set<string>>();
  for (const row of rowsOf(realColumns)) {
    const table = String(row.table_name);
    if (!byTable.has(table)) byTable.set(table, new Set());
    byTable.get(table)!.add(String(row.column_name));
  }

  const missingColumns: { table: string; columns: string[] }[] = [];
  for (const d of declaredMany) {
    const real = byTable.get(d.table);
    if (!real) continue; // the whole table is missing; it already shows up above
    const areMissing = d.columns.filter((c) => !real.has(c));
    if (areMissing.length > 0) missingColumns.push({ table: d.table, columns: areMissing });
  }

  console.log(
    `   Schema: ${declaredMany.length - absent.length}/${declaredMany.length} tables, ` +
      `${missingColumns.length} with missing columns`
  );

  if (absent.length === 0 && missingColumns.length === 0) return;

  if (missingColumns.length > 0) {
    console.error("");
    console.error("ERROR: there are columns declared in the code that the database does NOT have.");
    console.error("");
    for (const c of missingColumns) {
      console.error(`   · ${c.table}: ${c.columns.join(", ")}`);
    }
    console.error("");
    console.error("  The table exists, so nothing fails at startup: the first");
    console.error("  query that uses that column fails. With `auth_sessions.token` that was");
    console.error("  signing in, that is, creating the first administrator.");
    process.exitCode = 1;
  }

  if (absent.length === 0) return;

  console.error("");
  console.error("ERROR: there are tables declared in the code that the database does NOT have.");
  console.error("");
  for (const a of absent) {
    console.error(`   · ${a.table}   (${a.code})`);
  }
  console.error("");
  console.error("  No migration creates them. The API would start and fail with");
  console.error("  'relation \"...\" does not exist' the first time someone uses them,");
  console.error("  which is usually when creating the first user.");
  console.error("");
  console.error("  Add a migration in src/db/migrations/ that creates them, copying");
  console.error("  the columns from schema-core.ts. See 0036_missing_auth_tables.sql");
  console.error("  as an example.");
  console.error("");
  process.exitCode = 1;
}

// ALWAYS exit, also on the good path: `db` leaves a Postgres pool
// open and the process would not end on its own. It is the same failure that hung step
// [5/6] of startup; see tests/unit/startup-scripts-finish.test.ts.
main()
  .catch((err) => {
    console.error("ERROR verifying the schema:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
