/**
 * Security (data): computed fields of datasets do NOT execute code
 * ============================================================================
 *
 * `evaluateExpression` did `new Function("return " + expression)()` with the
 * row values pasted in as text. Anyone who could save a formula
 * (and a free account used to be enough) executed code on the server when listing
 * `GET /api/datasets/:id/entries?includeCalculated=true`.
 * And even if the formula was harmless, a text VALUE ending in `\` closed
 * the string and executed whatever came after it.
 *
 * These tests fail with the previous version: the global marker gets set.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateCalculatedField,
  evaluateExpression,
} from "../../packages/core/datasets/datasets.calculated";
import {
  inferTableName,
  allowedRelatedTable,
} from "../../packages/core/datasets/datasets.snapshots";
import {
  evaluateSafeExpression,
  EXPRESSION_LIMITS,
} from "../../packages/core/datasets/safe-expression";

const g = globalThis as Record<string, unknown>;

afterEach(() => {
  delete g.__sec_expr_pwned;
});

const rowValue = (row: Record<string, unknown>) => ({ row });

describe("evaluateExpression does not execute code", () => {
  it("a formula with JS code returns null and does not execute it", () => {
    for (const malicious of [
      "globalThis.__sec_expr_pwned = 1",
      "(globalThis.__sec_expr_pwned = 1, 2)",
      "(1).constructor.constructor('globalThis.__sec_expr_pwned = 1')()",
      "this.constructor.constructor('globalThis.__sec_expr_pwned = 1')()",
      "process.exit(1)",
      "[].map.constructor('globalThis.__sec_expr_pwned=1')()",
      "{x}.constructor",
      "`${globalThis.__sec_expr_pwned = 1}`",
    ]) {
      expect(evaluateExpression(malicious, rowValue({ x: 1 })), malicious).toBeNull();
      expect(g.__sec_expr_pwned, malicious).toBeUndefined();
    }
  });

  it("a text field's VALUE cannot close the string and inject", () => {
    // With the previous version the `\` in the value escaped the slash that the
    // «escaping» added, the next quote closed the string and what came
    // after it was executed: `"\\" + (globalThis.x = 1) //"`.
    const B = "\\";
    const value = `${B}" + (globalThis.__sec_expr_pwned = 1) //`;
    const r = evaluateExpression("{name}", rowValue({ name: value }));
    expect(g.__sec_expr_pwned).toBeUndefined();
    expect(r).toBe(value);

    const r2 = evaluateExpression(
      "{a} + {b}",
      rowValue({ a: `x${B}`, b: "); globalThis.__sec_expr_pwned=1;//" })
    );
    expect(g.__sec_expr_pwned).toBeUndefined();
    expect(r2).toBe(`x${B}); globalThis.__sec_expr_pwned=1;//`);
  });

  it("a field named like the prototype reaches nothing", () => {
    expect(evaluateSafeExpression("{constructor} + 1", {})).toBe(1);
    expect(evaluateSafeExpression("{__proto__} + 1", {})).toBe(1);
  });

  it("still computes what it used to compute", () => {
    const row = { price: 10, quantity: 3, discount: 0.5, name: "Sword", level: 7, active: true };
    expect(evaluateExpression("{price} * {quantity} * (1 - {discount})", rowValue(row))).toBe(15);
    expect(evaluateExpression("Math.round({price} / 3)", rowValue(row))).toBe(3);
    expect(evaluateExpression("max({price}, {quantity}, 42)", rowValue(row))).toBe(42);
    expect(evaluateExpression('{name} + " (" + {level} + ")"', rowValue(row))).toBe("Sword (7)");
    expect(evaluateExpression('{level} >= 5 ? "high" : "low"', rowValue(row))).toBe("high");
    expect(evaluateExpression("{active} && {price} > 5", rowValue(row))).toBe(true);
    expect(evaluateExpression("2 ** 10 % 1000", rowValue(row))).toBe(24);
    expect(evaluateExpression("-{price} + {noValue}", rowValue(row))).toBe(-10);
    // A computed field of formula type goes through the same interpreter.
    expect(
      evaluateCalculatedField(
        { type: "formula", config: { expression: "{price} * 2" } } as never,
        rowValue(row)
      )
    ).toBe(20);
  });

  it("limits: length, nesting and number of pieces", () => {
    expect(
      evaluateExpression("1+".repeat(EXPRESSION_LIMITS.length) + "1", rowValue({}))
    ).toBeNull();
    const deep = "(".repeat(100) + "1" + ")".repeat(100);
    expect(evaluateExpression(deep, rowValue({}))).toBeNull();
    const negations = "-".repeat(1500) + "1";
    expect(evaluateExpression(negations, rowValue({}))).toBeNull();
    // Within the limits, it works.
    expect(evaluateExpression("(".repeat(20) + "1" + ")".repeat(20), rowValue({}))).toBe(1);
  });
});

describe("snapshots: never copy rows from account or secret tables", () => {
  it("rejects the banned tables and accepts the content ones", () => {
    for (const field of [
      "auth_account_id",
      "authAccountId",
      "session_id",
      "user_id",
      "api_key_id",
      "agent_id",
    ]) {
      expect(allowedRelatedTable(inferTableName(field)), field).toBe(false);
    }
    for (const field of ["weapon_id", "characterId"]) {
      expect(allowedRelatedTable(inferTableName(field)), field).toBe(true);
    }
    expect(allowedRelatedTable('weapons"; drop table x; --')).toBe(false);
  });
});
