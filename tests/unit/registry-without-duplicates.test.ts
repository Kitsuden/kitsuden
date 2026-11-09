/**
 * A kon appears ONCE in the panel registry
 * ============================================================================
 *
 * ── THE FAILURE, MEASURED ──────────────────────────────────────────────────
 *
 * `GET /api/admin/registry` returned `kon-dms` **three times**, with all three
 * objects identical. The cause: the kon is listed in three grimoires
 * —`corporate`, `sharepoint` and `documents`— and the assembly pushed one
 * configuration for each without checking whether it was already there.
 *
 * ── WHY IT MATTERS MORE THAN IT SEEMS ──────────────────────────────────────
 *
 * What is visible is the kon repeated three times in the sidebar. What is not
 * seen: Svelte indexes lists by key, and a duplicate key does not scramble
 * the list — it breaks it. A repeated id can take down the rendering of the whole
 * menu, and the symptom («the panel does not load») does not point to a grimoire
 * manifest.
 *
 * ── WHY THIS TEST DOES NOT USE THE DATABASE ────────────────────────────────
 *
 * `buildAdminRegistry()` needs a database, and in the test environment
 * that is pg-mem, which returns an empty list: a test that walks zero
 * kons always passes. So the same thing is checked from the manifests, which
 * is where the cause is, and the assembly is also required to have the
 * check.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const GRIMOIRES = join(ROOT, "packages", "grimoires");
const REGISTRY = join(ROOT, "apps", "api", "src", "services", "admin-registry.ts");

/** Which kons each grimoire claims. */
function claimedItems(): Map<string, string[]> {
  const byKon = new Map<string, string[]>();
  if (!existsSync(GRIMOIRES)) return byKon;

  for (const dir of readdirSync(GRIMOIRES)) {
    const manifest = join(GRIMOIRES, dir, "grimoire.json");
    if (!existsSync(manifest)) continue;

    let g: { id?: string; kons?: string[] };
    try {
      g = JSON.parse(readFileSync(manifest, "utf-8"));
    } catch {
      continue;
    }

    for (const konId of g.kons ?? []) {
      byKon.set(konId, [...(byKon.get(konId) ?? []), g.id || dir]);
    }
  }

  return byKon;
}

describe("the registry does not repeat kons", () => {
  const byKon = claimedItems();

  it("grimoires were read", () => {
    expect(byKon.size, "no grimoire with kons was read").toBeGreaterThan(0);
  });

  it("sharing a kon between grimoires is normal and allowed", () => {
    /**
     * This is NOT what is being chased: a kon in several grimoires is legitimate —
     * `kon-dms` serves a corporate grimoire as well as a documents one.
     * We check that the case really exists, because if it stopped existing
     * the test below would stop guarding anything.
     */
    const sharedItems = [...byKon].filter(([, gs]) => gs.length > 1);

    expect(
      sharedItems.length,
      "no kon is in two grimoires anymore; this test and the next one " +
        "no longer have a case to guard."
    ).toBeGreaterThan(0);
  });

  it("the assembly discards what it already registered", () => {
    const source = readFileSync(REGISTRY, "utf-8");

    /**
     * It anchors on `const alreadyRegistered` and advances from there. The first
     * version cut from `for (const grimoire of grimoires) {`, which appears
     * BEFORE —there is another identical loop that only collects ids— so the slice
     * analyzed came out empty and the test failed with correct code.
     * A badly placed cut makes the guard look where it should not.
     */
    const from = source.indexOf("const alreadyRegistered");
    expect(from, "the already-registered check was not found").toBeGreaterThan(-1);

    const loop = source.slice(from, from + 1200);

    expect(
      loop.includes("alreadyRegistered"),
      "without an already-registered check, a kon in three grimoires generates three " +
        "identical entries with the same id."
    ).toBe(true);

    expect(
      /if \(alreadyRegistered\.has\([^)]+\)\) continue;/.test(loop),
      "the loop has to skip kons that already have a configuration."
    ).toBe(true);
  });
});
