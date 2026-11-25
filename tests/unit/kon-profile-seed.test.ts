/**
 * The product profile (`KITSUDEN_ENABLE_KONS`, apps/api/kitsuden.config.ts)
 *
 * One image, several products: the environment says which installed kons come on the first time the
 * `modules` table hears of them. Set, it decides alone; unset, the older seed sources decide.
 */
import { describe, expect, it } from "vitest";

import { enabledKonsProfile, seedOf } from "../../apps/api/kitsuden.config";

describe("KITSUDEN_ENABLE_KONS", () => {
  it("reads short and full ids, ignores spaces and case", () => {
    const p = enabledKonsProfile({ KITSUDEN_ENABLE_KONS: " Blog, kon-wiki ,,dc" });
    expect(p).toEqual(new Set(["kon-blog", "kon-wiki", "kon-dc"]));
    expect(enabledKonsProfile({ KITSUDEN_ENABLE_KONS: "blog,*" })).toBe("*");
    expect(enabledKonsProfile({})).toBeNull();
    expect(enabledKonsProfile({ KITSUDEN_ENABLE_KONS: "  " })).toBeNull();
  });

  it("set: listed kons on, every other off, whatever the other sources say", () => {
    const profile = new Set(["kon-dc"]);
    expect(seedOf("kon-dc", { declared: false, base: false }, profile)).toBe(true);
    expect(seedOf("kon-blog", { declared: true, base: true, manifestDefault: true }, profile)).toBe(
      false
    );
    expect(seedOf("kon-blog", {}, "*")).toBe(true);
  });

  it("unset: kitsuden.kons.json, then the base table, then the manifest", () => {
    expect(seedOf("kon-blog", { declared: false, base: true }, null)).toBe(false);
    expect(seedOf("kon-blog", { base: true }, null)).toBe(true);
    expect(seedOf("kon-x", { manifestDefault: true }, null)).toBe(true);
    expect(seedOf("kon-x", {}, null)).toBe(false);
  });
});
