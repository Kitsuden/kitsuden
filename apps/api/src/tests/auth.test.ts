/**
 * Auth Module Tests
 *
 * Tests for authentication functionality including:
 * - User registration
 * - User login
 * - Session management
 * - Agent NHI authentication (kitsuden_agent_*)
 *
 * Legacy API keys (kitsuden_sk_*) are deprecated. Tests cover the new
 * Agent NHI system which replaces them.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { authUsers, agentIdentities, agentApiKeys } from "../db/schema";
// import { createHash } from "crypto"; // Not needed for Agent NHI tests
import { createAgent, authenticateAgent, revokeApiKey } from "../services/agent-auth";

import { isDatabaseAvailable, clearTestData, createTestUserData, generateTestId } from "./setup";

// Skip tests if database is not available
let dbAvailable = false;

describe("Auth Module", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) {
      await clearTestData();
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await clearTestData();
    }
  });

  // Test user data
  const testUser = createTestUserData();
  let userId: string;

  describe("User Management", () => {
    it("should create a new user directly in database", async () => {
      if (!dbAvailable) {
        console.log("⚠️ Skipping: Database not available");
        return;
      }

      const [result] = await db
        .insert(authUsers)
        .values({
          id: generateTestId(),
          email: testUser.email,
          name: testUser.name,
          emailVerified: false,
          role: "user",
        })
        .returning();

      expect(result).toBeDefined();
      expect(result.email).toBe(testUser.email);
      expect(result.name).toBe(testUser.name);

      userId = result.id;
    });

    it("should find user by email", async () => {
      if (!dbAvailable) return;

      const [result] = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.email, testUser.email))
        .limit(1);

      expect(result).toBeDefined();
      expect(result.email).toBe(testUser.email);
    });

    it("should update user role", async () => {
      if (!dbAvailable) return;

      const [result] = await db
        .update(authUsers)
        .set({ role: "admin" })
        .where(eq(authUsers.id, userId))
        .returning();

      expect(result).toBeDefined();
      expect(result.role).toBe("admin");
    });

    it("should delete user", async () => {
      if (!dbAvailable) return;

      await db.delete(authUsers).where(eq(authUsers.id, userId));

      const [result] = await db.select().from(authUsers).where(eq(authUsers.id, userId)).limit(1);

      expect(result).toBeUndefined();
    });
  });

  describe("Agent NHI Management (replaces legacy API keys)", () => {
    let agentId: string;
    let plainApiKey: string;

    it("should create an agent with API key", async () => {
      if (!dbAvailable) return;

      const result = await createAgent({
        name: "Test Machine Agent",
        type: "machine",
        description: "Test agent for auth module",
        scopes: ["read:datasets", "write:datasets"],
        rateLimit: 120,
      });

      expect(result).toBeDefined();
      expect(result.agent).toBeDefined();
      expect(result.plainApiKey).toBeDefined();
      expect(result.plainApiKey.startsWith("kitsuden_agent_")).toBe(true);
      expect(result.agent.name).toBe("Test Machine Agent");
      expect(result.agent.type).toBe("machine");

      agentId = result.agent.id;
      plainApiKey = result.plainApiKey;
    });

    it("should authenticate agent with valid API key", async () => {
      if (!dbAvailable) return;

      const authResult = await authenticateAgent(plainApiKey);

      expect(authResult.success).toBe(true);
      expect(authResult.context).toBeDefined();
      expect(authResult.context!.agentId).toBe(agentId);
      expect(authResult.context!.agentName).toBe("Test Machine Agent");
      expect(authResult.context!.scopes).toContain("read:datasets");
      expect(authResult.context!.scopes).toContain("write:datasets");
      expect(authResult.context!.rateLimit).toBe(120);
    });

    it("should reject invalid API key format", async () => {
      if (!dbAvailable) return;

      const authResult = await authenticateAgent("invalid_key_format");

      expect(authResult.success).toBe(false);
      expect(authResult.code).toBe("INVALID_KEY_FORMAT");
    });

    it("should reject unknown API key", async () => {
      if (!dbAvailable) return;

      const fakeKey = "kitsuden_agent_test_" + "a".repeat(32);
      const authResult = await authenticateAgent(fakeKey);

      expect(authResult.success).toBe(false);
      expect(authResult.code).toBe("INVALID_KEY");
    });

    it("should update last_used_at on authentication", async () => {
      if (!dbAvailable) return;

      // Authenticate first
      await authenticateAgent(plainApiKey);

      // Check that lastUsedAt was updated
      const [keyRecord] = await db
        .select()
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, agentId))
        .limit(1);

      expect(keyRecord).toBeDefined();
      expect(keyRecord.lastUsedAt).toBeDefined();
    });

    it("should revoke agent API key", async () => {
      if (!dbAvailable) return;

      const [keyRecord] = await db
        .select()
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, agentId))
        .limit(1);

      expect(keyRecord).toBeDefined();
      await revokeApiKey(keyRecord.id);

      const [afterRevoke] = await db
        .select()
        .from(agentApiKeys)
        .where(eq(agentApiKeys.id, keyRecord.id))
        .limit(1);

      // Revoking MARKS the key (the row stays for auditing).
      expect(afterRevoke?.revokedAt).toBeInstanceOf(Date);
    });

    it("should fail authentication after revocation", async () => {
      if (!dbAvailable) return;

      const authResult = await authenticateAgent(plainApiKey);

      expect(authResult.success).toBe(false);
      expect(authResult.code).toBe("KEY_REVOKED");
    });

    afterAll(async () => {
      if (!dbAvailable) return;
      if (agentId) {
        await db.delete(agentIdentities).where(eq(agentIdentities.id, agentId));
      }
    });
  });

  describe("User Role Validation", () => {
    it("should validate role assignments", async () => {
      if (!dbAvailable) return;

      const validRoles = ["admin", "editor", "user"] as const;

      for (const role of validRoles) {
        const [user] = await db
          .insert(authUsers)
          .values({
            id: generateTestId(),
            email: `role-test-${role}-${Date.now()}@example.com`,
            name: `Role Test ${role}`,
            role,
          })
          .returning();

        expect(user.role).toBe(role);

        // Cleanup
        await db.delete(authUsers).where(eq(authUsers.id, user.id));
      }
    });
  });
});
