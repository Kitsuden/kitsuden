/**
 * The formula evaluator that replaced `new Function` (so the panel's CSP can
 * drop 'unsafe-eval'): the builder's operators with the builder's meaning, and
 * nothing that is not a formula.
 */
import { describe, expect, it } from "vitest";

import { evaluateFormula, FormulaError } from "./evaluate";

describe("evaluateFormula", () => {
  it("arithmetic with precedence, power right-associative, unary minus", () => {
    expect(evaluateFormula("1 + 2 * 3")).toBe(7);
    expect(evaluateFormula("(1 + 2) * 3")).toBe(9);
    expect(evaluateFormula("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluateFormula("-2 ^ 2")).toBe(4);
    expect(evaluateFormula("10 % 4 - 1")).toBe(1);
    expect(evaluateFormula("100 * 0.21")).toBeCloseTo(21);
  });

  it("comparisons and concatenation as the builder documents them", () => {
    expect(evaluateFormula("100 = 100")).toBe(true);
    expect(evaluateFormula("100 != 100")).toBe(false);
    expect(evaluateFormula("3 >= 2")).toBe(true);
    expect(evaluateFormula("'Sample' & ' ' & 2")).toBe("Sample 2");
    expect(evaluateFormula("'a' = 'a'")).toBe(true);
  });

  it("fields come from the context, own properties only", () => {
    expect(evaluateFormula("price * quantity", { price: 5, quantity: 3 })).toBe(15);
    expect(() => evaluateFormula("constructor", {})).toThrow(FormulaError);
    expect(() => evaluateFormula("missing + 1", { price: 1 })).toThrow(FormulaError);
  });

  it("anything that is not a formula is an error, never code", () => {
    for (const bad of [
      "alert(1)",
      "price; fetch('/api')",
      "this.constructor",
      "[1,2]",
      "a => a",
      "1 +",
      "(1",
      "`x`",
    ]) {
      expect(() => evaluateFormula(bad, { price: 1, a: 1, alert: 1 }), bad).toThrow();
    }
  });
});
