/**
 * Modules (Kons) Tests
 *
 * Tests for module registry, loading, and lifecycle management.
 * These tests don't require a database.
 */

import { describe, it, expect } from "bun:test";

import { installedKon } from "../lib/installed-kons";
import {
  KON_REGISTRY,
  KON_KEYS,
  getCoreKons,
  getOptionalKons,
  getGrimoireKons,
  getCoreDenKons,
} from "../services/module-registry";

/**
 * Kons are installed (kitsuden-kons repo) and the registry only
 * knows what is installed. What a specific kon expects is tested if THAT kon is
 * installed; in a clean clone of the core, the core's kons remain.
 */
const installed = (key: string) => !key.startsWith("kon-") || Boolean(installedKon(key)?.path);
const hasGrimoireKons = ["kon-games", "kon-esports", "kon-streamers"].some(installed);

describe("Kon Registry", () => {
  describe("Registry Structure", () => {
    it("should have kons registered", () => {
      expect(KON_REGISTRY.length).toBeGreaterThan(0);
      expect(KON_KEYS.length).toBeGreaterThan(0);
      expect(KON_KEYS.length).toBe(KON_REGISTRY.length);
    });

    it("should have unique keys", () => {
      const keys = KON_REGISTRY.map((g) => g.key);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it("should have all required fields for each kon", () => {
      for (const kon of KON_REGISTRY) {
        expect(kon.key).toBeDefined();
        expect(typeof kon.key).toBe("string");
        expect(kon.key.length).toBeGreaterThan(0);

        expect(kon.name).toBeDefined();
        expect(typeof kon.name).toBe("string");
        expect(kon.name.length).toBeGreaterThan(0);

        expect(kon.description).toBeDefined();
        expect(typeof kon.description).toBe("string");

        expect(kon.category).toBeDefined();
        expect(["core", "core-den", "optional", "grimoire"]).toContain(kon.category);

        expect(Array.isArray(kon.tables)).toBe(true);
        expect(Array.isArray(kon.dependsOn)).toBe(true);
        expect(Array.isArray(kon.referencedBy)).toBe(true);
      }
    });
  });

  describe("Categories", () => {
    it("should categorize kons correctly", () => {
      const core = getCoreKons();
      const optional = getOptionalKons();
      const coreDen = getCoreDenKons();
      const grimoire = getGrimoireKons();

      expect(core.length).toBeGreaterThanOrEqual(0);
      expect(optional.length).toBeGreaterThanOrEqual(0);
      expect(coreDen.length).toBeGreaterThanOrEqual(0);
      expect(grimoire.length).toBeGreaterThanOrEqual(0);

      // Verify total matches
      const total = core.length + optional.length + coreDen.length + grimoire.length;
      expect(total).toBe(KON_REGISTRY.length);
    });

    it("should have grimoire kons with grimoireId", () => {
      const grimoireKons = getGrimoireKons();

      for (const kon of grimoireKons) {
        expect(kon.grimoireId).toBeDefined();
        expect(typeof kon.grimoireId).toBe("string");
        expect(kon.grimoireId!.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Dependencies", () => {
    it("should track dependencies when present", () => {
      const konWithDeps = KON_REGISTRY.find((g) => g.dependsOn.length > 0);

      if (konWithDeps) {
        expect(konWithDeps.dependsOn.length).toBeGreaterThan(0);

        // All dependencies should exist in registry
        for (const dep of konWithDeps.dependsOn) {
          expect(KON_KEYS).toContain(dep);
        }
      } else {
        // If no kons have dependencies, that's also valid
        expect(KON_REGISTRY.every((g) => g.dependsOn.length === 0)).toBe(true);
      }
    });

    it("should track references when present", () => {
      const konWithRefs = KON_REGISTRY.find((g) => g.referencedBy.length > 0);

      if (konWithRefs) {
        expect(konWithRefs.referencedBy.length).toBeGreaterThan(0);

        for (const ref of konWithRefs.referencedBy) {
          expect(ref.kon).toBeDefined();
          expect(ref.table).toBeDefined();
          expect(ref.column).toBeDefined();
          expect(ref.label).toBeDefined();
        }
      }
    });
  });

  describe("Kon Definitions", () => {
    const expectedKons = [
      { key: "kon-media", category: "core" },
      { key: "kon-datasets", category: "core" },
      { key: "kon-blocks", category: "core-den" },
      { key: "kon-blog", category: "core-den" },
      { key: "kon-academy-lms", category: "optional" },
      { key: "kon-dms", category: "optional" },
      { key: "kon-booking", category: "optional" },
      { key: "kon-directory", category: "optional" },
      { key: "kon-crm", category: "optional" },
      { key: "ai-memories", category: "optional" },
      { key: "kon-games", category: "grimoire" },
      { key: "kon-esports", category: "grimoire" },
      { key: "kon-streamers", category: "grimoire" },
    ];

    for (const expected of expectedKons) {
      (installed(expected.key) ? it : it.skip)(
        `should have ${expected.key} as ${expected.category}`,
        () => {
          const kon = KON_REGISTRY.find((g) => g.key === expected.key);
          expect(kon).toBeDefined();
          expect((kon as any).category).toBe(expected.category);
        }
      );
    }
  });

  describe("Icons and Colors", () => {
    it("should have icons for all kons", () => {
      for (const kon of KON_REGISTRY) {
        expect(kon.icon).toBeDefined();
        expect(typeof kon.icon).toBe("string");
        expect(kon.icon.length).toBeGreaterThan(0);
      }
    });

    it("every kon declares a color that CSS understands", () => {
      /**
       * Hexadecimal OR `hsl(...)`.
       *
       * The previous version required only `#rrggbb`, and the registry moved to `hsl()`
       * when the palette was unified — so the test had been red for a while
       * reporting a deliberate change. A test that fails over something correct
       * teaches people to ignore the suite.
       *
       * What does matter is that the value is PAINTABLE: if it is not, the kon's
       * card comes out without color and nothing warns.
       */
      const validColor = /^(#[0-9A-Fa-f]{3,8}|hsla?\([^)]+\)|rgba?\([^)]+\))$/;

      const invalid = KON_REGISTRY.filter((kon) => !validColor.test(kon.color ?? "")).map(
        (kon) => `${kon.key}: ${kon.color}`
      );

      expect(invalid).toEqual([]);
    });
  });
});

describe("Kon Loader", () => {
  it("should resolve directory paths correctly", () => {
    const testCases = [
      { input: "games", expectedDir: "kon-games" },
      { input: "academy", expectedDir: "kon-academy-lms" },
      { input: "kitsuden-crm", expectedDir: "kon-crm" },
    ];

    for (const testCase of testCases) {
      // Mirror the logic in module-loader.ts
      const cleanName = testCase.input.replace(/^kon-/, "");
      const dirMap: Record<string, string> = {
        academy: "kon-academy-lms",
        "kitsuden-crm": "kon-crm",
      };
      const dirName = dirMap[testCase.input] || `kon-${cleanName}`;

      expect(dirName).toBe(testCase.expectedDir);
    }
  });
});

describe("Kon Registry Helpers", () => {
  it("getCoreKons should return only core category", () => {
    const core = getCoreKons();
    expect(core.every((g) => g.category === "core")).toBe(true);
  });

  it("getOptionalKons should return only optional category", () => {
    const optional = getOptionalKons();
    expect(optional.every((g) => g.category === "optional")).toBe(true);
  });

  it("getGrimoireKons should return only grimoire category", () => {
    const grimoire = getGrimoireKons();
    expect(grimoire.every((g) => g.category === "grimoire")).toBe(true);
  });

  it("getCoreDenKons should return only core-den category", () => {
    const coreDen = getCoreDenKons();
    expect(coreDen.every((g) => g.category === "core-den")).toBe(true);
  });

  it("getGrimoireKons should filter by grimoireId", () => {
    const grimoireEsports = getGrimoireKons("grimoire-esports");
    expect(grimoireEsports.every((g) => g.grimoireId === "grimoire-esports")).toBe(true);
  });

  (hasGrimoireKons ? it : it.skip)(
    "getGrimoireKons without filter should return all grimoire kons",
    () => {
      const allGrimoire = getGrimoireKons();
      expect(allGrimoire.length).toBeGreaterThan(0);
      expect(allGrimoire.every((g) => g.category === "grimoire")).toBe(true);
    }
  );
});

describe("Registry Counts", () => {
  it("should have expected number of kons", () => {
    // The core's (media, datasets, blocks) and ai-memories always; with the
    // earlier kons installed, at least 13.
    const withThePreviousOnes = ["kon-blog", "kon-crm", "kon-games", "kon-dms"].every(installed);
    expect(KON_REGISTRY.length).toBeGreaterThanOrEqual(withThePreviousOnes ? 13 : 4);
  });

  it("core and grimoire do not overlap", () => {
    /**
     * It used to assert «there are more grimoire kons than core», which is not
     * a property of the system but a snapshot of how many there were the day it was
     * written. When the categories were reordered it became 3 and 3 and the test turned
     * red with nothing wrong.
     *
     * What must always hold is that a kon is not in both
     * lists: if it were, activating or deactivating it would have two different
     * answers depending on where you ask.
     */
    const grimoire = new Set(getGrimoireKons().map((k) => k.key));
    const core = getCoreKons().map((k) => k.key);

    const inBoth = core.filter((key) => grimoire.has(key));
    expect(inBoth).toEqual([]);
  });
});
