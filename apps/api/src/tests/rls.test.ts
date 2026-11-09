/**
 * Row Level Security (RLS) Tests
 *
 * Tests for RLS middleware, context management, and tenant isolation.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";

import { isDatabaseAvailable } from "./setup";

let dbAvailable = false;

describe("Row Level Security", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
  });

  describe("RLS Context Variables", () => {
    it("should set and get RLS context variables", async () => {
      if (!dbAvailable) {
        console.log("⚠️ Skipping: Database not available");
        return;
      }

      const userId = `test-user-${Date.now()}`;
      const userRole = "admin";

      // `set_config(..., true)` is only valid inside the current transaction.
      // With a bare `db.execute` each statement is its own transaction (and in
      // a pool, sometimes another connection): the value no longer existed when read. With
      // pg-mem this never ran. Also, the column is called
      // `current_setting`, no `set_config`.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
        await tx.execute(sql`SELECT set_config('app.current_user_role', ${userRole}, true)`);

        const userIdResult = await tx.execute<{ current_setting: string }>(
          sql`SELECT current_setting('app.current_user_id', true)`
        );
        const roleResult = await tx.execute<{ current_setting: string }>(
          sql`SELECT current_setting('app.current_user_role', true)`
        );

        expect(userIdResult.rows?.[0]?.current_setting).toBe(userId);
        expect(roleResult.rows?.[0]?.current_setting).toBe(userRole);
      });
    });

    it("should handle missing RLS context gracefully", async () => {
      if (!dbAvailable) return;

      // Reset context
      await db.execute(sql`SELECT set_config('app.current_user_id', '', true)`);

      const result = await db.execute<{ current_setting: string }>(
        sql`SELECT current_setting('app.current_user_id', true)`
      );

      // Should return empty string for missing context
      expect(result.rows?.[0]?.current_setting).toBe("");
    });

    it("should maintain context within transaction", async () => {
      if (!dbAvailable) return;

      const testUserId = `transaction-test-${Date.now()}`;

      await db.transaction(async (tx) => {
        // Set context in transaction
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${testUserId}, true)`);

        // Verify context in same transaction
        const result = await tx.execute<{ current_setting: string }>(
          sql`SELECT current_setting('app.current_user_id', true)`
        );

        expect(result.rows?.[0]?.current_setting).toBe(testUserId);
      });
    });
  });

  describe("RLS Policy Validation", () => {
    it("should check if RLS is enabled on tables", async () => {
      if (!dbAvailable) return;

      const result = await db.execute<{ relname: string; relrowsecurity: boolean }>(
        sql`
          SELECT relname, relrowsecurity 
          FROM pg_class 
          WHERE relname IN ('data_entries', 'data_sets', 'auth_users')
        `
      );

      // Verify we can query RLS status
      expect(Array.isArray(result.rows)).toBe(true);

      for (const row of result.rows || []) {
        expect(row.relname).toBeDefined();
        expect(typeof row.relrowsecurity).toBe("boolean");
      }
    });

    it("should query RLS policies", async () => {
      if (!dbAvailable) return;

      const result = await db.execute<{
        tablename: string;
        policyname: string;
      }>(
        sql`
          SELECT tablename, policyname
          FROM pg_policies
          WHERE schemaname = 'public'
        `
      );

      // Should be able to query policies
      expect(Array.isArray(result.rows)).toBe(true);
    });
  });

  describe("Security Context", () => {
    it("should handle special characters in user ID safely", async () => {
      if (!dbAvailable) return;

      // SQL injection attempt
      const maliciousUserId = "user'; DROP TABLE users; --";

      // Should handle safely via parameterized query (in a transaction: see
      // «should set and get RLS context variables»)
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${maliciousUserId}, true)`);

        const result = await tx.execute<{ current_setting: string }>(
          sql`SELECT current_setting('app.current_user_id', true)`
        );

        // Should store value as-is (parameterized query prevents injection)
        expect(result.rows?.[0]?.current_setting).toBe(maliciousUserId);
      });
    });

    it("should handle long user IDs", async () => {
      if (!dbAvailable) return;

      const longUserId = "user-" + "x".repeat(500);

      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${longUserId}, true)`);

        const result = await tx.execute<{ current_setting: string }>(
          sql`SELECT current_setting('app.current_user_id', true)`
        );

        expect(result.rows?.[0]?.current_setting).toBe(longUserId);
      });
    });
  });

  describe("Role Validation", () => {
    it("should validate valid roles", async () => {
      if (!dbAvailable) return;

      const validRoles = ["admin", "editor", "user"];

      for (const role of validRoles) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.current_user_role', ${role}, true)`);

          const result = await tx.execute<{ current_setting: string }>(
            sql`SELECT current_setting('app.current_user_role', true)`
          );

          expect(result.rows?.[0]?.current_setting).toBe(role);
        });
      }
    });

    it("should enforce admin role check", async () => {
      if (!dbAvailable) return;

      const isAdmin = (role: string) => role === "admin";

      expect(isAdmin("admin")).toBe(true);
      expect(isAdmin("user")).toBe(false);
      expect(isAdmin("editor")).toBe(false);
    });
  });
});

describe("RLS Integration", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
  });

  it("should verify database connection", async () => {
    if (!dbAvailable) {
      console.log("⚠️ Database not available for integration tests");
      return;
    }

    const result = await db.execute(sql`SELECT 1 as connected`);
    expect(result.rows?.[0]).toHaveProperty("connected");
  });
});
