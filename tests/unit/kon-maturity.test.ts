/**
 * Every kon declares its maturity
 * ============================================================================
 *
 * `maturity` says how much real use a kon has: «stable» (in production end
 * to end), «beta» (works and has tests, with gaps or little real use)
 * or «experimental» (nobody has used it end to end). The README, CORE.md and
 * the panel badge (Kons view) come from this field, so a kon without
 * it would be advertised as if it were as reliable as the blog.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HAS_INSTALLED_KONS } from "./helpers/known-kons";

const ROOT = join(__dirname, "..", "..");
const LEVELS = ["stable", "beta", "experimental"];

function manifests(dirName: string): Array<[string, Record<string, unknown>]> {
  const dir = join(ROOT, "packages", dirName);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "kon.json")))
    .map((e) => [
      `${dirName}/${e.name}`,
      JSON.parse(readFileSync(join(dir, e.name, "kon.json"), "utf8")),
    ]);
}

// The installed ones (packages/kons, copies from kitsuden-kons) and the core ones.
const installed = manifests("kons");
const ofTheCore = manifests("core");
const all = [...installed, ...ofTheCore];

describe("kon maturity", () => {
  it("there are manifests to review", () => {
    // Without installed kons, the three core ones remain.
    expect(all.length).toBeGreaterThan(HAS_INSTALLED_KONS ? 20 : 2);
  });

  it.each(all)("%s declares a valid maturity", (_route, manifest) => {
    expect(LEVELS).toContain(manifest.maturity);
  });

  it("the schema requires it and only admits the three levels", () => {
    const schema = JSON.parse(
      readFileSync(join(ROOT, "packages", "schemas", "kon-schema.json"), "utf8")
    );
    expect(schema.required).toContain("maturity");
    expect(schema.properties.maturity.enum).toEqual(LEVELS);
  });

  it("CORE.md lists each core module with the same maturity as its kon.json", () => {
    // The table of installable kons lives in the kitsuden-kons README.
    const core = readFileSync(join(ROOT, "CORE.md"), "utf8");
    for (const [, m] of ofTheCore) {
      const row = new RegExp(`\\|\\s*\`${m.id}\`\\s*\\|\\s*\`?${m.maturity}\`?\\s*\\|`);
      expect(core, `${m.id} (${m.maturity}) in CORE.md`).toMatch(row);
    }
  });
});
