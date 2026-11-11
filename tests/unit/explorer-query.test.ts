/**
 * The list query of the data explorer (apps/api/src/lib/explorer-query.ts).
 *
 * `GET /api/explorer/:collection` used to ignore `search` and honour one `filter_field`:
 * the panel's search box filtered a single column, and a second filter silently replaced
 * the first. The parser now reads a search across columns and several filters, and refuses
 * what it cannot honour instead of answering with the whole table.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXPLORER_QUERY_LIMITS,
  ExplorerQueryError,
  isTextualPgType,
  likePattern,
  parseExplorerQuery,
  searchableColumns,
} from "../../apps/api/src/lib/explorer-query";

const q = (params: string) => {
  const out: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(params)) (out[key] ??= []).push(value);
  return parseExplorerQuery(out);
};

describe("parseExplorerQuery", () => {
  it("no parameters: no conditions and no search", () => {
    expect(q("limit=25&page=2&sort=name")).toEqual({
      conditions: [],
      search: null,
      searchFields: null,
    });
  });

  it("the older single filter still works, `contains` by default", () => {
    expect(q("filter_field=email&filter_value=@gmail.com").conditions).toEqual([
      { field: "email", op: "contains", value: "@gmail.com", legacy: true },
    ]);
    expect(q("filter_field=status&filter_op=equals&filter_value=draft").conditions).toEqual([
      { field: "status", op: "equals", value: "draft", legacy: true },
    ]);
  });

  it("the older filter without a value is no filter, as before", () => {
    expect(q("filter_field=email").conditions).toEqual([]);
    expect(q("filter_value=x").conditions).toEqual([]);
  });

  it("several filters at once, each with its operator", () => {
    const { conditions } = q(
      "filter[status]=draft&filter[featured]=true&filter[created_at][gte]=2026-01-01&filter[created_at][lte]=2026-02-01"
    );
    expect(conditions).toEqual([
      { field: "status", op: "equals", value: "draft", legacy: false },
      { field: "featured", op: "equals", value: "true", legacy: false },
      { field: "created_at", op: "gte", value: "2026-01-01", legacy: false },
      { field: "created_at", op: "lte", value: "2026-02-01", legacy: false },
    ]);
  });

  it("the new filters and the older one add up", () => {
    const { conditions } = q("filter[status]=draft&filter_field=name&filter_value=ana");
    expect(conditions.map((c) => `${c.field}:${c.op}`)).toEqual(["status:equals", "name:contains"]);
  });

  it("an empty filter value is a filter that is not set", () => {
    expect(q("filter[status]=").conditions).toEqual([]);
  });

  it("an unknown operator is refused, never read as 'no filter'", () => {
    expect(() => q("filter[name][starts_with]=a")).toThrow(ExplorerQueryError);
    expect(() => q("filter_field=name&filter_op=starts_with&filter_value=a")).toThrow(
      /Unsupported filter operator: "starts_with"/
    );
    try {
      q("filter[name][like]=a");
    } catch (error) {
      expect((error as ExplorerQueryError).supported).toContain("contains");
    }
  });

  it("a field that is not an identifier is refused", () => {
    expect(() => q('filter[name"; drop table x; --]=a')).toThrow(/Malformed filter field/);
    expect(() => q("filter[]=a")).toThrow(/Malformed filter field/);
  });

  it("a secret column cannot be filtered or searched: no oracle on tokens", () => {
    expect(() => q("filter[password_hash][contains]=a")).toThrow(/Cannot filter or search/);
    expect(() => q("filter_field=api_token&filter_value=a")).toThrow(/Cannot filter or search/);
    expect(() => q("search=a&search_fields=name,secret")).toThrow(/Cannot filter or search/);
  });

  it("search is trimmed; only spaces is no search", () => {
    expect(q("search=%20ana%20").search).toBe("ana");
    expect(q("search=%20%20").search).toBeNull();
  });

  it("search_fields narrows the search", () => {
    expect(q("search=ana&search_fields=name,%20email").searchFields).toEqual(["name", "email"]);
    expect(q("search=ana").searchFields).toBeNull();
  });

  it("limits: filters and search length", () => {
    const many = Array.from(
      { length: EXPLORER_QUERY_LIMITS.conditions + 1 },
      (_, i) => `filter[c${i}]=x`
    ).join("&");
    expect(() => q(many)).toThrow(/At most/);
    expect(() => q(`search=${"a".repeat(EXPLORER_QUERY_LIMITS.search + 1)}`)).toThrow(/limited/);
  });
});

describe("search helpers", () => {
  it("likePattern takes the user's wildcards literally", () => {
    expect(likePattern("50%")).toBe("%50\\%%");
    expect(likePattern("a_b")).toBe("%a\\_b%");
    expect(likePattern("a\\b")).toBe("%a\\\\b%");
  });

  it("searchableColumns drops secret columns and checks the requested ones", () => {
    expect(searchableColumns(["name", "email", "api_token"], null)).toEqual(["name", "email"]);
    expect(searchableColumns(["name", "email"], ["email"])).toEqual(["email"]);
    expect(() => searchableColumns(["name"], ["age"])).toThrow(/Not a searchable column: age/);
  });

  it("isTextualPgType: text-like types only", () => {
    for (const type of ["text", "character varying", "varchar(255)", "uuid", "citext"]) {
      expect(isTextualPgType(type)).toBe(true);
    }
    for (const type of ["integer", "boolean", "timestamp with time zone", "jsonb", "numeric"]) {
      expect(isTextualPgType(type)).toBe(false);
    }
  });
});

describe("the route uses the parser on both paths", () => {
  const route = readFileSync(
    join(import.meta.dirname, "..", "..", "apps", "api", "src", "routes", "data-explorer.ts"),
    "utf8"
  );

  it("the typed and the dynamic list both read the query through it", () => {
    expect(route.match(/readListQuery\(c\)/g)?.length).toBe(2);
    expect(route).toContain("typedWhere(meta, listQuery)");
    expect(route).toContain("dynamicWhere(tableName, listQuery)");
    // The one-filter reads are gone: nothing honours a single `filter_field` on its own.
    expect(route).not.toContain('c.req.query("filter_field")');
  });

  it("count and page share one WHERE", () => {
    expect(route).toContain("FROM ${table}${whereSql}`");
    expect(route.match(/\$\{whereSql\}/g)?.length).toBe(2);
  });
});
