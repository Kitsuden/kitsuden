/**
 * Kon: Media Library (Core)
 *
 * Media file management with pluggable storage (MinIO, S3, Local, R2).
 * Toggleable Core Kon - can be disabled but storage service remains.
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonDefinition, KonContext } from "@kitsuden/shared";

import { adminConfig } from "./admin";
import { mediaOperations } from "./media.routes";
import { transformationOperations } from "./transform.routes";

// Tables array for kon definition
const tables = ["media", "media_folders"];
import { sql } from "drizzle-orm";

// Export configuration types
export type {
  StorageConfig,
  MinioStorageConfig,
  S3StorageConfig,
  LocalStorageConfig,
  R2StorageConfig,
  MediaFeaturesConfig,
  MediaKonConfig,
} from "./config.schema";
export { defaultMediaConfig, validateMediaConfig, storageProviders } from "./config.schema";
export { createStorageAdapter, testStorageConnection } from "./storage.adapter";

// ═══════════════════════════════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════════════════════════════

const hooks: NonNullable<KonDefinition["hooks"]> = {
  /**
   * onStartup: Verify media tables exist
   */
  onStartup: async (ctx: KonContext) => {
    ctx.logger.info("[Media] Verifying database tables...");

    try {
      // Check if media table exists
      const result = await ctx.db.instance.execute(sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'media'
        );
      `);

      const exists = result.rows?.[0]?.exists ?? false;

      if (!exists) {
        ctx.logger.warn("[Media] Tables not found. Run migrations:");
        ctx.logger.warn("  cd apps/api && bun run db:migrate");
      } else {
        ctx.logger.info("[Media] ✓ Tables verified");
      }
    } catch (err) {
      ctx.logger.error("[Media] Failed to verify tables:", err as Record<string, unknown>);
    }
  },

  /**
   * onEnable: Setup when enabled
   */
  onEnable: async (ctx: KonContext) => {
    ctx.logger.info("[Media] Enabled");
  },

  /**
   * onDisable: Cleanup when disabled
   */
  onDisable: async (ctx: KonContext) => {
    ctx.logger.info("[Media] Disabled - routes will be removed");
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// KON DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

// Kon SDK: the router, the OpenAPI and the MCP tools come from the
// operations declared in media.routes.ts and transform.routes.ts.
export const kon: KonDefinition = defineKonSdk({
  // Identity
  id: "kon-media",
  name: "Media Library",
  version: "1.0.0",
  description: "Media file management with S3/MinIO storage",

  // Icon
  icon: "Image",

  // Type
  mountPath: "/api/media",

  // The operations (the router is generated from them). First the media library and
  // then the transformations: the registration order is the same as before.
  operations: (ctx: KonContext) => [...mediaOperations(ctx), ...transformationOperations(ctx)],

  // Tables
  tables,

  // Transforming is public and expensive (sharp): its own per-IP limit
  // (security audit).
  rateLimits: [
    {
      path: "/transform/:id",
      limit: 120,
      window: 60,
      message: "Too many transformations in a row.",
    },
  ],

  // Admin configuration
  admin: {
    category: "core",
    views: (adminConfig.views || []).map((v) => ({
      id: v.slug,
      type: "custom" as const,
      title: v.label,
    })),
  },

  // Dependencies
  dependencies: {
    kons: [],
    core: ["auth"],
  },

  // Hooks
  hooks,
});

// Default export for dynamic imports
export default kon;
