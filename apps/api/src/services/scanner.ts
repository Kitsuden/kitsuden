/**
 * Filesystem Scanner Service (The Lore Refactor Edition)
 *
 * Scans /packages/kons, /packages/grimoires, and node_modules for manifests.
 * Uses Bun's native optimized I/O APIs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LORE REFACTOR: Kitsuden's Magic Hierarchy
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * KONS: Individual magical code blocks (formerly "modules")
 *   Location: packages/kons/
 *   Manifest: kon.json or kitsuden.json
 *
 * GRIMOIRES: Business ecosystems grouping kons (formerly "themes")
 *   Location: packages/grimoires/
 *   Manifest: grimoire.json or kitsuden.json
 *
 * INSTALLED: Kons installed via npm/marketplace
 *   Location: node_modules/
 *   Registry: installed_kons table
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { db } from "../db";
import { installedKons } from "../db/schema";
import { file } from "../lib/file";
import { manifestIsOfType } from "../lib/grimoire-manifest";
import { listInstalledKons } from "../lib/installed-kons";

/** Kon/Grimoire manifest structure */
export interface KitsudenManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  type: "kon" | "grimoire" | "module" | "theme"; // module/theme are legacy
  icon?: string;
  author?: string;
  // Kon-specific
  admin_route?: string;
  category?: "core" | "core-den" | "optional" | "grimoire" | string;
  grimoireId?: string;
  // Grimoire-specific
  css_entry?: string; // defaults to variables.css
  preview_image?: string; // relative path to screenshot
  kons?: string[]; // kons this grimoire requires (new)
  requires_modules?: string[]; // legacy: modules this theme is designed for
  optional_modules?: string[]; // legacy: modules that unlock extra features
  optional_kons?: string[]; // kons that unlock extra features (new)
  grimoire_type?: string; // e.g. "blog", "lms", "portfolio", "gaming", "corporate"
  theme_type?: string; // legacy alias
  components?: Record<string, string>; // named component overrides
  // Internal
  source?: "filesystem" | "npm" | "marketplace" | "local";
  hasMigrations?: boolean;
  // For installed kons
  installed?: boolean;
  enabled?: boolean;
  installPath?: string;
  // For grimoire manifests
  tables?: (string | TableConfig)[];
  /** Per-kon admin overrides when this grimoire is active */
  konConfig?: Record<
    string,
    {
      displayName?: string;
      hiddenTables?: string[];
      extraViews?: Array<{
        id: string;
        type: "grid" | "kanban" | "calendar" | "custom";
        title: string;
        table?: string;
      }>;
      defaultView?: string;
    }
  >;
  /** Seed configuration */
  seed?: {
    sql?: string; // relative path to seed.sql (default: seed.sql)
    datasets?: string; // relative path to seed-datasets.json
    runOnce?: boolean; // default: true
  };
}

/** Table configuration in kon manifest */
interface TableConfig {
  name: string;
  table?: string;
  label?: string;
  icon?: string;
  description?: string;
  primaryKey?: string;
  searchableFields?: string[];
  filterableFields?: string[];
  readonly?: boolean;
}

// Resolve workspace root (Docker vs dev)
function getPackagesRoot(): string {
  const cwdCheck = join(process.cwd(), "packages", "kons", "package.json");
  const root = existsSync(cwdCheck) ? process.cwd() : join(process.cwd(), "../../");
  return join(root, "packages");
}

// Resolve node_modules paths
async function getNodeModulesPaths(): Promise<string[]> {
  const paths: string[] = [];
  const root = existsSync(join(process.cwd(), "apps", "api"))
    ? process.cwd()
    : join(process.cwd(), "../../");

  // Check multiple possible locations
  paths.push(join(root, "node_modules"));
  paths.push(join(root, "apps", "api", "node_modules"));
  paths.push(join(process.cwd(), "node_modules"));

  return paths.filter((p) => existsSync(p));
}

// Cache entry structure
interface CacheEntry {
  data: KitsudenManifest[];
  timestamp: number;
}

// Simple in-memory cache to avoid disk thrashing on frequent refreshes
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Scan kons from node_modules (installed via npm)
 */
export async function scanInstalledKons(): Promise<KitsudenManifest[]> {
  const cacheKey = "installed";
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const manifests: KitsudenManifest[] = [];
  const nodeModulesPaths = await getNodeModulesPaths();

  // First, get installed kons from database
  try {
    const dbKons = await db.select().from(installedKons).where(eq(installedKons.enabled, true));

    for (const g of dbKons) {
      const manifest = g.manifest as KitsudenManifest | undefined;
      manifests.push({
        id: g.konId,
        name: g.name,
        description: g.description || manifest?.description,
        version: g.version,
        type: "kon",
        source: g.source as "npm" | "marketplace" | "local",
        installed: true,
        enabled: g.enabled,
        installPath: g.path,
        ...manifest,
      });
    }
  } catch {
    // Table might not exist yet, continue with filesystem scan
  }

  // And those DECLARED in the installation that live in node_modules (published
  // packages). Before, `node_modules/@kitsuden/kon-*` and
  // `node_modules/kon-*` were walked: any package with that name showed up as an
  // installed kon. Now only what was installed (`kitsuden kon add`, KITSUDEN_KONS).
  void nodeModulesPaths;
  for (const kon of listInstalledKons()) {
    if (kon.source === "core" || !kon.path || !/[\\/]node_modules[\\/]/.test(kon.path)) continue;
    const manifest = await readKonManifest(kon.path);
    if (manifest && !manifests.some((m) => m.id === manifest.id)) {
      manifests.push({
        ...manifest,
        source: "npm",
        installed: true,
        enabled: true,
        installPath: kon.path,
      });
    }
  }

  cache.set(cacheKey, { data: manifests, timestamp: Date.now() });
  return manifests;
}

/**
 * Read kon.json or package.json from a directory
 */
async function readKonManifest(dirPath: string): Promise<KitsudenManifest | null> {
  // Try kon.json first
  const konJsonPath = join(dirPath, "kon.json");
  const konFile = file(konJsonPath);

  if (await konFile.exists()) {
    try {
      const json = (await konFile.json()) as Record<string, unknown>;
      return {
        ...(json as unknown as KitsudenManifest),
        type: (json.type as KitsudenManifest["type"]) || "kon",
      };
    } catch {
      // Invalid JSON
    }
  }

  // Try package.json with kitsuden field
  const packageJsonPath = join(dirPath, "package.json");
  const packageFile = file(packageJsonPath);

  if (await packageFile.exists()) {
    try {
      // ONLY what this block reads is declared. Before it was `any`, which besides
      // turning off the checker hid which fields of the foreign package.json
      // are being taken for granted — which is exactly what you need to know when one
      // of them is missing and the kon does not show up.
      type PkgKitsuden = { type?: string; id?: string; name?: string; [k: string]: unknown };
      type Pkg = {
        name?: string;
        description?: string;
        version?: string;
        author?: string | { name?: string };
        kitsuden?: PkgKitsuden;
      };

      const pkg = (await packageFile.json()) as Pkg;
      if (pkg.kitsuden?.type === "kon") {
        return {
          id: pkg.kitsuden.id || pkg.name,
          name: pkg.kitsuden.name || pkg.name,
          description: pkg.description,
          version: pkg.version,
          type: "kon",
          author: typeof pkg.author === "string" ? pkg.author : pkg.author?.name,
          ...pkg.kitsuden,
        } as KitsudenManifest;
      }
    } catch {
      // Invalid JSON
    }
  }

  return null;
}

/**
 * Scan kons or grimoires directories
 * @param type "kons" | "grimoires" (legacy: "modules" | "themes")
 */
export async function scanPackages(
  type: "kons" | "grimoires" | "modules" | "themes"
): Promise<KitsudenManifest[]> {
  // Normalize legacy types
  const dirName = type === "modules" ? "kons" : type === "themes" ? "grimoires" : type;

  const cacheKey = dirName;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const dirPath = join(getPackagesRoot(), dirName);
  const manifests: KitsudenManifest[] = [];

  try {
    // KONS come from the installation (kitsuden.kons.json + KITSUDEN_KONS,
    // see lib/installed-kons.ts), not from walking packages/kons:
    // the kons live in the kitsuden-kons repo and that folder only holds the
    // installed copies. Grimoires are still in packages/grimoires.
    let dirs: { name: string; route: string }[];
    if (dirName === "kons") {
      dirs = listInstalledKons()
        .filter((k) => k.source !== "core" && k.path)
        .map((k) => ({ name: k.id, route: k.path as string }));
    } else {
      const dirExists = (await file(dirPath).exists()) || (await isDirectory(dirPath));
      if (!dirExists) {
        return [];
      }
      const entries = await readdir(dirPath, { withFileTypes: true });
      dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, route: join(dirPath, e.name) }));
    }

    for (const dir of dirs) {
      // Try new manifest formats first, then legacy
      const manifestPaths = [
        join(dir.route, dirName === "kons" ? "kon.json" : "grimoire.json"),
        join(dir.route, "kitsuden.json"), // Legacy fallback
      ];

      for (const manifestPath of manifestPaths) {
        const manifestFile = file(manifestPath);

        if (await manifestFile.exists()) {
          try {
            const json = (await manifestFile.json()) as Record<string, unknown>;

            // The fallback to kitsuden.json is legitimate for legacy
            // manifests, but in packages/grimoires/<id>/ that file is the
            // THEME (type: "theme", with its own id). Without this check,
            // a missing grimoire.json slipped the theme into the list of
            // grimoires with the wrong id and without a single kon.
            const expected = dirName === "kons" ? "kon" : "grimoire";
            if (!manifestIsOfType(json, expected)) {
              continue;
            }

            // Basic validation
            if (json.id && json.name && json.version) {
              // `hasMigrations` = the folder has some `.sql`, not that a
              // file called `init.sql` exists.
              //
              // Checking for `init.sql` was the same mistake that
              // `runKonMigrations` carried: no kon uses that name, so ALL
              // kons were announced as "without migrations" even if they carried four.
              const migrationDir = join(dir.route, "migrations");
              let hasMigrations = false;
              try {
                hasMigrations = (await readdir(migrationDir)).some((f) => f.endsWith(".sql"));
              } catch {
                hasMigrations = false; // the folder does not exist
              }

              // Determine type from manifest or directory
              const manifestType: KitsudenManifest["type"] =
                (json.type as KitsudenManifest["type"]) ||
                (dirName === "kons" ? "kon" : "grimoire");

              manifests.push({
                ...(json as unknown as KitsudenManifest),
                source: "filesystem",
                type: manifestType,
                hasMigrations,
              });
            }
            break; // Found a valid manifest, stop checking other paths
          } catch (err) {
            console.error(`[Scanner] Failed to parse ${manifestPath}`, err);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Scanner] Error scanning ${dirPath}:`, err);
  }

  cache.set(cacheKey, { data: manifests, timestamp: Date.now() });
  return manifests;
}

/**
 * Get all available kons (local + installed)
 */
export async function getAllKons(): Promise<KitsudenManifest[]> {
  const [localKons, installedKons] = await Promise.all([scanPackages("kons"), scanInstalledKons()]);

  // Merge, with installed taking precedence
  const all = new Map<string, KitsudenManifest>();

  for (const g of localKons) {
    all.set(g.id, g);
  }

  for (const g of installedKons) {
    // Installed kons override local ones
    all.set(g.id, { ...all.get(g.id), ...g });
  }

  return Array.from(all.values());
}

// Helper to check if path is dir using Bun
async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await import("node:fs/promises").then((m) => m.stat(path));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ── Run Migrations ──

/**
 * Applies a kon's migrations.
 *
 * ── WHAT IT USED TO DO ─────────────────────────────────────────────────────
 *
 * It looked for ONE file called `migrations/init.sql`. No kon in the repo
 * is named that: they all use the numeric prefix (`0000_initial.sql`,
 * `0001_members.sql`). `file(...).exists()` gave false, the function exited
 * silently, and whoever called it took a kon with no tables at all as installed.
 *
 * The implementation lives in `lib/kon-migrations.ts` and is the SAME one the
 * startup runner uses, with the same history. Having two was the reason this one
 * rotted without anyone noticing: only the other one was exercised.
 *
 * The error is propagated on purpose. Whoever activates a kon has to find out
 * that it could not be installed.
 */
export async function runKonMigrations(konId: string): Promise<void> {
  const manifest = (await getAllKons()).find((m) => m.id === konId);

  const { applyKonMigrations } = await import("../lib/kon-migrations");
  await applyKonMigrations(konId, { installPath: manifest?.installPath });
}

/**
 * @deprecated Use runKonMigrations instead
 */
export const runModuleMigrations = runKonMigrations;

/**
 * @deprecated Use scanPackages("kons") instead
 */
export async function scanModules(): Promise<KitsudenManifest[]> {
  return scanPackages("kons");
}

/**
 * @deprecated Use scanPackages("grimoires") instead
 */
export async function scanThemes(): Promise<KitsudenManifest[]> {
  return scanPackages("grimoires");
}
