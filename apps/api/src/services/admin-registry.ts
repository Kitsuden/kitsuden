/**
 * Admin Registry Service — Zero Config Kon Registration
 *
 * Auto-discovers admin configuration from kons and grimoires:
 * 1. Scans kon.json for admin.tables[]
 * 2. Scans grimoire.json for grimoire-specific kons (DYNAMIC)
 * 3. Detects custom views by checking for .svelte files
 * 4. Generates default DataExplorer config for tables without custom UI
 * 5. Exposes unified registry at /api/admin/registry
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { file } from "../lib/file";
import { readGrimoireManifest } from "../lib/grimoire-manifest";
import { logger } from "../lib/logger";

import { scanPackages, KitsudenManifest } from "./scanner";
import { introspectTable, type IntrospectedColumn } from "./schema-introspector";

// Resolve workspace root (Docker vs dev)
function getPackagesRoot(): string {
  const cwdCheck = join(process.cwd(), "packages", "kons", "package.json");
  const root = existsSync(cwdCheck) ? process.cwd() : join(process.cwd(), "../../");
  return join(root, "packages");
}

// @ts-ignore - Reserved for future use
const _ADMIN_VIEWS_PATH = "../../../packages/admin/src/views";

/**
 * Grimoire manifest structure
 */
interface GrimoireManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  type: "grimoire";
  kons: string[];
  optional_kons?: string[];
  config?: {
    theme?: {
      css_entry?: string;
      primary_color?: string;
      accent_color?: string;
    };
  };
  /** Per-kon admin overrides */
  konConfig?: Record<
    string,
    {
      displayName?: string;
      hiddenTables?: string[];
      extraViews?: Array<{
        id: string;
        type: "grid" | "kanban" | "calendar" | "custom" | "element";
        /** For `element` only: the Web Component's tag name. */
        element?: string;
        /** For `element` only: path of the script inside the kon. */
        src?: string;
        title: string;
        table?: string;
      }>;
      defaultView?: string;
    }
  >;
  /** Seed configuration */
  seed?: {
    sql?: string;
    datasets?: string;
    runOnce?: boolean;
  };
}

/**
 * Dynamic grimoire info with its kons
 */
interface GrimoireInfo {
  id: string;
  name: string;
  description?: string;
  kons: string[];
  optionalKons: string[];
}

/** Admin table configuration */
export interface AdminTableConfig {
  name: string;
  label: string;
  icon?: string;
  description?: string;
  primaryKey?: string;
  searchableFields?: string[];
  filterableFields?: string[];
  readonly?: boolean;
}

/**
 * Admin view configuration
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * On custom views and why there are two mechanisms
 *
 * The admin serves TWO audiences that need not share a framework:
 *
 *   1. The core (page builder, kanban, knowledge graph) is written by the
 *      Kitsuden team in Svelte, and there Svelte wins because of the shape of that UI.
 *   2. The views of a third-party kon are written by someone else — and in practice,
 *      this being a BaaS for vibe coders, by their AI agent.
 *
 * Forcing (2) to write Svelte couples the extension point to the admin's
 * internal framework. The agnostic form (`type: "element"`) receives an ALREADY
 * COMPILED ARTIFACT that is loaded at runtime, not source code that enters the build
 * of the admin: each extension brings its own runtime inside, isolated by Shadow
 * DOM, and the admin's bundler never needs to understand JSX or anything foreign.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface AdminViewConfig {
  id: string;
  /**
   * `element` is the recommended form for custom views: an agnostic
   * Web Component. `custom` remains for the Svelte legacy.
   */
  type: "grid" | "kanban" | "calendar" | "custom" | "element";
  title: string;
  table?: string;
  /**
   * @deprecated Path to a `.svelte`, imported as SOURCE inside the admin's
   * build. It couples the extension to the host's framework and puts the code of all
   * kons in the bundle even if nobody opens that view. Use `element` + `src`.
   */
  component?: string;
  /**
   * Name of the custom element the view registers, e.g. `broadcast-scoreboard`.
   * It must contain a hyphen: the Custom Elements specification requires it.
   */
  element?: string;
  /**
   * Path to the already-compiled ESM bundle, relative to the root of the kon's package
   * (`./admin/scoreboard.js`). The API serves it under a stable URL; the admin
   * loads it with `import(url)` at runtime, never at build time.
   */
  src?: string;
  // Extra props forwarded from kon.json admin.views declarations
  groupBy?: string;
  /** Fixed filter of the view: what defines it. See the mapping below. */
  defaultFilter?: Record<string, unknown>;
  /** Singular name for the create button ("Add tournament"). */
  singularName?: string;
  dateField?: string;
  titleField?: string;
  icon?: string;
  [key: string]: any;
}

/** Kon admin configuration */
export interface KonAdminConfig {
  id: string;
  name: string;
  icon?: string;
  category: "core" | "content" | "data" | "esports";
  hasCustomView: boolean;
  tables: AdminTableConfig[];
  views: AdminViewConfig[];
  /** Initial view, or `null` if the kon exposes none (it has no data). */
  defaultView: string | null;
  /** Custom API base path (e.g., /api/directory) - if not set, uses /api/explorer */
  apiBase?: string;
}

/** Core module with custom view */
interface CoreModuleWithView {
  id: string;
  name: string;
  category: KonAdminConfig["category"];
  tables?: string[];
}

// Cache to avoid frequent disk reads
let registryCache: KonAdminConfig[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60_000; // 1 minute in development

/**
 * Core modules with custom admin views
 * These are loaded from apps/api/src/modules/, not packages/kons/
 *
 * NOTE: Webhooks and Workers are part of the Actions Engine (framework level),
 * not Kons. They are managed through the Actions UI at /actions.
 *
 * This list is intentionally empty as all current core features are either:
 * - Kons (DataSets, Media, Blocks)
 * - Engine features (Actions with Webhooks/Workers)
 * - Settings features (Connectors)
 */
const CORE_MODULES_WITH_VIEWS: CoreModuleWithView[] = [
  // Empty - all core features are now proper Kons or Engine features
];

/**
 * Scan all available grimoires and their kons
 * This is DYNAMIC - no hardcoded grimoire data needed
 */
async function scanGrimoires(): Promise<GrimoireInfo[]> {
  const grimoiresDir = join(getPackagesRoot(), "grimoires");
  const grimoires: GrimoireInfo[] = [];

  try {
    const entries = await readdir(grimoiresDir, { withFileTypes: true });
    const grimoireDirs = entries.filter(
      (e: { isDirectory: () => boolean; name: string }) =>
        e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules"
    );

    for (const dir of grimoireDirs) {
      // grimoire.json, falling back to kitsuden.json ONLY if it really contains
      // a grimoire: in that same directory kitsuden.json is the theme.
      const manifest = (await readGrimoireManifest(
        join(grimoiresDir, dir.name)
      )) as GrimoireManifest | null;

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
    // This was a `console.log` for an ERROR. That the grimoires folder does not
    // exist is normal and deserves no noise; that the scan fails for another reason
    // does — and with `console.log` the two things were the same invisible line.
    logger.debug({ err }, "[AdminRegistry] no grimoires folder or the scan failed");
  }

  return grimoires;
}

/**
 * The default view, checked against the views that actually exist.
 *
 * ── WHY IT IS A SINGLE FUNCTION ────────────────────────────────────────────
 *
 * Because `defaultView` was assigned in THREE places —two constructors and the
 * override patching— and only one checked anything. The first was fixed and
 * `kon-esports` kept announcing `"grid"` with a single view called
 * `to-panel`: the entire bug, intact, through the branch that was not touched.
 *
 * With one function, the question is the same in all three places and the fourth that
 * someone adds finds it already written.
 *
 * ── WHAT IT BROKE ──────────────────────────────────────────────────────────
 *
 * Nine kons declare `admin.defaultView: "grid"`, which is not the id of any
 * view: the generated ones are called `grid-<table>`. The panel opened with that id, the
 * per-view filter returned ZERO views, with no view there was no table, and the create
 * modal ended up asking for the schema of a table named after the kon:
 *
 *     Could not load schema for table "kon-character-builder"
 *
 * Four layers between the cause and the message, and the message blames a table that
 * never existed.
 */
function defaultViewValid(
  declared: string | undefined | null,
  views: { id: string }[],
  konId: string
): string | null {
  if (declared && views.some((v) => v.id === declared)) return declared;

  if (declared) {
    console.warn(
      `  ⚠️  ${konId}: admin.defaultView es "${declared}" and there is no view ` +
        `with that id (${views.map((v) => v.id).join(", ") || "none"}). The first one is used.`
    );
  }

  // `?? null` and not an invented id: "this kon exposes no views" is a
  // valid answer, and fabricating one turns that into a table error.
  return views[0]?.id ?? null;
}

/**
 * Extract admin views from kon manifest (Hybrid Rendering support).
 * Reads kon.json `admin.views` as the primary source.
 * Returns empty array if no admin.views declared — caller should fallback.
 */
function extractViewsFromManifest(kon: KitsudenManifest): AdminViewConfig[] {
  const adminConfig = (kon as any).admin;
  if (!adminConfig || !Array.isArray(adminConfig.views)) {
    return [];
  }

  const views: AdminViewConfig[] = [];

  for (const raw of adminConfig.views) {
    if (!raw.id || !raw.type) continue;

    // Normalize unknown/invalid types to valid AdminViewConfig types
    let type = raw.type;
    // `element` is a FIRST-CLASS type, not an oddity: it is how a kon
    // contributes its own screen without being compiled against the admin (a Web
    // Component served from the kon itself).
    //
    // It was missing from this list, so it fell into the normalization below and
    // turned into "grid" without warning. Four kons —tierlist, broadcast,
    // broadcast-moba and esports— brought their view, the API served it
    // correctly, and the admin ended up drawing a grid in its place.
    const validTypes = new Set(["grid", "kanban", "calendar", "custom", "element"]);
    const typeNormalization: Record<string, string> = {
      list: "grid",
      table: "grid",
      dashboard: "custom",
    };

    if (!validTypes.has(type)) {
      type = typeNormalization[type] || "grid";
    }

    const view: AdminViewConfig = {
      id: raw.id,
      type: type as AdminViewConfig["type"],
      title: raw.title || raw.id,
      table: raw.table,
    };

    // For custom views, derive component path if not explicitly set
    if (type === "custom") {
      view.component = raw.component || `$views/${getViewPath(kon.id)}`;
    }

    // A Web Component needs to know WHAT the tag is called and WHERE the
    // file is; without those two pieces of data the admin cannot mount it.
    if (type === "element") {
      view.element = raw.element;
      view.src = raw.src;
    }

    // Pass through extra properties used by DataExplorer and UI
    if (raw.groupBy !== undefined) view.groupBy = raw.groupBy;
    if (raw.dateField !== undefined) view.dateField = raw.dateField;
    if (raw.titleField !== undefined) view.titleField = raw.titleField;
    if (raw.icon !== undefined) view.icon = raw.icon;
    if (raw.description !== undefined) view.description = raw.description;
    if (raw.rowActions !== undefined) view.rowActions = raw.rowActions;
    if (raw.bulkActions !== undefined) view.bulkActions = raw.bulkActions;

    /**
     * ── THE VIEW'S FILTER, WHICH WAS LOST HERE ─────────────────────────────
     *
     * `defaultFilter` is what makes "Published" show the published ones and
     * "Drafts" the drafts. Without it, two tabs on the same table
     * ask for the same thing and show the same thing — a draft post appeared under
     * "Published".
     *
     * It was already fixed once on the client (`generateExplorerConfig` did not
     * copy it) and it still did not work, because the data NEVER ARRIVED: this
     * mapping copies field by field and `defaultFilter` was not in the list. The
     * second half of the path was fixed while the first was still cut.
     *
     * Copying field by field fails silently by design: whatever is not named
     * disappears without a warning. That is why there is a test that compares the keys
     * used by the `kon.json` files with those this block forwards.
     */
    if (raw.defaultFilter !== undefined) view.defaultFilter = raw.defaultFilter;

    /**
     * Singular name for the "Add" button.
     *
     * It replaces the regular-expression singularization that produced
     * "Add All Gam": now the kon declares it and the panel uses it as is.
     * If it does not arrive, the button just says "Add" — ugly but never invented.
     */
    if (raw.singularName !== undefined) view.singularName = raw.singularName;

    views.push(view);
  }

  return views;
}

/**
 * Build kon config as part of a grimoire (dynamic)
 */
/**
 * The API base the kon declares, or nothing.
 *
 * ── WHY IT IS A FUNCTION AND NOT TWO LINES ─────────────────────────────────
 *
 * Because there were two constructors of the same object —`buildKonAdminConfig` and
 * `buildGrimoireKonConfig`— and only one filled in this field. A kon that
 * belonged to a grimoire lost its declared `apiBase` without anything
 * saying so: kon-dms declares `/api/dms` in its manifest and the registry returned
 * `undefined`. Two places computing the same thing diverge; one cannot.
 *
 * ── WHY IT IS NOT DEDUCED FROM `mount.path` ────────────────────────────────
 *
 * Here it used `admin?.apiBase || mount?.path`, and that is a false promise:
 * `mount.path` says where the kon's router is attached; `apiBase` promises that
 * `<apiBase>/<table>` lists that table. Academy mounts at `/api/academy` and
 * serves nothing like `/courses`.
 *
 * With the deduction, the panel fixed one endpoint per kon and used it on ALL its
 * tabs: in Academy all eleven asked for `courses`. It was the cause of "I can't
 * move between options inside each kon".
 */
function declaredApiBase(kon: KitsudenManifest): string | undefined {
  return (kon as { admin?: { apiBase?: string } }).admin?.apiBase;
}

async function buildGrimoireKonConfig(
  kon: KitsudenManifest,
  _grimoire: GrimoireInfo
): Promise<KonAdminConfig | null> {
  // Skip engine infrastructure
  if (isEngineInfrastructure(kon.id)) {
    return null;
  }

  const konPath = join(getPackagesRoot(), "kons", getKonDirName(kon.id));

  // Get tables from kon.json or infer from id
  const tables = await detectTables(kon, konPath);

  // 1. Try to read admin.views from kon.json (Hybrid Rendering)
  const views = extractViewsFromManifest(kon);

  // 2. Fallback to legacy behavior if no admin.views declared
  let hasCustomViewLegacy = false;
  if (views.length === 0) {
    hasCustomViewLegacy = await detectCustomView(kon.id);
    if (hasCustomViewLegacy) {
      views.push({
        id: "custom",
        type: "custom",
        title: "Overview",
        component: `$views/${getViewPath(kon.id)}`,
      });
    }
    for (const table of tables) {
      views.push({
        id: `grid-${table.name}`,
        type: "grid",
        title: table.label,
        table: table.name,
      });
    }
  }

  const hasCustomView = views.some((v) => v.type === "custom") || hasCustomViewLegacy;
  const defaultView = defaultViewValid((kon as any).admin?.defaultView, views, kon.id);

  return {
    id: kon.id,
    name: kon.name || kon.id,
    icon: kon.icon || getDefaultIcon(kon.id),
    category: "esports", // Grimoires are always esports category
    hasCustomView,
    tables,
    views,
    defaultView,
    // It was missing: a grimoire kon lost its declared `apiBase`.
    apiBase: declaredApiBase(kon),
  };
}

/**
 * Scan all kons and build admin registry
 */
/**
 * Load the manifest of the currently active grimoire (grimoire.json).
 */
async function loadActiveGrimoireManifest(): Promise<GrimoireManifest | null> {
  const activeGrimoireId =
    process.env.KITSUDEN_ACTIVE_GRIMOIRE || process.env.KITSUDEN_ACTIVE_THEME || null;
  if (!activeGrimoireId) return null;

  const manifest = await readGrimoireManifest(
    join(getPackagesRoot(), "grimoires", activeGrimoireId)
  );
  return manifest as GrimoireManifest | null;
}

/**
 * Apply grimoire-level overrides to a kon admin config.
 */
function applyGrimoireOverrides(
  config: KonAdminConfig,
  grimoireManifest: GrimoireManifest | null
): KonAdminConfig {
  if (!grimoireManifest?.konConfig) return config;

  const override = grimoireManifest.konConfig[config.id];
  if (!override) return config;

  // Clone to avoid mutating original
  const patched = { ...config };

  // Override display name
  if (override.displayName) {
    patched.name = override.displayName;
  }

  // Override default view — checked just like the other two: an override
  // that points to a nonexistent view breaks the same as a manifest does.
  if (override.defaultView) {
    patched.defaultView = defaultViewValid(override.defaultView, patched.views, patched.id);
  }

  // Hide tables
  if (override.hiddenTables && override.hiddenTables.length > 0) {
    const hiddenSet = new Set(override.hiddenTables);
    patched.tables = patched.tables.filter((t) => !hiddenSet.has(t.name));
    patched.views = patched.views.filter((v) => !v.table || !hiddenSet.has(v.table));
  }

  // Add extra views
  if (override.extraViews && override.extraViews.length > 0) {
    patched.views = [...patched.views, ...override.extraViews];
  }

  return patched;
}

export async function buildAdminRegistry(): Promise<KonAdminConfig[]> {
  // Check cache
  if (registryCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return registryCache;
  }

  const kons = await scanPackages("kons");
  const grimoires = await scanGrimoires();
  const activeGrimoireManifest = await loadActiveGrimoireManifest();
  const configs: KonAdminConfig[] = [];

  /**
   * Kons built by the second loop, so as not to build them twice.
   *
   * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────
   *
   * The `optionalKons` were also added here, and the second loop only walks
   * `grimoire.kons`. Result: a kon that only appears as an OPTIONAL of some
   * grimoire was skipped here and not added there — it vanished from the registry without
   * anything failing.
   *
   * It was THIRTEEN out of twenty-six: booking, members, payments, newsletter, wiki,
   * maps, cardsim, tierlist, builder, formulas, directory, ocr-training and
   * broadcast-moba. All listed as optional in grimoire-gremius,
   * grimoire-viggo or grimoire-documents.
   *
   * The symptom did not look like this: `/api/admin/registry/kon-booking` returned
   * 404, the panel fell back to its default configuration —a single view with
   * `table = <kon id>`— and the form said
   *
   *     Could not load schema for table "kon-booking"
   *
   * that is, the kon's id disguised as a missing table. The three tabs its
   * manifest declares did not show up anywhere.
   *
   * That a kon is OPTIONAL in a grimoire does not make it the property of that
   * grimoire: it is still a standalone kon that shows itself. Only those the
   * second loop is actually going to build are excluded.
   */
  const grimoireKonIds = new Set<string>();
  for (const grimoire of grimoires) {
    for (const gId of grimoire.kons) {
      grimoireKonIds.add(gId);
    }
  }

  // Scan standalone kons (not part of any grimoire)
  for (const kon of kons) {
    // Skip kons that belong to grimoires - they'll be handled separately
    if (grimoireKonIds.has(kon.id)) {
      continue;
    }

    const config = await buildKonAdminConfig(kon);
    if (config) {
      configs.push(config);
    }
  }

  /**
   * ── ONE KON, ONE ENTRY ───────────────────────────────────────────────────
   *
   * The same kon can be listed in SEVERAL grimoires: `kon-dms` appears in
   * `grimoire-corporate`, `grimoire-sharepoint` and `grimoire-documents`. Without this
   * check one configuration was pushed for each, and the registry returned
   * THREE identical entries with the same `id`.
   *
   * What shows in the panel: the kon repeated three times in the sidebar.
   * And since Svelte keys its lists, a duplicate id is also the
   * kind of thing that breaks the rendering of the whole list, not just its
   * appearance.
   *
   * The first one stays: it is the same one that was already being used —all three
   * generated an identical configuration— and the scan order is stable.
   */
  const alreadyRegistered = new Set(configs.map((c) => c.id));

  for (const grimoire of grimoires) {
    for (const konId of grimoire.kons) {
      if (alreadyRegistered.has(konId)) continue;

      // Find the kon manifest
      const kon = kons.find((g) => g.id === konId);
      if (kon) {
        const config = await buildGrimoireKonConfig(kon, grimoire);
        if (config) {
          configs.push(config);
          alreadyRegistered.add(config.id);
        }
      } else {
        console.warn(`[AdminRegistry] Grimoire ${grimoire.id} references unknown kon: ${konId}`);
      }
    }
  }

  // Scan core modules with custom views
  for (const coreModule of CORE_MODULES_WITH_VIEWS) {
    const config = await buildCoreModuleAdminConfig(coreModule);
    if (config) {
      configs.push(config);
    }
  }

  // Apply grimoire overrides (name changes, hidden tables, extra views)
  for (let i = 0; i < configs.length; i++) {
    configs[i] = applyGrimoireOverrides(configs[i], activeGrimoireManifest);
  }

  // Sort: custom views first, then alphabetically
  configs.sort((a, b) => {
    if (a.hasCustomView && !b.hasCustomView) return -1;
    if (!a.hasCustomView && b.hasCustomView) return 1;
    return a.name.localeCompare(b.name);
  });

  registryCache = configs;
  cacheTimestamp = Date.now();
  return configs;
}

/**
 * Build admin config for a single kon
 */
async function buildKonAdminConfig(kon: KitsudenManifest): Promise<KonAdminConfig | null> {
  // Skip engine infrastructure (Level 1 - always active, not user-facing)
  if (isEngineInfrastructure(kon.id)) {
    return null;
  }

  const konPath = join(getPackagesRoot(), "kons", getKonDirName(kon.id));

  // 2. Get tables from kon.json or infer from id
  const tables = await detectTables(kon, konPath);

  // 3. Build views config — read admin.views from kon.json (Hybrid Rendering)
  const views = extractViewsFromManifest(kon);

  // Fallback to legacy behavior if no admin.views declared
  let hasCustomViewLegacy = false;
  if (views.length === 0) {
    hasCustomViewLegacy = await detectCustomView(kon.id);
    if (hasCustomViewLegacy) {
      views.push({
        id: "custom",
        type: "custom",
        title: "Overview",
        component: `$views/${getViewPath(kon.id)}`,
      });
    }
    for (const table of tables) {
      views.push({
        id: `grid-${table.name}`,
        type: "grid",
        title: table.label,
        table: table.name,
      });
    }
  }

  const hasCustomView = views.some((v) => v.type === "custom") || hasCustomViewLegacy;

  const apiBase = declaredApiBase(kon);

  const defaultView = defaultViewValid((kon as any).admin?.defaultView, views, kon.id);

  return {
    id: kon.id,
    name: kon.name || kon.id,
    icon: kon.icon || getDefaultIcon(kon.id),
    category: mapCategory(kon.category, kon.grimoireId),
    hasCustomView,
    tables,
    views,
    defaultView,
    apiBase,
  };
}

/**
 * Build admin config for a core module (from apps/api/src/modules/)
 */
async function buildCoreModuleAdminConfig(
  coreModule: CoreModuleWithView
): Promise<KonAdminConfig | null> {
  // 1. Detect custom view by convention
  const hasCustomView = await detectCustomView(coreModule.id);

  // 2. Build tables config
  const tables: AdminTableConfig[] = [];
  if (coreModule.tables) {
    for (const tableName of coreModule.tables) {
      const introspected = await introspectTable(tableName);
      tables.push({
        name: tableName,
        label: humanize(tableName),
        icon: getTableIcon(tableName),
        primaryKey: introspected?.primaryKey[0] || "id",
        searchableFields: introspected?.columns
          .filter((c) => isSearchableType(c))
          .map((c) => c.name),
        filterableFields: introspected?.columns
          .filter((c) => isFilterableType(c))
          .map((c) => c.name),
      });
    }
  }

  // 3. Build views config
  const views: AdminViewConfig[] = [];

  if (hasCustomView) {
    views.push({
      id: "custom",
      type: "custom",
      title: "Overview",
      component: `$views/${getViewPath(coreModule.id)}`,
    });
  }

  // Add grid views for each table
  for (const table of tables) {
    views.push({
      id: `grid-${table.name}`,
      type: "grid",
      title: table.label,
      table: table.name,
    });
  }

  return {
    id: coreModule.id,
    name: coreModule.name,
    icon: getDefaultIcon(coreModule.id),
    category: coreModule.category,
    hasCustomView,
    tables,
    views,
    // With no views NONE is invented.
    //
    // This used to end in `|| "grid"`, an identifier that corresponds to nothing.
    // A kon with no tables or view of its own —there are ones that only register
    // game profiles in `kon-broadcast`— thus received a nonexistent
    // grid view, and the admin opened it as an explorer of a table named
    // the same as the kon. Hence "Collection '<kon>' not found" and
    // "0 columns": nothing was missing, that kon simply has no data to show.
    defaultView: hasCustomView ? "custom" : (views[0]?.id ?? null),
  };
}

/**
 * Detect if kon has custom Svelte view by convention.
 * Uses getViewPath() which already handles all special mappings.
 * Avoids false positives from shared view files (e.g., PostsView.svelte
 * being incorrectly detected for every kon).
 */
async function detectCustomView(konId: string): Promise<boolean> {
  const viewPath = getViewPath(konId);

  // Primary: the mapped view path (handles all special cases)
  if (await file(join(process.cwd(), "../../packages/admin/src/views", viewPath)).exists()) {
    return true;
  }

  // Fallback: index.svelte in the same folder
  const indexPath = viewPath.includes("/")
    ? viewPath.replace(/\/[^/]+\.svelte$/, "/index.svelte")
    : `${viewPath.replace(/\.svelte$/, "")}/index.svelte`;

  if (await file(join(process.cwd(), "../../packages/admin/src/views", indexPath)).exists()) {
    return true;
  }

  return false;
}

/**
 * Table config from kon manifest
 */
interface KonTableConfig {
  name?: string;
  table?: string;
  label?: string;
  icon?: string;
  description?: string;
  primaryKey?: string;
  searchableFields?: string[];
  filterableFields?: string[];
  readonly?: boolean;
}

/**
 * Detect tables for a kon
 */
async function detectTables(
  kon: KitsudenManifest,

  _konPath: string
): Promise<AdminTableConfig[]> {
  // Priority 1: Tables defined in kon.json
  if (kon.tables && Array.isArray(kon.tables)) {
    const configs: AdminTableConfig[] = [];

    for (const t of kon.tables) {
      if (typeof t === "string") {
        // Try to introspect from DB for extra metadata
        const introspected = await introspectTable(t);

        configs.push({
          name: t,
          label: humanize(t),
          icon: getTableIcon(t),
          primaryKey: introspected?.primaryKey[0] || "id",
          searchableFields: introspected?.columns
            .filter((c) => isSearchableType(c))
            .map((c) => c.name),
          filterableFields: introspected?.columns
            .filter((c) => isFilterableType(c))
            .map((c) => c.name),
        });
      } else {
        const tableConfig = t as KonTableConfig;
        const name = tableConfig.name || tableConfig.table || "";
        configs.push({
          name,
          label: tableConfig.label || humanize(name),
          icon: tableConfig.icon || getTableIcon(name),
          description: tableConfig.description,
          primaryKey: tableConfig.primaryKey || "id",
          searchableFields: tableConfig.searchableFields,
          filterableFields: tableConfig.filterableFields,
          readonly: tableConfig.readonly || false,
        });
      }
    }

    return configs;
  }

  // Priority 2: Auto-detect table from DB introspection
  const baseName = kon.id.replace(/^kon-/, "").replace(/-/g, "_");

  // Try to find table with same name or plural
  const introspected =
    (await introspectTable(baseName)) ||
    (await introspectTable(baseName + "s")) ||
    (await introspectTable(baseName.replace(/s$/, "")));

  if (introspected) {
    const searchableFields = introspected.columns
      .filter((c) => isSearchableType(c))
      .map((c) => c.name);
    const filterableFields = introspected.columns
      .filter((c) => isFilterableType(c))
      .map((c) => c.name);

    return [
      {
        name: introspected.name,
        label: kon.name || humanize(kon.id),
        icon: getDefaultIcon(kon.id),
        primaryKey: introspected.primaryKey[0] || "id",
        searchableFields,
        filterableFields,
      },
    ];
  }

  // Priority 3: Fallback to basic config
  return [
    {
      name: baseName,
      label: kon.name || humanize(kon.id),
      icon: getDefaultIcon(kon.id),
      primaryKey: "id",
    },
  ];
}

/** Column with type info */
interface ColumnInfo {
  name: string;
  type: string;
}

// Helper to determine if column is searchable
function isSearchableType(col: ColumnInfo): boolean {
  const searchableTypes = ["text", "varchar", "char"];
  const type = col.type.toLowerCase();
  const searchableNames = ["name", "title", "label", "email", "description", "slug"];

  return (
    searchableTypes.some((t) => type.includes(t)) ||
    searchableNames.some((n) => col.name.toLowerCase().includes(n))
  );
}

// Helper to determine if column is filterable
function isFilterableType(col: IntrospectedColumn): boolean {
  if (col.name === "id") return false;
  if (col.name.endsWith("_id")) return true; // FKs are filterable
  if (col.type.toLowerCase().includes("json")) return false;
  return true;
}

/**
 * Get the directory name for a kon ID
 */
function getKonDirName(id: string): string {
  // Common patterns
  if (id.startsWith("kon-")) return id;
  if (id.startsWith("core-")) return id.replace("core-", "core/");
  return `kon-${id}`;
}

/**
 * Get view path for custom component
 * Handles kon- prefix stripping for view paths
 */
function getViewPath(konId: string): string {
  const shortId = konId.replace(/^kon-/, "");
  const pascal = pascalCase(shortId);

  // Special cases for kon IDs that map to different view paths

  // blog: stored in content/ folder with PostsView name
  if (konId === "kon-blog") {
    return "content/PostsView.svelte";
  }

  // Page Builder (Blocks): maps to blocks/ folder
  if (konId === "kon-blocks") {
    return "blocks/BlocksView.svelte";
  }

  // Academy LMS: maps to academy/ folder
  if (konId === "kon-academy-lms") {
    return "academy/AcademyView.svelte";
  }

  // Games (esports grimoire): maps to games/ folder
  if (konId === "kon-games") {
    return "games/GamesView.svelte";
  }

  // Streamers: maps to users/ folder
  if (konId === "kon-streamers") {
    return "users/StreamersView.svelte";
  }

  // Webhooks: maps to webhooks/ folder
  if (konId === "kon-webhooks" || konId === "webhooks") {
    return "webhooks/WebhooksView.svelte";
  }

  // Workers: maps to workers/ folder
  if (konId === "kon-workers" || konId === "workers") {
    return "workers/WorkersView.svelte";
  }

  // Media Library: maps to Media.svelte
  if (konId === "media-library" || konId === "media" || konId === "kon-media") {
    return "Media.svelte";
  }

  // DataSets: Core kon - maps to DataSets.svelte
  if (konId === "kon-datasets" || konId === "datasets") {
    return "DataSets.svelte";
  }

  // Page Builder (Blocks): maps to blocks/BlocksView.svelte
  if (konId === "kon-blocks" || konId === "blocks") {
    return "blocks/BlocksView.svelte";
  }

  // Blog: maps to content/PostsView.svelte
  if (konId === "kon-blog" || konId === "blog") {
    return "content/PostsView.svelte";
  }

  // Default: use short ID without kon- prefix
  return `${shortId}/${pascal}View.svelte`;
}

/**
 * Engine infrastructure kons that should be hidden from admin
 * These are Level 1 - always active, not user-facing
 *
 * NOTE: Media Library is now a Core Kon (toggleable), not engine infrastructure.
 * The underlying MinIO storage service remains always-on as engine infrastructure,
 * but the API routes and UI are toggleable via kon system.
 */
const ENGINE_INFRASTRUCTURE: string[] = [];

/**
 * Check if kon is engine infrastructure (should be hidden)
 */
function isEngineInfrastructure(id: string): boolean {
  return ENGINE_INFRASTRUCTURE.includes(id);
}

/**
 * Map category to admin category
 *
 * Category mapping:
 * - "core-den" | "core" → "core" (Level 2 - Core kons: blog, blocks, webhooks, connectors)
 * - "optional" → "content" or "data" (Level 3 - Optional features)
 * - "grimoire" | grimoireId present → "esports" (Level 4 - Grimoire-specific, dynamic)
 */
function mapCategory(category?: string, grimoireId?: string): KonAdminConfig["category"] {
  // Grimoires are dynamic and separate from optional kons
  if (grimoireId || category === "grimoire") return "esports";
  // Core kons (both core-den and core/system infrastructure)
  if (category === "core-den" || category === "core") return "core";
  // Content kons
  if (["blog", "media", "content"].includes(category || "")) return "content";
  // System/Infrastructure kons also go to core
  if (["webhooks", "workers", "system"].includes(category || "")) return "core";
  // The family of tools (builders, wikis, maps, simulators) declares
  // `tools`, which does not yet exist in the registry's versioned contract: it travels
  // as `data` until the version is bumped and the panel gives it its own section.
  if (category === "tools") return "data";
  // Default to data for other optional kons
  return "data";
}

/**
 * Get default icon for kon/table
 */
function getDefaultIcon(id: string): string {
  const icons: Record<string, string> = {
    games: "Gamepad2",
    streamers: "Tv",
    platforms: "Monitor",
    tags: "Tag",
    collections: "Library",
    teams: "Users",
    players: "UserCircle",
    matches: "Swords",
    tournaments: "Trophy",
    webhooks: "Webhook",
    workers: "Cpu",
    academy: "GraduationCap",
    booking: "CalendarDays",
    directory: "Contact",
    crm: "Briefcase",
    dms: "FileStack",
    blog: "FileText",
    media: "Image",
    datasets: "Database",
  };
  return icons[id] || "Database";
}

/**
 * Get icon for specific table
 */
function getTableIcon(tableName: string): string {
  if (tableName.includes("user") || tableName.includes("contact")) return "User";
  if (tableName.includes("game")) return "Gamepad2";
  if (tableName.includes("media") || tableName.includes("image")) return "Image";
  if (tableName.includes("post") || tableName.includes("article")) return "FileText";
  if (tableName.includes("category") || tableName.includes("tag")) return "Tag";
  if (tableName.includes("order") || tableName.includes("sale")) return "ShoppingCart";
  return "Table";
}

/**
 * Convert snake_case or camelCase to Human Readable
 */
function humanize(str: string): string {
  return str
    .replace(/^kon-/, "")
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

/**
 * Convert to PascalCase
 */
function pascalCase(str: string): string {
  return str
    .replace(/^kon-/, "")
    .replace(/[-_]/g, " ")
    .replace(/(?:^|\s)(\w)/g, (_, c) => c.toUpperCase())
    .replace(/\s/g, "");
}

/**
 * Clear registry cache (useful after kon installation)
 */
export function clearAdminRegistryCache() {
  registryCache = null;
  cacheTimestamp = 0;
}

/**
 * Get admin config for a specific kon
 */
export async function getKonAdminConfig(konId: string): Promise<KonAdminConfig | null> {
  const registry = await buildAdminRegistry();
  return registry.find((g) => g.id === konId) || null;
}
