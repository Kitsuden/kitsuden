/**
 * Kon: Page Builder (Core)
 *
 * Lego-style block system for dynamic page layouts with drag & drop.
 * Toggleable Core Kon.
 *
 * @version 1.0.0
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonDefinition, KonContext } from "@kitsuden/shared";

// KonHooks removed from @kitsuden/shared — inline the type
type KonHooks = Record<string, (...args: any[]) => void | Promise<void>>;
import { createBlocksRouter, blockOperations } from "./blocks.routes";

// Tables array for kon definition
const tables = ["block_pages", "block_contents", "block_templates"];
import { sql } from "drizzle-orm";

// Export schema types
export { pages, blocks, blockTemplates } from "./blocks.schema";

export type {
  Page,
  NewPage,
  Block,
  NewBlock,
  BlockTemplate,
  NewBlockTemplate,
  BlockContent,
  HeroBlockContent,
  TextBlockContent,
  ImageBlockContent,
  VideoBlockContent,
  GridBlockContent,
  CardsBlockContent,
  QuoteBlockContent,
  CtaBlockContent,
  EmbedBlockContent,
  DividerBlockContent,
  SpacerBlockContent,
  CustomBlockContent,
} from "./blocks.schema";

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const adminConfig = {
  views: [
    {
      label: "Pages",
      slug: "pages",
      icon: "FileText",
      defaultView: true,
      component: "Blocks",
    },
    {
      label: "Templates",
      slug: "templates",
      icon: "Layout",
      defaultView: false,
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════════════════════════════

const hooks: KonHooks = {
  /**
   * onStartup: Verify tables exist
   */
  onStartup: async (ctx: KonContext) => {
    ctx.logger.info("[PageBuilder] Verifying database tables...");

    try {
      // Check if pages table exists
      const result = await ctx.db.instance.execute(sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = 'block_pages'
        );
      `);

      const exists = result.rows?.[0]?.exists ?? false;

      if (!exists) {
        ctx.logger.warn("[PageBuilder] Tables not found. Run migrations:");
        ctx.logger.warn("  cd apps/api && bun run db:migrate");
      } else {
        ctx.logger.info("[PageBuilder] ✓ Tables verified");
      }
    } catch (err) {
      ctx.logger.error("[PageBuilder] Failed to verify tables:", err as Record<string, unknown>);
    }
  },

  /**
   * onShutdown: Cleanup
   */
  onShutdown: async (ctx: KonContext) => {
    ctx.logger.info("[PageBuilder] Shutting down...");
  },

  /**
   * onEnable: Setup when enabled
   */
  onEnable: async (ctx: KonContext) => {
    ctx.logger.info("[PageBuilder] Enabled");
  },

  /**
   * onDisable: Cleanup when disabled
   */
  onDisable: async (ctx: KonContext) => {
    ctx.logger.info("[PageBuilder] Disabled - routes will be removed");
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// KON DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

// Kon SDK: the router, the OpenAPI and the MCP tools come from the
// operations declared in blocks.routes.ts.
export const kon: KonDefinition = defineKonSdk({
  // Identity
  id: "kon-blocks",
  name: "Page Builder",
  version: "1.0.0",
  description:
    "Lego-style block system for dynamic page layouts with drag & drop. Includes Hero, Text, Image, Video, Grid, Cards, Quote, CTA, Embed, Divider, and Spacer blocks.",

  // Icon
  icon: "Layout",

  // Type
  mountPath: "/api/page-builder",

  // The operations (the router is generated from them)
  operations: (ctx: KonContext) => blockOperations(ctx),

  // Tables
  tables,

  // Admin configuration
  admin: {
    category: "core",
    views: adminConfig.views.map((v) => ({
      id: v.slug,
      type: "custom" as const,
      title: v.label,
    })),
  },

  // Dependencies
  dependencies: {
    kons: ["kon-media"], // Needs media for images
    core: ["auth"],
  },

  // Hooks
  hooks,
});

// Default export for dynamic imports
export default kon;

// Legacy exports for compatibility
export const pageBuilderRoutes = createBlocksRouter;
