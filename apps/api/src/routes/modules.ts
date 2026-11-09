/**
 * Modules API Routes
 *
 * Returns modules organized by category:
 *   - core: Official Kitsuden BaaS features (toggleable)
 *   - optional: Enterprise/vertical features (toggleable)
 *   - grimoire: Bundled with active grimoire (auto-loaded) — DYNAMIC
 *   - uninstalled: Kons with preserved data (can recover or purge)
 *
 * GET    /api/modules              — list all modules with categories
 * GET    /api/modules/:key         — get a single module by key
 * GET    /api/modules/:key/check   — can this module be disabled?
 * PATCH  /api/modules/:key         — toggle enabled / update settings
 * POST   /api/modules/:key/uninstall — uninstall but preserve data
 * POST   /api/modules/:key/recover   — recover uninstalled kon
 * DELETE /api/modules/:key         — delete kon and its data
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { eq, sql as drizzleSql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import { db } from "../db";
import { modules, siteSettings } from "../db/schema";
import { file } from "../lib/file";
import { readGrimoireManifest } from "../lib/grimoire-manifest";
import { konRoute } from "../lib/installed-kons";
import { searchByKonKey, canonicalKey, mergeByKon } from "../lib/kon-key";
import { getLoadReport } from "../lib/module-loader";
import {
  CORE_MODULES,
  CORE_MODULE_KEYS,
  checkCanDisable,
  getCoreModules,
  getOptionalModules,
  getCoreDenKons,
} from "../services/module-registry";
import { scanPackages } from "../services/scanner";

/**
 * Check if a kon has data in the database
 * Returns table names and row counts if data exists
 */
/**
 * Are this kon's routes mounted in the running process?
 *
 * ── WHY THIS CANNOT BE FIXED BY MOUNTING THEM ──────────────────────────────
 *
 * Because Hono does not allow it. Kons are mounted with `app.route()` in `loadKons()`,
 * which runs ONCE at startup, and as soon as the router serves the first
 * request it freezes its matcher:
 *
 *     Can not add a route since the matcher is already built.
 *
 * So hot-activating a kon can create its tables —that does work—
 * but its endpoints will not exist until the next restart.
 *
 * Keeping quiet about it would leave exactly the state that was so costly to debug: the kon
 * shows up in the menu, the user goes in, and each of its screens returns 404 with
 * nothing explaining why. A half installation presented as complete.
 */
function mountedRoutes(key: string): boolean {
  const report = getLoadReport();
  const withoutPrefix = key.replace(/^kon-/, "");
  return report.loaded.some((c) => c === key || c.replace(/^kon-/, "") === withoutPrefix);
}

/**
 * Leaves the kon serving ALREADY, without restarting.
 *
 * At startup `loadKons()` reserved a wildcard path for each disabled kon
 * (see `lib/deferred-kons.ts`). Here it is only necessary to import the kon and hang its
 * router from that path — Hono's route table is not touched, which is what
 * made it impossible.
 *
 * It is done here and not on the first request so that a broken kon shows up in
 * the toggle's response, which is where the user is looking, and not as a
 * stray 500 five minutes later.
 */
async function hotMountKon(key: string): Promise<{ mounted: boolean; reason?: string }> {
  try {
    const { activateKonHot } = await import("../lib/deferred-kons");
    return await activateKonHot(key);
  } catch (err) {
    return { mounted: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Installs a kon's schema before considering it active.
 *
 * ── WHY IT RETURNS THE FAILURE INSTEAD OF THROWING ─────────────────────────
 *
 * Because the failure has to reach the user as a response, not as a generic
 * 500. What was there was even worse:
 *
 *     try { await runModuleMigrations(key); }
 *     catch (err) { console.error(err); }        // ← and then
 *     await db.update(modules).set({ enabled: true });
 *
 * A `catch` that logs and carries on. The kon was left marked as enabled without
 * a single table, showed up in the side menu, and each of its screens returned
 * 500 or a form with no fields. The only trace was a line in the container logs.
 *
 * Returns `null` if all went well, or the response body and code.
 */
async function installKonSchema(
  key: string
): Promise<{ status: 409 | 500; body: Record<string, unknown> } | null> {
  const kons = await scanPackages("kons");
  const manifest = kons.find((k) => k.id === key || k.id === `kon-${key}`);

  // The kon is not on this install (the default image holds the core only). Without
  // this, the panel's switch answered 500 «migrations failed», which sends you
  // looking for an SQL error that does not exist.
  if (!manifest && !konRoute(key)) {
    return {
      status: 409,
      body: {
        error: "Kon not installed",
        message: `'${key}' is not installed on this instance, so it cannot be enabled.`,
        key,
        hint:
          `With Docker: add it to KITSUDEN_KONS and rebuild the image. ` +
          `Locally: kitsuden kon add ${key.replace(/^kon-/, "")}. See docs/kons/installing.md.`,
      },
    };
  }

  // The declared tables are checked AFTER migrating: they are the kon's
  // explicit promise, and what separates "migrated" from "works".
  const declaredMany = (
    (manifest as { tables?: (string | { name: string })[] } | undefined)?.tables ?? []
  ).map((t) => (typeof t === "string" ? t : t.name));

  try {
    const { applyKonMigrations } = await import("../lib/kon-migrations");
    const r = await applyKonMigrations(key, {
      installPath: manifest?.installPath,
      declaredTables: declaredMany,
    });

    if (r.missingTables.length > 0) {
      /**
       * Three different reasons with the same symptom, and they have to be told apart.
       *
       * The earlier version always said "still do not exist AFTER
       * APPLYING their migrations", and in the most common case that was false: none
       * was applied. All were already recorded in `kitsuden_migrations` and were
       * skipped. The message sent people to review an SQL that had not been
       * run.
       *
       * The case does happen —a test cleanup caused it— whenever
       * the history and the schema stop matching: someone drops tables,
       * a partial backup is restored, or `--baseline` was applied to a database
       * that did not have that schema.
       */
      const nothingToApply = r.applied.length === 0 && r.alreadyWere.length === 0;
      const historyOutOfSync = r.applied.length === 0 && r.alreadyWere.length > 0;

      const message = historyOutOfSync
        ? `The history says the migrations of '${key}' were ALREADY applied, ` +
          `but its tables are not in the database. No migration was run ` +
          `in this attempt: all were skipped because they are recorded as applied.`
        : nothingToApply
          ? `'${key}' has no migration files, so nothing creates its ` +
            `tables. It is not activated: doing so would leave its screens returning ` +
            `errors.`
          : `The migrations of '${key}' were applied but did not create all the ` +
            `tables its manifest declares.`;

      const hint = historyOutOfSync
        ? `The history and the schema do not match. For the chain to be ` +
          `applied again, delete its record and retry:

` +
          `    DELETE FROM kitsuden_migrations WHERE name LIKE '${key}/%';

` +
          `If the tables were dropped on purpose, this recreates them empty.`
        : nothingToApply
          ? `Add the startup migration in packages/kons/${key}/migrations/ ` +
            `(you can generate it from its *.schema.ts file with drizzle-kit).`
          : `Check that packages/kons/${key}/migrations creates exactly the ` +
            `tables that kon.json declares.`;

      return {
        status: 409,
        body: {
          error: "Incomplete schema",
          message,
          key,
          missingTables: r.missingTables,
          applied: r.applied,
          alreadyRecorded: r.alreadyWere,
          hint,
        },
      };
    }

    if (r.applied.length > 0) {
      console.log(`[Modules] ${key}: applied ${r.applied.length} migration(s) (${r.connection}).`);
    }
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[Modules] Could not install the schema of ${key}:`, detail);
    return {
      status: 500,
      body: {
        error: "Could not install the schema",
        message:
          `The migrations of '${key}' failed, so the kon has NOT been ` +
          `activated. Activating it with a half-installed schema produces broken screens ` +
          `with no explanation.`,
        key,
        detail,
      },
    };
  }
}

async function checkKonData(konKey: string): Promise<{
  hasData: boolean;
  tables: Array<{ name: string; rowCount: number }>;
  totalRows: number;
}> {
  // Get tables from kon.json
  // The folder of the INSTALLED kon (it may not be in packages/kons).
  const konDir = konRoute(konKey) ?? join(getWorkspaceRoot(), "packages", "kons", konKey);
  const konJsonPath = join(konDir, "kon.json");

  let tablesToCheck: string[] = [];

  try {
    const konFile = file(konJsonPath);
    if (await konFile.exists()) {
      const manifest = await konFile.json();
      if (manifest.tables && Array.isArray(manifest.tables)) {
        tablesToCheck = manifest.tables
          .map((t: any) => (typeof t === "string" ? t : t.name || t.table))
          .filter(Boolean);
      }
    }
  } catch {
    // If can't read kon.json, infer from key
    tablesToCheck = [konKey.replace(/^kon-/, "").replace(/-/g, "_")];
  }

  const existingTables: Array<{ name: string; rowCount: number }> = [];

  for (const tableName of tablesToCheck) {
    try {
      const result = await db.execute(
        drizzleSql.raw(`SELECT COUNT(*) as count FROM "${tableName}"`)
      );
      const rowCount = Number((result.rows?.[0] as any)?.count || 0);
      if (rowCount > 0 || result.rows) {
        existingTables.push({ name: tableName, rowCount });
      }
    } catch {
      // Table doesn't exist or error counting
    }
  }

  const totalRows = existingTables.reduce((sum, t) => sum + t.rowCount, 0);

  return {
    hasData: existingTables.length > 0 && totalRows > 0,
    tables: existingTables,
    totalRows,
  };
}

/**
 * Get all uninstalled kons that have preserved data
 */
async function getUninstalledKonsWithData(): Promise<
  Array<{
    key: string;
    name: string;
    uninstalledAt: string | null;
    data: {
      hasData: boolean;
      tables: Array<{ name: string; rowCount: number }>;
      totalRows: number;
    };
  }>
> {
  const dbModules = await db.select().from(modules);
  const installedKeys = new Set(dbModules.map((m) => m.key));

  // Get all available kons from filesystem
  const availableKons = await scanPackages("kons");
  const uninstalled: Array<any> = [];

  for (const kon of availableKons) {
    if (!installedKeys.has(kon.id)) {
      // Check if this kon has data
      const dataCheck = await checkKonData(kon.id);

      if (dataCheck.hasData) {
        uninstalled.push({
          key: kon.id,
          name: kon.name || kon.id,
          uninstalledAt: null, // Could track this in the future
          data: dataCheck,
        });
      }
    }
  }

  return uninstalled;
}

/**
 * Resolve workspace root (same logic as module-loader / schema-merger).
 * - Dev: process.cwd() = apps/api/ → ../../ = monorepo root
 * - Docker: process.cwd() = /app/apps/api/ → packages/ at /app/packages/
 */
function getWorkspaceRoot(): string {
  const cwdCheck = join(process.cwd(), "packages", "kons", "package.json");
  return existsSync(cwdCheck) ? process.cwd() : join(process.cwd(), "../../");
}

function getPackagesRoot(): string {
  return join(getWorkspaceRoot(), "packages");
}

/**
 * Dynamic grimoire info
 */
interface DynamicGrimoire {
  id: string;
  name: string;
  description?: string;
  kons: string[];
  optionalKons: string[];
}

/**
 * Scan all available grimoires dynamically
 * This reads grimoire.json from packages/grimoires/
 */
async function scanGrimoiresDynamic(): Promise<DynamicGrimoire[]> {
  const grimoiresDir = join(getPackagesRoot(), "grimoires");
  const grimoires: DynamicGrimoire[] = [];

  try {
    const entries = await readdir(grimoiresDir, { withFileTypes: true });
    const grimoireDirs = entries.filter(
      (e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules"
    );

    for (const dir of grimoireDirs) {
      // grimoire.json, falling back to kitsuden.json ONLY if it really contains
      // a grimoire: in that same directory kitsuden.json is the theme.
      const manifest = await readGrimoireManifest(join(grimoiresDir, dir.name));

      if (manifest && manifest.id) {
        grimoires.push({
          id: manifest.id,
          name: manifest.name || manifest.id,
          description: manifest.description,
          kons: manifest.kons || [],
          optionalKons: manifest.optional_kons || [],
        });
      }
    }
  } catch (err) {
    // Grimoires directory might not exist
  }

  return grimoires;
}

/**
 * Get all grimoire kons dynamically
 * Combines hardcoded registry with dynamically scanned grimoires
 */
async function getDynamicGrimoireKons(): Promise<
  Array<{
    key: string;
    name: string;
    description: string;
    icon: string;
    color: string;
    category: "grimoire";
    grimoireId: string;
    tables: string[];
    dependsOn: string[];
    referencedBy: any[];
  }>
> {
  const grimoires = await scanGrimoiresDynamic();
  const konList = await scanPackages("kons");
  const konMap = new Map(konList.map((g) => [g.id, g]));

  const result: Array<any> = [];

  for (const grimoire of grimoires) {
    for (const konId of grimoire.kons) {
      // Get kon info from scanned packages
      const kon = konMap.get(konId);

      if (kon) {
        result.push({
          // The id AS IS. This used to be
          // `konId.replace(/^kon-/,"").replace(/-/g,"_")`, which turned
          // `kon-blog` into `blog` — a key that is no longer the id of anything. The
          // result was the same kon twice on the Kons screen, with
          // contradictory states, and a toggle that wrote under a
          // nonexistent key.
          key: konId,
          name: kon.name || konId,
          description: kon.description || `${kon.name} module`,
          icon: kon.icon || "📦",
          color: "#6366F1",
          category: "grimoire" as const,
          grimoireId: grimoire.id,
          tables: kon.tables || [],
          dependsOn: [],
          referencedBy: [],
        });
      } else {
        // Fallback if kon not found in packages
        result.push({
          key: konId,
          name: konId
            .replace(/^kon-/, "")
            .replace(/-/g, " ")
            .replace(/\b\w/g, (l) => l.toUpperCase()),
          description: `Kon from ${grimoire.name}`,
          icon: "📦",
          color: "#6366F1",
          category: "grimoire" as const,
          grimoireId: grimoire.id,
          tables: [],
          dependsOn: [],
          referencedBy: [],
        });
      }
    }
  }

  return result;
}

export const modulesRoutes = new Hono();

// ── The configuration file NO LONGER decides what is active ────────────────
//
// `CORE_FLAG_MAP` lived here, and it was not a lookup map: it OVERRODE the database.
//
//     const enabled = configFlag !== undefined ? configFlag : stored.enabled;
//
// With `kon-media` in the map, turning it off from the panel was saved in the database and
// `/api/modules` kept answering what `kitsuden.config.ts` said. The
// toggle went back by itself on reload. It was not duplication: the panel lied
// about the system's state.
//
// Now the file only SEEDS the database at startup (`lib/seed-modules.ts`)
// and from then on `modules` is in charge. A core kon still comes enabled
// out of the box —the seed says so— but it can be turned off, and it stays off.

// Helper: get default enabled state by category
function defaultEnabled(category: string): boolean {
  if (category === "core") return true;
  if (category === "core-den") return true;
  if (category === "grimoire") return false; // Grimoire modules OFF unless grimoire is active
  return false; // optional defaults to off
}

/** canonical kon id → maturity declared in its kon.json (kons and core). */
async function readKonMaturity(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const m of await scanPackages("kons")) {
    const value = (m as unknown as { maturity?: string }).maturity;
    if (m.id && value) map.set(canonicalKey(m.id), value);
  }
  const dirCore = join(getPackagesRoot(), "core");
  try {
    for (const e of await readdir(dirCore, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const route = join(dirCore, e.name, "kon.json");
      if (!existsSync(route)) continue;
      try {
        const json = JSON.parse(await file(route).text()) as { id?: string; maturity?: string };
        if (json.id && json.maturity) map.set(canonicalKey(json.id), json.maturity);
      } catch {
        // unreadable manifest: no badge
      }
    }
  } catch {
    // no packages/core
  }
  return map;
}

// Helper: get active theme/grimoire
async function getActiveTheme(): Promise<string | null> {
  try {
    const [settings] = await db.select().from(siteSettings).limit(1);
    // Support both new activeGrimoire and legacy activeTheme columns
    return (settings as any)?.activeGrimoire || settings?.activeTheme || null;
  } catch {
    return null;
  }
}

// ── GET / — List ALL modules organized by category ──
modulesRoutes.get("/", async (c) => {
  const dbModules = await db.select().from(modules);
  const dbMap = new Map(dbModules.map((m) => [m.key, m]));
  const activeTheme = await getActiveTheme();

  // Transform registry module to API response
  const transformModule = (
    m: (typeof CORE_MODULES)[0],
    source: "core" | "grimoire" | "filesystem"
  ) => {
    // By KON key, not by string: the kon-games row may be called
    // `games` in the database (legacy rows from before the prefix). With the
    // earlier exact lookup, that kon did not find its row and fell back to the
    // default while its real row said something else.
    const stored = searchByKonKey(dbMap, m.key);

    // Grimoire modules are auto-enabled when their grimoire is active
    const isGrimoireActive = m.category === "grimoire" && m.grimoireId === activeTheme;

    // Check if this kon is linked to the active grimoire in DB
    const enabledByGrimoire = stored?.grimoireId === activeTheme && activeTheme !== null;

    // The database first; the active grimoire may turn its own on; and only if the
    // database knows nothing about this kon is the default used.
    const enabled = stored ? stored.enabled : enabledByGrimoire ? true : defaultEnabled(m.category);

    // Unify core categories: both "core" and "core-den" become "core"
    const unifiedCategory = m.category === "core-den" ? "core" : m.category;

    return {
      key: m.key,
      name: m.name,
      description: m.description,
      icon: m.icon,
      color: m.color,
      category: unifiedCategory,
      grimoireId: stored?.grimoireId || m.grimoireId || null,
      enabled,
      settings: stored?.settings || {},
      dependsOn: m.dependsOn,
      tables: m.tables,
      source,
      // UI hints
      canToggle: true, // All kons can be toggled individually now
      isGrimoireActive,
      enabledByGrimoire, // Indicates this kon is active because its grimoire is active
      sidebarBadge: enabledByGrimoire ? "Active by Grimoire" : stored?.sidebarBadge,
    };
  };

  // Core modules (media, webhooks, connectors)
  const coreModules = getCoreModules().map((m) => transformModule(m, "core"));

  // Kon-Core modules (blog, blocks, formulas)
  const coreDenModules = getCoreDenKons().map((m) => transformModule(m, "core"));

  // Optional modules (academy, dms, booking, directory, crm, blog)
  const optionalModules = getOptionalModules().map((m) => transformModule(m, "core"));

  // Grimoire modules — DYNAMICALLY loaded from packages/grimoires/*/
  const allGrimoireKons = await getDynamicGrimoireKons();
  const grimoireModulesRaw = allGrimoireKons.map((m) => transformModule(m, "grimoire"));

  /**
   * A kon shipping in a grimoire does NOT make it a different kon.
   *
   * Before, this list was concatenated whole onto the registry's, so
   * `kon-blog` showed up twice: once from the registry (on) and once from the
   * grimoire (off). Two toggles for the same thing, and the second one wrote
   * under a key that did not exist.
   *
   * Now membership in a grimoire is a piece of DATA of the single entry —which
   * grimoires bring it and their badge—, not a separate entry. It can still be
   * turned on or off individually: `canToggle` does not depend on this.
   *
   * And it is PLURAL DATA: `kon-dms` is included by Corporate, SharePoint and
   * VekDocs at once. In the grimoire view it shows up in all three, which is
   * correct; here it shows up ONCE, but naming all three.
   */
  const registryModules = [...coreModules, ...coreDenModules, ...optionalModules];
  const fusion = mergeByKon(registryModules, grimoireModulesRaw);
  const grimoireModules = fusion.grimoireOnly;
  const byKon = new Map(
    [...fusion.record, ...grimoireModules].map((m) => [canonicalKey(m.key), m])
  );

  // Auto-discovered kons from filesystem (not in hardcoded registry)
  // This is the key to zero-config: drop a kon directory with kon.json
  // and it auto-appears in the admin panel.
  // By KON key: `byKon` already has the registry and the grimoire's entries that were not
  // merged. Comparing strings let the same thing through twice
  // as soon as one of the two carried the prefix and the other did not.
  const alreadyListed = byKon;

  let filesystemModules: any[] = [];
  try {
    const manifestList = await scanPackages("kons");
    filesystemModules = manifestList
      .filter((m) => !alreadyListed.has(canonicalKey(m.id)))
      .map((m) => {
        const stored = searchByKonKey(dbMap, m.id);
        const enabledByGrimoire = stored?.grimoireId === activeTheme && activeTheme !== null;
        const enabled = enabledByGrimoire ? true : stored?.enabled || false;

        return {
          key: m.id,
          name:
            m.name ||
            m.id
              .replace(/^kon-/, "")
              .replace(/-/g, " ")
              .replace(/^\w/, (c: string) => c.toUpperCase()),
          description: m.description || "",
          version: m.version,
          icon: m.icon || "📦",
          category: stored?.grimoireId ? "grimoire" : "optional",
          grimoireId: stored?.grimoireId || null,
          enabled,
          settings: stored?.settings || {},
          sidebarPath: m.admin_route || `/${m.id.replace(/^kon-/, "")}`,
          source: "filesystem" as const,
          canToggle: true,
          enabledByGrimoire,
          sidebarBadge: enabledByGrimoire ? "Active by Grimoire" : stored?.sidebarBadge,
        };
      });
  } catch {
    // No packages dir
  }

  // Get uninstalled kons with preserved data
  const uninstalledKons = await getUninstalledKonsWithData();

  // Build categorized response
  const response = {
    /**
     * Both names, and not for fun.
     *
     * The admin reads `activeGrimoire` (states/modules.svelte.ts) and this response
     * only carried `activeTheme`, a leftover of the theme→grimoire rebrand. Result: the
     * panel ALWAYS thought there was no active grimoire, with no error at all — the
     * store's type declares `activeGrimoire?: string`, so not even TypeScript
     * gave it away.
     *
     * `activeTheme` is kept because some clients still read it; the surplus one is removed
     * when none are left.
     */
    activeGrimoire: activeTheme,
    activeTheme,
    categories: {
      core: {
        label: "Core Infrastructure",
        description: "Level 2 — Switchable infrastructure",
        modules: coreModules,
      },
      "core-den": {
        label: "Kon Core",
        description: "Level 3 — Official superpowers",
        modules: coreDenModules,
      },
      optional: {
        label: "Optional Kons",
        description: "Enterprise and vertical features",
        modules: [...optionalModules, ...filesystemModules],
      },
      theme: {
        label: "Grimoire Kons",
        description: activeTheme
          ? `Active grimoire: ${activeTheme}`
          : "No grimoire active — all disabled",
        modules: grimoireModules,
      },
      uninstalled: {
        label: "Uninstalled (Data Preserved)",
        description:
          uninstalledKons.length > 0
            ? `${uninstalledKons.length} kons with data available for recovery`
            : "No uninstalled kons with preserved data",
        modules: uninstalledKons.map((g) => ({
          key: g.key,
          name: g.name,
          status: "uninstalled",
          hasPreservedData: true,
          dataSummary: {
            totalRows: g.data.totalRows,
            tables: g.data.tables.map((t) => ({ name: t.name, rows: t.rowCount })),
          },
          canRecover: true,
          canDelete: true, // Can permanently delete from here
          actions: ["recover", "delete"],
        })),
      },
    },
    // Flat list for backward compatibility (sidebar, etc.)
    docs: [
      ...coreModules,
      ...coreDenModules,
      ...optionalModules,
      ...grimoireModules,
      ...filesystemModules,
    ],
    totalDocs:
      coreModules.length +
      coreDenModules.length +
      optionalModules.length +
      grimoireModules.length +
      filesystemModules.length,
  };

  // Maturity declared in each kon.json ("stable" | "beta" | "experimental").
  // The panel draws it as a badge next to the toggle: activating an
  // experimental kon has to be a knowing decision.
  const maturity = await readKonMaturity();
  for (const m of response.docs as Array<Record<string, unknown>>) {
    const value = maturity.get(canonicalKey(String(m.key)));
    if (value) m.maturity = value;
  }

  return c.json(response);
});

// ── GET /:key — Get a single module by key ──
export async function getModuleHandler(c: any) {
  const key = c.req.param("key")!;
  const activeTheme = await getActiveTheme();
  const [stored] = await db.select().from(modules).where(eq(modules.key, key)).limit(1);
  const registryDef = CORE_MODULES.find((m) => m.key === key);

  if (!stored && !registryDef) {
    return c.json({ error: `Module '${key}' not found` }, 404);
  }

  // Check if enabled by grimoire (stored in DB and grimoire matches active)
  const enabledByGrimoire = stored?.grimoireId === activeTheme && activeTheme !== null;

  // Calculate isGrimoireActive - either from registry or from DB
  const isGrimoireActive =
    (registryDef?.category === "grimoire" && registryDef?.grimoireId === activeTheme) ||
    enabledByGrimoire;

  // Calculate enabled status
  const enabled = stored
    ? stored.enabled
    : enabledByGrimoire
      ? true
      : defaultEnabled(registryDef?.category || "optional");

  // Check if this is a grimoire kon (either from registry or DB)
  const isGrimoireKon = registryDef?.category === "grimoire" || !!stored?.grimoireId;

  return c.json({
    key,
    name: registryDef?.name || stored?.name || key,
    description: registryDef?.description || stored?.description || "",
    icon: registryDef?.icon || stored?.icon || "📦",
    color: registryDef?.color || "",
    category:
      registryDef?.category === "core-den"
        ? "core"
        : registryDef?.category || stored?.category || "optional",
    grimoireId: stored?.grimoireId || registryDef?.grimoireId || null,
    enabled,
    settings: stored?.settings || {},
    tables: registryDef?.tables || [],
    dependsOn: registryDef?.dependsOn || [],
    canToggle: true, // All kons can be toggled individually
    isGrimoireActive,
    enabledByGrimoire,
    isGrimoireKon,
    sidebarBadge: enabledByGrimoire ? "Active by Grimoire" : stored?.sidebarBadge,
  });
}
modulesRoutes.get("/:key", getModuleHandler);

// ── GET /:key/check — Can this module be disabled? ──
export async function checkModuleHandler(c: any) {
  const key = c.req.param("key")!;

  // Check if this is a grimoire kon - grimoire kons CAN be toggled individually now
  // but we show a warning that it's part of a grimoire
  const moduleDef = CORE_MODULES.find((m) => m.key === key);
  const [stored] = await db.select().from(modules).where(eq(modules.key, key)).limit(1);
  const isGrimoireKon = moduleDef?.category === "grimoire" || !!stored?.grimoireId;

  const dbModules = await db.select().from(modules);
  const dbMap = new Map(dbModules.map((m) => [m.key, m]));

  const enabledKeys = new Set<string>();

  for (const cm of CORE_MODULES) {
    const stored = dbMap.get(cm.key);
    const isEnabled = stored ? stored.enabled : defaultEnabled(cm.category);
    if (isEnabled) enabledKeys.add(cm.key);
  }

  for (const [k, v] of dbMap) {
    if (!CORE_MODULE_KEYS.includes(k) && v.enabled) {
      enabledKeys.add(k);
    }
  }

  const result = await checkCanDisable(key, enabledKeys);

  // Add grimoire info to result
  const checkResult = {
    ...result,
    isGrimoireKon,
    grimoireId: stored?.grimoireId || moduleDef?.grimoireId || null,
    warning: isGrimoireKon
      ? "This kon is part of a grimoire. Disabling it may affect grimoire functionality."
      : undefined,
  };

  return c.json(checkResult);
}
modulesRoutes.get("/:key/check", checkModuleHandler);

export async function updateModuleHandler(c: Context) {
  const key = c.req.param("key")!;
  const body = await c.req.json();

  const registryDef = CORE_MODULES.find((m) => m.key === key);

  // Check if this is a grimoire kon
  const [_existingModule] = await db.select().from(modules).where(eq(modules.key, key)).limit(1);

  // If disabling, run dependency check
  if (body.enabled === false) {
    const dbModules = await db.select().from(modules);
    const dbMap = new Map(dbModules.map((m) => [m.key, m]));

    const enabledKeys = new Set<string>();
    for (const cm of CORE_MODULES) {
      const stored = dbMap.get(cm.key);
      if (stored ? stored.enabled : defaultEnabled(cm.category)) {
        enabledKeys.add(cm.key);
      }
    }
    for (const [k, v] of dbMap) {
      if (!CORE_MODULE_KEYS.includes(k) && v.enabled) enabledKeys.add(k);
    }

    const check = await checkCanDisable(key, enabledKeys);
    if (!check.canDisable) {
      return c.json(
        {
          error: "Cannot disable module",
          message: `${key} has active dependencies that must be removed first.`,
          blockers: check.blockers,
        },
        409
      );
    }
  }

  /**
   * Upsert ON THE KON'S ROW, not on the string that came in the URL.
   *
   * The exact `where(key = :key)` did not find the legacy row —kon-games's
   * is called `games`— and inserted a SECOND one. From then on the
   * same kon had two rows with different states and one or the other won depending on
   * who asked. It is the same bug `lib/seed-modules.ts` had already
   * avoided when seeding, and which was still alive here.
   */
  const allRows = await db.select().from(modules);
  const existingRow = searchByKonKey(new Map(allRows.map((m) => [m.key, m])), key);
  const rowKey = existingRow?.key ?? key;
  const existing = existingRow ? [existingRow] : [];

  if (existing.length === 0) {
    if (body.enabled !== undefined) {
      if (body.enabled === true) {
        const failure = await installKonSchema(key);
        if (failure) return c.json(failure.body, failure.status);
      }

      await db.insert(modules).values({
        key,
        name: registryDef?.name || body.name || key,
        description: registryDef?.description || body.description,
        icon: registryDef?.icon || body.icon,
        category: registryDef?.category || "optional",
        enabled: body.enabled,
        settings: body.settings || {},
      });
    }
  } else {
    const updates: Record<string, unknown> = {};

    if (typeof body.enabled === "boolean") {
      updates.enabled = body.enabled;
      if (body.enabled === true) {
        const failure = await installKonSchema(key);
        if (failure) return c.json(failure.body, failure.status);
      }
    }

    if (body.settings !== undefined) updates.settings = body.settings;

    if (Object.keys(updates).length > 0) {
      // rowKey, not `key`: it may be the legacy form without a prefix.
      await db.update(modules).set(updates).where(eq(modules.key, rowKey));
    }
  }

  const [updated] = await db.select().from(modules).where(eq(modules.key, rowKey));

  if (!updated && registryDef) {
    return c.json({
      key,
      name: registryDef.name,
      enabled: defaultEnabled(registryDef.category),
      settings: {},
      category: registryDef.category,
      grimoireId: null,
      enabledByGrimoire: false,
    });
  }

  // Get active theme to calculate enabledByGrimoire
  const activeTheme = await getActiveTheme();
  const enabledByGrimoire = updated?.grimoireId === activeTheme && activeTheme !== null;

  /**
   * It was just activated and its routes are NOT mounted in this process.
   *
   * The tables were created —that works hot—, but `app.route()`
   * can only be called before the first request: Hono freezes its matcher
   * afterwards. The kon's endpoints will not exist until a restart.
   *
   * It is stated in the response instead of letting the user discover it
   * screen by screen. A half-done kon presented as installed is the
   * failure that was so costly to debug.
   */
  let needsRestart = false;
  let mountedNow = false;

  if (body.enabled === true && !mountedRoutes(key)) {
    // It was not loaded at startup. An attempt is made to hot-mount it through the
    // reserved path; only if that fails is a restart needed.
    const r = await hotMountKon(key);
    mountedNow = r.mounted;
    needsRestart = !r.mounted;
    if (!r.mounted && r.reason && r.reason !== "not-deferred") {
      console.warn(`[Modules] ${key}: could not be hot-mounted —${r.reason}`);
    }
  }

  return c.json(
    updated
      ? {
          ...updated,
          enabledByGrimoire,
          isGrimoireKon: !!updated.grimoireId,
          requiresRestart: needsRestart,
          mountedNow,
          ...(needsRestart
            ? {
                restartReason:
                  `The tables of '${key}' are already created, but its API routes could not ` +
                  `be mounted without a restart. Restart the API so its ` +
                  `screens work.`,
              }
            : {}),
        }
      : { key, enabled: body.enabled || false, grimoireId: null, enabledByGrimoire: false }
  );
}
modulesRoutes.patch("/:key", updateModuleHandler);

// ── POST /:key/uninstall — Uninstall kon but preserve data ──
modulesRoutes.post("/:key/uninstall", async (c) => {
  const key = c.req.param("key")!;

  // Check if module exists in DB
  const [existing] = await db.select().from(modules).where(eq(modules.key, key)).limit(1);

  if (!existing) {
    return c.json({ error: `Kon '${key}' not found` }, 404);
  }

  // Check for dependencies
  const dbModulesList = await db.select().from(modules);
  const dbMap = new Map(dbModulesList.map((m) => [m.key, m]));

  const enabledKeys = new Set<string>();
  for (const cm of CORE_MODULES) {
    const stored = dbMap.get(cm.key);
    if (stored ? stored.enabled : defaultEnabled(cm.category)) {
      enabledKeys.add(cm.key);
    }
  }
  for (const [k, v] of dbMap) {
    if (!CORE_MODULE_KEYS.includes(k) && v.enabled) enabledKeys.add(k);
  }

  const check = await checkCanDisable(key, enabledKeys);

  if (existing.enabled && !check.canDisable) {
    return c.json(
      {
        error: "Cannot uninstall",
        message: `${key} has active dependencies. Disable it first.`,
        blockers: check.blockers,
        enabled: existing.enabled,
      },
      409
    );
  }

  // Get data info before uninstalling
  const dataInfo = await checkKonData(key);

  // Delete the module from DB (preserves data in actual tables)
  await db.delete(modules).where(eq(modules.key, key));

  console.log(`[Modules] Kon ${key} uninstalled, data preserved (${dataInfo.totalRows} rows)`);

  return c.json({
    success: true,
    action: "uninstall",
    key,
    name: existing.name,
    wasEnabled: existing.enabled,
    wasGrimoireKon: !!existing.grimoireId,
    grimoireId: existing.grimoireId,
    dataPreserved: {
      hasData: dataInfo.hasData,
      totalRows: dataInfo.totalRows,
      tables: dataInfo.tables,
    },
    message: `Kon ${key} uninstalled. Data preserved: ${dataInfo.totalRows} rows in ${dataInfo.tables.length} tables.`,
    nextSteps: [
      "Use POST /api/modules/${key}/recover to reinstall and recover data",
      "Use DELETE /api/modules/${key}?purge=true to permanently delete data",
    ],
  });
});

// ── POST /:key/recover — Recover/Reinstall an uninstalled kon ──
modulesRoutes.post("/:key/recover", async (c) => {
  const key = c.req.param("key")!;

  // Check if already installed
  const [existing] = await db.select().from(modules).where(eq(modules.key, key)).limit(1);

  if (existing) {
    return c.json(
      {
        error: "Already installed",
        message: `Kon ${key} is already installed.`,
        key,
        enabled: existing.enabled,
      },
      409
    );
  }

  // Get kon info from filesystem
  const kons = await scanPackages("kons");
  const kon = kons.find((g) => g.id === key);
  const registryDef = CORE_MODULES.find((m) => m.key === key);

  if (!kon && !registryDef) {
    return c.json({ error: `Kon '${key}' not found in filesystem or registry` }, 404);
  }

  // Check if there's preserved data
  const dataInfo = await checkKonData(key);

  // Recovering is reinstalling: if the schema cannot be restored, there is no kon
  // to recover and saying otherwise leaves the user with broken screens.
  const failure = await installKonSchema(key);
  if (failure) return c.json(failure.body, failure.status);

  // Re-insert into modules table
  const name = kon?.name || registryDef?.name || key;
  const description = kon?.description || registryDef?.description;
  const icon = kon?.icon || registryDef?.icon || "📦";
  const category = registryDef?.category || "optional";

  await db.insert(modules).values({
    key,
    name,
    description,
    icon,
    category,
    enabled: true,
    settings: {},
  });

  console.log(`[Modules] Kon ${key} recovered, data restored (${dataInfo.totalRows} rows)`);

  return c.json({
    success: true,
    action: "recover",
    key,
    name,
    enabled: true,
    dataRestored: {
      hasData: dataInfo.hasData,
      totalRows: dataInfo.totalRows,
      tables: dataInfo.tables,
    },
    message: dataInfo.hasData
      ? `Kon ${key} recovered successfully with ${dataInfo.totalRows} rows of data.`
      : `Kon ${key} recovered successfully. No previous data found.`,
  });
});

// ── DELETE /:key — Permanently delete kon and its data ──
modulesRoutes.delete("/:key", async (c) => {
  const key = c.req.param("key")!;
  const purge = c.req.query("purge") === "true";
  const force = c.req.query("force") === "true";

  // Check if module exists in DB
  const [existing] = await db.select().from(modules).where(eq(modules.key, key)).limit(1);

  // If still installed, require purge flag
  if (existing && !purge) {
    return c.json(
      {
        error: "Kon is installed",
        message: `Kon ${key} is still installed. Use POST /api/modules/${key}/uninstall first, or use ?purge=true to uninstall and delete in one step.`,
        key,
        status: "installed",
        enabled: existing.enabled,
        canUninstall: true,
      },
      409
    );
  }

  // Check for dependencies if still "enabled" somehow
  if (existing?.enabled) {
    const dbModulesList = await db.select().from(modules);
    const dbMap = new Map(dbModulesList.map((m) => [m.key, m]));

    const enabledKeys = new Set<string>();
    for (const cm of CORE_MODULES) {
      const stored = dbMap.get(cm.key);
      if (stored ? stored.enabled : defaultEnabled(cm.category)) {
        enabledKeys.add(cm.key);
      }
    }

    const check = await checkCanDisable(key, enabledKeys);

    if (!check.canDisable && !force) {
      return c.json(
        {
          error: "Cannot delete",
          message: `${key} has active dependencies. Disable it first or use ?force=true.`,
          blockers: check.blockers,
        },
        409
      );
    }
  }

  // Get data info before deletion
  const dataInfo = await checkKonData(key);

  // Delete from modules table if exists
  if (existing) {
    await db.delete(modules).where(eq(modules.key, key));
  }

  // If purge, also drop the actual tables
  const droppedTables: string[] = [];
  if (purge) {
    for (const table of dataInfo.tables) {
      try {
        await db.execute(drizzleSql.raw(`DROP TABLE IF EXISTS "${table.name}" CASCADE`));
        droppedTables.push(table.name);
      } catch (err) {
        console.error(`[Modules] Error dropping table ${table.name}:`, err);
      }
    }
  }

  console.log(
    `[Modules] Kon ${key} deleted${purge ? ` with ${droppedTables.length} tables dropped` : " (data preserved)"}`
  );

  return c.json({
    success: true,
    action: "delete",
    key,
    name: existing?.name || key,
    purge,
    dataDeleted: purge
      ? {
          tablesDropped: droppedTables.length,
          tables: droppedTables,
          totalRows: dataInfo.totalRows,
        }
      : undefined,
    message: purge
      ? `Kon ${key} permanently deleted. ${droppedTables.length} tables dropped (${dataInfo.totalRows} rows).`
      : `Kon ${key} removed from registry. Data preserved in ${dataInfo.tables.length} tables.`,
    warning: purge ? "This action is irreversible. Data has been permanently deleted." : undefined,
  });
});
