/**
 * System Map — Route (system function, no AI)
 * ============================================================================
 *
 * GET /api/map
 *   Deterministic map of the repo (routes, tables, kons, services, libs) + the
 *   live application (tables and FK relations via PostgreSQL introspection).
 *
 * Like every route under /api/*, it honors TOON negotiation:
 *   GET /api/map?format=toon   →  response in TOON
 *   Accept: application/vnd.toon
 */

import { buildSystemMap } from "@kitsuden/engine";
import { Hono } from "hono";

import { protectRoute } from "../middleware/auth-guard";
import { getAllTables, introspectTable } from "../services/schema-introspector";

const app = new Hono();

/** Builds the live FK relations from PostgreSQL introspection. */
async function liveDatabase(): Promise<
  { tables: string[]; relations: { from: string; to: string; via: string }[] } | undefined
> {
  try {
    const tables = await getAllTables("public");
    const relations: { from: string; to: string; via: string }[] = [];
    for (const table of tables) {
      const info = await introspectTable(table, "public");
      if (!info) continue;
      for (const fk of info.foreignKeys) {
        relations.push({ from: table, to: fk.foreignTable, via: fk.column });
      }
    }
    return { tables, relations };
  } catch {
    // No DB available → repo-only map (clean degradation).
    return undefined;
  }
}

app.get("/", protectRoute, async (c) => {
  const includeDb = c.req.query("db") !== "false";
  const database = includeDb ? await liveDatabase() : undefined;
  const map = buildSystemMap({ projectRoot: process.cwd(), database });
  return c.json(map);
});

export const systemMapRoutes = app;
