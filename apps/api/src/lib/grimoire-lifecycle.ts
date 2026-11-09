/**
 * Grimoire Lifecycle Manager
 *
 * Handles grimoire activation, seeding, and deactivation.
 * - Reads grimoire.json for seed configuration
 * - Executes seed.sql if present and not already run
 * - Tracks seed execution to prevent duplicates (runOnce default)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { messageOf } from "@kitsuden/engine";
import { sql } from "drizzle-orm";

import { db } from "../db";

import { file } from "./file";
import { readGrimoireManifest } from "./grimoire-manifest";

// Strict validation of grimoireId: prevents SQL injection and path traversal.
// The IDs come from admin routes, but defense in depth is not optional.
const GRIMOIRE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function assertGrimoireId(grimoireId: string): void {
  if (!GRIMOIRE_ID_RE.test(grimoireId)) {
    throw new Error(`Invalid grimoire id: ${grimoireId}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface GrimoireSeedConfig {
  sql?: string; // relative path to seed sql file (default: "seed.sql")
  datasets?: string; // relative path to seed datasets json
  runOnce?: boolean; // if true (default), seed only runs once per grimoire
}

interface GrimoireManifest {
  id: string;
  name: string;
  kons: string[];
  seed?: GrimoireSeedConfig;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEED TRACKER
// ═══════════════════════════════════════════════════════════════════════════

const SEED_TRACKER_TABLE = "grimoire_seed_tracker";

async function ensureSeedTrackerTable(): Promise<void> {
  try {
    await db.execute(
      sql.raw(`
      CREATE TABLE IF NOT EXISTS ${SEED_TRACKER_TABLE} (
        grimoire_id TEXT PRIMARY KEY,
        seeded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `)
    );
  } catch {
    // Table may already exist
  }
}

async function isGrimoireSeeded(grimoireId: string): Promise<boolean> {
  assertGrimoireId(grimoireId);
  try {
    const result = await db.execute(
      sql`SELECT seeded_at FROM grimoire_seed_tracker WHERE grimoire_id = ${grimoireId}`
    );
    const rows = result.rows as Array<{ seeded_at: string }>;
    return rows.length > 0 && rows[0].seeded_at != null;
  } catch {
    return false;
  }
}

async function markGrimoireSeeded(grimoireId: string): Promise<void> {
  assertGrimoireId(grimoireId);
  await ensureSeedTrackerTable();
  await db.execute(
    sql`INSERT INTO grimoire_seed_tracker (grimoire_id) VALUES (${grimoireId})
        ON CONFLICT (grimoire_id) DO UPDATE SET seeded_at = NOW()`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// GRIMOIRE MANIFEST LOADER
// ═══════════════════════════════════════════════════════════════════════════

function getPackagesRoot(): string {
  const cwdCheck = join(process.cwd(), "packages", "kons", "package.json");
  const root = existsSync(cwdCheck) ? process.cwd() : join(process.cwd(), "../../");
  return join(root, "packages");
}

async function loadGrimoireManifest(grimoireId: string): Promise<GrimoireManifest | null> {
  assertGrimoireId(grimoireId); // prevents path traversal (../../)
  const grimoiresDir = join(getPackagesRoot(), "grimoires");

  // The fallback to kitsuden.json lives in readGrimoireManifest, which also
  // checks that what was read is a grimoire and not the THEME in the same directory.
  const manifest = await readGrimoireManifest(join(grimoiresDir, grimoireId));
  return manifest as GrimoireManifest | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEED EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute a seed SQL file for a grimoire.
 */
async function executeSeedSql(grimoireId: string, sqlPath: string): Promise<boolean> {
  const seedFile = file(sqlPath);
  if (!(await seedFile.exists())) {
    console.log(`[Grimoire] No seed file found at ${sqlPath}`);
    return false;
  }

  const content = await seedFile.text();
  if (!content.trim()) {
    console.log(`[Grimoire] Seed file is empty: ${sqlPath}`);
    return false;
  }

  console.log(`[Grimoire] Executing seed for ${grimoireId}...`);
  try {
    await db.execute(sql.raw(content));
    console.log(`[Grimoire] Seed executed successfully for ${grimoireId}`);
    return true;
  } catch (err: unknown) {
    console.error(`[Grimoire] Seed failed for ${grimoireId}:`, messageOf(err));
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Activate a grimoire: load its manifest and run seed if configured.
 * Safe to call multiple times — respects runOnce setting.
 */
export async function activateGrimoire(grimoireId: string): Promise<void> {
  assertGrimoireId(grimoireId);
  const manifest = await loadGrimoireManifest(grimoireId);
  if (!manifest) {
    console.warn(`[Grimoire] Manifest not found for grimoire: ${grimoireId}`);
    return;
  }

  const seedConfig = manifest.seed;
  if (!seedConfig) {
    console.log(`[Grimoire] No seed configured for ${grimoireId}`);
    return;
  }

  const runOnce = seedConfig.runOnce !== false;

  if (runOnce) {
    await ensureSeedTrackerTable();
    if (await isGrimoireSeeded(grimoireId)) {
      console.log(`[Grimoire] ${grimoireId} already seeded (runOnce=true). Skipping.`);
      return;
    }
  }

  const grimoiresDir = join(getPackagesRoot(), "grimoires", grimoireId);

  // Execute SQL seed if configured
  const sqlFile = seedConfig.sql || "seed.sql";
  const sqlPath = join(grimoiresDir, sqlFile);
  const seeded = await executeSeedSql(grimoireId, sqlPath);

  if (seeded && runOnce) {
    await markGrimoireSeeded(grimoireId);
  }
}

/**
 * Check if a grimoire has seed configuration.
 */
export async function grimoireHasSeed(grimoireId: string): Promise<boolean> {
  const manifest = await loadGrimoireManifest(grimoireId);
  return !!manifest?.seed;
}

/**
 * Reset seed tracking for a grimoire (useful for dev/testing).
 */
export async function resetGrimoireSeed(grimoireId: string): Promise<void> {
  assertGrimoireId(grimoireId);
  await ensureSeedTrackerTable();
  await db.execute(sql`DELETE FROM grimoire_seed_tracker WHERE grimoire_id = ${grimoireId}`);
  console.log(`[Grimoire] Seed tracking reset for ${grimoireId}`);
}
