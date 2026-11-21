/**
 * rls-builder: an rlsRule with an unknown operator fails closed (H86, 2026-11-20).
 *
 * `buildRuleCondition` returned null for an operator it did not know, and
 * `buildDrizzleWhere` dropped the rule. A dataset whose only rule had a typo or a
 * newer operator was then read with no row filter at all. Now the rule becomes
 * `1 = 0`: nobody meets it, which is what realtime's `meetsRule` already did.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test, vi } from "vitest";

import { queryWouldSkipIsolation } from "../../apps/api/src/routes/datasets-query";
import {
  buildDatasetWhere,
  buildDrizzleWhere,
  createRLSFilter,
  type PolicyJson,
  type RLSRule,
} from "../../packages/shared/src/rls-builder";

const dialect = new PgDialect();
const DS = "11111111-1111-4111-8111-111111111111";
const unknown = [
  { field: "ownerId", operator: "equals", value: "__USER_ID__" },
] as unknown as RLSRule[];

describe("rls-builder with an unknown operator", () => {
  test("buildDrizzleWhere keeps the rule as an impossible condition", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const where = buildDrizzleWhere(unknown, { id: "u-1", role: "user" });
    warn.mockRestore();
    expect(where).toBeDefined();
    expect(dialect.sqlToQuery(where!).sql).toContain("1 = 0");
  });

  test("buildDatasetWhere filters the non-admin to nothing, not to everything", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { where, hasRLS } = buildDatasetWhere(DS, unknown, { id: "u-1", role: "editor" });
    warn.mockRestore();
    expect(hasRLS).toBe(true);
    expect(dialect.sqlToQuery(where!).sql).toContain("1 = 0");
  });

  test("an unknown operator next to a valid rule still closes the read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rules = [
      { field: "status", operator: "eq", value: "published" },
      { field: "ownerId", operator: "in", value: "__USER_ID__" },
    ] as unknown as RLSRule[];
    const text = dialect.sqlToQuery(buildDrizzleWhere(rules, { id: "u-1" })!).sql;
    warn.mockRestore();
    expect(text).toContain("1 = 0");
    expect(text).toContain("->>");
  });

  test("the admin still sees everything, as before", () => {
    const { hasRLS } = buildDatasetWhere(DS, unknown, { id: "u-1", role: "admin" });
    expect(hasRLS).toBe(false);
  });

  test("the legacy in-memory filter refuses the row too", () => {
    const policy = {
      readAccess: "authenticated",
      writeAccess: "admin",
      enableRLS: true,
      rlsRules: unknown,
    } as PolicyJson;
    const filter = createRLSFilter(policy, { id: "u-1" })!;
    expect(filter({ data: { ownerId: "u-1" } })).toBe(false);
  });

  test("the raw query route treats such a dataset as isolated", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const skips = queryWouldSkipIsolation(
      { readAccess: "public", writeAccess: "admin", enableRLS: true, rlsRules: unknown },
      { id: "u-1", role: "user" }
    );
    warn.mockRestore();
    expect(skips).toBe(true);
  });

  test("known operators are unchanged", () => {
    const rules: RLSRule[] = [{ field: "ownerId", operator: "eq", value: "__USER_ID__" }];
    const text = dialect.sqlToQuery(buildDrizzleWhere(rules, { id: "u-1" })!).sql;
    expect(text).not.toContain("1 = 0");
    expect(text).toContain("->>");
  });
});
