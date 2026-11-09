/**
 * Zero Config Integration Tests
 *
 * Validates the complete flow:
 * 1. Kon auto-discovery from kon.json
 * 2. Schema introspection from database
 * 3. Admin config generation
 * 4. Inline relations detection
 * 5. API endpoint responses
 */

import { describe, it, expect, beforeAll } from "bun:test";

import { installedKon } from "../lib/installed-kons";
import { buildAdminRegistry, getKonAdminConfig } from "../services/admin-registry";
import { detectRelations, generateInlineConfigs } from "../services/inline-relations";
import {
  introspectTable,
  getAllTables,
  generateAdminConfigFromIntrospection,
} from "../services/schema-introspector";

import { isDatabaseAvailable } from "./setup";

// kon-games is the example for these tests: an INSTALLABLE kon (kitsuden-kons).
const withGames = Boolean(installedKon("kon-games")?.path);
const itWithGames = withGames ? it : it.skip;

let dbAvailable = false;

describe("Zero Config Integration", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
  });

  describe("🎛️ Admin Registry Flow", () => {
    itWithGames("should discover kons from filesystem", async () => {
      const registry = await buildAdminRegistry();

      expect(registry.length).toBeGreaterThan(0);

      // Check for known kons
      const hasGames = registry.some((g) => g.id === "kon-games");
      expect(hasGames).toBe(true);
    });

    itWithGames("should parse kon.json config correctly", async () => {
      const config = await getKonAdminConfig("kon-games");

      expect(config).toBeDefined();
      expect(config?.name).toBe("Games");
      expect(config?.tables.length).toBeGreaterThan(0);
      expect(config?.views.length).toBeGreaterThan(0);
    });

    it("should detect custom views correctly", async () => {
      const registry = await buildAdminRegistry();

      // webhooks should have custom view (from legacy registry)
      const webhooks = registry.find((g) => g.id === "webhooks" || g.id === "core-webhooks");
      if (webhooks) {
        expect(webhooks.hasCustomView).toBe(true);
      }
    });
  });

  describe("🔍 Schema Introspection Flow", () => {
    it("should list all database tables", async () => {
      if (!dbAvailable) {
        console.log("⏭️ Skipping schema introspection — database not available");
        return;
      }
      const tables = await getAllTables();

      expect(Array.isArray(tables)).toBe(true);
      expect(tables.length).toBeGreaterThan(0);

      // Should have core tables
      expect(tables).toContain("agent_identities");
      expect(tables).toContain("auth_users");
    });

    it("should introspect a table", async () => {
      if (!dbAvailable) return;
      const introspected = await introspectTable("agent_identities");

      expect(introspected).toBeDefined();
      expect(introspected?.name).toBe("agent_identities");
      expect(introspected?.columns.length).toBeGreaterThan(0);
      expect(introspected?.primaryKey.length).toBeGreaterThan(0);
    });

    it("should detect columns with correct types", async () => {
      if (!dbAvailable) return;
      const introspected = await introspectTable("agent_identities");

      if (!introspected) return;

      const idColumn = introspected.columns.find((c) => c.name === "id");
      expect(idColumn).toBeDefined();
      expect(idColumn?.isPrimaryKey).toBe(true);
    });

    it("should generate admin config from introspection", async () => {
      if (!dbAvailable) return;
      const config = await generateAdminConfigFromIntrospection("agent_identities");

      expect(config.table).toBe("agent_identities");
      expect(config.columns.length).toBeGreaterThan(0);
      expect(config.icon).toBeDefined();
    });
  });

  describe("🔗 Inline Relations Flow", () => {
    it("should detect relations for a table", async () => {
      if (!dbAvailable) return;
      const relations = await detectRelations("agent_identities");

      expect(Array.isArray(relations)).toBe(true);
      // agent identities have relations to users and keys.
    });

    it("should generate inline configs", async () => {
      if (!dbAvailable) return;
      const configs = await generateInlineConfigs("agent_identities");

      expect(Array.isArray(configs)).toBe(true);
      // Each config should have required fields
      for (const config of configs) {
        expect(config.name).toBeDefined();
        expect(config.table).toBeDefined();
        expect(config.fkColumn).toBeDefined();
        expect(config.fields.length).toBeGreaterThan(0);
      }
    });
  });

  describe("🔄 End-to-End Flow", () => {
    itWithGames("complete flow: kon → introspection → relations", async () => {
      if (!dbAvailable) return;
      // Step 1: Get kon from registry
      const kon = await getKonAdminConfig("kon-games");
      expect(kon).toBeDefined();

      // Step 2: Introspect its main table
      const mainTable = kon?.tables[0]?.name;
      expect(mainTable).toBeDefined();

      const introspected = await introspectTable(mainTable!);
      expect(introspected).toBeDefined();

      // Step 3: Generate admin config
      const adminConfig = await generateAdminConfigFromIntrospection(mainTable!);
      expect(adminConfig.columns.length).toBeGreaterThan(0);

      // Step 4: Detect relations
      const relations = await detectRelations(mainTable!);
      expect(Array.isArray(relations)).toBe(true);

      // Step 5: Generate inline configs
      const inlines = await generateInlineConfigs(mainTable!);
      expect(Array.isArray(inlines)).toBe(true);
    });

    it("should handle missing tables gracefully", async () => {
      if (!dbAvailable) return;
      const introspected = await introspectTable("non_existent_table_xyz");
      expect(introspected).toBeNull();
    });

    it("should handle missing kons gracefully", async () => {
      if (!dbAvailable) return;
      const config = await getKonAdminConfig("non-existent-kon");
      expect(config).toBeNull();
    });
  });

  describe("📊 Data Consistency", () => {
    it("registry should be consistent across calls", async () => {
      const registry1 = await buildAdminRegistry();
      const registry2 = await buildAdminRegistry();

      // Should be same length (from cache)
      expect(registry1.length).toBe(registry2.length);
    });

    it("introspection should be cacheable", async () => {
      if (!dbAvailable) return;
      // First call
      const intro1 = await introspectTable("agent_identities");
      // Second call should use cache
      const intro2 = await introspectTable("agent_identities");

      expect(intro1).toEqual(intro2);
    });
  });
});

console.log("🧪 Running Zero Config Integration tests...");
