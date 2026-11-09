#!/usr/bin/env bun
/**
 * Seeding and reconciliation of `modules` from `kitsuden.config.ts`
 * ============================================================================
 *
 * The API seeds by itself on every startup: it fills in the `modules` table with the kons
 * that the configuration declares and the database does not yet know, touching no
 * existing row. This script does the same by hand, and adds what startup
 * does NOT do on its own.
 *
 * ── WHY `--force` EXISTS ──────────────────────────────────────────────────
 *
 * Because there are two legitimate ways to operate this and I did not want to choose for you:
 *
 *   · The normal one — the database rules. You turn kons on and off from the panel, and the
 *     file only says what comes by default in a new installation.
 *   · The git one — the desired state lives in the repository. You edit the file,
 *     deploy, and want the database to adjust to it.
 *
 * `--force` is the second one, ON REQUEST. It overwrites `enabled` in the database with whatever
 * the file says. It is made explicit and never done at startup because doing it
 * automatically is exactly the failure this split came to correct:
 * you turned off a kon in the panel and the file turned it back on without saying anything.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   bun run scripts/seed-modules.ts            fill gaps (what startup does)
 *   bun run scripts/seed-modules.ts --dry-run  what it would do, touching nothing
 *   bun run scripts/seed-modules.ts --force   impose the file over the database
 */

import { seedModules } from "../src/lib/seed-modules";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const force = args.has("--force") || args.has("--forzar"); // `--forzar`: earlier alias
  const dryRun = args.has("--dry-run");

  if (dryRun) {
    // A dry-run seed has no mode of its own: the read is done and reported
    // without writing. It is implemented here and not in `seedModules` so that
    // function keeps a single responsibility.
    const { db } = await import("../src/db");
    const { sql } = await import("drizzle-orm");
    const config = await import("../kitsuden.config");
    const staticConfig = config.staticConfig ?? config.default;

    const res = (await db.execute(sql.raw(`SELECT key, enabled FROM modules`))) as unknown as {
      rows?: { key: string; enabled: boolean }[];
    };
    const rows = Array.isArray(res) ? res : (res.rows ?? []);
    // Same normalization as the seeding: the database stores `games` and the
    // configuration says `kon-games`. Comparing raw would lie twice.
    const canonical = (id: string) => id.replace(/^kon-/, "");
    const inDb = new Map(rows.map((f) => [canonical(f.key), f.enabled]));

    const all = [
      ...(staticConfig.core ?? []).map((k) => ({ id: k.id, enabled: k.enabled })),
      ...(staticConfig.features ?? []).map((k) => ({ id: k.id, enabled: k.enabled })),
    ];

    console.log(`\nSeeds in the configuration: ${all.length}\n`);
    for (const s of all) {
      const actual = inDb.get(canonical(s.id));
      if (actual === undefined) {
        console.log(`  WOULD SEED  ${s.id}  →  enabled=${s.enabled}`);
      } else if (actual !== s.enabled) {
        console.log(
          `  DIFFERS     ${s.id}  →  base=${actual}, file=${s.enabled}` +
            `  (only changes with --force)`
        );
      }
    }
    console.log("\n  (--dry-run: nothing was written)\n");
    return;
  }

  const r = await seedModules({ force });

  console.log("");
  if (r.seeded.length > 0) console.log(`  seeded      ${r.seeded.join(", ")}`);
  if (r.taxes.length > 0) console.log(`  forced      ${r.taxes.join(", ")}`);
  if (r.seeded.length === 0 && r.taxes.length === 0) {
    console.log(`  Nothing to do: ${r.respected.length} kon(s) already in the database.`);
  } else {
    console.log(
      `  ${r.respected.length} kon(s) left untouched: the database already had its own opinion.`
    );
  }
  console.log("");
}

// ALWAYS exit: `db` leaves a pool open and the process would not end on its own.
// Ver tests/unit/startup-scripts-finish.test.ts.
main()
  .catch((err) => {
    console.error(`\n  ✗ ${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
