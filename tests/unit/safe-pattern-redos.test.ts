/**
 * ReDoS in `validationRegex` (security review F4)
 *
 * The previous filter was a regex over the pattern's text: it did not see
 * through nested parentheses (`^((a+))+$`) nor polynomial patterns without
 * groups (`^a*a*a*a*a*b$`). Now the pattern is analysed with a real reader.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_LENGTH_TO_TEST,
  riskyPattern,
  safePattern,
  testPattern,
} from "../../packages/shared/src/safe-pattern";

const DANGEROUS = [
  // Repeated groups with something variable inside, at any depth
  "^((a+))+$",
  "^(((a+)))+$",
  "^(?:(?:a+))+$",
  "^(?:a+){2}$",
  "^(\\((a+)\\))+$",
  "^([)]+)+$",
  "^(a?){25}a{25}$",
  "^(ab|a)*c$",
  "^(?:\\w|\\d)+$",
  "^(?=(a+)+b)",
  "^(?<g>a+)+$",
  // Polynomial without groups: quantifiers that share the characters
  "^a*a*a*a*a*b$",
  "^.*a.*a.*a.*b$",
  "^[\\s\\S]*,[\\s\\S]*,[\\s\\S]*$",
  "^\\d+\\d+\\d+x$",
  "a*a*b",
  "\\S+@\\S+$",
  "^(a+)?(a+)?(a+)?b$",
  "^" + "a?".repeat(30) + "a{30}$",
  "^\\d{1,100}\\d{1,100}\\d{1,100}\\d{1,100}\\d{1,100}x$",
  // Backreferences
  "(a)\\1",
  "(?<x>a)\\k<x>",
];

const NORMAL = [
  "^[A-Z]{3}-\\d{4}$",
  "^\\S+@\\S+$",
  "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
  "^(es|en|pt)$",
  "^\\d+(\\.\\d+)?$",
  "^-?\\d+(\\.\\d+)?$",
  "^-?\\d+(\\.\\d+)?(e\\d+)?$",
  "^\\(\\d{3}\\) \\d+$",
  "^https?://.+$",
  "^\\d{5}(-\\d{4})?$",
  "^\\+?\\d{1,3}[- ]?\\d{3}[- ]?\\d{4}$",
  "^#?[0-9a-fA-F]{6}$",
  "^#[0-9a-fA-F]{3,8}$",
  "^[a-z0-9-]+$",
  "^[A-Za-z0-9._:/-]*$",
  "^[\\w.:/@-]+$",
  "^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$",
  "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
  "^-?\\d{1,15}(\\.\\d{1,4})?$",
  "^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$",
  "^.*a.*$",
  "\\d+\\.\\d+",
  "[{}]",
  "^a{,3}$",
  "^[\\]\\-\\\\]+$",
];

describe("safePattern: pattern analysis (F4)", () => {
  it("rejects catastrophic patterns even when hidden in nested parentheses or without groups", () => {
    for (const p of DANGEROUS) {
      expect(() => new RegExp(p), p).not.toThrow();
      expect(safePattern(p), p).toBeNull();
    }
  });

  it("still accepts the normal patterns of a field", () => {
    for (const p of NORMAL) expect(safePattern(p), p).toBeInstanceOf(RegExp);
  });

  it("a pattern the reader does not understand is treated as risky", () => {
    expect(riskyPattern("(")).toBe(true);
  });

  it("dangerous patterns are never run: nothing takes time", () => {
    const start = performance.now();
    for (const p of DANGEROUS) {
      expect(testPattern(p, "a".repeat(MAX_LENGTH_TO_TEST - 1) + "!"), p).toBe(true);
    }
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("the worst case of an accepted pattern (degree 2) with the longest value is still fast", () => {
    const value = "@".repeat(MAX_LENGTH_TO_TEST - 1) + " ";
    const start = performance.now();
    expect(testPattern("^\\S+@\\S+$", value)).toBe(false);
    expect(testPattern("^a*a*b$", "a".repeat(MAX_LENGTH_TO_TEST))).toBe(false);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it("a value above the cap is not tested", () => {
    expect(testPattern("^a+$", "a".repeat(MAX_LENGTH_TO_TEST + 1))).toBe(false);
    expect(testPattern("^a+$", "a".repeat(MAX_LENGTH_TO_TEST))).toBe(true);
  });
});
