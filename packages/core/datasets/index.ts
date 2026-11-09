/**
 * Kitsuden Core Kon - DataSets
 *
 * Dynamic data collections with automatic API generation.
 * This is a CORE kon - enabled by default but can be disabled.
 *
 * Provides:
 * - Dynamic schema definition
 * - Auto-generated REST API
 * - RLS (Row Level Security)
 * - Validation with Zod
 * - Relations between datasets
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";

import { adminConfig } from "./datasets.admin";
import { createDatasetsRouter, datasetOperations } from "./datasets.routes";

// Re-export schema for schema-merger
export * from "./datasets.schema";
export * from "./datasets.calculated.schema";
export { adminConfig };
export { registerDatasetsPolicy } from "./datasets.policy";

// Export new features
export * from "./datasets.import-export";
export * from "./datasets.snapshots";
export * from "./datasets.indexes";
export * from "./datasets.search";

/**
 * Kon definition for DataSets
 */
// Kon SDK: the router, the OpenAPI and the MCP tools come from the
// operations declared in datasets.routes.ts.
export const kon = defineKonSdk({
  id: "kon-datasets",
  name: "DataSets",
  version: "1.0.0",
  description: "Dynamic data collections with automatic REST API",
  icon: "Database",

  // Mount path for routes
  mountPath: "/api/datasets",

  // The operations (the router is generated from them)
  operations: (ctx: KonContext) => datasetOperations(ctx),

  // Admin configuration
  admin: {
    category: "core",
    order: 0, // First in sidebar
    icon: "Database",
    views: adminConfig.views as any,
  } as any,

  // Hooks
  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("📊 DataSets kon initialized");

      // Verify tables exist
      const hasDataSets = await ctx.db.tableExists("data_sets");
      const hasDataEntries = await ctx.db.tableExists("data_entries");
      const hasCalculatedFields = await ctx.db.tableExists("data_set_calculated_fields");

      if (!hasDataSets || !hasDataEntries) {
        ctx.logger.error("❌ DataSets tables not found. Run migrations!");
        throw new Error("DataSets tables missing");
      }

      if (!hasCalculatedFields) {
        ctx.logger.warn(
          "⚠️ Calculated fields table not found. Run migration: 0001_calculated_fields.sql"
        );
      }

      ctx.logger.info("✅ DataSets tables verified");
    },

    onEnable: async (ctx) => {
      ctx.logger.info("📊 DataSets enabled");
    },

    onDisable: async (ctx) => {
      ctx.logger.info("📊 DataSets disabled - API routes will not be available");
    },
  },

  // Dependencies
  dependencies: {
    kons: [], // No dependencies on other kons
    core: ["auth"], // Requires auth system
  },
});

// Export router creator for compatibility
export { createDatasetsRouter };

// Export calculated fields types (from legacy packages/core)
export type {
  CalculatedField,
  CalculatedFieldType,
  FilterConfig,
  FormulaBuilderNode,
} from "./calculated-fields";

export { FORMULA_FUNCTIONS, FORMULA_OPERATORS } from "./calculated-fields";

// Default export
export default kon;
