/**
 * The promotion scanner does not classify a path by its first literal
 * (security review F73): `kitsuden.api.delete("/api/ad" + "min/users/1")`
 * arrived as `DELETE /api/ad`, which is not sensitive, and was activated on
 * its own in turbo.
 */
import { describe, expect, it } from "vitest";

import { scanCode } from "../../packages/shared/src/code-scan";

const paths = (code: string) => scanCode(code).apiCalls.map((c) => [c.method, c.path]);

describe("scanCode: the literal must be the whole argument", () => {
  it("a literal followed by `)` or `,` is classified as before", () => {
    expect(paths('await kitsuden.api.get("/api/items")')).toEqual([["GET", "/api/items"]]);
    expect(paths('await kitsuden.api.post("/api/items", { a: 1 })')).toEqual([
      ["POST", "/api/items"],
    ]);
    expect(paths('await kitsuden.api.request("DELETE", "/api/items/1")')).toEqual([
      ["DELETE", "/api/items/1"],
    ]);
    expect(paths('await kitsuden.api.request("PATCH", "/api/items/1", { a: 1 })')).toEqual([
      ["PATCH", "/api/items/1"],
    ]);
  });

  it("concatenated, with a method call or anything else after it: unclassified", () => {
    for (const code of [
      'await kitsuden.api.delete("/api/ad" + "min/users/1")',
      'await kitsuden.api.delete("/api/ad"\n  + "min/users/1")',
      'await kitsuden.api.get("/api/x".concat("y"))',
      'await kitsuden.api.get("/api/x" + id)',
      'await kitsuden.api.get("/api/x"[0])',
      'await kitsuden.api.request("DELETE", "/api/ad" + "min/users/1")',
    ]) {
      const calls = scanCode(code).apiCalls;
      expect(calls.length, code).toBe(1);
      expect(calls[0]!.path, code).toBeNull();
    }
  });
});
