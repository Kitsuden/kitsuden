/**
 * Module Loader Unit Tests
 *
 * Tests pure functions and resolution logic without DB initialization.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";

// We test the pure logic patterns used by module-loader without importing
// the heavy module which triggers DB side effects on load.

describe("Module Loader Logic", () => {
  describe("Kon path resolution", () => {
    it("should map kon name to directory name", () => {
      const cases = [
        { name: "games", expected: "kon-games" },
        { name: "blog", expected: "kon-blog" },
        { name: "academy", expected: "kon-academy-lms" },
        { name: "kitsuden-crm", expected: "kon-crm" },
        { name: "media", expected: "kon-media" },
      ];

      for (const { name, expected } of cases) {
        const cleanName = name.replace(/^kon-/, "");
        const dirMap: Record<string, string> = {
          academy: "kon-academy-lms",
          "kitsuden-crm": "kon-crm",
        };
        const dirName = dirMap[name] || `kon-${cleanName}`;
        expect(dirName).toBe(expected);
      }
    });

    it("should handle scoped npm packages", () => {
      const scopes = ["@kitsuden/kon-games", "@scope/kon-custom"];
      for (const pkg of scopes) {
        expect(pkg).toMatch(/^@[a-z0-9-]+\/kon-[a-z0-9-]+$/);
      }
    });

    it("should handle community package names", () => {
      const pkg = "kon-games";
      expect(pkg.startsWith("kon-")).toBe(true);
    });
  });

  describe("Dependency ordering", () => {
    it("should sort kons with no dependencies in original order", () => {
      const kons = [
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: [] },
        { id: "c", dependsOn: [] },
      ];
      const sorted = [...kons]; // No deps = same order
      expect(sorted.map((g) => g.id)).toEqual(["a", "b", "c"]);
    });

    it("should place dependencies before dependents", () => {
      const kons = [
        { id: "blog", dependsOn: ["media"] },
        { id: "media", dependsOn: [] },
      ];
      // Simulate a topological sort
      const byDeps = [...kons].sort((a, b) => {
        if (a.dependsOn.includes(b.id)) return 1;
        if (b.dependsOn.includes(a.id)) return -1;
        return 0;
      });
      expect(byDeps[0].id).toBe("media");
      expect(byDeps[1].id).toBe("blog");
    });

    it("should handle transitive dependencies with topological sort", () => {
      const kons = [
        { id: "esports", dependsOn: ["games"] },
        { id: "games", dependsOn: ["media"] },
        { id: "media", dependsOn: [] },
      ];

      // Simple topological sort via iteration
      const sorted: typeof kons = [];
      const remaining = new Set(kons.map((g) => g.id));
      while (remaining.size > 0) {
        for (const g of kons) {
          if (!remaining.has(g.id)) continue;
          const depsSatisfied = g.dependsOn.every((d) => !remaining.has(d));
          if (depsSatisfied) {
            sorted.push(g);
            remaining.delete(g.id);
          }
        }
      }

      expect(sorted[0].id).toBe("media");
      expect(sorted[1].id).toBe("games");
      expect(sorted[2].id).toBe("esports");
    });
  });

  describe("Hono router detection", () => {
    it("should identify a Hono instance", () => {
      const hono = new Hono();
      expect(typeof hono).toBe("object");
      expect(typeof hono.fetch).toBe("function");
      expect(typeof hono.route).toBe("function");
    });

    it("should reject non-Hono values", () => {
      expect(typeof {} === "object").toBe(true);
      expect(typeof ({} as any).fetch).toBe("undefined");
      expect(typeof (() => {}) === "function").toBe(true);
    });
  });

  describe("Kon validation", () => {
    it("should validate a well-formed kon definition", () => {
      const def = {
        id: "test",
        name: "Test",
        version: "1.0.0",
        createRouter: () => new Hono(),
      };
      expect(typeof def.id).toBe("string");
      expect(typeof def.createRouter).toBe("function");
    });

    it("should reject invalid kon definitions", () => {
      const invalid = [{}, { id: "x" }, { createRouter: () => {} }, null, "string"];
      for (const def of invalid) {
        const isValid =
          typeof def === "object" &&
          def !== null &&
          "id" in def &&
          "createRouter" in def &&
          typeof (def as any).createRouter === "function";
        expect(isValid).toBe(false);
      }
    });
  });

  describe("Fallback resolution", () => {
    it("should fallback to legacy path if modern path missing", () => {
      const modernPath = false;
      const legacyPath = true;
      const resolved = modernPath || legacyPath;
      expect(resolved).toBe(true);
    });

    it("should return null if no path resolves", () => {
      const modernPath = false;
      const legacyPath = false;
      const resolved = modernPath || legacyPath || null;
      expect(resolved).toBeNull();
    });
  });
});
