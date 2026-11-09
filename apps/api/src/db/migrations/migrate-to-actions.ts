/**
 * Migration Script: Workers + Webhooks → Actions
 *
 * Run this script to migrate existing data from:
 * - kitsuden_functions table → actions table
 * - webhooks table → actions table (if webhooks table exists)
 *
 * Usage:
 *   bun run apps/api/src/db/migrations/migrate-to-actions.ts
 *
 * This is idempotent - running it multiple times won't create duplicates
 * because it tracks legacyId and legacyType.
 */

import { messageOf } from "@kitsuden/engine";
import { eq } from "drizzle-orm";

import { db } from "../index";
import { actions, kitsudenFunctions } from "../schema";

interface MigrationStats {
  functionsMigrated: number;
  webhooksMigrated: number;
  errors: string[];
}

async function migrateFunctions(): Promise<number> {
  console.log("[Migration] Checking for functions to migrate...");

  // Get functions that haven't been migrated yet
  const existingLegacyIds = await db
    .select({ legacyId: actions.legacyId })
    .from(actions)
    .where(eq(actions.legacyType, "function"));

  const existingIds = new Set(existingLegacyIds.map((r) => r.legacyId).filter(Boolean));

  const functions = await db.select().from(kitsudenFunctions);
  const toMigrate = functions.filter((f) => !existingIds.has(f.id));

  if (toMigrate.length === 0) {
    console.log("[Migration] No new functions to migrate");
    return 0;
  }

  console.log(`[Migration] Migrating ${toMigrate.length} functions...`);

  let migrated = 0;

  for (const fn of toMigrate) {
    try {
      // Map trigger
      let trigger: "manual" | "cron" | "event" | "http" = "manual";
      let triggerConfig: Record<string, unknown> = {};

      if (fn.trigger === "cron") {
        trigger = "cron";
        triggerConfig = { cronExpression: fn.cronExpression };
      } else if (fn.trigger?.startsWith("on_")) {
        trigger = "event";
        const eventMap: Record<string, string> = {
          on_entry_created: "entry.created",
          on_entry_updated: "entry.updated",
          on_entry_deleted: "entry.deleted",
          on_post_published: "post.published",
        };
        triggerConfig = {
          eventName: eventMap[fn.trigger] || fn.trigger,
          datasetId: fn.watchDatasetId,
        };
      }

      await db.insert(actions).values({
        name: fn.name,
        slug: fn.slug,
        description: fn.description,
        type: "code",
        trigger,
        triggerConfig,
        config: {
          code: fn.code,
          timeoutMs: fn.timeoutMs,
          memoryLimitMb: fn.memoryLimitMb,
          envVars: fn.envVars ?? undefined,
        },
        status: fn.status === "error" ? "error" : fn.status === "inactive" ? "paused" : "active",
        lastExecutedAt: fn.lastExecutedAt,
        lastError: fn.lastError,
        executionCount: fn.executionCount,
        errorCount: fn.errorCount,
        createdById: fn.createdById,
        createdAt: fn.createdAt,
        updatedAt: fn.updatedAt,
        // Track migration
        legacyId: fn.id,
        legacyType: "function",
      });

      migrated++;
    } catch (err: unknown) {
      console.error(`[Migration] Failed to migrate function "${fn.name}":`, messageOf(err));
    }
  }

  console.log(`[Migration] Migrated ${migrated}/${toMigrate.length} functions`);
  return migrated;
}

async function migrateWebhooks(): Promise<number> {
  console.log("[Migration] Checking for webhooks to migrate...");

  // Check if webhooks table exists
  try {
    const result = await db.execute(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'webhooks'
      )
    `);

    const tableExists = result.rows[0]?.exists === true;

    if (!tableExists) {
      console.log("[Migration] No webhooks table found, skipping");
      return 0;
    }
  } catch (err) {
    console.log("[Migration] Could not check for webhooks table, skipping");
    return 0;
  }

  // Get webhooks that haven't been migrated yet
  const existingLegacyIds = await db
    .select({ legacyId: actions.legacyId })
    .from(actions)
    .where(eq(actions.legacyType, "webhook"));

  const existingIds = new Set(existingLegacyIds.map((r) => r.legacyId).filter(Boolean));

  // Fetch webhooks from raw query (since we don't have the schema typed)
  const webhooksResult = await db.execute(`SELECT * FROM webhooks`);
  const webhooks = webhooksResult.rows as any[];

  const toMigrate = webhooks.filter((w) => !existingIds.has(w.id));

  if (toMigrate.length === 0) {
    console.log("[Migration] No new webhooks to migrate");
    return 0;
  }

  console.log(`[Migration] Migrating ${toMigrate.length} webhooks...`);

  let migrated = 0;

  for (const wh of toMigrate) {
    try {
      // Generate slug from name
      const slug = (wh.name as string)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

      await db.insert(actions).values({
        name: wh.name,
        slug,
        description: `Migrated webhook: ${wh.event}`,
        type: "webhook_out",
        trigger: "event",
        triggerConfig: {
          eventName: wh.event?.replace("on_", "").replace("_", "."),
          datasetId: wh.dataset_id,
        },
        config: {
          url: wh.target_url || wh.url,
          headers: wh.headers || {},
          secret: wh.secret,
        },
        status: wh.enabled ? "active" : "paused",
        createdAt: wh.created_at || new Date(),
        updatedAt: wh.updated_at || new Date(),
        // Track migration
        legacyId: wh.id,
        legacyType: "webhook",
      });

      migrated++;
    } catch (err: unknown) {
      console.error(`[Migration] Failed to migrate webhook "${wh.name}":`, messageOf(err));
    }
  }

  console.log(`[Migration] Migrated ${migrated}/${toMigrate.length} webhooks`);
  return migrated;
}

async function runMigration(): Promise<MigrationStats> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Actions Migration: Workers + Webhooks → Actions");
  console.log("═══════════════════════════════════════════════════════════\n");

  const stats: MigrationStats = {
    functionsMigrated: 0,
    webhooksMigrated: 0,
    errors: [],
  };

  try {
    // Migrate functions
    stats.functionsMigrated = await migrateFunctions();

    // Migrate webhooks
    stats.webhooksMigrated = await migrateWebhooks();

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  Migration Complete!");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Functions migrated: ${stats.functionsMigrated}`);
    console.log(`  Webhooks migrated: ${stats.webhooksMigrated}`);
    console.log(`  Total actions created: ${stats.functionsMigrated + stats.webhooksMigrated}`);
    console.log("═══════════════════════════════════════════════════════════\n");

    console.log("Next steps:");
    console.log("  1. Update your UI to use the new /api/actions endpoints");
    console.log("  2. Test that all actions work correctly");
    console.log("  3. After verification, you can drop the old tables:");
    console.log("     - kitsuden_functions (keep until fully verified)");
    console.log("     - webhooks (keep until fully verified)");
    console.log("");
  } catch (err: unknown) {
    console.error("[Migration] Fatal error:", messageOf(err));
    stats.errors.push(messageOf(err));
    throw err;
  }

  return stats;
}

// Run if executed directly
if (import.meta.main) {
  runMigration()
    .then(() => {
      console.log("[Migration] Done!");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[Migration] Failed:", err);
      process.exit(1);
    });
}

export { runMigration };
