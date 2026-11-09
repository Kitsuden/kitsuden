/**
 * Kitsuden — Dynamic Schema Merger (The Arcane Schema Weaver)
 *
 * Reads grimoire.json manifests and dynamically imports each kon's
 * Drizzle schema file, merging all exports into a single object
 * alongside the core schema.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LORE REFACTOR: Kitsuden's Magical Hierarchy
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Schema sources:
 *   1. Core schema: ./src/db/schema.ts
 *   2. Kon schemas: packages/kons/{kon}/{kon}.schema.ts
 *   3. Legacy theme modules: packages/grimoires/{grimoire}/kons/... (fallback)
 *
 * Used by db/index.ts to pass a complete schema to drizzle().
 * NOTE: schema-all.ts (static) is kept for drizzle-kit code generation.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { staticConfig as kitsudenConfig } from "../../kitsuden.config";
// `import type`, NOT `import`: TypeScript erases it at compile time, so it leaves no
// runtime edge towards `../db`. That edge was the cycle that blocked the entire
// API startup (see the comment on `buildMergedSchema`).
import type { Database } from "../db";
import * as coreSchema from "../db/schema-core";
import { installedKons } from "../db/schema-core";

import { readGrimoireKons } from "./grimoire-manifest";
import { konRoute } from "./installed-kons";

/**
 * Kons that handle their own migrations (SQL files)
 * These are excluded from schema merging to avoid conflicts
 */
const SELF_MIGRATING_KONS = new Set(["kon-academy-lms", "kon-booking", "academy", "booking"]);

/**
 * Get the currently active grimoire from environment (sync version for startup).
 * Falls back to null if not available.
 */
async function getActiveGrimoireSync(): Promise<string | null> {
  try {
    // Support both old and new env vars
    return process.env.KITSUDEN_ACTIVE_GRIMOIRE || process.env.KITSUDEN_ACTIVE_THEME || null;
  } catch {
    return null;
  }
}

/**
 * Grimoire manifest interface (grimoire.json)
 */
interface GrimoireManifest {
  id: string;
  name: string;
  kons: string[];
  optional_kons?: string[];
  bundled_modules?: string[]; // Legacy support
}

/**
 * Get bundled kons for a grimoire by reading its grimoire.json manifest.
 */
async function getGrimoireKons(grimoireId: string): Promise<string[]> {
  // Resolve workspace root
  const cwdCheck = join(process.cwd(), "packages", "kons", "package.json");
  const root = existsSync(cwdCheck) ? process.cwd() : join(process.cwd(), "../../");

  // The fallback to kitsuden.json and the check that what was read is a
  // grimoire (and not the THEME that lives in the same directory) are in
  // readGrimoireKons.
  return readGrimoireKons(join(root, "packages/grimoires", grimoireId));
}

/**
 * Dynamically build a merged schema object from core + active kons + grimoire kons.
 * Uses Bun's native dynamic import().
 */
/**
 * `queries` is the database access, and it is passed as a PARAMETER instead of imported.
 *
 * This is not style: `apps/api/src/db/index.ts` ends with
 * `export const db = await getDbInstance()` —a top-level await— and that
 * initialization calls here. If this module imported `db`, there would be a cycle with
 * a top-level await, and in ESM that blocks or not DEPENDING ON WHERE YOU ENTER FROM:
 * entering through `db` worked, entering through any module that reached
 * this one first hung forever, at 0% CPU and without a single error.
 *
 * It is omitted when the database initialization itself calls it —there is no
 * database yet— and it is passed from `routes/graphql.ts`, which rebuilds the schema
 * on the fly and does have one.
 *
 * This used to work by accident: during initialization, `db` was
 * in the temporal dead zone, the query threw a ReferenceError and the `catch` below
 * —commented as "the table may not exist"— swallowed it. The actual effect
 * was that kons installed through the database were NEVER taken into account at startup, and
 * nobody could see it. Now that is explicit.
 */
export async function buildMergedSchema(queries?: Database): Promise<Record<string, unknown>> {
  // Start with all core schema exports
  const merged: Record<string, unknown> = { ...coreSchema };

  const configKons = kitsudenConfig.kons ?? kitsudenConfig.modules ?? [];
  const activeGrimoire = await getActiveGrimoireSync();
  const grimoireKons = activeGrimoire ? await getGrimoireKons(activeGrimoire) : [];

  // Get kons installed via npm/marketplace from installed_kons table
  let dbInstalledIds: string[] = [];
  if (queries) {
    try {
      const rows = await queries
        .select({ konId: installedKons.konId })
        .from(installedKons)
        .where(eq(installedKons.enabled, true));
      dbInstalledIds = rows.map((r) => r.konId);
    } catch {
      // The table may not exist yet: on a clean startup, the schema is
      // built before the migrations have created it.
    }
  }

  const allKons = new Set([...configKons, ...grimoireKons, ...dbInstalledIds]);

  // Resolve workspace root (same logic as module-loader)
  const cwdCheck = join(process.cwd(), "packages", "kons", "package.json");
  const workspaceRoot = existsSync(cwdCheck)
    ? process.cwd() // Docker: /app/packages/kons exists
    : join(process.cwd(), "../../"); // Dev: apps/api/../../

  const konsPath = join(workspaceRoot, "packages/kons");
  const legacyModulesPath = join(process.cwd(), "src/modules");

  const KON_DIR_MAP: Record<string, string> = {
    academy: "kon-academy-lms",
    "kitsuden-crm": "kon-crm",
    "ai-memories": "ai-memories",
  };

  for (const name of allKons) {
    // Skip kons that handle their own migrations
    if (SELF_MIGRATING_KONS.has(name)) {
      console.log(`  ⏩ ${name} → self-managing (skipped)`);
      continue;
    }

    let schemaLoaded = false;

    // Try kons path first (new location)
    try {
      const cleanName = name.replace(/^kon-/, "");
      const dirName = KON_DIR_MAP[name] || KON_DIR_MAP[cleanName] || `kon-${cleanName}`;

      // First the folder of the INSTALLED kon (installed-kons.ts): it may not
      // be in packages/kons (linked from kitsuden-kons, node_modules…).
      const installed = konRoute(name);
      const possiblePaths = [
        ...(installed
          ? [
              join(installed, `${cleanName}.schema.ts`),
              join(installed, `${dirName}.schema.ts`),
              join(installed, `schema.ts`),
              join(installed, `src`, `schema.ts`),
              join(installed, `src`, `${cleanName}.schema.ts`),
            ]
          : []),
        join(konsPath, name, `${name}.schema.ts`),
        join(konsPath, name, `${cleanName}.schema.ts`),
        join(konsPath, name, `schema.ts`),
        join(konsPath, name, `src`, `schema.ts`),
        join(konsPath, name, `src`, `${name}.schema.ts`),
        join(konsPath, name, `src`, `${cleanName}.schema.ts`),
        join(konsPath, dirName, `${cleanName}.schema.ts`),
        join(konsPath, dirName, `${name}.schema.ts`),
        join(konsPath, dirName, `${dirName}.schema.ts`),
        join(konsPath, dirName, `schema.ts`),
        join(konsPath, dirName, `src`, `schema.ts`),
        join(konsPath, dirName, `src`, `${cleanName}.schema.ts`),
        join(konsPath, dirName, `src`, `${dirName}.schema.ts`),
      ];

      let targetPath = null;
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          targetPath = p;
          break;
        }
      }

      if (targetPath) {
        const mod = await import(targetPath);
        for (const [key, value] of Object.entries(mod)) {
          if (key === "default") continue;
          merged[key] = value;
        }
        console.log(`  📜 ${name} → schema merged (kon)`);
        schemaLoaded = true;
      }
    } catch {
      // Try legacy modules path
    }

    // Try node_modules (npm-installed kons)
    if (!schemaLoaded) {
      try {
        const cleanName = name.replace(/^kon-/, "");
        const nodeModulesPaths = [
          join(workspaceRoot, "node_modules"),
          join(process.cwd(), "node_modules"),
          join(workspaceRoot, "apps", "api", "node_modules"),
        ];

        for (const nmPath of nodeModulesPaths) {
          const npmPaths = [
            // Scoped official
            join(nmPath, "@kitsuden", `kon-${cleanName}`, `${cleanName}.schema.ts`),
            join(nmPath, "@kitsuden", `kon-${cleanName}`, `schema.ts`),
            join(nmPath, "@kitsuden", `kon-${cleanName}`, `src`, `schema.ts`),
            join(nmPath, "@kitsuden", name, `${cleanName}.schema.ts`),
            join(nmPath, "@kitsuden", name, `schema.ts`),
            join(nmPath, "@kitsuden", name, `src`, `schema.ts`),
            // Community
            join(nmPath, `kon-${cleanName}`, `${cleanName}.schema.ts`),
            join(nmPath, `kon-${cleanName}`, `schema.ts`),
            join(nmPath, `kon-${cleanName}`, `src`, `schema.ts`),
            join(nmPath, name, `${cleanName}.schema.ts`),
            join(nmPath, name, `schema.ts`),
            join(nmPath, name, `src`, `schema.ts`),
          ];

          for (const p of npmPaths) {
            if (existsSync(p)) {
              const mod = await import(p);
              for (const [key, value] of Object.entries(mod)) {
                if (key === "default") continue;
                merged[key] = value;
              }
              console.log(`  📜 ${name} → schema merged (npm)`);
              schemaLoaded = true;
              break;
            }
          }
          if (schemaLoaded) break;
        }

        // Fallback: use installed_kons.sourceUrl to resolve schema path
        if (!schemaLoaded) {
          try {
            const dbRows = queries
              ? await queries
                  .select({ sourceUrl: installedKons.sourceUrl, path: installedKons.path })
                  .from(installedKons)
                  .where(eq(installedKons.konId, name))
              : [];

            for (const row of dbRows) {
              const pkgName = row.sourceUrl;
              if (!pkgName) continue;

              for (const nmPath of nodeModulesPaths) {
                const resolvedPkgPath = join(nmPath, pkgName);
                if (!existsSync(resolvedPkgPath)) continue;

                const sourceUrlPaths = [
                  join(resolvedPkgPath, `${name.replace(/^kon-/, "")}.schema.ts`),
                  join(resolvedPkgPath, `schema.ts`),
                  join(resolvedPkgPath, `src`, `schema.ts`),
                  join(resolvedPkgPath, `${name}.schema.ts`),
                ];

                for (const p of sourceUrlPaths) {
                  if (existsSync(p)) {
                    const mod = await import(p);
                    for (const [key, value] of Object.entries(mod)) {
                      if (key === "default") continue;
                      merged[key] = value;
                    }
                    console.log(`  📜 ${name} → schema merged (npm via sourceUrl)`);
                    schemaLoaded = true;
                    break;
                  }
                }
                if (schemaLoaded) break;
              }
              if (schemaLoaded) break;
            }
          } catch {
            // Ignore
          }
        }
      } catch {
        // Continue to legacy fallback
      }
    }

    // Try legacy core modules path if not found
    if (!schemaLoaded) {
      try {
        const schemaPath = join(legacyModulesPath, name, `${name}.schema.ts`);
        if (existsSync(schemaPath)) {
          const mod = await import(schemaPath);
          for (const [key, value] of Object.entries(mod)) {
            if (key === "default") continue;
            merged[key] = value;
          }
          console.log(`  📜 ${name} → schema merged (legacy module)`);
          schemaLoaded = true;
        }
      } catch {
        // Kon may not have a schema file
      }
    }

    // If still not loaded, it's okay — kon might use core schema only
    if (!schemaLoaded) {
      console.log(`  ⚠️  ${name} → no schema file found`);
    }
  }

  return merged;
}

/**
 * @deprecated Use buildMergedSchema instead
 */
export const buildDynamicSchema = buildMergedSchema;
