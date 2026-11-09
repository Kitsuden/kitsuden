/**
 * Dataset indexes: a field's key cannot inject SQL
 * ============================================================================
 *
 * Audit (A2): `datasets.indexes.ts` put `field.key` inside
 * a `CREATE INDEX … (data->>'<key>')` run with `sql.raw`. The key is
 * written by an editor; the index is applied by an admin. Now a key that is not
 * a simple identifier generates no index, and the index name is always
 * a clean identifier.
 */

import { describe, expect, it } from "vitest";

import { suggestIndexesForDataset } from "../../packages/core/datasets/datasets.indexes";

describe("index suggestions", () => {
  it("a key with quotes or semicolons generates no SQL", () => {
    const bad = ["x')); DROP TABLE auth_users; --", "a'b", "a;b", "a b", "a)--"];
    for (const key of bad) {
      expect(suggestIndexesForDataset("games", { fields: [{ key, type: "date" }] }), key).toEqual(
        []
      );
    }
  });

  it("a normal key still gives its index, with a clean name even if the slug has hyphens", () => {
    const [s] = suggestIndexesForDataset("my-games", {
      fields: [{ key: "release_date", type: "date" }],
    });
    expect(s!.sql).toBe(
      "CREATE INDEX idx_my_games_release_date_btree ON data_entries (((data->>'release_date')::timestamp));"
    );
    expect(s!.table).toBe("my-games");
  });

  it("a slug with quotes does not break the index name", () => {
    const [s] = suggestIndexesForDataset("a'; drop table x; --", {
      fields: [{ key: "n", type: "number" }],
    });
    expect(s!.sql).not.toMatch(/[';]\s*drop/i);
    expect(s!.sql).toMatch(/^CREATE INDEX [a-z0-9_]{1,63} ON data_entries /);
  });
});
