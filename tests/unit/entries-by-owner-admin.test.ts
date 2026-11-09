/**
 * `buildDatasetWhere` and datasets with owner rules.
 *
 * The admin got 0 rows from `GET /api/data-sets/:id/entries` for a dataset
 * with owner `rlsRules`, because the rule `data->>'ownerId' = <user>` was
 * applied to them too. The admin sees everything; any other role (editor included)
 * is still filtered by the rules.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import { buildDatasetWhere, type RLSRule } from "../../packages/shared/src/rls-builder";

const dialect = new PgDialect();
const DS = "11111111-1111-4111-8111-111111111111";
const rules: RLSRule[] = [{ field: "ownerId", operator: "eq", value: "__USER_ID__" }];

function sqlOf(role: string | undefined, id = "u-1") {
  const { where, hasRLS } = buildDatasetWhere(DS, rules, { id, role });
  return { text: dialect.sqlToQuery(where!).sql, hasRLS };
}

describe("buildDatasetWhere with owner rules", () => {
  test("admin: only the dataset filter, no owner rule", () => {
    const r = sqlOf("admin");
    expect(r.hasRLS).toBe(false);
    expect(r.text).not.toContain("->>");
  });

  test.each(["user", "editor", undefined])("role %s: still filtered by owner", (role) => {
    const r = sqlOf(role);
    expect(r.hasRLS).toBe(true);
    expect(r.text).toContain("->>");
  });

  test("anonymous: the rule with __USER_ID__ lets nothing through", () => {
    const { where } = buildDatasetWhere(DS, rules, null);
    expect(dialect.sqlToQuery(where!).sql).toContain("1 = 0");
  });
});
