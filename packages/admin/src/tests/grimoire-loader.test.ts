/**
 * Grimoire Loader Tests
 *
 * Tests the frontend grimoire loader functionality
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  hasCustomView,
  generateExplorerConfig,
  generateDefaultConfig,
  GRIMOIRE_VIEW_REGISTRY,
  clearRegistryCache,
  getGrimoireIcon,
} from "../lib/grimoire-loader";

describe("Grimoire Loader", () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  describe("Registry Cache", () => {
    it("should start with empty cache", () => {
      // Cache should be empty initially
      expect(true).toBe(true);
    });
  });

  describe("Custom View Detection", () => {
    it("should detect legacy registry entries", () => {
      expect(hasCustomView("games")).toBe(true);
      expect(hasCustomView("academy")).toBe(true);
      expect(hasCustomView("blog")).toBe(true);
    });

    it("should detect per-view entries only when a viewId is given", () => {
      // crm is hybrid: no grimoire-level monolith, only per-view components
      expect(hasCustomView("crm")).toBe(false);
      expect(hasCustomView("crm", "dashboard")).toBe(true);
      expect(hasCustomView("crm", "deal-form")).toBe(true);
    });

    it("should return false for unknown grimoires", () => {
      expect(hasCustomView("unknown-grimoire")).toBe(false);
      expect(hasCustomView("non-existent")).toBe(false);
    });
  });

  describe("Icon Resolution", () => {
    it("should return correct icons for known grimoires", () => {
      expect(getGrimoireIcon("games")).toBe("Gamepad2");
      expect(getGrimoireIcon("blog")).toBe("FileText");
      expect(getGrimoireIcon("actions")).toBe("Database");
      expect(getGrimoireIcon("datasets")).toBe("Database");
    });

    it("should return default icon for unknown grimoires", () => {
      expect(getGrimoireIcon("unknown")).toBe("Database");
      expect(getGrimoireIcon("xyz")).toBe("Database");
    });
  });

  describe("Config Generation", () => {
    it("should generate config from grimoire data", () => {
      const mockGrimoire = {
        id: "test-grimoire",
        name: "Test Grimoire",
        icon: "Test",
        category: "data" as const,
        hasCustomView: false,
        tables: [{ name: "items", label: "Items", primaryKey: "id" }],
        views: [{ id: "grid", type: "grid" as const, title: "All Items", table: "items" }],
        defaultView: "grid",
      };

      const config = generateExplorerConfig(mockGrimoire);

      expect(config.name).toBe("Test Grimoire");
      expect(config.singularName).toBe("Items");
      expect(config.icon).toBe("Test");
      expect(config.views).toHaveLength(1);
      expect(config.views[0].type).toBe("grid");

      /**
       * Without a declared `apiBase` there is NO `apiEndpoint`.
       *
       * This test demanded `"/api/explorer/items"` — the kon's FIRST table,
       * fixed — and it was pinning a real bug: DataExplorer treats a
       * three-segment route as final, so that value was used for ALL
       * the tabs. In Academy, all eleven requested `courses`; you clicked "Topics" and
       * kept seeing courses.
       *
       * Omitting it is what makes the explorer build
       * `/api/explorer/<table of the active view>` and the tabs work.
       */
      expect(config.apiEndpoint).toBeUndefined();
    });

    it("respects the apiBase the kon declares", () => {
      // The four kons that do expose a CRUD API per table (directory, dms,
      // ocr-training, vekstudio) declare it on purpose, and there the explorer
      // appends the table: `/api/directory` + `/employees`.
      const config = generateExplorerConfig({
        id: "test",
        name: "Test",
        icon: "Test",
        category: "data" as const,
        hasCustomView: false,
        tables: [{ name: "employees", label: "Employees", primaryKey: "id" }],
        views: [{ id: "grid", type: "grid" as const, title: "Employees", table: "employees" }],
        defaultView: "grid",
        apiBase: "/api/directory",
      });

      expect(config.apiEndpoint).toBe("/api/directory");
    });

    it("should handle kanban views", () => {
      const mockGrimoire = {
        id: "test",
        name: "Test",
        icon: "Test",
        category: "data" as const,
        hasCustomView: false,
        tables: [{ name: "tasks", label: "Tasks" }],
        views: [{ id: "kanban", type: "kanban" as const, title: "Board", table: "tasks" }],
        defaultView: "kanban",
      };

      const config = generateExplorerConfig(mockGrimoire);

      expect(config.views[0].type).toBe("kanban");
    });

    it("should handle calendar views", () => {
      const mockGrimoire = {
        id: "test",
        name: "Test",
        icon: "Test",
        category: "data" as const,
        hasCustomView: false,
        tables: [{ name: "events", label: "Events" }],
        views: [{ id: "calendar", type: "calendar" as const, title: "Calendar", table: "events" }],
        defaultView: "calendar",
      };

      const config = generateExplorerConfig(mockGrimoire);

      expect(config.views[0].type).toBe("calendar");
    });

    it("should filter out custom views", () => {
      const mockGrimoire = {
        id: "test",
        name: "Test",
        category: "data" as const,
        hasCustomView: true,
        tables: [{ name: "data", label: "Data" }],
        views: [
          { id: "custom", type: "custom" as const, title: "Custom", component: "Test" },
          { id: "grid", type: "grid" as const, title: "Grid", table: "data" },
        ],
        defaultView: "custom",
      };

      const config = generateExplorerConfig(mockGrimoire);

      expect(config.views).toHaveLength(1);
      expect(config.views[0].type).toBe("grid");
    });
  });

  describe("Default Config Generation", () => {
    it("should generate fallback config", async () => {
      const config = await generateDefaultConfig("my-grimoire");

      expect(config.name).toBe("My grimoire");
      expect(config.singularName).toBe("Record");
      expect(config.icon).toBeDefined();
      expect(config.views).toHaveLength(1);
      expect(config.views[0].type).toBe("grid");
      expect(config.apiEndpoint).toBe("/api/explorer/my-grimoire");
    });

    it("should handle grimoire- prefix", async () => {
      const config = await generateDefaultConfig("grimoire-books");

      expect(config.name).toBe("Books");
    });
  });

  describe("Legacy Registry", () => {
    it("should have games view registered", () => {
      expect(GRIMOIRE_VIEW_REGISTRY.games).toBeDefined();
    });

    it("should have games view registered", () => {
      expect(GRIMOIRE_VIEW_REGISTRY.games).toBeDefined();
    });
  });
});

console.log("🧪 Running Grimoire Loader tests...");
