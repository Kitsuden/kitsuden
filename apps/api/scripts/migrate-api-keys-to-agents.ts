/**
 * Migration Script: Legacy API Keys to Agent NHI
 *
 * This script migrates all entries from the 'api_keys' table to the new
 * 'agent_identities' system.
 *
 * It creates a new Agent for each legacy key and generates a new token.
 * Legacy keys are NOT deleted and will continue to work until the sunset date.
 */

import { like } from "drizzle-orm";

import { db } from "../src/db";
import { apiKeys, agentIdentities, agentApiKeys } from "../src/db/schema";
import { generateAgentApiKey } from "../src/services/agent-auth";

async function migrate() {
  console.log("\n🚀 Starting migration of legacy API keys to Agents...");
  console.log("=======================================================");

  const legacyKeys = await db.select().from(apiKeys);

  if (legacyKeys.length === 0) {
    console.log("No legacy API keys found. Nothing to migrate.");
    return;
  }

  console.log(`Found ${legacyKeys.length} legacy API keys.\n`);

  let migratedCount = 0;
  let skippedCount = 0;

  for (const key of legacyKeys) {
    // Check for idempotency
    const existingAgents = await db
      .select()
      .from(agentIdentities)
      .where(like(agentIdentities.description, `%ID: ${key.id}%`))
      .limit(1);

    if (existingAgents.length > 0) {
      console.log(`⏭️  Skipping ${key.name} (already migrated to Agent ${existingAgents[0].id})`);
      skippedCount++;
      continue;
    }

    console.log(`📦 Migrating key: ${key.name} (${key.hint})...`);

    try {
      // 1. Create Agent Identity
      // Legacy API keys were essentially site-wide admins
      const [agent] = await db
        .insert(agentIdentities)
        .values({
          name: `${key.name} (Migrated)`,
          description: `Migrated from legacy API key ID: ${key.id} (Hint: ${key.hint})`,
          type: "migrated-legacy",
          scopes: ["admin", "dataset:*", "media:*", "actions:*"], // Robust default scopes
          isActive: true,
        })
        .returning();

      // 2. Generate NEW Agent Token
      const { plainKey, keyHash, keyPrefix } = await generateAgentApiKey("migrated");

      // 3. Create Agent API Key entry
      await db.insert(agentApiKeys).values({
        agentId: agent.id,
        keyHash,
        keyPrefix,
        expiresAt: key.expiresAt,
      });

      console.log(`   ✅ Success! Agent ID: ${agent.id}`);
      console.log(`   🔑 NEW TOKEN: ${plainKey}`);
      console.log(`   ⚠️  ACTION REQUIRED: Update your client to use the new token.`);
      console.log(`   (The old token will still work until 2026-08-01)\n`);
      migratedCount++;
    } catch (err: any) {
      console.error(`   ❌ Failed to migrate ${key.name}:`, err.message);
    }
  }

  console.log("=======================================================");
  console.log(`✨ Migration finished.`);
  console.log(`   Migrated: ${migratedCount}`);
  console.log(`   Skipped:  ${skippedCount}`);
  console.log("=======================================================\n");

  process.exit(0);
}

migrate().catch((err) => {
  console.error("❌ Critical migration error:", err);
  process.exit(1);
});
