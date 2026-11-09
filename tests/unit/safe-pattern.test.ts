/**
 * Validation patterns without ReDoS (earlier audit)
 *
 * `^(a+)+$` against "aaaa…!" used to hang the API event loop. Risky
 * patterns are ignored and the tested value has a cap.
 */
import { describe, expect, it } from "vitest";

import { safePattern, testPattern } from "../../packages/shared/src/safe-pattern";

describe("safePattern", () => {
  it("rejects exponential backtracking patterns and backreferences", () => {
    for (const p of [
      "^(a+)+$",
      "(a|aa)*",
      "(\\w*)*",
      "^(x+x+)+y$",
      "(a{1,9})+",
      "(a)\\1",
      "(?<x>a)\\k<x>",
      "x".repeat(300),
    ]) {
      expect(safePattern(p), p).toBeNull();
    }
  });

  it("accepts normal patterns", () => {
    for (const p of [
      "^[A-Z]{3}-\\d{4}$",
      "^\\S+@\\S+$",
      "^(es|en|pt)$",
      "^\\d+(\\.\\d+)?$",
      "^\\(\\d{3}\\) \\d+$",
    ]) {
      expect(safePattern(p), p).toBeInstanceOf(RegExp);
    }
  });

  it("a catastrophic pattern is not tested and does not hang", () => {
    const start = Date.now();
    expect(testPattern("^(a+)+$", "a".repeat(40) + "!")).toBe(true);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("a huge value is not tested", () => {
    expect(testPattern("^a+$", "a".repeat(20_000))).toBe(false);
  });
});
