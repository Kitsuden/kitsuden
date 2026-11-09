/**
 * Equality of dataset filters
 * ============================================================================
 *
 * `evaluateCondition` compared with `==`. It looks harmless —the filter arrives
 * as text and the data lives in JSONB, so coercion is needed— but `==`
 * brings its own rules as a freebie: `"" == 0` is true. Translated to the
 * product: a `stock eq 0` filter also returned the rows where the field
 * is EMPTY, which is exactly the opposite of what the user asked for.
 *
 * And `in` did not use `==` but `includes`, that is `===`, so two sibling
 * operators gave different answers for the same data.
 *
 * These tests pin down the criterion: coerce where it means something and
 * leave empty out.
 */

import { describe, expect, it } from "vitest";

import { evaluateCondition, sameValue } from "../../packages/core/datasets/datasets.calculated";

const row = (fields: Record<string, unknown>) => ({ row: fields }) as never;

describe("sameValue", () => {
  it("crosses text and number, which is what the lax operator was asked for", () => {
    expect(sameValue(30, "30")).toBe(true);
    expect(sameValue("30", 30)).toBe(true);
    expect(sameValue(30.5, "30.50")).toBe(true);
    expect(sameValue(30, "31")).toBe(false);
  });

  it("does NOT treat empty as zero — the regression that motivated all this", () => {
    expect(sameValue(0, "")).toBe(false);
    expect(sameValue("", 0)).toBe(false);
    expect(sameValue(0, "   ")).toBe(false);
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue(0, false)).toBe(false);
  });

  it("null and undefined are the same 'no value', and match nothing else", () => {
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, "")).toBe(false);
    expect(sameValue(undefined, 0)).toBe(false);
  });

  it("accepts 'true'/'false' from a form, but not 0/1", () => {
    expect(sameValue(true, "true")).toBe(true);
    expect(sameValue(false, "false")).toBe(true);
    expect(sameValue(true, "false")).toBe(false);
    // `1 == true` in JS. Not here: if the field is boolean, it is compared as such.
    expect(sameValue(true, 1)).toBe(false);
    expect(sameValue(false, 0)).toBe(false);
    expect(sameValue(false, "")).toBe(false);
  });

  it("compares dates by instant, not by object identity", () => {
    expect(sameValue(new Date("2026-01-01"), new Date("2026-01-01"))).toBe(true);
    expect(sameValue(new Date("2026-01-01"), "2026-01-01")).toBe(true);
    expect(sameValue(new Date("2026-01-01"), new Date("2026-01-02"))).toBe(false);
    expect(sameValue(new Date("2026-01-01"), "is not a date")).toBe(false);
  });
});

describe("evaluateCondition", () => {
  it("eq finds the number stored as text", () => {
    expect(
      evaluateCondition({ field: "age", operator: "eq", value: 30 } as never, row({ age: "30" }))
    ).toBe(true);
  });

  it("eq 0 no longer drags in the empty rows", () => {
    const cond = { field: "stock", operator: "eq", value: 0 } as never;
    expect(evaluateCondition(cond, row({ stock: 0 }))).toBe(true);
    expect(evaluateCondition(cond, row({ stock: "" }))).toBe(false);
    expect(evaluateCondition(cond, row({ stock: null }))).toBe(false);
  });

  it("neq is the exact negation of eq, not a loose `!=`", () => {
    const eq = { field: "stock", operator: "eq", value: 0 } as never;
    const neq = { field: "stock", operator: "neq", value: 0 } as never;
    for (const value of [0, "", null, "0", 1, false]) {
      expect(evaluateCondition(neq, row({ stock: value }))).toBe(
        !evaluateCondition(eq, row({ stock: value }))
      );
    }
  });

  it("in uses the same criterion as eq", () => {
    // Before: `eq 30` found `"30"` but `in [30]` did not.
    const inside = { field: "age", operator: "in", value: [30, 40] } as never;
    expect(evaluateCondition(inside, row({ age: "30" }))).toBe(true);
    expect(evaluateCondition(inside, row({ age: 40 }))).toBe(true);
    expect(evaluateCondition(inside, row({ age: "35" }))).toBe(false);
    expect(evaluateCondition(inside, row({ age: "" }))).toBe(false);
  });

  it("empty still distinguishes empty from zero", () => {
    const empty = { field: "note", operator: "empty", value: null } as never;
    expect(evaluateCondition(empty, row({ note: "" }))).toBe(true);
    expect(evaluateCondition(empty, row({ note: null }))).toBe(true);
    expect(evaluateCondition(empty, row({ note: 0 }))).toBe(false);
  });
});
