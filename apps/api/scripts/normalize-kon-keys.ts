/**
 * Normalizes the `modules` keys to the `kon-<id>` form
 * ============================================================================
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 *
 * The `modules` table stores the state of each kon (enabled, settings,
 * grimoire) under a `key`. Two forms of the same key coexist:
 *
 *     blog        ← old form, from before the prefix
 *     kon-blog    ← current form
 *
 * And that breaks in two different ways, both silent:
 *
 *   1. The panel showed TWO cards for the same kon, one per key.
 *   2. The state is ORPHANED. `kon-games` had no row; its own was called
 *      `games` and said `enabled=false`. While the deployed API was old
 *      the value was ignored and the kon served anyway; once the API was deployed up to date,
 *      games started answering «Kon not enabled» without anyone having
 *      turned it off.
 *
 * That second case is what makes this not cosmetic: a row with the wrong
 * key is a setting that is not applied and that nobody sees.
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 * For every row whose key does not carry the prefix:
 *
 *   · if the prefixed row does NOT exist → it is renamed.
 *   · if it DOES exist → it is MERGED and the old one is deleted. Merge, don't overwrite:
 *     `enabled` stays `true` if either of the two was, because
 *     turning off a kon someone turned on is the only one of the two directions
 *     that breaks anything. The prefixed row's settings win; those that exist only
 *     in the old one are kept.
 *
 * It is idempotent: running it twice changes nothing the second time.
 *
 *     bun scripts/normalize-kon-keys.ts            (reports)
 *     bun scripts/normalize-kon-keys.ts --apply  (writes)
 */

import { sql } from "drizzle-orm";

import { db } from "../src/db";

const apply = process.argv.includes("--apply");

interface Row {
  key: string;
  name: string | null;
  enabled: boolean;
  settings: unknown;
  grimoire_id: string | null;
}

function rowsOf<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  const c = r as { rows?: unknown };
  return Array.isArray(c?.rows) ? (c.rows as T[]) : [];
}

const all = rowsOf<Row>(
  await db.execute(sql`SELECT key, name, enabled, settings, grimoire_id FROM modules ORDER BY key`)
);

const byKey = new Map(all.map((f) => [f.key, f]));
const withoutPrefix = all.filter((f) => !f.key.startsWith("kon-"));

console.log(`\nRows in \`modules\`: ${all.length}`);
console.log(
  `Keys without prefix:  ${withoutPrefix.length}${withoutPrefix.length ? "" : "  (nothing to do)"}\n`
);

if (withoutPrefix.length === 0) {
  console.log("Everything is already normalized.\n");
  process.exit(0);
}

let renamed = 0;
let merged = 0;

for (const old of withoutPrefix) {
  const newKey = `kon-${old.key}`;
  const existing = byKey.get(newKey);

  if (!existing) {
    console.log(`  rename     ${old.key}  →  ${newKey}   (enabled=${old.enabled})`);
    if (apply) {
      await db.execute(sql`UPDATE modules SET key = ${newKey} WHERE key = ${old.key}`);
    }
    renamed++;
    continue;
  }

  // Enabled if EITHER of the two was: turning off is the direction that
  // breaks things, and the old row may carry the «yes» someone gave months
  // ago.
  const turnedOn = existing.enabled || old.enabled;

  console.log(
    `  merge      ${old.key} + ${newKey}  →  ${newKey}   ` +
      `(enabled: ${old.enabled} | ${existing.enabled}  →  ${turnedOn})`
  );

  if (apply) {
    await db.execute(sql`
      UPDATE modules
         SET enabled = ${turnedOn},
             grimoire_id = COALESCE(grimoire_id, ${old.grimoire_id}),
             settings = COALESCE(NULLIF(settings, '{}'::jsonb), ${JSON.stringify(old.settings ?? {})}::jsonb)
       WHERE key = ${newKey}
    `);
    await db.execute(sql`DELETE FROM modules WHERE key = ${old.key}`);
  }
  merged++;
}

console.log(`\n${apply ? "Applied" : "Dry run"}: ${renamed} renamed, ${merged} merged.`);
if (!apply) console.log("Run it again with --apply to write.\n");
else console.log("");

process.exit(0);
