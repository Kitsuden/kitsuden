/**
 * Repairs the search trigger of `data_entries`
 * ============================================================================
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 *
 * The function `data_entries_search_update()` builds the search vector
 * like this:
 *
 *     NEW.search_vector := to_tsvector('english',
 *       COALESCE(NEW.title, '')   || ' ' ||
 *       COALESCE(NEW.content, '') || ' ' ||     ← this column DOES NOT EXIST
 *       COALESCE(NEW.data::text, '')
 *     );
 *
 * `data_entries` has `title`, `data_set_id`, `data`, `sort_order`… but
 * no `content`. So ANY insert or update on the table
 * fails with:
 *
 *     ERROR 42703: record "new" has no field "content"
 *
 * Consequence: not a single entry can be added to any dataset. That is
 * why an installation with this trigger has empty datasets and no
 * clue why — the error only shows up when trying to write.
 *
 * ── THERE IS NOW A MIGRATION ───────────────────────────────────────────────
 *
 * This script was written believing the trigger was not in the repo. It
 * is: `src/db/migrations/0022_critical_features.sql` creates it, so EVERY
 * database migrated from scratch was born unable to store dataset rows. It is fixed by
 * `0042_dataset_search_without_content.sql`, which `scripts/migrate.ts` applies.
 * The script is kept for databases that do not go through the migration runner.
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 * It rewrites the function using the columns that DO exist (`title` and `data`).
 * The trigger and the `search_vector` column are kept: the goal is that
 * search works, not to remove it.
 *
 *     bun scripts/repair-dataset-search.ts            (reports)
 *     bun scripts/repair-dataset-search.ts --apply  (writes)
 *
 * ── THE ADMIN CONNECTION IS NEEDED ─────────────────────────────────────────
 *
 * Changing a function is DDL, and the application role cannot do it — which
 * is exactly what makes the RLS policies effective. Without it you get a 42501:
 *
 *     DATABASE_URL=$DATABASE_ADMIN_URL bun scripts/repair-dataset-search.ts --apply
 */

import { sql } from "drizzle-orm";

import { db } from "../src/db";

const apply = process.argv.includes("--apply");

function rowsOf<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  const c = r as { rows?: unknown };
  return Array.isArray(c?.rows) ? (c.rows as T[]) : [];
}

const [fn] = rowsOf<{ prosrc: string }>(
  await db.execute(sql`SELECT prosrc FROM pg_proc WHERE proname = 'data_entries_search_update'`)
);

if (!fn) {
  console.log("\n`data_entries_search_update()` does not exist. Nothing to repair.\n");
  process.exit(0);
}

const columns = rowsOf<{ column_name: string }>(
  await db.execute(sql`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'data_entries'
  `)
).map((c) => c.column_name);

/** Fields the function uses and the table does not have. */
const absent = [...fn.prosrc.matchAll(/NEW\.(\w+)/g)]
  .map((m) => m[1])
  .filter((field, i, all) => all.indexOf(field) === i)
  .filter((field) => !columns.includes(field));

console.log(`\nColumns of \`data_entries\`: ${columns.length}`);
console.log(`Fields the function uses and that do NOT exist: ${absent.join(", ") || "none"}\n`);

if (absent.length === 0) {
  console.log("The trigger is already consistent with the table. Nothing to do.\n");
  process.exit(0);
}

console.log("  rewrite  data_entries_search_update()  →  only `title` and `data`");

if (!apply) {
  console.log("\nDry run. Run it again with --apply to write.\n");
  process.exit(0);
}

await db.execute(sql`
  CREATE OR REPLACE FUNCTION data_entries_search_update() RETURNS trigger AS $$
  BEGIN
    NEW.search_vector := to_tsvector('english',
      COALESCE(NEW.title, '') || ' ' ||
      COALESCE(NEW.data::text, '')
    );
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`);

// It is checked by really writing: that the function compiles says nothing
// about whether the INSERT passes, which is what was broken.
const [ds] = rowsOf<{ id: string }>(
  await db.execute(sql`
    INSERT INTO data_sets (name, slug, schema)
    VALUES ('__probe__', ${"probe-" + Date.now()}, '[]'::jsonb)
    RETURNING id
  `)
);

try {
  await db.execute(sql`
    INSERT INTO data_entries (title, data_set_id, data)
    VALUES ('probe', ${ds.id}, '{"x":1}'::jsonb)
  `);
  console.log("\nApplied. Verified: a dataset entry can now be inserted.\n");
} finally {
  await db.execute(sql`DELETE FROM data_entries WHERE data_set_id = ${ds.id}`);
  await db.execute(sql`DELETE FROM data_sets WHERE id = ${ds.id}`);
}

process.exit(0);
