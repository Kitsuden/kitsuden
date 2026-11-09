/**
 * Schema Introspection API
 *
 * Provides database schema introspection endpoints for:
 * - Auto-discovery of table structure
 * - Column types and constraints
 * - Foreign key relationships
 * - Index information
 */

import { Hono } from "hono";

import { requireAuth } from "../middleware/auth";
import {
  introspectTable,
  getAllTables,
  searchTables,
  getRelatedTables,
  generateAdminConfigFromIntrospection,
  clearIntrospectionCache,
} from "../services/schema-introspector";

export const schemaIntrospectionRoutes = new Hono();

// All routes require authentication
schemaIntrospectionRoutes.use("/*", requireAuth);

/**
 * GET /api/schema/tables
 * List all tables in the database
 */
schemaIntrospectionRoutes.get("/tables", async (c) => {
  try {
    const tables = await getAllTables();
    return c.json({
      success: true,
      tables,
      count: tables.length,
    });
  } catch (err) {
    console.error("[SchemaIntrospection] Failed to get tables:", err);
    return c.json(
      {
        success: false,
        error: "Failed to retrieve tables",
      },
      500
    );
  }
});

/**
 * GET /api/schema/tables/:tableName
 * Get detailed introspection for a specific table
 */
schemaIntrospectionRoutes.get("/tables/:tableName", async (c) => {
  const tableName = c.req.param("tableName");

  try {
    const introspected = await introspectTable(tableName);

    if (!introspected) {
      return c.json(
        {
          success: false,
          error: `Table '${tableName}' not found`,
        },
        404
      );
    }

    return c.json({
      success: true,
      table: introspected,
    });
  } catch (err) {
    console.error(`[SchemaIntrospection] Failed to introspect ${tableName}:`, err);
    return c.json(
      {
        success: false,
        error: "Failed to introspect table",
      },
      500
    );
  }
});

/**
 * GET /api/schema/tables/:tableName/admin-config
 * Generate admin configuration from introspection
 */
schemaIntrospectionRoutes.get("/tables/:tableName/admin-config", async (c) => {
  const tableName = c.req.param("tableName");

  try {
    const config = await generateAdminConfigFromIntrospection(tableName);

    return c.json({
      success: true,
      config,
    });
  } catch (err) {
    console.error(`[SchemaIntrospection] Failed to generate config for ${tableName}:`, err);
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Failed to generate config",
      },
      404
    );
  }
});

/**
 * GET /api/schema/tables/:tableName/related
 * Get tables related to this one (incoming and outgoing FKs)
 */
schemaIntrospectionRoutes.get("/tables/:tableName/related", async (c) => {
  const tableName = c.req.param("tableName");

  try {
    const related = await getRelatedTables(tableName);

    return c.json({
      success: true,
      table: tableName,
      related,
    });
  } catch (err) {
    console.error(`[SchemaIntrospection] Failed to get related tables for ${tableName}:`, err);
    return c.json(
      {
        success: false,
        error: "Failed to get related tables",
      },
      500
    );
  }
});

/**
 * GET /api/schema/search?q=pattern
 * Search tables by name pattern
 */
schemaIntrospectionRoutes.get("/search", async (c) => {
  const query = c.req.query("q");

  if (!query) {
    return c.json(
      {
        success: false,
        error: "Query parameter 'q' is required",
      },
      400
    );
  }

  try {
    const tables = await searchTables(query);

    return c.json({
      success: true,
      query,
      tables,
      count: tables.length,
    });
  } catch (err) {
    console.error("[SchemaIntrospection] Failed to search tables:", err);
    return c.json(
      {
        success: false,
        error: "Failed to search tables",
      },
      500
    );
  }
});

/**
 * POST /api/schema/refresh
 * Clear introspection cache
 */
schemaIntrospectionRoutes.post("/refresh", async (c) => {
  try {
    clearIntrospectionCache();

    return c.json({
      success: true,
      message: "Schema cache cleared",
    });
  } catch (err) {
    console.error("[SchemaIntrospection] Failed to clear cache:", err);
    return c.json(
      {
        success: false,
        error: "Failed to clear cache",
      },
      500
    );
  }
});
