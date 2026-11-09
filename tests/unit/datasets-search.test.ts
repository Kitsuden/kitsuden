/**
 * DataSets — search, facets and comparison
 * ============================================================================
 *
 * These three capabilities were born as a separate kon (`kon-gamedata`) with
 * their own tables. That was a mistake: they duplicated the store that already
 * exists in `core/datasets`, and worse — `datasets.indexes.ts` already
 * generated the indexes on `(data->>'field')` that those dedicated columns
 * tried to replace.
 *
 * Each test here pins down a decision that is easy to get wrong.
 */

import { describe, it, expect } from "vitest";

import {
  searchEntries,
  compareInputs,
  filterCondition,
  rowsOf,
  readFilters,
  normalizeText,
} from "../../packages/core/datasets/datasets.search";

describe("searchEntries with the production driver", () => {
  /**
   * `pg` returns `{ rows }` in `db.execute`, not an array: the search fell into
   * 500 ("is not iterable") with any real dataset. Nobody tested it with the
   * result this driver really gives (Schemathesis).
   */
  function pgDb(rows: unknown[], account: number, groups: unknown[]) {
    const query = {
      from: () => query,
      where: () => query,
      limit: () => query,
      offset: async () => rows,
    };
    let calls = 0;
    return {
      select: () => query,
      execute: async () => ({ rows: calls++ === 0 ? [{ n: account }] : groups, rowCount: 1 }),
    };
  }

  it("count and facets come from `rows`", async () => {
    const r = await searchEntries(
      pgDb([{ id: "e1" }], 7, [{ value: "legendary", n: 3 }]) as never,
      {
        dataSetId: "ds",
        facets: ["rarity"],
      }
    );
    expect(r.total).toBe(7);
    expect(r.facets).toEqual([{ field: "rarity", values: [{ value: "legendary", count: 3 }] }]);
  });

  it("rowsOf accepts the array of other drivers and does not blow up with anything", () => {
    expect(rowsOf([{ n: 1 }])).toEqual([{ n: 1 }]);
    expect(rowsOf({ rows: [{ n: 2 }] })).toEqual([{ n: 2 }]);
    expect(rowsOf(undefined)).toEqual([]);
    expect(rowsOf({})).toEqual([]);
  });
});

describe("normalization for searching", () => {
  it("strips accents, uppercase and punctuation", () => {
    // Without this, searching "talisman" does not find "Talismán" and "wolfs" does not
    // find "Wolf's". It is the difference between a search engine and a text box
    // that almost never hits.
    expect(normalizeText("Talismán")).toBe("talisman");
    expect(normalizeText("Wolf's Bane")).toBe("wolf s bane");
    expect(normalizeText("  FLAMING   Sword ")).toBe("flaming sword");
  });
});

describe("reading filters", () => {
  it("understands equality and open ranges on either side", () => {
    expect(readFilters("slot:helmet")).toEqual([{ field: "slot", equal: "helmet" }]);
    expect(readFilters("damage:100..500")).toEqual([{ field: "damage", min: 100, max: 500 }]);
    expect(readFilters("weight:..6.5")).toEqual([{ field: "weight", max: 6.5 }]);
    expect(readFilters("level:60..")).toEqual([{ field: "level", min: 60 }]);
  });

  it("accepts a value that contains a colon", () => {
    // `source:https://x.com` has a colon and is not a range. Splitting at the
    // FIRST `:` and not at all of them is what distinguishes it.
    expect(readFilters("url:https://x.com")).toEqual([{ field: "url", equal: "https://x.com" }]);
  });

  it("THROWS on a malformed filter instead of ignoring it", () => {
    // It is the important decision: a filter that is silently skipped returns
    // MORE results than asked for, and whoever reads them believes they filtered.
    expect(() => readFilters("noColon")).toThrow(/Malformed/);
    expect(() => readFilters(":noField")).toThrow(/Malformed/);
    expect(() => readFilters("damage:abc..def")).toThrow(/is not a number/);
  });

  it("does not invent filters from an empty string", () => {
    expect(readFilters(undefined)).toEqual([]);
    expect(readFilters("")).toEqual([]);
    expect(readFilters("  ,  ")).toEqual([]);
  });
});

describe("SQL condition of a filter", () => {
  const sqlOf = (x: unknown) => JSON.stringify(x);

  it("uses data->>'field', which is what datasets.indexes indexes", () => {
    // `datasets.indexes.ts` creates `CREATE INDEX ... ON data_entries
    // ((data->>'field'))`. Writing `data#>>'{field}'` here would give the same
    // result and would NOT use the index: the query would go from milliseconds to
    // seconds without anything failing.
    const c = sqlOf(filterCondition({ field: "rarity", equal: "legendary" }));
    expect(c).toContain("data->>");
  });

  it("a numeric filter discards what the field does not declare", () => {
    // If you search "damage > 100" and things without damage show up, you think they have
    // been compared. That is why the condition always carries an IS NOT NULL.
    const c = sqlOf(filterCondition({ field: "damage", min: 100 }));
    expect(c).toContain("IS NOT NULL");
  });

  it("title and status are columns, not data fields", () => {
    const c = sqlOf(filterCondition({ field: "status", equal: "published" }));
    expect(c).not.toContain("data->>");
  });
});

describe("comparison between different entries", () => {
  it("returns ONLY the fields where there is a difference", () => {
    // The question that brings someone to a comparator is "how do they differ".
    // Showing forty rows of which thirty-eight are identical hides the
    // answer in noise.
    const dif = compareInputs([
      { id: "a", title: "Sword A", data: { damage: 100, weight: 5, type: "sword" } },
      { id: "b", title: "Sword B", data: { damage: 120, weight: 5, type: "sword" } },
    ]);

    expect(dif).toHaveLength(1);
    expect(dif[0]!.field).toBe("damage");
    expect(dif[0]!.values).toEqual({ a: 100, b: 120 });
  });

  it("a field that only one of the two has IS a difference", () => {
    const dif = compareInputs([
      { id: "a", title: "A", data: { damage: 100, bleed: 50 } },
      { id: "b", title: "B", data: { damage: 100 } },
    ]);
    expect(dif.map((d) => d.field)).toEqual(["bleed"]);
    expect(dif[0]!.values).toEqual({ a: 50, b: null });
  });

  it("a field that NEITHER declares does not appear", () => {
    const dif = compareInputs([
      { id: "a", title: "A", data: { damage: 100 } },
      { id: "b", title: "B", data: { damage: 100 } },
    ]);
    expect(dif).toEqual([]);
  });

  it("compares complex values by content, not by reference", () => {
    // Two arrays with the same content are different objects in JS. Comparing
    // with === would deem them different ALWAYS, and the comparator would show every
    // list field as if it had changed.
    const dif = compareInputs([
      { id: "a", title: "A", data: { tags: ["fire", "sword"] } },
      { id: "b", title: "B", data: { tags: ["fire", "sword"] } },
    ]);
    expect(dif).toEqual([]);
  });

  it("handles entries without data", () => {
    const dif = compareInputs([
      { id: "a", title: "A", data: null },
      { id: "b", title: "B", data: { x: 1 } },
    ]);
    expect(dif.map((d) => d.field)).toEqual(["x"]);
  });
});

// kitsuden-test: needs-no-kons (names kon-gamedata to check that it is NOT there)
describe("kon-gamedata must not come back", () => {
  it("there is no kon that duplicates the datasets store", async () => {
    // It was written and deleted: it duplicated `data_sets` / `data_entries` with parallel
    // tables. Two places where "one entity" lives do not give an error the day
    // someone imports into one and searches the other — they give zero results.
    //
    // This test is not paranoia: the kon did exist, with a migration and everything,
    // because the search for duplicates covered `packages/kons/` and never `packages/core/`.
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(existsSync(join(process.cwd(), "packages/kons/kon-gamedata"))).toBe(false);
  });
});
