/**
 * Data explorer: sorting and writing secret or read-only columns (H25, H26, 2026-11-20).
 *
 * `?sort=` accepted a secret column, so the order of the rows answered "is this token
 * before or after ab?" one request at a time. And the dynamic create/update stripped the
 * read-only fields by the key as sent, then wrote the key with its odd characters removed:
 * `"i-d"` wrote `id` past the read-only list, and `"api-token"` wrote `apitoken`-style
 * names nobody checked. Keys are now checked exactly as they will be written.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ExplorerQueryError,
  checkSortField,
  writableFields,
} from "../../apps/api/src/lib/explorer-query";

const ROUTE = readFileSync(join(__dirname, "../../apps/api/src/routes/data-explorer.ts"), "utf8");

describe("explorer sort", () => {
  it("refuses a secret column by key or by SQL name", () => {
    expect(() => checkSortField("api_token")).toThrow(ExplorerQueryError);
    expect(() => checkSortField("apiToken")).toThrow(ExplorerQueryError);
    expect(() => checkSortField("label", "password_hash")).toThrow(ExplorerQueryError);
  });

  it("lets an ordinary column through", () => {
    expect(() => checkSortField("created_at", "createdAt")).not.toThrow();
    expect(() => checkSortField(null, undefined)).not.toThrow();
    // An LLM's counters are not secrets.
    expect(() => checkSortField("tokens_in")).not.toThrow();
  });

  it("both list handlers check the sort", () => {
    expect(ROUTE).toContain("checkSortField(sortField, meta.table[sortField]?.name)");
    expect(ROUTE).toContain("checkSortField(sortField, safeSort)");
  });
});

describe("explorer dynamic writes", () => {
  const readonly = ["id", "created_at"];

  it("refuses a key that is not a plain identifier instead of sanitising it", () => {
    expect(() => writableFields({ "i-d": 5 }, readonly)).toThrow(ExplorerQueryError);
    expect(() => writableFields({ 'name" = 1; --': "x" }, readonly)).toThrow(ExplorerQueryError);
    expect(() => writableFields({ "created at": "x" }, readonly)).toThrow(ExplorerQueryError);
  });

  it("refuses a secret column", () => {
    expect(() => writableFields({ api_token: "x" }, readonly)).toThrow(/secret/);
    expect(() => writableFields({ passwordHash: "x" }, readonly)).toThrow(/secret/);
  });

  it("drops the read-only fields and keeps the rest", () => {
    expect({ ...writableFields({ id: 1, created_at: "x", name: "a" }, readonly) }).toEqual({
      name: "a",
    });
  });

  it("refuses a body that is not an object", () => {
    expect(() => writableFields([1, 2], readonly)).toThrow(ExplorerQueryError);
    expect(() => writableFields(null, readonly)).toThrow(ExplorerQueryError);
  });

  it("a `__proto__` key stays a key, not a prototype", () => {
    const fields = writableFields(JSON.parse('{"__proto__": {"x": 1}, "name": "a"}'), readonly);
    expect(Object.keys(fields)).toEqual(["__proto__", "name"]);
    expect((fields as { x?: unknown }).x).toBeUndefined();
  });

  it("the dynamic create and update use it, and the typed ones refuse secrets", () => {
    expect(
      ROUTE.match(/writableFields\(await c\.req\.json\(\), meta\.readonlyFields\)/g)
    ).toHaveLength(2);
    expect(ROUTE.match(/const secret = secretFieldOf\(meta, body\)/g)).toHaveLength(2);
  });
});
