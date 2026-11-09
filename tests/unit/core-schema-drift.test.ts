/**
 * Schema drift in packages/core
 * ============================================================================
 *
 * Checks that the tables declared by `packages/core` can be QUERIED
 * against the schema the migrations produce.
 *
 * ── WHY THIS TEST AND NOT A LIST COMPARISON ────────────────────────────────
 *
 * Comparing the list of declared columns against the list of created columns
 * is what was done first, reading the `.sql` files with regular expressions, and
 * it undercounted the tables with multiline formatting. A badly parsed list gives
 * false positives and false negatives with the same confidence.
 *
 * Here the real schema is built —base migration plus the whole chain— and the
 * query is run. If a declared column does not exist, Postgres says so. There
 * is no interpretation.
 *
 * ── WHAT THIS PROTECTS ─────────────────────────────────────────────────────
 *
 * A Drizzle `.select()` with no arguments enumerates ALL the declared columns.
 * One that does not exist is enough for the whole query to fail — not the
 * column, the query. And it fails in production, because in development almost
 * nobody starts against a database migrated from scratch.
 */

import { beforeAll, describe, expect, it } from "vitest";

import * as schemaCore from "../../apps/api/src/db/schema-core";
import { getPgMemDb } from "../../apps/api/src/tests/pg-mem-db";
import { dataEntries, dataSets } from "../../packages/core/datasets/datasets.schema";
import { media, mediaFolders } from "../../packages/core/media/media.schema";

let db: Awaited<ReturnType<typeof getPgMemDb>>;

beforeAll(async () => {
  db = await getPgMemDb();
});

/**
 * The `packages/core` tables that the application really mounts.
 *
 * `media` is here because `apps/api/src/db/schema-kons.generated.ts` re-exports
 * it from the core module: it is the one the app uses, not the one in `schema-core`.
 */
const TABLES = [
  ["dataSets", dataSets],
  ["dataEntries", dataEntries],
  ["media", media],
  ["mediaFolders", mediaFolders],
] as const;

describe("the packages/core tables exist in the migrated schema", () => {
  for (const [name, table] of TABLES) {
    it(`${name}: all its columns can be SELECTed`, async () => {
      /**
       * `.select()` with no arguments enumerates every declared column.
       *
       * It is exactly what the dataset and media routes do, so
       * if this passes, those work; and if it fails, the message says WHICH column
       * is missing, which is half the work of fixing it.
       */
      await expect(db.select().from(table).limit(1)).resolves.toBeDefined();
    });
  }
});

describe("the columns the drift had taken away", () => {
  /**
   * Each of these was declared in `packages/core` and existed in no
   * migration. They were added in `0035_core_schema_drift.sql`.
   *
   * The list came from RUNNING the queries, not from comparing the `.sql` files
   * with regular expressions: that first attempt flagged `active` and `published`
   * as missing columns when they are DEFAULT values, and missed that
   * `media_folders` did not exist as a table.
   *
   * The test names them one by one instead of trusting the SELECT above
   * because, if someone removes one again, the message says which.
   */
  const EXPECTED: [string, string[]][] = [
    ["data_sets", ["updated_at"]],
    ["data_entries", ["created_by_id", "updated_by_id"]],
    ["media_folders", ["path", "parent_id"]],
  ];

  for (const [table, columns] of EXPECTED) {
    for (const column of columns) {
      it(`${table}.${column} exists`, async () => {
        const rows = (await db.execute(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = '${table}' AND column_name = '${column}'` as never
        )) as unknown as { rows?: unknown[] } | unknown[];

        const n = Array.isArray(rows) ? rows.length : (rows.rows?.length ?? 0);
        expect(
          n,
          `${table}.${column} is declared by packages/core and does not exist in the schema`
        ).toBe(1);
      });
    }
  }
});

describe("a single declaration per table", () => {
  /**
   * `apps/api/src/db/schema-core.ts` declared `media`, `data_sets` and
   * `data_entries` on its own, besides `packages/core`. And they had drifted:
   *
   *   · Migration 0031 renamed `url→public_url`, `alt→alt_text` and
   *     `uploaded_by_id→created_by_id`. `packages/core/media` was updated;
   *     `schema-core` was not. Its `media` table had been broken since.
   *   · `data_sets.content_config` and `data_entries.owner_id` were only declared
   *     by `schema-core`.
   *
   * Now `schema-core` re-exports. This test checks the IDENTITY of the
   * objects, not that the columns match: two tables with the same columns
   * today can separate again tomorrow, and comparing lists would not detect it
   * until they had already drifted again.
   */
  const PAIRS = [
    ["media", schemaCore.media, media],
    ["mediaFolders", schemaCore.mediaFolders, mediaFolders],
    ["dataSets", schemaCore.dataSets, dataSets],
    ["dataEntries", schemaCore.dataEntries, dataEntries],
  ] as const;

  for (const [name, fromApp, fromCore] of PAIRS) {
    it(`${name}: schema-core and packages/core are the SAME object`, () => {
      expect(fromApp, `${name} was declared twice again: they will drift again`).toBe(fromCore);
    });
  }

  it("the schema-core tables can be queried", async () => {
    // `media` through schema-core failed with `column "url" does not exist`
    // since migration 0031. With the re-export it cannot happen again.
    for (const [name, fromApp] of PAIRS.map(([n, a]) => [n, a] as const)) {
      await expect(
        db
          .select()
          .from(fromApp as never)
          .limit(1),
        `SELECT on ${name} from schema-core`
      ).resolves.toBeDefined();
    }
  });
});
