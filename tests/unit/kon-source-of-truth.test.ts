/**
 * `kitsuden.config.ts` seeds; the `modules` table rules
 * ============================================================================
 *
 * There were two places saying which kons are active, and they were not merely
 * duplicated: the file OVERRODE the database.
 *
 *     // Core infrastructure flags from kitsuden.config.ts take precedence
 *     const configFlag = CORE_FLAG_MAP[m.key];
 *     const enabled = configFlag !== undefined ? configFlag : stored.enabled;
 *
 * With `kon-media` in that map, turning it off from the panel was saved in the database and
 * `/api/modules` kept answering what the file said: the switch
 * flipped back on its own on reload. The panel lied about the system's state.
 *
 * ── THE SPLIT THIS TEST UPHOLDS ────────────────────────────────────────────
 *
 *   · `kitsuden.config.ts` is the SEED — what comes on out of the box.
 *     Its only runtime consumer is `lib/seed-modules.ts`.
 *   · the `modules` table is the TRUTH — whatever the panel dictates.
 *
 * That is why two distinct things are guarded:
 *
 *   1. That the hot readers —the kon loader and the panel
 *      routes— do not query the file again.
 *   2. That seeding does not overwrite: it fills gaps, never overwrites, except with
 *      `--force` requested by hand.
 *
 * ── WHAT MAY STILL READ THE FILE ───────────────────────────────────────────
 *
 * The migration runner, on purpose. There the UNION of file and
 * database is applied because a superset is the safe choice: applying a migration that
 * was not needed costs an idempotent `CREATE TABLE`, and not applying one that was
 * costs a broken screen. It is a decision, not an oversight, and that is why it is
 * excluded below.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./helpers/comments";

const ROOT = join(__dirname, "..", "..");

// Mentioning the file in a comment is not reading it: these same files
// document the split being guarded. The stripper lives in `helpers/` because
// the naive version of this regex deleted 23 KB of `index.ts` by confusing
// wildcard routes (`"/api/v1/*"`) with comment openers.
const code = withoutComments;

/**
 * Hot readers: they decide what is loaded or what is answered NOW.
 *
 * `scripts/migrate.ts` and `scripts/lib/kon-schemas.ts` are not included: they use the
 * union on purpose (see header).
 */
const HOT_READERS = ["apps/api/src/lib/module-loader.ts", "apps/api/src/routes/modules.ts"];

describe("a single source of truth for active kons", () => {
  for (const relativeValue of HOT_READERS) {
    it(`${relativeValue} does not query kitsuden.config.ts`, () => {
      const source = code(readFileSync(join(ROOT, relativeValue), "utf-8"));

      expect(
        /kitsuden\.config/.test(source),
        `${relativeValue} reads kitsuden.config.ts again to decide what is ` +
          `active.\n\n` +
          `The file only SEEDS the database (lib/seed-modules.ts, at ` +
          `startup). From then on the 'modules' table rules; otherwise whatever ` +
          `the user touches in the panel reverts by itself and the switch ` +
          `lies — which is how kon-media was.`
      ).toBe(false);
    });
  }

  it("seeding does not overwrite unless asked to", () => {
    const source = readFileSync(join(ROOT, "apps/api/src/lib/seed-modules.ts"), "utf-8");

    // There can only be ONE UPDATE of `enabled`, and it has to be behind
    // `options.force`. An unconditional UPDATE would turn seeding into the imposition
    // that was just removed.
    const updates = [...code(source).matchAll(/UPDATE modules SET enabled/g)];
    expect(updates.length, "more than one UPDATE of enabled in seeding").toBe(1);

    const beforeUpdate = code(source).slice(0, updates[0]!.index);
    expect(
      /options\.force/.test(beforeUpdate),
      "the UPDATE of `enabled` is not protected by `options.force`: " +
        "seeding would again impose the file over what the user decides."
    ).toBe(true);
  });

  it("startup seeds before loading the kons", () => {
    /**
     * Order matters and is not obvious: since the loader reads ONLY the
     * database, a new installation would start with no kons at all if seeding
     * ran afterwards. It would be an empty system with no error.
     */
    const source = code(readFileSync(join(ROOT, "apps/api/src/index.ts"), "utf-8"));
    const seeding = source.indexOf("seedModules");
    const load = source.indexOf("loadModules(app)");

    expect(seeding, "index.ts no longer seeds the modules").toBeGreaterThan(-1);
    expect(load, "index.ts no longer loads the kons").toBeGreaterThan(-1);
    expect(
      seeding < load,
      "seeding has to go BEFORE loadModules(app): the loader reads the " +
        "database, and on a new installation the database is empty until it is seeded."
    ).toBe(true);
  });
});
