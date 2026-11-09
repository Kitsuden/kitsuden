/**
 * What a grimoire promises is what it brings
 * ============================================================================
 *
 * A grimoire is a list of kons with a description saying what it is for.
 * Nothing checked that the two things resembled each other, and they did not:
 *
 *   · `grimoire-sharepoint` promised "document libraries" and brought ZERO kons.
 *   · `grimoire-corporate` promised "document management, employee
 *     directories" and brought only kon-crm.
 *   · `grimoire-viggo` listed kon-broadcast TWICE: as mandatory and
 *     again as optional.
 *
 * None of those four gave an error anywhere. They were seen by looking at the
 * grimoire's card and counting.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { konStatus } from "./helpers/known-kons";

const ROOT = join(__dirname, "..", "..");
const GRIMOIRES = join(ROOT, "packages", "grimoires");
const KONS = join(ROOT, "packages", "kons");
const CORE = join(ROOT, "packages", "core");

interface Grimoire {
  id: string;
  description?: string;
  kons?: string[];
  optional_kons?: string[];
}

function listGrimoires(): Array<[string, Grimoire]> {
  return readdirSync(GRIMOIRES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(GRIMOIRES, e.name, "grimoire.json")))
    .map((e) => [
      e.name,
      JSON.parse(readFileSync(join(GRIMOIRES, e.name, "grimoire.json"), "utf8")) as Grimoire,
    ]);
}

/** Does this kon exist? Core ones live in packages/core under another name. */
function konExists(id: string): boolean {
  if (existsSync(join(KONS, id)) || existsSync(join(CORE, id.replace(/^kon-/, "")))) return true; // kon-media → core/media
  // A kon can be uninstalled and still exist (repo
  // kitsuden-kons): the sibling checkout is looked at and, without it, it cannot be known.
  return konStatus(id) !== "does-not-exist";
}

const grimoires = listGrimoires();

describe("the repository's grimoires", () => {
  it("there are grimoires to review", () => {
    expect(grimoires.length).toBeGreaterThan(3);
  });

  it.each(grimoires.map(([d, g]) => [d, g] as const))(
    "%s: does not repeat a kon between mandatory and optional",
    (_dir, g) => {
      // Viggo had kon-broadcast in both lists. The card counted it twice
      // and it is unclear what "optional" means for something mandatory.
      const repeatedValues = (g.optional_kons ?? []).filter((k) => (g.kons ?? []).includes(k));

      expect(repeatedValues).toEqual([]);
    }
  );

  it.each(grimoires.map(([d, g]) => [d, g] as const))(
    "%s: does not repeat a kon within the same list",
    (_dir, g) => {
      for (const list of [g.kons ?? [], g.optional_kons ?? []]) {
        expect(new Set(list).size).toBe(list.length);
      }
    }
  );

  it.each(grimoires.map(([d, g]) => [d, g] as const))(
    "%s: all the kons it names exist",
    (_dir, g) => {
      const ghosts = [...(g.kons ?? []), ...(g.optional_kons ?? [])].filter((k) => !konExists(k));

      expect(
        ghosts,
        `It names kons that are not on disk. It happened when merging the four ` +
          `kon-broadcast-* into kon-broadcast: the lists were left pointing ` +
          `to deleted folders. Kons: ${ghosts.join(", ")}`
      ).toEqual([]);
    }
  );

  it.each(grimoires.map(([d, g]) => [d, g] as const))(
    "%s: uses the kon's full id, with its prefix",
    (_dir, g) => {
      // Without the prefix the key matches no manifest, and that is where the
      // chain of ghost entries on the Kons screen began.
      const withoutPrefix = [...(g.kons ?? []), ...(g.optional_kons ?? [])].filter(
        (k) => !k.startsWith("kon-")
      );

      expect(withoutPrefix).toEqual([]);
    }
  );
});

describe("what the description promises", () => {
  /**
   * Word in the description → kon that fulfills it.
   *
   * Deliberately short: only what is unambiguous. It does not try to guess
   * a grimoire's composition, only to catch the case where its own text
   * names a function and the list does not bring it.
   */
  const PROMISES: Array<{ pattern: RegExp; kon: string; what: string }> = [
    { pattern: /document (management|librar)/i, kon: "kon-dms", what: "document management" },
    { pattern: /employee director/i, kon: "kon-directory", what: "employee directory" },

    // ONLY `optional` KONS GO HERE, and the reason matters.
    //
    // The first version of this table required "editorial content → kon-blog"
    // and with it kon-blog was added to a grimoire. It broke
    // core-does-not-belong-to-brand.test.ts, which is right: kon-blog is
    // `core-den`, it comes switched on with EVERY installation, and a brand cannot
    // claim something everyone already has.
    //
    // It only makes sense to require what has to be switched on on purpose.
  ];

  it.each(grimoires.map(([d, g]) => [d, g] as const))("%s delivers what it says", (_dir, g) => {
    const included = new Set([...(g.kons ?? []), ...(g.optional_kons ?? [])]);
    const unmet = PROMISES.filter(
      (p) => p.pattern.test(g.description ?? "") && !included.has(p.kon)
    ).map((p) => `promises ${p.what} but does not include ${p.kon}`);

    expect(unmet).toEqual([]);
  });
});
