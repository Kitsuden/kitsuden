/**
 * The repository's deepmerge (packages/deepmerge, linked over every `deepmerge` by the
 * root pnpm override) closes GHSA-gcqx-w48m-w2h4: an own `__proto__` key in a source,
 * which `JSON.parse` produces, used to become the prototype of the merged object.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const require = createRequire(import.meta.url);
const deepmerge = require(join(root, "packages", "deepmerge")) as (
  a: unknown,
  b: unknown,
  o?: unknown
) => Record<string, unknown>;

describe("deepmerge without prototype poisoning", () => {
  it("an own __proto__ key does not change the prototype of the result", () => {
    const merged = deepmerge({ a: 1 }, JSON.parse('{"__proto__": {"polluted": true}, "b": 2}'));
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect((merged as { polluted?: boolean }).polluted).toBeUndefined();
    expect(merged).toEqual({ a: 1, b: 2 });
  });

  it("nested, and through constructor.prototype, nothing leaks either", () => {
    const merged = deepmerge(
      { inner: { x: 1 } },
      JSON.parse('{"inner": {"__proto__": {"p": 1}}, "constructor": {"prototype": {"q": 1}}}')
    );
    expect(Object.getPrototypeOf(merged.inner)).toBe(Object.prototype);
    expect(({} as { p?: number; q?: number }).p).toBeUndefined();
    expect(({} as { q?: number }).q).toBeUndefined();
    expect(merged).toEqual({ inner: { x: 1 } });
  });

  it("still merges as before: nested objects, arrays concatenated or replaced", () => {
    expect(deepmerge({ a: { b: 1 }, l: [1] }, { a: { c: 2 }, l: [2] })).toEqual({
      a: { b: 1, c: 2 },
      l: [1, 2],
    });
    const replace = { arrayMerge: (_t: unknown[], s: unknown[]) => s };
    expect(deepmerge({ l: [1] }, { l: [2] }, replace)).toEqual({ l: [2] });
  });

  it("every deepmerge in the lockfile is this one", () => {
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    expect(lock).not.toMatch(/^\s+'?deepmerge@\d/m);
    expect(lock).toContain("deepmerge: link:./packages/deepmerge");
  });
});
