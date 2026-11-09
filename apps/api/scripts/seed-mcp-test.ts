// @ts-nocheck
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SEED SCRIPT: MCP Test - "Step 0: Titanium Validation"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Purpose: Create the "DevBot" identity with a valid MCP token for connection
 * tests with Claude Desktop.
 *
 * Usage: bun run apps/api/scripts/seed-mcp-test.ts
 */

import { createHash, randomBytes } from "crypto";

// Console colors
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

function log(message: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// API key generator compatible with id-generator.ts
function generateAgentApiKey(options: { type: string; randomLength?: number }): {
  plainKey: string;
  keyHash: string;
  keyPrefix: string;
} {
  const { type, randomLength = 32 } = options;
  const AGENT_ID_PREFIX = "kitsuden_agent";

  // Normalize type
  const normalizedType = type
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

  // Generate random part
  const randomPart = randomBytes(randomLength).toString("base64url");

  // Build key
  const plainKey = `${AGENT_ID_PREFIX}_${normalizedType}_${randomPart}`;
  const keyHash = createHash("sha256").update(plainKey).digest("hex");
  const keyPrefix = `${AGENT_ID_PREFIX}_${normalizedType}_****${randomPart.slice(-8)}`;

  return { plainKey, keyHash, keyPrefix };
}

async function seedMcpTest() {
  log("\n╔═══════════════════════════════════════════════════════════════╗", "cyan");
  log("║   🔐 STEP 0: TITANIUM VALIDATION (Zero-Trust MCP)            ║", "cyan");
  log("╚═══════════════════════════════════════════════════════════════╝\n", "cyan");

  let dbConnected = false;
  let agentId = `agent_${randomBytes(8).toString("hex")}`;

  try {
    // Try to import and connect to the database
    log("📡 Step 1: Verifying connection to PostgreSQL...", "yellow");

    const { db } = await import("../src/db");

    try {
      const result = await db.execute<{ now: string }>("SELECT NOW() as now");
      if (result.rows && result.rows.length > 0) {
        log(`   ✅ Connection successful - ${result.rows[0].now}\n`, "green");
        dbConnected = true;
      }
    } catch (connError: any) {
      log(
        `   ⚠️  Could not connect to PostgreSQL: ${connError.message || "ECONNREFUSED"}`,
        "yellow"
      );
      log(`   💡 Make sure the database is running:`, "yellow");
      log(`      docker compose up -d db\n`, "cyan");
    }

    // ───────────────────────────────────────────────────────────────────────
    // GENERATE TOKEN WITH FORMAT kitsuden_agent_...
    // ───────────────────────────────────────────────────────────────────────
    log("🔑 Step 2: Generating secure MCP token...", "yellow");

    const apiKeyResult = generateAgentApiKey({
      type: "claude-desktop",
      randomLength: 32,
    });

    const plainToken = apiKeyResult.plainKey;
    const keyHash = apiKeyResult.keyHash;
    const keyPrefix = apiKeyResult.keyPrefix;

    log(`   ✅ Token generated: ${keyPrefix}...`, "green");
    log(`   🔒 Hash SHA-256: ${keyHash.substring(0, 16)}...\n`, "green");

    // ───────────────────────────────────────────────────────────────────────
    // IF THERE IS A CONNECTION, INSERT INTO THE DATABASE
    // ───────────────────────────────────────────────────────────────────────
    if (dbConnected) {
      const { db } = await import("../src/db");
      const { agentIdentities, agentApiKeys } = await import("../src/db/schema");
      const { eq } = await import("drizzle-orm");

      log("👤 Step 3: Creating 'DevBot' identity in database...", "yellow");

      // Check whether it already exists
      const existingAgent = await db.query.agentIdentities.findFirst({
        where: (table, { eq }) => eq(table.name, "DevBot"),
      });

      if (existingAgent) {
        log("   ⚠️  DevBot already exists. Updating...", "yellow");
        agentId = existingAgent.id;

        await db
          .update(agentIdentities)
          .set({
            scopes: ["read:issues", "write:intake"],
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(agentIdentities.id, agentId));
      } else {
        // Create new agent
        const [newAgent] = await db
          .insert(agentIdentities)
          .values({
            name: "DevBot",
            description: "Development agent for MCP tests with Claude Desktop",
            type: "claude-desktop",
            capabilities: ["mcp-connect", "tool-execution", "context-management"],
            systemPrompt:
              "You are DevBot, a development agent connected to Kitsuden CMS. You have access to MCP tools to interact with the system.",
            allowedTools: ["read_dataset", "write_intake", "search_memories"],
            scopes: ["read:issues", "write:intake"],
            rateLimit: 120,
            isActive: true,
          })
          .returning();

        agentId = newAgent.id;
        log(`   ✅ DevBot created with ID: ${agentId}`, "green");
      }

      log(`   📋 Scopes assigned: ["read:issues", "write:intake"]\n`, "green");

      // Insert API Key
      log("🔐 Step 4: Registering API Key in database...", "yellow");

      const existingKey = await db.query.agentApiKeys.findFirst({
        where: (table, { eq }) => eq(table.agentId, agentId),
      });

      if (existingKey) {
        log("   ⚠️  An API key already exists. Revoking and creating a new one...", "yellow");
        await db.delete(agentApiKeys).where(eq(agentApiKeys.id, existingKey.id));
      }

      const [newKey] = await db
        .insert(agentApiKeys)
        .values({
          agentId,
          keyHash,
          keyPrefix,
          expiresAt: null,
        })
        .returning();

      log(`   ✅ API Key registered: ${newKey.id}`, "green");
      log(`   📅 Expires: Never (for development tests)\n`, "green");

      // Final verification
      log("✅ Step 5: Verifying data integrity...", "yellow");

      const verification = await db.execute<{
        agent_count: number;
        key_count: number;
      }>(`
        SELECT 
          (SELECT COUNT(*) FROM agent_identities WHERE id = '${agentId}') as agent_count,
          (SELECT COUNT(*) FROM agent_api_keys WHERE agent_id = '${agentId}') as key_count
      `);

      const v = verification.rows?.[0];
      if (v && v.agent_count > 0 && v.key_count > 0) {
        log("   ✅ Data verified in PostgreSQL\n", "green");
      }

      await db.$client.end?.();
    } else {
      // Offline mode - show SQL to run manually
      log("👤 Step 3 (OFFLINE MODE): Preparing SQL for manual execution...", "yellow");
      log(`   ⚠️  Could not connect to the database\n`, "yellow");

      log("════════════════════════════════════════════════════════════════", "bold");
      log("SQL SCRIPT TO RUN MANUALLY:", "bold");
      log("════════════════════════════════════════════════════════════════\n", "bold");

      const sqlScript = `
-- Insert DevBot into agent_identities
INSERT INTO agent_identities (
  id, name, description, type, capabilities, system_prompt,
  allowed_tools, scopes, rate_limit, is_active, created_at, updated_at
) VALUES (
  '${agentId}',
  'DevBot',
  'Development agent for MCP tests with Claude Desktop',
  'claude-desktop',
  '["mcp-connect", "tool-execution", "context-management"]',
  'You are DevBot, a development agent connected to Kitsuden CMS.',
  '["read_dataset", "write_intake", "search_memories"]',
  '["read:issues", "write:intake"]',
  120,
  true,
  NOW(),
  NOW()
) ON CONFLICT (id) DO UPDATE SET
  scopes = '["read:issues", "write:intake"]',
  is_active = true,
  updated_at = NOW();

-- Insert API Key into agent_api_keys
INSERT INTO agent_api_keys (
  id, agent_id, key_hash, key_prefix, created_at, expires_at
) VALUES (
  gen_random_uuid(),
  '${agentId}',
  '${keyHash}',
  '${keyPrefix}',
  NOW(),
  NULL
);
`;
      log(sqlScript, "cyan");

      log("════════════════════════════════════════════════════════════════\n", "bold");
    }

    // ───────────────────────────────────────────────────────────────────────
    // SHOW FINAL RESULT
    // ───────────────────────────────────────────────────────────────────────
    log("╔═══════════════════════════════════════════════════════════════╗", "cyan");
    log("║   🎉 STEP 0 COMPLETED - MCP TOKEN GENERATED                   ║", "cyan");
    log("╚═══════════════════════════════════════════════════════════════╝\n", "cyan");

    log("════════════════════════════════════════════════════════════════", "bold");
    log("MCP TOKEN (KEEP IN A SAFE PLACE):", "bold");
    log("════════════════════════════════════════════════════════════════", "bold");
    log(`\n${plainToken}\n`, "cyan");

    log("════════════════════════════════════════════════════════════════", "bold");
    log("CONFIGURATION FOR CLAUDE DESKTOP:", "bold");
    log("════════════════════════════════════════════════════════════════\n", "bold");

    const claudeConfig = {
      mcpServers: {
        kitsuden: {
          command: "bun",
          args: ["run", "/path/to/kitsuden/apps/api/src/mcp-server.ts"],
          env: {
            KITSUDEN_API_TOKEN: plainToken,
            KITSUDEN_API_URL: "http://localhost:3001",
            NODE_ENV: "development",
          },
        },
      },
    };

    log("Copy this block into your claude_desktop_config.json file:\n", "yellow");
    log(JSON.stringify(claudeConfig, null, 2), "cyan");

    log("\n════════════════════════════════════════════════════════════════", "bold");
    log("CONFIGURATION FILE LOCATION:", "bold");
    log("════════════════════════════════════════════════════════════════\n", "bold");
    log("Windows: %APPDATA%\\Claude\\claude_desktop_config.json", "cyan");
    log("macOS: ~/Library/Application Support/Claude/claude_desktop_config.json", "cyan");
    log("Linux: ~/.config/Claude/claude_desktop_config.json\n", "cyan");

    log("════════════════════════════════════════════════════════════════", "bold");
    log("CONNECTION TEST:", "bold");
    log("════════════════════════════════════════════════════════════════\n", "bold");

    log("1. Make sure the Kitsuden server is running:", "reset");
    log("   cd apps/api && bun run dev\n", "cyan");

    log("2. Open Claude Desktop", "reset");
    log("3. Ve a Config > Developer > Edit Config", "reset");
    log("4. Paste the JSON configuration above", "reset");
    log("5. Restart Claude Desktop", "reset");
    log("6. Type: 'List the tools you have available'\n", "reset");

    log("════════════════════════════════════════════════════════════════", "bold");
    log("ZERO-TRUST VALIDATION:", "bold");
    log("════════════════════════════════════════════════════════════════\n", "bold");

    log("✅ The middleware will validate:", "green");
    log("   • Token format: kitsuden_agent_claude-desktop_...", "reset");
    log("   • SHA-256 hash in the database", "reset");
    log("   • Agent scopes: [read:issues, write:intake]", "reset");
    log("   • Rate limiting per agent", "reset");
    log("   • Recorded in agent_audit_logs\n", "reset");

    if (!dbConnected) {
      log("⚠️  WARNING: No database connection", "yellow");
      log("   The token was generated but is NOT registered in the DB.", "yellow");
      log("   Run the SQL script shown above before using the token.\n", "yellow");
    }

    log("════════════════════════════════════════════════════════════════\n", "bold");

    // Save to token file
    const tokenInfo = `
═══════════════════════════════════════════════════════════════════
MCP TOKEN GENERATED - Step 0: Titanium Validation
Date: ${new Date().toISOString()}
Status: ${dbConnected ? "Registered in DB" : "PENDING - Run SQL"}
═══════════════════════════════════════════════════════════════════

AGENT:
  Name: DevBot
  ID: ${agentId}
  Type: claude-desktop
  Scopes: ["read:issues", "write:intake"]

TOKEN:
  ${plainToken}

CLAUDE DESKTOP CONFIGURATION:
  Windows: %APPDATA%\\Claude\\claude_desktop_config.json
  macOS: ~/Library/Application Support/Claude/claude_desktop_config.json

TEST:
  1. Start the server: cd apps/api && bun run dev
  2. Configure Claude Desktop with the provided JSON
  3. In Claude: "List the available tools"

VALIDATION:
  • Zero-Trust middleware active
  • Scopes validated on every request
  • Audit in agent_audit_logs
  • Rate limiting: 120 req/min

═══════════════════════════════════════════════════════════════════
`;

    // Write to progress.txt
    try {
      const fs = await import("fs");
      const path = await import("path");
      const progressPath = path.join(process.cwd(), "progress.txt");

      fs.writeFileSync(progressPath, tokenInfo);
      log(`📝 Token saved to: ${progressPath}`, "green");
    } catch (fsError) {
      log(`⚠️  Could not save to progress.txt`, "yellow");
    }

    return {
      success: true,
      dbConnected,
      agentId,
      token: plainToken,
      scopes: ["read:issues", "write:intake"],
    };
  } catch (error: any) {
    log(`\n❌ ERROR: ${error.message}\n`, "red");
    console.error(error);
    process.exit(1);
  }
}

// Run
seedMcpTest()
  .then((result) => {
    if (result.dbConnected) {
      log("✨ Script completed - Token registered in database", "green");
    } else {
      log("✨ Script completed - RUN SQL MANUALLY", "yellow");
    }
    process.exit(0);
  })
  .catch((error) => {
    log(`✨ Error fatal: ${error.message}`, "red");
    process.exit(1);
  });
