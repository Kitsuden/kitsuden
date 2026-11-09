/**
 * No kon can disappear from the panel registry
 * ============================================================================
 *
 * `buildAdminRegistry()` walks the kons in TWO loops: the standalone ones and those
 * contributed by a grimoire. To avoid building them twice, the first skips
 * the ones the second is going to build.
 *
 * ── THE GAP BETWEEN THE TWO LOOPS ──────────────────────────────────────────
 *
 * The exclusion set was filled with `grimoire.kons` **and**
 * `grimoire.optionalKons`, and the second loop only walks `grimoire.kons`. A
 * kon listed only as OPTIONAL was skipped in the first and not added
 * in the second: it fell in between and never reached the registry.
 *
 * It was THIRTEEN of twenty-six —booking, members, payments, newsletter, wiki, maps,
 * cardsim, tierlist, builder, formulas, directory, ocr-training and
 * broadcast-moba— and no error gave it away. The symptom was something else:
 * `/api/admin/registry/kon-booking` returned 404, the panel fell back to its
 * default configuration and the form said
 *
 *     Could not load schema for table "kon-booking"
 *
 * the kon id disguised as a nonexistent table. Their three declared tabs
 * did not show up.
 *
 * ── WHAT IS CHECKED HERE ───────────────────────────────────────────────────
 *
 * This does not run the registry —it would need the database—, so it checks the
 * PROPERTY that made it fail: that the first loop's exclusion does not include
 * anything the second will not build. It is the invariant, not the symptom.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./helpers/comments";

const ROOT = join(__dirname, "..", "..");
const REGISTRY = join(ROOT, "apps", "api", "src", "services", "admin-registry.ts");

describe("panel kon registry", () => {
  // Normalized: a checkout may have CRLF, and the pattern below includes line ends.
  const source = withoutComments(readFileSync(REGISTRY, "utf-8").replaceAll("\r\n", "\n"));

  it("the first loop's exclusion does not cover optional kons", () => {
    /**
     * `grimoireKonIds` is what the first loop skips. It can only be fed from
     * `grimoire.kons`, which is exactly what the second walks. Adding
     * `optionalKons` there reopens the gap.
     */
    const block = source.match(/const grimoireKonIds = new Set<string>\(\);[\s\S]*?\n {2}\}\n/);
    expect(block, "the construction of grimoireKonIds was not found").not.toBeNull();

    expect(
      /optionalKons/.test(block![0]),
      "`grimoireKonIds` includes `optionalKons` again. The first loop will " +
        "skip those kons and the second does not build them —it only walks " +
        "`grimoire.kons`—, so they will vanish from the panel with no error. " +
        "It happened with thirteen kons; the symptom was «Could not load schema for table " +
        '"kon-booking"».'
    ).toBe(false);
  });

  it("the second loop still walks grimoire.kons", () => {
    // If it ever also walked the optional ones, the exclusion above
    // COULD include them. The two halves have to move together.
    expect(
      /for \(const konId of grimoire\.kons\)/.test(source),
      "the second loop no longer walks `grimoire.kons`: check that the exclusion " +
        "of the first still matches what this one builds."
    ).toBe(true);
  });

  it("a view without a table does not fall back to the kon id", () => {
    /**
     * The other side of the same failure, in the panel: `table: v.table || grimoire.id`
     * turned «this view does not say which table it shows» into «the table is called
     * kon-booking», and the resulting error spoke of a table nobody had
     * ever declared.
     */
    const loader = withoutComments(
      readFileSync(join(ROOT, "packages", "admin", "src", "lib", "grimoire-loader.ts"), "utf-8")
    );

    expect(
      /table:\s*v\.table \|\| grimoire\.id/.test(loader),
      "`generateExplorerConfig` falls back to the kon id as the table name " +
        "again. A fallback that fabricates a false name costs more to debug " +
        "than the absence of the data: use the first declared table."
    ).toBe(false);
  });
});
