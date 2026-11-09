/**
 * Every table a kon declares has to be created by some migration
 * ============================================================================
 *
 * A `kon.json` promises two things about tables:
 *
 *   · `tables: [...]`              — the ones the kon owns.
 *   · `admin.views[].table`        — the one each panel tab shows.
 *
 * And nothing checked that promise. The result, measured on the repo the
 * day this test was written: **four kons declared tables that no
 * migration created**, for two different reasons and with the same symptom.
 *
 * ── 1. KONS WITHOUT A STARTUP MIGRATION ────────────────────────────────────
 *
 * `kon-agile` declared thirteen tables and did not even have a `migrations/` folder.
 * `kon-dms` came with four migrations and none created `dms_documents`: all
 * started with an ALTER against it. `kon-esports` came with eleven and the first one
 * RENAMED tables from an earlier version of the core that do not exist
 * in a fresh install.
 *
 * All three could be activated from the panel, and from then on each of their screens
 * returned 500. The real schema lived in the kon's Drizzle file,
 * which nobody translated to SQL.
 *
 * ── 2. camelCase NAMES ─────────────────────────────────────────────────────
 *
 * `kon-members` declared `memberTiers`, `kon-broadcast` `broadcastMatches`,
 * `kon-ecommerce` `shopProducts`. Those are the KEYS of the Drizzle object, not the
 * table names, which are `member_tiers`, `broadcast_matches`,
 * `shop_products`. The panel asked for `/api/explorer/memberTiers`, got a 404 and
 * showed an empty tab — indistinguishable from a table with no rows.
 *
 * ── WHAT THIS TEST DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not run the SQL: it checks that the name appears in a `CREATE TABLE` or in
 * a `RENAME TO`. Whether the migration is also valid is another matter, and that
 * takes a real Postgres.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HAS_INSTALLED_KONS } from "./helpers/known-kons";

const ROOT = join(__dirname, "..", "..");

/** Table names created or renamed by any `.sql` in the repo. */
function tablesSomeoneCreates(): Set<string> {
  const foundOnes = new Set<string>();

  const dirs = [
    join(ROOT, "apps", "api", "drizzle"),
    join(ROOT, "apps", "api", "src", "db", "migrations"),
    ...listMigrationSubdirs(join(ROOT, "packages", "kons")),
    ...listMigrationSubdirs(join(ROOT, "packages", "core")),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".sql")) continue;
      const sql = readFileSync(join(dir, file), "utf-8");
      for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?([A-Za-z0-9_]+)"?/gi)) {
        foundOnes.add(m[1]!);
      }
      // A rename also "creates" the new name, and some kons reach
      // their final name that way instead of with a CREATE.
      for (const m of sql.matchAll(/RENAME TO "?([A-Za-z0-9_]+)"?/gi)) {
        foundOnes.add(m[1]!);
      }
      // `format('ALTER TABLE %I RENAME TO %I', ...)` inside a DO: the
      // names go in a VALUES list, not in the statement.
      for (const m of sql.matchAll(/\(\s*'[a-z0-9_]+'\s*,\s*'([a-z0-9_]+)'\s*\)/gi)) {
        foundOnes.add(m[1]!);
      }
    }
  }

  return foundOnes;
}

function listMigrationSubdirs(base: string): string[] {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => join(base, e.name, "migrations"));
}

interface Declared {
  kon: string;
  table: string;
  where: string;
}

function declaredTables(): Declared[] {
  const base = join(ROOT, "packages", "kons");
  const declaredMany: Declared[] = [];

  for (const input of readdirSync(base, { withFileTypes: true })) {
    if (!input.isDirectory() || input.name === "node_modules") continue;
    const manifest = join(base, input.name, "kon.json");
    if (!existsSync(manifest)) continue;

    const json = JSON.parse(readFileSync(manifest, "utf-8"));

    for (const t of json.tables ?? []) {
      const name = typeof t === "string" ? t : t?.name;
      if (name) declaredMany.push({ kon: input.name, table: name, where: "tables[]" });
    }
    for (const v of json.admin?.views ?? []) {
      if (v?.table) {
        declaredMany.push({ kon: input.name, table: v.table, where: `admin.views[${v.id}]` });
      }
    }
  }

  return declaredMany;
}

describe("tables declared by the kons", () => {
  const createdMany = tablesSomeoneCreates();
  const declaredMany = declaredTables();

  it.skipIf(!HAS_INSTALLED_KONS)("manifests and migrations were read", () => {
    // Without this, a format change would leave both lists empty and the
    // check below would pass without looking at anything — which is exactly the
    // silent failure mode this test exists to prevent.
    expect(declaredMany.length).toBeGreaterThan(30);
    expect(createdMany.size).toBeGreaterThan(50);
  });

  it("every one is created by some migration", () => {
    const orphans = declaredMany
      .filter((d) => !createdMany.has(d.table))
      .map((d) => `${d.kon}  →  ${d.table}  (${d.where})`);

    expect(
      orphans,
      `These kons declare tables that no migration creates:\n\n` +
        `${orphans.join("\n")}\n\n` +
        `The kon can be activated and its screens will fail one by one. The two ` +
        `causes seen so far:\n\n` +
        `  · The startup migration is missing. The schema only exists in the ` +
        `kon's Drizzle file. Generate the SQL from there.\n` +
        `  · The name is in camelCase. The manifest takes the REAL name of ` +
        `the table (member_tiers), not the Drizzle object key (memberTiers).\n`
    ).toEqual([]);
  });

  it("migrations carry a 4-digit numeric prefix", () => {
    const bad: string[] = [];
    for (const dir of listMigrationSubdirs(join(ROOT, "packages", "kons"))) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".sql") && !/^\d{4}_/.test(f)) {
          bad.push(`${dir.split(/[\\/]/).at(-2)}/${f}`);
        }
      }
    }

    expect(
      bad,
      `Without a numeric prefix there is no deterministic order, and order is the only thing ` +
        `that makes a chain of migrations reproducible:\n\n${bad.join("\n")}`
    ).toEqual([]);
  });

  it("no migrations folder repeats an order number", () => {
    const repeatedValues: string[] = [];
    for (const dir of listMigrationSubdirs(join(ROOT, "packages", "kons"))) {
      if (!existsSync(dir)) continue;
      const seen = new Map<string, string>();
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
        const num = f.slice(0, 4);
        const prior = seen.get(num);
        if (prior) {
          repeatedValues.push(`${dir.split(/[\\/]/).at(-2)}: ${prior} and ${f} share the ${num}`);
        }
        seen.set(num, f);
      }
    }

    // Two files with the same number are ordered by whatever follows, which
    // is alphabetical and does not have to match the order in which they must
    // be applied. It happened when adding `0000_esquema_base.sql` next to a
    // `0000_rename_tables.sql` that MUST go after.
    expect(repeatedValues, `Repeated migration numbers:\n\n${repeatedValues.join("\n")}`).toEqual(
      []
    );
  });
});
