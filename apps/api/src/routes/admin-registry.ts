/**
 * Admin Registry API
 *
 * Exposes auto-discovered kon admin configurations
 * for the frontend to consume without hardcoding.
 *
 * GET /api/admin/registry — Get all kon admin configs
 * GET /api/admin/registry/:konId — Get specific kon config
 * POST /api/admin/registry/refresh — Clear cache and rebuild
 */

import { ADMIN_REGISTRY_VERSION, CONTRACT_HEADER } from "@kitsuden/shared";
import { Hono } from "hono";

import { requireAuth } from "../middleware/auth";
import {
  buildAdminRegistry,
  getKonAdminConfig,
  clearAdminRegistryCache,
} from "../services/admin-registry";

export const adminRegistryRoutes = new Hono();

// All routes require authentication
adminRegistryRoutes.use("/*", requireAuth);

// The contract version also travels in a header, so a client can
// decide whether it can talk to this server without having to parse the body.
adminRegistryRoutes.use("/*", async (c, next) => {
  await next();
  c.header(CONTRACT_HEADER, `admin-registry/v${ADMIN_REGISTRY_VERSION}`);
});

/**
 * GET /api/admin/registry
 * Returns admin configuration for all enabled kons
 */
adminRegistryRoutes.get("/", async (c) => {
  try {
    const registry = await buildAdminRegistry();
    return c.json({
      success: true,
      contract: ADMIN_REGISTRY_VERSION,
      kons: registry,
      total: registry.length,
      withCustomViews: registry.filter((g) => g.hasCustomView).length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[AdminRegistry] Failed to build registry:", err);
    return c.json(
      {
        success: false,
        error: "Failed to build admin registry",
        message: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
});

/**
 * GET /api/admin/registry/:konId
 * Returns admin config for a specific kon
 */
adminRegistryRoutes.get("/:konId", async (c) => {
  const konId = c.req.param("konId");

  try {
    const config = await getKonAdminConfig(konId);

    if (!config) {
      return c.json(
        {
          success: false,
          error: `Kon '${konId}' not found or has no admin configuration`,
        },
        404
      );
    }

    return c.json({
      success: true,
      contract: ADMIN_REGISTRY_VERSION,
      kon: config,
    });
  } catch (err) {
    console.error(`[AdminRegistry] Failed to get config for ${konId}:`, err);
    return c.json(
      {
        success: false,
        error: "Failed to get kon config",
        message: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
});

/**
 * POST /api/admin/registry/refresh
 * Clears cache and rebuilds registry (useful after kon changes)
 */
adminRegistryRoutes.post("/refresh", async (c) => {
  try {
    clearAdminRegistryCache();
    const registry = await buildAdminRegistry();

    return c.json({
      success: true,
      contract: ADMIN_REGISTRY_VERSION,
      message: "Admin registry refreshed",
      kons: registry,
      total: registry.length,
    });
  } catch (err) {
    console.error("[AdminRegistry] Failed to refresh registry:", err);
    return c.json(
      {
        success: false,
        error: "Failed to refresh registry",
        message: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
});

/**
 * GET /api/admin/registry/:konId/schema/:table
 * Returns schema for a specific table (columns, types, etc.)
 */
adminRegistryRoutes.get("/:konId/schema/:table", async (c) => {
  const { konId: _konId, table: _table } = c.req.param();

  // Delegate to existing data-explorer endpoint
  // This maintains backward compatibility
  return c.json({
    success: true,
    message: "Use /api/explorer/schema/:table for table schema",
  });
});
