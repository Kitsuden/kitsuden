/**
 * A core kon cannot belong to a grimoire
 * ============================================================================
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 *
 * A `core` (or `core-den`) kon comes with EVERY installation and is switched on
 * by default. A grimoire is a BRAND —Viggo, Corporate— and its kons are
 * switched on when that brand is active.
 *
 * Both at once mean nothing: "always comes" and "comes with this brand"
 * contradict each other.
 *
 * ── WHAT WAS HAPPENING ─────────────────────────────────────────────────────
 *
 * `kon-blog` was declared as `core-den` in the registry AND listed among
 * a grimoire's kons. That produced two effects, both odd:
 *
 *   1. The panel showed TWO cards of the same kon —"kon-blog" (core) and
 *      "blog" (grimoire)—, each with its own off button.
 *   2. A core kon's card appeared with a brand's `grimoireId`,
 *      that is, a kon that comes with everybody marked as the property of
 *      a specific brand.
 *
 * Deduplication by canonical key covered up the first. This test prevents the
 * second, which is the cause: as long as the contradiction is in the data, every
 * layer that reads it has to decide which of the two truths to believe.
 *
 * ── WHAT IS ALLOWED ────────────────────────────────────────────────────────
 *
 * A grimoire can claim `optional` or `grimoire` kons — that is exactly what it is
 * for: `grimoire-corporate` switches on `kon-crm`, which is off by default. What
 * it cannot claim is something that already comes switched on always.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const REGISTRY = join(ROOT, "apps", "api", "src", "services", "module-registry.ts");
const GRIMOIRES = join(ROOT, "packages", "grimoires");

/** Declared category of each kon in the static registry. */
function registryCategories(): Map<string, string> {
  const source = readFileSync(REGISTRY, "utf-8");
  const cats = new Map<string, string>();

  for (const m of source.matchAll(/key:\s*"([^"]+)"([\s\S]*?)category:\s*"([^"]+)"/g)) {
    // The first occurrence wins: the `[\s\S]*?` does not cross into the next entry
    // because it is lazy, but if an entry declared no
    // category, the neighbor's would slip in. Keeping the first avoids
    // changing a category already read.
    if (!cats.has(m[1])) cats.set(m[1], m[3]);
  }

  return cats;
}

describe("core and grimoire are mutually exclusive", () => {
  const categories = registryCategories();

  it("the registry could be read", () => {
    expect(
      categories.size,
      "no category was extracted from `module-registry.ts`. If the " +
        "format changed, this test would pass empty and guard nothing."
    ).toBeGreaterThan(5);
  });

  it("no grimoire claims a core kon", () => {
    const problems: string[] = [];

    for (const dir of readdirSync(GRIMOIRES)) {
      const manifest = join(GRIMOIRES, dir, "grimoire.json");
      if (!existsSync(manifest)) continue;

      let g: { id?: string; kons?: string[] };
      try {
        g = JSON.parse(readFileSync(manifest, "utf-8"));
      } catch {
        continue;
      }

      for (const kon of g.kons ?? []) {
        const category = categories.get(kon);
        if (category === "core" || category === "core-den") {
          problems.push(
            `${g.id ?? dir} claims \`${kon}\`, which is declared as ` +
              `\`${category}\` in the registry. A core kon comes with every ` +
              `installation and is already switched on by default: it also being owned by ` +
              `a brand makes the panel treat it as two different kons and ` +
              `its card come out marked as the property of a grimoire. ` +
              `Remove it from the grimoire's list, or change its category.`
          );
        }
      }
    }

    expect(problems, problems.join("\n\n")).toEqual([]);
  });

  it("`kon-blog` is still core and nobody else's", () => {
    /**
     * The specific case that was fixed, written separately so that if someone
     * puts blog in a grimoire again the message says exactly that instead of
     * a generic failure.
     */
    expect(["core", "core-den"]).toContain(categories.get("kon-blog"));

    for (const dir of readdirSync(GRIMOIRES, { withFileTypes: true })) {
      if (!dir.isDirectory() || !dir.name.startsWith("grimoire-")) continue;
      const grimoire = JSON.parse(
        readFileSync(join(GRIMOIRES, dir.name, "grimoire.json"), "utf-8")
      ) as { kons?: string[] };

      expect(
        grimoire.kons ?? [],
        `the blog belongs to the CMS, not to ${dir.name}: publishing content is done by every ` +
          "installation, with or without a brand."
      ).not.toContain("kon-blog");
    }
  });
});
