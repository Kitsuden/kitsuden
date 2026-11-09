/**
 * Cleanup Script: Remove Legacy Tables After Migration Verification
 *
 * ⚠️ WARNING: This script PERMANENTLY DELETES the old tables.
 * Only run this after:
 *   1. Successfully migrating data to actions table
 *   2. Running in production for a while without issues
 *   3. Verifying all functionality works with new actions table
 *   4. Creating a fresh backup
 *
 * Usage:
 *   bun run apps/api/src/db/migrations/cleanup-legacy-actions.ts --dry-run
 *   bun run apps/api/src/db/migrations/cleanup-legacy-actions.ts --execute
 */

import { messageOf } from "@kitsuden/engine";

import { db } from "../index";

interface CleanupResult {
  tablesDropped: string[];
  enumsDropped: string[];
  errors: string[];
}

const LEGACY_TABLES = ["kitsuden_functions", "function_executions", "webhooks"];

const LEGACY_ENUMS = ["function_trigger", "function_status"];

async function verifyMigration(): Promise<{ success: boolean; issues: string[] }> {
  console.log("[Cleanup] Verifying migration status...\n");

  const issues: string[] = [];

  // Check if new actions table exists and has data
  try {
    const actionsResult = await db.execute(`SELECT COUNT(*) FROM actions`);
    const actionsCount = parseInt(actionsResult.rows[0]?.count as string) || 0;

    if (actionsCount === 0) {
      issues.push("No actions found in new 'actions' table");
    } else {
      console.log(`  ✓ actions table has ${actionsCount} records`);
    }
  } catch (err) {
    issues.push("actions table does not exist or is not accessible");
  }

  // Check if action_executions table exists
  try {
    const execResult = await db.execute(`SELECT COUNT(*) FROM action_executions`);
    const execCount = parseInt(execResult.rows[0]?.count as string) || 0;
    console.log(`  ✓ action_executions table has ${execCount} records`);
  } catch (err) {
    issues.push("action_executions table does not exist or is not accessible");
  }

  // Verify data integrity: compare counts
  try {
    const [legacyCount, newCount] = await Promise.all([
      db.execute(`SELECT COUNT(*) FROM kitsuden_functions`).catch(() => ({ rows: [{ count: 0 }] })),
      db
        .execute(`SELECT COUNT(*) FROM actions WHERE legacy_type = 'function'`)
        .catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    const legacyFunctions = parseInt(legacyCount.rows[0]?.count as string) || 0;
    const migratedFunctions = parseInt(newCount.rows[0]?.count as string) || 0;

    console.log(`  ✓ Migrated ${migratedFunctions}/${legacyFunctions} functions`);

    if (migratedFunctions < legacyFunctions) {
      issues.push(`Not all functions migrated: ${migratedFunctions}/${legacyFunctions}`);
    }
  } catch (err) {
    // Legacy table might not exist, which is fine
  }

  console.log("");

  return {
    success: issues.length === 0,
    issues,
  };
}

async function checkLegacyTablesExist(): Promise<string[]> {
  const existing: string[] = [];

  for (const table of LEGACY_TABLES) {
    try {
      const result = await db.execute(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = '${table}'
        )
      `);

      if (result.rows[0]?.exists === true) {
        existing.push(table);
      }
    } catch (err) {
      console.warn(`[Cleanup] Could not check table ${table}:`, err);
    }
  }

  return existing;
}

async function dropLegacyTables(dryRun: boolean): Promise<CleanupResult> {
  const result: CleanupResult = {
    tablesDropped: [],
    enumsDropped: [],
    errors: [],
  };

  const existingTables = await checkLegacyTablesExist();

  if (existingTables.length === 0) {
    console.log("[Cleanup] No legacy tables found to drop\n");
    return result;
  }

  console.log(`[Cleanup] Tables to drop: ${existingTables.join(", ")}\n`);

  for (const table of existingTables) {
    try {
      if (dryRun) {
        console.log(`  [DRY-RUN] Would drop table: ${table}`);
      } else {
        console.log(`  Dropping table: ${table}...`);
        await db.execute(`DROP TABLE IF EXISTS "${table}" CASCADE`);
        console.log(`  ✓ Dropped: ${table}`);
      }
      result.tablesDropped.push(table);
    } catch (err: unknown) {
      console.error(`  ✗ Failed to drop ${table}:`, messageOf(err));
      result.errors.push(`Failed to drop ${table}: ${messageOf(err)}`);
    }
  }

  return result;
}

async function dropLegacyEnums(dryRun: boolean): Promise<CleanupResult> {
  const result: CleanupResult = {
    tablesDropped: [],
    enumsDropped: [],
    errors: [],
  };

  for (const enumName of LEGACY_ENUMS) {
    try {
      if (dryRun) {
        console.log(`  [DRY-RUN] Would drop enum: ${enumName}`);
      } else {
        console.log(`  Dropping enum: ${enumName}...`);
        await db.execute(`DROP TYPE IF EXISTS "${enumName}" CASCADE`);
        console.log(`  ✓ Dropped: ${enumName}`);
      }
      result.enumsDropped.push(enumName);
    } catch (err: unknown) {
      console.error(`  ✗ Failed to drop ${enumName}:`, messageOf(err));
      result.errors.push(`Failed to drop ${enumName}: ${messageOf(err)}`);
    }
  }

  return result;
}

async function runCleanup(dryRun: boolean): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log(dryRun ? "  Cleanup: DRY RUN MODE" : "  Cleanup: EXECUTE MODE");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Step 1: Verify migration
  const verification = await verifyMigration();

  if (!verification.success) {
    console.error("❌ Migration verification failed:");
    for (const issue of verification.issues) {
      console.error(`   - ${issue}`);
    }
    console.error("\n⚠️  DO NOT PROCEED WITH CLEANUP UNTIL ISSUES ARE RESOLVED\n");
    process.exit(1);
  }

  console.log("✓ Migration verification passed\n");

  if (dryRun) {
    console.log("[DRY-RUN] No changes will be made\n");
  } else {
    console.log("⚠️  THIS WILL PERMANENTLY DELETE DATA\n");

    // In non-dry-run mode, ask for confirmation (unless --force is passed)
    const args = process.argv.slice(2);
    const force = args.includes("--force");

    if (!force) {
      console.log("To proceed, run with --force flag:");
      console.log("  bun run cleanup-legacy-actions.ts --execute --force\n");
      process.exit(0);
    }
  }

  // Step 2: Drop tables
  console.log("--- Dropping Legacy Tables ---\n");
  const tableResult = await dropLegacyTables(dryRun);

  // Step 3: Drop enums
  console.log("\n--- Dropping Legacy Enums ---\n");
  const enumResult = await dropLegacyEnums(dryRun);

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(dryRun ? "  DRY RUN Complete" : "  Cleanup Complete");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Tables ${dryRun ? "to drop" : "dropped"}: ${tableResult.tablesDropped.length}`);
  console.log(`Enums ${dryRun ? "to drop" : "dropped"}: ${enumResult.enumsDropped.length}`);

  if (tableResult.errors.length > 0 || enumResult.errors.length > 0) {
    console.log(`\nErrors: ${tableResult.errors.length + enumResult.errors.length}`);
    for (const error of [...tableResult.errors, ...enumResult.errors]) {
      console.log(`  - ${error}`);
    }
  }

  console.log("");

  if (dryRun) {
    console.log("To execute for real, run:");
    console.log("  bun run cleanup-legacy-actions.ts --execute --force\n");
  } else {
    console.log("✓ Legacy tables and enums have been removed\n");
    console.log("Next steps:");
    console.log("  1. Remove legacy code from function-dispatcher.ts");
    console.log("  2. Remove legacy API routes from functions.ts");
    console.log("  3. Update UI to remove legacy fallback code\n");
  }
}

// Parse arguments
const args = process.argv.slice(2);
const dryRun = !args.includes("--execute");

runCleanup(dryRun)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Cleanup] Fatal error:", err);
    process.exit(1);
  });
