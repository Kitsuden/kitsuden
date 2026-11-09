/**
 * An `$effect` cannot depend on what it causes itself
 * ============================================================================
 *
 * ── THE FAILURE ────────────────────────────────────────────────────────────
 *
 * In `components/DataExplorer.svelte` it was written like this:
 *
 *     $effect(() => {
 *       if (!initialData && apiEndpoint) loadData();
 *     });
 *
 * In Svelte 5, everything that is READ inside an effect becomes a dependency of
 * it — including what is read inside the functions it calls. And `loadData`
 * did this:
 *
 *     rows = response.docs || response;
 *     pagination.total = response.totalDocs || rows.length;   // ← READS `rows`
 *     pagination.totalPages = Math.ceil(pagination.total / …); // ← READS `total`
 *
 * That is: the effect ended up depending on `rows` and `pagination.total`,
 * which are exactly what the load writes. Loading triggered loading.
 *
 * ── WHY IT WAS NOT VISIBLE ─────────────────────────────────────────────────
 *
 * While the list was EMPTY nothing happened: the same values were rewritten.
 * It appeared as soon as there was a real post to return. It is the kind
 * of failure that waits for data to exist before showing up — and then it does so
 * on the main screen.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * If an effect calls a function that writes state, the dependencies are
 * WRITTEN by hand and the call goes inside `untrack`. In Svelte 5, «react to
 * this» is declared, not deduced.
 *
 * It was already applied three times in this panel —blog editor, view selector,
 * games tabs— before finding it here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const COMPONENTS = join(ROOT, "packages", "admin", "src", "lib", "components");

/** The two explorers: the one for kon views and the one for own views. */
const EXPLORERS = [
  ["own views", join(COMPONENTS, "DataExplorer.svelte")],
  ["kon views", join(COMPONENTS, "admin", "DataExplorer.svelte")],
] as const;

describe("the explorers do not reload themselves", () => {
  for (const [name, route] of EXPLORERS) {
    it(`${name}: the load is isolated inside the effect`, () => {
      const source = readFileSync(route, "utf-8");

      /**
       * Looks for the `$effect`s that call `loadData` and requires the
       * call to be wrapped in `untrack`. A bare call ties the effect
       * to everything the load touches.
       */
      const effects = [...source.matchAll(/\$effect\(\(\) => \{([\s\S]*?)\n {2}\}\);/g)].map(
        (m) => m[1]
      );

      const withLoad = effects.filter((body) => /\bloadData\(\)/.test(body));

      expect(
        withLoad.length,
        `no \`$effect\` that loads data was found in ${name}`
      ).toBeGreaterThan(0);

      for (const body of withLoad) {
        expect(
          body.includes("untrack("),
          `There is an \`$effect\` that calls \`loadData()\` without \`untrack\` in ` +
            `${name}. Everything the load reads becomes a dependency of the ` +
            `effect, including what it writes itself: loading triggers loading. ` +
            `It does not fail while the table is empty, because the same ` +
            `values are rewritten — it shows up as soon as there is data.`
        ).toBe(true);
      }
    });
  }

  it("the load does not read the state it has just written", () => {
    /**
     * The other side of the same failure: even if the effect is isolated, reading
     * `rows.length` right after assigning `rows` is fragile and ties
     * the function back to its own output as soon as someone calls it from an effect.
     * Work on a local variable.
     */
    for (const [name, route] of EXPLORERS) {
      const source = readFileSync(route, "utf-8");

      expect(
        /(pagination\.total|totalCount) = [^;]*(rows|data)\.length/.test(source),
        `In ${name}, the total is computed by reading the list that was just ` +
          `assigned. Use a local variable with the response: reading what you ` +
          `just wrote ties the function back to its own output as soon as ` +
          `someone calls it from an effect.`
      ).toBe(false);
    }
  });
});
