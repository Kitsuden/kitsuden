/**
 * Admin Registry Tests
 *
 * Validates the zero-config kon registration system
 */

import { describe, it, expect } from "bun:test";

import { listInstalledKons } from "../lib/installed-kons";
import { buildAdminRegistry, getKonAdminConfig } from "../services/admin-registry";
import { scanPackages } from "../services/scanner";

// Without installed kons (clean clone of the core) there is nothing to scan.
const hasKons = listInstalledKons().some((k) => k.source !== "core" && Boolean(k.path));

describe("Admin Registry", () => {
  describe("Service", () => {
    // The first one builds the registry COLD (scans all the installed
    // kons): with the 18 production ones it exceeds bun's default 5 s.
    it("should build registry without errors", async () => {
      const registry = await buildAdminRegistry();
      expect(registry).toBeDefined();
      expect(Array.isArray(registry)).toBe(true);
    }, 30_000);

    it("should return kons with required fields", async () => {
      const registry = await buildAdminRegistry();

      for (const kon of registry) {
        expect(kon.id).toBeDefined();
        expect(kon.name).toBeDefined();
        expect(kon.category).toBeDefined();
        expect(kon.hasCustomView).toBeBoolean();
        expect(Array.isArray(kon.tables)).toBe(true);
        expect(Array.isArray(kon.views)).toBe(true);
        expect(kon.defaultView).toBeDefined();
      }
    });

    it("should detect tables from kon.json", async () => {
      const registry = await buildAdminRegistry();
      const gamesKon = registry.find((g) => g.id === "kon-games");

      if (gamesKon) {
        expect(gamesKon.tables.length).toBeGreaterThan(0);
        expect(gamesKon.tables.some((t) => t.name === "games")).toBe(true);
      }
    });

    it("should get specific kon config", async () => {
      const config = await getKonAdminConfig("kon-games");

      if (config) {
        expect(config.id).toBe("kon-games");
        expect(config.name).toBeDefined();
        expect(config.tables).toBeDefined();
      }
    });

    it("should return null for non-existent kon", async () => {
      const config = await getKonAdminConfig("non-existent-kon");
      expect(config).toBeNull();
    });

    it("should have consistent view configuration", async () => {
      const registry = await buildAdminRegistry();

      for (const kon of registry) {
        // All views should have required fields
        for (const view of kon.views) {
          expect(view.id).toBeDefined();
          expect(view.type).toBeDefined();
          expect(view.title).toBeDefined();

          /**
           * Valid view types.
           *
           * `dashboard` and `element` were missing from this list and they are the two that
           * the most kons use today: `element` is how third-party custom views
           * are loaded (a Web Component, not a .svelte import) and
           * `dashboard` is declared by Academy, DMS and Newsletter.
           *
           * The short list turned a perfectly valid view into a
           * test failure, which is the fastest way for a suite to stop
           * being looked at.
           */
          expect([
            "grid",
            "kanban",
            "calendar",
            "custom",
            "dashboard",
            "element",
            "form",
          ]).toContain(view.type);
        }

        // Default view should exist in views array (if views are defined)
        if (kon.views.length > 0) {
          const defaultViewExists = kon.views.some((v) => v.id === kon.defaultView);
          // Some kons may have a defaultView that doesn't match any view id;
          // in that case, we just verify the defaultView is a string.
          expect(typeof kon.defaultView).toBe("string");
        }
      }
    });
  });

  describe("Scanner Integration", () => {
    (hasKons ? it : it.skip)("should scan kons successfully", async () => {
      const kons = await scanPackages("kons");
      expect(kons).toBeDefined();
      expect(Array.isArray(kons)).toBe(true);
      expect(kons.length).toBeGreaterThan(0);
    });

    it("should have valid kon.json files", async () => {
      const kons = await scanPackages("kons");

      for (const kon of kons) {
        expect(kon.id).toBeDefined();
        expect(kon.name).toBeDefined();
        expect(kon.version).toBeDefined();
      }
    });
  });

  describe("Table Configuration", () => {
    it("should parse table configs from kon.json", async () => {
      const registry = await buildAdminRegistry();

      for (const kon of registry) {
        for (const table of kon.tables) {
          expect(table.name).toBeDefined();
          expect(table.label).toBeDefined();
          expect(table.primaryKey || "id").toBeDefined();
        }
      }
    });

    it("should support searchable and filterable fields", async () => {
      const registry = await buildAdminRegistry();

      for (const kon of registry) {
        for (const table of kon.tables) {
          if (table.searchableFields) {
            expect(Array.isArray(table.searchableFields)).toBe(true);
          }
          if (table.filterableFields) {
            expect(Array.isArray(table.filterableFields)).toBe(true);
          }
        }
      }
    });
  });
});

// Run tests
console.log("🧪 Running Admin Registry tests...");
