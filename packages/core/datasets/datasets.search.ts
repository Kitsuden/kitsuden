/**
 * DataSets — search, facets and comparison between entries
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The three things `datasets` was missing for a dataset to be
 * QUERYABLE and not just listable. Until now `/:id/entries` filtered by `status` and
 * `limit`, and nothing else: to find something you had to fetch the thousand entries and
 * search them on the client.
 *
 * ── WHY IT IS HERE AND NOT IN A KON ────────────────────────────────────────
 *
 * It was first written as a separate kon (`kon-gamedata`) with its own tables
 * `game_datasets` / `game_entities`. That was a mistake: it duplicated the store that
 * already exists here, and worse — `datasets.indexes.ts` already generates B-tree indexes
 * over `(data->>'field')` and GIN with `gin_trgm_ops`, which is exactly the
 * problem those dedicated columns tried to solve.
 *
 * Two places where "an entity" lives do not give an error the day someone imports
 * into one and searches the other. They give zero results, which is worse.
 *
 * And searching, faceting and knowing where a dataset came from are not needs of
 * video game data: any dataset has them. That is why they go in the core.
 */

import { and, eq, sql, type SQL } from "drizzle-orm";

import { dataEntries } from "./datasets.schema";

/**
 * Normalizes text for searching: no accents, no uppercase, no punctuation.
 *
 * Without this, searching "talisman" does not find "Talismán" and "wolfs" does not find
 * "Wolf's". It is the difference between a search engine and a text box that almost
 * never hits.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface FieldFilter {
  /** Field inside `data`, or `title` / `status` for the table's own columns. */
  field: string;
  /** Exact equality. */
  equal?: string;
  min?: number;
  max?: number;
}

/**
 * `damage:100..500,slot:helmet,weight:..6.5` → filters.
 *
 * It throws instead of ignoring what it does not understand: a badly written filter that is
 * silently skipped returns MORE results than requested, and whoever reads it believes
 * it has filtered.
 */
export function readFilters(raw: string | undefined): FieldFilter[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const cut = p.indexOf(":");
      if (cut <= 0) {
        throw new Error(`Malformed filter: "${p}". Use field:value or field:min..max`);
      }
      const field = p.slice(0, cut);
      const value = p.slice(cut + 1);

      if (!value.includes("..")) return { field, equal: value };

      const [min, max] = value.split("..");
      const num = (x: string | undefined) => {
        if (!x) return undefined;
        const n = Number(x);
        if (!Number.isFinite(n)) throw new Error(`"${x}" is not a number in the filter "${p}"`);
        return n;
      };
      return { field, min: num(min), max: num(max) };
    });
}

/** Own columns of `data_entries`; the rest live inside `data`. */
const OWN_COLUMNS = new Set(["title", "status"]);

/**
 * SQL condition for a filter.
 *
 * `data` fields are read with `data->>'field'`, which is the SAME expression
 * that `datasets.indexes.ts` indexes. Writing it differently here (with `data#>>` or
 * with a different cast) would stop Postgres from using the index and the query
 * would go from milliseconds to seconds without anything failing.
 */
export function filterCondition(f: FieldFilter): SQL {
  const own = OWN_COLUMNS.has(f.field);
  const expr = own
    ? sql.identifier(f.field === "title" ? "title" : "status")
    : sql`data->>${f.field}`;

  if (f.equal !== undefined) return sql`${expr} = ${f.equal}`;

  const parts: SQL[] = [];
  if (f.min !== undefined) parts.push(sql`(${expr})::numeric >= ${f.min}`);
  if (f.max !== undefined) parts.push(sql`(${expr})::numeric <= ${f.max}`);
  // A numeric filter on something that does not declare the field does NOT pass: if you search
  // "damage > 100" and things without damage show up, you believe they were compared.
  parts.push(sql`${expr} IS NOT NULL`);
  return sql.join(parts, sql` AND `);
}

export interface SearchOptions {
  dataSetId: string;
  /** Free text. Compared normalized against the title. */
  q?: string;
  filters?: FieldFilter[];
  /** Fields to count facets on. */
  facets?: string[];
  limit?: number;
  offset?: number;
  status?: string;
  /**
   * Extra condition the route ALWAYS requires (the dataset's `rlsRules` for
   * anyone not on the team). Before, search applied no policy.
   */
  rls?: SQL;
}

/** Limits of a search: what arrives in the URL does not decide how hard the database works. */
export const SEARCH_LIMITS = { filters: 20, words: 10, offset: 100_000 } as const;

export interface Facet {
  field: string;
  values: { value: string; count: number }[];
}

export interface SearchResult<T> {
  data: T[];
  total: number;
  facets: Facet[];
}

/**
 * Searches the entries of a dataset.
 *
 * ── FACETS ARE COUNTED IN THE DATABASE ─────────────────────────────────────
 *
 * It is tempting to fetch the rows and count them in JS. It works with five hundred and
 * falls over with fifty thousand — and a game's item catalog has fifty
 * thousand. Each facet is a `GROUP BY` over the indexed expression.
 *
 * ── AND THEY ARE COUNTED OVER THE ALREADY-FILTERED RESULT ──────────────────
 *
 * Except for the facet itself. This is what makes the numbers on the left
 * match what is shown: a facet counted over the total says
 * "Legendary (146)" and then shows three.
 */
/**
 * The rows of a `db.execute`. With the `pg` driver (the production one) it returns
 * `{ rows, … }`, not an array: `const [{ n }] = await db.execute(…)` blew up
 * with "is not iterable" and search answered 500 as soon as there was a real
 * dataset (found by Schemathesis). Other drivers give the array.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export async function searchEntries(
  db: {
    select: (...a: unknown[]) => any;
    execute: (q: SQL) => Promise<unknown>;
  },
  options: SearchOptions
): Promise<SearchResult<typeof dataEntries.$inferSelect>> {
  const { dataSetId, q, filters: filters = [], facets: facets = [], status, rls } = options;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.min(Math.max(options.offset ?? 0, 0), SEARCH_LIMITS.offset);
  if (filters.length > SEARCH_LIMITS.filters) {
    throw new Error(`At most ${SEARCH_LIMITS.filters} filters per search`);
  }

  const conditions: SQL[] = [eq(dataEntries.dataSetId, dataSetId)];
  if (status) conditions.push(eq(dataEntries.status, status));
  if (rls) conditions.push(rls);
  for (const f of filters) conditions.push(filterCondition(f));

  if (q?.trim()) {
    /**
     * Search uses `ILIKE` on the title.
     *
     * `gin_trgm_ops`, which `datasets.indexes.ts` knows how to create, indexes exactly
     * this pattern, so a `%text%` does not force a table scan. Every
     * word of the query must appear, in any order: whoever types
     * "sword fire" expects to find "Flaming Sword of Fire".
     */
    for (const word of normalizeText(q).split(" ").filter(Boolean).slice(0, SEARCH_LIMITS.words)) {
      conditions.push(sql`${dataEntries.title} ILIKE ${"%" + word + "%"}`);
    }
  }

  const where = and(...conditions)!;

  const rows = (await db
    .select()
    .from(dataEntries)
    .where(where)
    .limit(limit)
    .offset(offset)) as (typeof dataEntries.$inferSelect)[];

  const [{ n }] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT COUNT(*)::int AS n FROM data_entries WHERE ${where}`)
  );

  const output: Facet[] = [];
  for (const field of facets) {
    /**
     * The facet is counted WITHOUT its own filter.
     *
     * If you are filtering by "rarity: legendary", the rarity facet has to
     * keep showing how many epics there are — otherwise you cannot change option
     * without blindly removing the filter. The other facets do respect the filter.
     */
    const others = conditions.filter((_, i) => {
      const f = filters[i - (conditions.length - filters.length)];
      return !f || f.field !== field;
    });
    const expr = OWN_COLUMNS.has(field) ? sql.identifier(field) : sql`data->>${field}`;

    const groups = rowsOf<{ value: string; n: number }>(
      await db.execute(
        sql`SELECT ${expr} AS value, COUNT(*)::int AS n
            FROM data_entries
            WHERE ${and(...others)!} AND ${expr} IS NOT NULL
            GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 100`
      )
    );

    output.push({
      field,
      values: groups.map((g) => ({ value: String(g.value), count: g.n })),
    });
  }

  return { data: rows, total: n ?? 0, facets: output };
}

export interface FieldDifference {
  field: string;
  /** `entryId` → value. */
  values: Record<string, unknown>;
}

/**
 * Compares several DIFFERENT entries field by field.
 *
 * Not to be confused with `compareSnapshots`, which compares two versions of THE SAME
 * entry. This is the product comparator: "how do these three
 * swords differ?".
 *
 * It returns only the fields where there is a difference. Showing all forty rows when
 * thirty-eight are identical hides the answer in noise, and the
 * question that brings someone to a comparator is exactly that.
 */
export function compareInputs(
  inputs: { id: string; title: string; data: Record<string, unknown> | null }[]
): FieldDifference[] {
  const fields = new Set<string>();
  for (const e of inputs) for (const k of Object.keys(e.data ?? {})) fields.add(k);

  return [...fields]
    .sort()
    .map((field) => {
      const values: Record<string, unknown> = {};
      for (const e of inputs) values[e.id] = (e.data ?? {})[field] ?? null;
      return { field, values };
    })
    .filter((f) => {
      const vs = Object.values(f.values).map((v) => JSON.stringify(v));
      // A field that neither declares is not a difference.
      return new Set(vs).size > 1;
    });
}
