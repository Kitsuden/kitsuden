/**
 * Seeding: the configuration file populates the database ONCE
 * ============================================================================
 *
 * ── THE PROBLEM IT SOLVES ──────────────────────────────────────────────────
 *
 * There were TWO places saying which kons are active:
 *
 *   · `kitsuden.config.ts` — a code file, with `enabled: true/false`.
 *   · the `modules` table  — what the user turns on from the panel.
 *
 * And they were not just duplicated: the file OVERRODE the database. `/api/modules` did
 *
 *     const enabled = configFlag !== undefined ? configFlag : stored.enabled;
 *
 * so turning kon-media off from the panel was saved and, on reload, the switch
 * flipped back by itself. The panel lied.
 *
 * ── THE DIVISION OF ROLES ──────────────────────────────────────────────────
 *
 * From here on, each one has ONE role and not the other's:
 *
 *   · the file is the SEED — what comes enabled out of the box. It is read when
 *     the database does not yet know anything about that kon.
 *   · the `modules` table is the runtime TRUTH. Whatever the panel says goes.
 *
 * That is why this function NEVER overwrites an existing row: as soon as the database has
 * an opinion about a kon, that opinion wins. Seeding is filling gaps, not
 * imposing.
 *
 * ── WHY THE DATABASE AND NOT THE FILE ──────────────────────────────────────
 *
 * In production with several replicas, the file travels INSIDE each image and
 * the database is shared. If they diverge, each replica believes something different
 * —and the file cannot change without a deployment, while enabling a kon already
 * works on the fly (see `lib/deferred-kons.ts`).
 *
 * ── RECONCILING ON PURPOSE ─────────────────────────────────────────────────
 *
 * Whoever wants the git flow —the desired state in the repository— has
 * `scripts/seed-modules.ts --force`, which does impose the file over the
 * database. Explicit and when asked for, not as a surprise on every startup.
 */

import { sql } from "drizzle-orm";

import { db, isPgMem } from "../db";

/**
 * Canonical key for comparison: without the `kon-` prefix.
 *
 * The `modules` table and the manifests do NOT use the same form. The kon-games
 * manifest declares `"id": "kon-games"` and in the database the row is called `games`,
 * from when core modules carried no prefix.
 *
 * Without normalizing, seeding would have created a SECOND `kon-games` row with
 * `enabled=false` while `games` stayed `true`: the same kon with two
 * identities and two contradictory states, which is worse than the problem
 * this seeding came to solve. The `--dry-run` uncovered it before writing.
 */
function key(id: string): string {
  return id.replace(/^kon-/, "");
}

export interface SeedResult {
  /** Kons that were not in the database and have been created. */
  seeded: string[];
  /** Kons whose row already existed: the database already had an opinion and it is respected. */
  respected: string[];
  /** Only with `--force`: rows whose `enabled` has been overwritten. */
  taxes: string[];
}

interface SeedKon {
  id: string;
  enabled: boolean;
  core?: boolean;
}

/**
 * Reads the seeds from the configuration file.
 *
 * It is imported lazily because `kitsuden.config.ts` does discovery
 * through the file system when it loads, and that must not happen on every import of
 * this module.
 */
async function seeds(): Promise<SeedKon[]> {
  const config = await import("../../kitsuden.config");

  /**
   * `getConfig()`, not `staticConfig`.
   *
   * `staticConfig` is TWO hand-written lists. A new kon on disk does not
   * enter them, so seeding did not create a row for it and the automatic
   * discovery —which does exist, and which announces "Auto-discovered kon" at
   * startup— never reached the database. With 28 kons on disk, the list
   * was two behind: kon-comments and kon-ecommerce.
   *
   * `getConfig()` already does the right merge: what is hand-written WINS over
   * its `enabled`, and what is discovered is added disabled. That way a new kon appears
   * in the panel so it can be enabled, without enabling itself.
   */
  let cfg: { core?: SeedKon[]; features?: SeedKon[] };
  try {
    cfg = await config.getConfig();
  } catch {
    // Discovery touches the disk. If it fails, seeding the static list is
    // better than seeding nothing.
    cfg = config.staticConfig;
  }

  return [
    ...(cfg.core ?? []).map((k) => ({ id: k.id, enabled: k.enabled, core: true })),
    ...(cfg.features ?? []).map((k) => ({ id: k.id, enabled: k.enabled })),
  ];
}

/** Presentation metadata for a new row, if the registry knows it. */
async function metadataOf(id: string): Promise<{ name: string; category: string }> {
  try {
    const { CORE_MODULES } = await import("../services/module-registry");
    const def = CORE_MODULES.find((m: { key: string }) => m.key === id);
    if (def) return { name: def.name, category: def.category };
  } catch {
    // The registry is optional for seeding: without it the row keeps the id as its
    // name, which is ugly but true. Not seeding would be worse.
  }
  return { name: id.replace(/^kon-/, ""), category: "optional" };
}

/**
 * Fills in `modules` with the kons that the configuration declares and the database does not
 * know yet.
 *
 * Idempotent: on the second startup it seeds nothing. It is safe to call it on
 * every start, and in fact it must be called that way — a new kon that appears in the
 * file after an update has to reach the database without intervention.
 */
export async function seedModules(options: { force?: boolean } = {}): Promise<SeedResult> {
  const result: SeedResult = { seeded: [], respected: [], taxes: [] };

  /**
   * pg-mem is not seeded.
   *
   * pg-mem is the in-memory database used by the tests, and its SQL support is
   * partial: it rejects this very INSERT. But the underlying reason is not that —it is
   * that seeding the real configuration inside a test database does not
   * mean anything, and each suite sets up the state it needs.
   *
   * It was discovered when ten tests broke at once: the API startup imports
   * this module, so seeding ran there too.
   */
  if (isPgMem) return result;

  let existingOnes: Map<string, boolean>;
  /** From canonical key to the REAL name of the row, to update the right one. */
  let realKeys = new Map<string, string>();
  try {
    const rows = (await db.execute(sql.raw(`SELECT key, enabled FROM modules`))) as unknown as {
      rows?: { key: string; enabled: boolean }[];
    };
    const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
    // Indexed by canonical key: `games` and `kon-games` are the same kon.
    existingOnes = new Map(list.map((f) => [key(f.key), f.enabled]));
    realKeys = new Map(list.map((f) => [key(f.key), f.key]));
  } catch {
    // The table does not exist yet: startup is happening before migrating. It is not an
    // error and nothing is invented — the next call, once migrated, will seed.
    return result;
  }

  for (const seed of await seeds()) {
    const actual = existingOnes.get(key(seed.id));

    if (actual === undefined) {
      const meta = await metadataOf(seed.id);
      await db.execute(
        sql`INSERT INTO modules (key, name, category, enabled, settings) VALUES (${seed.id}, ${meta.name}, ${seed.core ? "core" : meta.category}, ${seed.enabled}, '{}'::jsonb) ON CONFLICT (key) DO NOTHING`
      );
      result.seeded.push(seed.id);
      continue;
    }

    if (options.force && actual !== seed.enabled) {
      // The REAL row is updated, which may be called `games` and not `kon-games`.
      const pinsInDatabase = realKeys.get(key(seed.id)) ?? seed.id;
      await db.execute(
        sql`UPDATE modules SET enabled = ${seed.enabled} WHERE key = ${pinsInDatabase}`
      );
      result.taxes.push(seed.id);
      continue;
    }

    result.respected.push(seed.id);
  }

  return result;
}
