/**
 * Kitsuden — Kon Classification System (The Magic Hierarchy)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LORE REFACTOR: Kitsuden's Magic Hierarchy
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE:
 *
 *   ENGINE (invisible, always active, NOT kons):
 *     Schema Engine, Auth Manager, API Gateway, Valkey, Kon Loader
 *     Media Hub ← Infrastructure, not a kon
 *     Data Sets ← NOW A CORE KON (kon-datasets), toggleable
 *
 *   CORE KONS (shown, toggleable, grimoire-agnostic):
 *     Blog, Webhooks, Connectors, Blocks, Formulas KPI
 *
 *   OPTIONAL KONS (shown, toggleable, vertical features):
 *     Academy, DMS, Booking, Directory, CRM, Blog
 *
 *   GRIMOIRE KONS (shown in OPTIONAL section with "Enabled by Grimoire" badge):
 *     Games, Streamers, Platforms, Tags, Collections (when Grimoire Esports active)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "../db";
import { konIdOf, listInstalledKons, konRoute } from "../lib/installed-kons";

export type KonCategory = "core" | "core-den" | "optional" | "grimoire";

export interface KonDef {
  key: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  category: KonCategory;
  tables: string[];
  dependsOn: string[];
  grimoireId?: string;
  referencedBy: Array<{
    kon: string;
    table: string;
    column: string;
    label: string;
  }>;
}

// ═══════════════════════════════════════════════════════════════
// KON REGISTRY
// ═══════════════════════════════════════════════════════════════

/**
 * HAND-CURATED entries.
 *
 * What is written here is what no kon.json knows about itself: the card's
 * color, the toggle category (core / core-den / optional /
 * grimoire) and, above all, `referencedBy` — the foreign-key graph that says
 * which other kon breaks if you turn this one off. That is deduced from the schema, not from the
 * manifest.
 *
 * The rest of the registry fills itself in from packages/kons/. See
 * KON_REGISTRY, below.
 */
const CURATED_KONS: KonDef[] = [
  // ═════════════════════════════════════════════════════════════
  // LEVEL 2 — CORE KONS (switchable via kitsuden.config.ts)
  // category: "core" | "core-den" — Shown in admin, gated by feature flags
  // NOTE: media-library is ENGINE infrastructure (Level 1), NOT here
  // NOTE: DataSets is NOW a kon (was: engine feature, now: core kon)
  // ═══════════════════════════════════════════════════════════════

  // MEDIA LIBRARY - Core kon, file uploads & storage
  {
    key: "kon-media",
    name: "Media Library",
    description: "File uploads, image optimization, and pluggable storage (MinIO, S3, Local, R2).",
    icon: "🖼️",
    color: "#EC4899",
    category: "core",
    tables: ["media", "media_folders"],
    dependsOn: [],
    referencedBy: [
      {
        kon: "kon-blog",
        table: "blog_posts",
        column: "cover_image_id",
        label: "Blog post cover images",
      },
    ],
  },
  // DATASETS - Core kon, enabled by default, positioned first in admin
  {
    key: "kon-datasets",
    name: "DataSets",
    description:
      "Dynamic data collections with automatic REST API, validation, and RLS. The foundation of Kitsuden content management.",
    icon: "🗃️",
    color: "#3B82F6",
    category: "core",
    tables: ["data_sets", "data_entries"],
    dependsOn: [],
    referencedBy: [
      {
        kon: "kon-blog",
        table: "blog_posts",
        column: "dataset_id",
        label: "Blog posts using datasets",
      },
      {
        kon: "kon-crm",
        table: "crm_deals",
        column: "dataset_id",
        label: "CRM deals using datasets",
      },
    ],
  },
  // NOTE: Webhooks merged into Actions Engine (Nivel 1). Not a standalone kon.
  // NOTE: Data Connectors moved to Settings > Integrations. Not a kon.
  {
    key: "kon-blocks",
    name: "Page Builder",
    description:
      "Lego-style block system for dynamic page layouts (Hero, Grid, Filter, etc.) with drag & drop, templates, and scheduling.",
    icon: "🧱",
    color: "#3B82F6",
    category: "core-den",
    tables: ["pages", "blocks", "block_templates"],
    dependsOn: [],
    referencedBy: [],
  },
  // ═══════════════════════════════════════════════════════════════
  // OPTIONAL KONS — Vertical/enterprise features
  // ═══════════════════════════════════════════════════════════════
  {
    key: "kon-academy-lms",
    name: "Kitsuden Academy LMS",
    description:
      "Learning Management System with courses, modules, quizzes, learning paths, progress tracking, groups, and satisfaction surveys.",
    icon: "🎓",
    color: "#6366F1",
    category: "optional",
    tables: [
      "training_user_profiles",
      "courses",
      "assignment_groups",
      "group_users",
      "group_supervisors",
      "course_modules",
      "topics",
      "additional_files",
      "quizzes",
      "questions",
      "options",
      "course_progress",
      "module_progress",
      "topic_progress",
      "user_answers",
      "quiz_results",
      "learning_paths",
      "learning_path_courses",
      "learning_path_progress",
      "learning_path_assignments",
      "assignments",
      "feedback",
      "satisfaction_surveys",
      "certificates",
      "academy_activity_log",
    ],
    dependsOn: [],
    referencedBy: [],
  },
  {
    key: "kon-dms",
    name: "Document Management",
    description:
      "Versioned document storage with hierarchical categories, semantic versioning, approval workflows, and comprehensive audit trail. Optimized for manuals and corporate documentation.",
    icon: "📄",
    color: "#FF9100",
    category: "optional",
    tables: [
      "dms_categories",
      "dms_documents",
      "dms_document_versions",
      "dms_document_files",
      "dms_document_relations",
      "dms_document_acknowledgments",
      "dms_access_log",
    ],
    dependsOn: [],
    referencedBy: [],
  },
  {
    key: "kon-booking",
    name: "Booking Engine",
    description:
      "Room reservations with conflict detection, amenities management, approval workflows, and check-in/out tracking.",
    icon: "📅",
    color: "#00BFA5",
    category: "optional",
    tables: ["rooms", "amenities", "room_amenities", "bookings", "booking_notes", "blackout_dates"],
    dependsOn: [],
    referencedBy: [],
  },
  {
    key: "kon-directory",
    name: "Employee Directory",
    description:
      "Employee profiles, departments, positions, and organizational hierarchy with org charts, reporting chains, and document management.",
    icon: "👥",
    color: "#448AFF",
    category: "optional",
    tables: [
      "organizations",
      "departments",
      "positions",
      "employees",
      "employee_documents",
      "org_chart_cache",
    ],
    dependsOn: [],
    referencedBy: [],
  },
  {
    key: "kon-crm",
    name: "Kitsuden CRM",
    description:
      "Contacts, deals pipeline, and activity log built on Data Sets with automation hooks.",
    icon: "💼",
    color: "#E91E63",
    category: "optional",
    tables: [],
    dependsOn: [],
    referencedBy: [],
  },
  {
    key: "kon-analytics",
    name: "Analytics",
    description:
      "Views per subject and day, with no cookies or personal data. It orders the home page and measures the blog and the tournaments.",
    icon: "📊",
    color: "#38BDF8",
    category: "core-den",
    tables: ["analytics_views"],
    dependsOn: [],
    referencedBy: [],
  },
  {
    key: "kon-blog",
    name: "Blog & Content Publishing",
    description:
      "Complete CMS publishing with editorial workflow, SEO, slugs, scheduling. Includes former 'Promote' functionality.",
    icon: "📝",
    color: "#76FF03",
    category: "core-den",
    tables: ["blog_posts", "blog_posts_to_tags", "blog_posts_to_games"],
    dependsOn: ["kon-media"],
    referencedBy: [],
  },
  {
    key: "ai-memories",
    name: "AI Memories",
    description:
      "Vector-based semantic memory storage with pgvector. Supports OpenAI embeddings, document chunking, and similarity search for RAG applications.",
    icon: "🧠",
    color: "#9C27B0",
    category: "optional",
    tables: ["ai_memories", "ai_memory_chunks"],
    dependsOn: [],
    referencedBy: [],
  },

  // ═══════════════════════════════════════════════════════════════
  // GRIMOIRE KONS — Bundled with Kitsuden CMS Grimoire (Consolidated)
  // Show in OPTIONAL section with "Enabled by Grimoire" badge when active
  // ═══════════════════════════════════════════════════════════════
  {
    key: "kon-games",
    name: "Games Catalog",
    description:
      "Complete game library with IGDB integration: games, platforms, tags, and collections.",
    icon: "🎮",
    color: "#00E5FF",
    category: "grimoire",
    grimoireId: "grimoire-default",
    tables: [
      "games",
      "platforms",
      "tags",
      "game_collections",
      "game_collection_entries",
      "games_to_platforms",
      "games_to_tags",
    ],
    dependsOn: [],
    referencedBy: [
      {
        kon: "blog",
        table: "blog_posts_to_games",
        column: "game_id",
        label: "Blog posts referencing games",
      },
      {
        kon: "kon-streamers",
        table: "games_to_streamers",
        column: "game_id",
        label: "Streamers linked to games",
      },
      {
        kon: "kon-esports",
        table: "tournaments",
        column: "game_id",
        label: "Tournaments using games",
      },
    ],
  },
  {
    key: "kon-esports",
    name: "Esports",
    description: "Complete competitive ecosystem: players, teams, tournaments, and matches.",
    icon: "🏆",
    color: "#FFD600",
    category: "grimoire",
    grimoireId: "grimoire-default",
    tables: [
      "players",
      "teams",
      "players_to_teams",
      "tournaments",
      "tournament_participants",
      "matches",
    ],
    dependsOn: ["kon-games"],
    referencedBy: [],
  },
  {
    key: "kon-streamers",
    name: "Streamers",
    description: "Track live streamers across Twitch, YouTube, and Kick with real-time sync.",
    icon: "📡",
    color: "#FF6E40",
    category: "grimoire",
    grimoireId: "grimoire-default",
    tables: ["streamers", "games_to_streamers"],
    dependsOn: ["kon-games"],
    referencedBy: [],
  },

  // ═════════════════════════════════════════════════════════════
  // ENGINE INFRASTRUCTURE (Level 1) — NOT KONS:
  //   - media-library: File uploads, always active via /api/media
  // NOTE: datasets WAS a native engine feature, NOW is a core kon (kon-datasets)
  // It can be toggled via kitsuden.config.ts or admin UI
  // ═══════════════════════════════════════════════════════════════
];

// ═══════════════════════════════════════════════════════════════
// AUTODISCOVERY — the registry is completed from the manifests
// ═══════════════════════════════════════════════════════════════

/**
 * Of the 33 kons on disk, this table classified 13.
 *
 * The other 24 started up just the same —the loader scans the filesystem, not
 * this list— but were left without metadata: no category to group them by
 * in the panel, no `tables` to count rows with and no `dependsOn`. And the
 * failure mode was the worst: there was no visible gap, they simply did not show up.
 *
 * Now the curated list above takes precedence, and every INSTALLED kon (see
 * lib/installed-kons.ts) that is not in it enters derived from its own
 * kon.json. A curated card for a kon that is not installed does not enter. Adding a kon no longer
 * requires touching this file; curating it is still optional and that is what
 * CURATED_KONS is for.
 */
/** `tables` accepts strings or cards with `name`; consumers accept both. */
function tableNames(tables: unknown): string[] {
  if (!Array.isArray(tables)) return [];
  return tables
    .map((t) => (typeof t === "string" ? t : (t as { name?: string })?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

/**
 * The manifest's tier is the closest thing to a toggle category that
 * a kon declares about itself: "essential" always starts, the rest are activated.
 */
function categoryFromTier(tier: unknown, core: unknown): KonCategory {
  if (core === true || tier === "essential") return "core";
  return "optional";
}

/** Stable color derived from the id: same kon, same color on every startup. */
function colorFromId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 65%, 55%)`;
}

function deriveKonsFromDisk(alreadyCurated: Set<string>): KonDef[] {
  const derivedAll: KonDef[] = [];

  // What is INSTALLED (kitsuden.kons.json + KITSUDEN_KONS), not what is in the
  // folder: The kons live in kitsuden-kons.
  for (const kon of listInstalledKons()) {
    if (kon.source === "core" || !kon.path || alreadyCurated.has(kon.id)) continue;
    const input = { name: kon.id };

    const manifest = join(kon.path, "kon.json");
    if (!existsSync(manifest)) continue;

    let m: Record<string, any>;
    try {
      m = JSON.parse(readFileSync(manifest, "utf8"));
    } catch (err) {
      // An unreadable manifest CANNOT just disappear: that would be going back to the
      // problem this block fixes, only one at a time.
      console.warn(`[KonRegistry] ${manifest} is not valid JSON: ${(err as Error).message}`);
      continue;
    }

    derivedAll.push({
      key: input.name,
      name: m.name || input.name,
      description: m.description || "",
      icon: m.icon || "Package",
      color: colorFromId(input.name),
      category: categoryFromTier(m.tier, m.core),
      tables: tableNames(m.tables),
      dependsOn: Array.isArray(m.dependencies?.kons) ? m.dependencies.kons : [],
      // The reference graph comes from the schema, not the manifest: it is curated by
      // hand in CURATED_KONS when needed.
      referencedBy: [],
    });
  }

  return derivedAll;
}

/**
 * Fills in from the manifest the gaps the curated entry left empty.
 *
 * `kon-crm` was curated with `tables: []`. It was not an oversight: its 6 tables
 * were declared in `database.tables`, a field nobody reads, so
 * whoever wrote the card by hand did not find them. With the manifest fixed, the
 * right thing is for the card to complete itself — typing the six names here
 * would mean having two lists again that drift apart over time.
 *
 * Curated content that DOES have value always wins.
 */
function completeFromManifest(kon: KonDef): KonDef {
  if (kon.tables.length > 0 && kon.dependsOn.length > 0) return kon;

  const route = konRoute(kon.key);
  const manifest = route ? join(route, "kon.json") : "";
  if (!route || !existsSync(manifest)) return kon;

  try {
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    return {
      ...kon,
      tables: kon.tables.length ? kon.tables : tableNames(m.tables),
      dependsOn: kon.dependsOn.length
        ? kon.dependsOn
        : Array.isArray(m.dependencies?.kons)
          ? m.dependencies.kons
          : [],
    };
  } catch {
    return kon; // the broken manifest is already reported when deriving
  }
}

export const KON_REGISTRY: KonDef[] = (() => {
  // Curated cards of kons that are NOT installed do not enter: the panel
  // would offer to turn on something that does not exist. The core ones (media, datasets,
  // blocks) are always there.
  const installed = new Set(listInstalledKons().map((k) => k.id));
  // (Those that are not kons —`ai-memories`, a legacy API module— stay.)
  const curated = CURATED_KONS.filter(
    (k) => !k.key.startsWith("kon-") || installed.has(konIdOf(k.key))
  );
  const keys = new Set(CURATED_KONS.map((k) => k.key));
  return [...curated.map(completeFromManifest), ...deriveKonsFromDisk(keys)];
})();

export const KON_KEYS = KON_REGISTRY.map((g) => g.key);

// ═══════════════════════════════════════════════════════════════
// Helpers (Legacy aliases maintained for backward compatibility)
// ═══════════════════════════════════════════════════════════════

export function getCoreKons(): KonDef[] {
  return KON_REGISTRY.filter((g) => g.category === "core");
}

export function getCoreDenKons(): KonDef[] {
  return KON_REGISTRY.filter((g) => g.category === "core-den");
}

export function getOptionalKons(): KonDef[] {
  return KON_REGISTRY.filter((g) => g.category === "optional");
}

export function getGrimoireKons(grimoireId?: string): KonDef[] {
  if (grimoireId) {
    return KON_REGISTRY.filter((g) => g.category === "grimoire" && g.grimoireId === grimoireId);
  }
  return KON_REGISTRY.filter((g) => g.category === "grimoire");
}

export function getKonsByGrimoire(grimoireId: string): KonDef[] {
  return KON_REGISTRY.filter((g) => g.grimoireId === grimoireId);
}

// ═══════════════════════════════════════════════════════════════
// Legacy aliases for backward compatibility
// ═══════════════════════════════════════════════════════════════

/** @deprecated Use KonDef instead */
export type CoreModuleDef = KonDef;

/** @deprecated Use KON_REGISTRY instead */
export const CORE_MODULES = KON_REGISTRY;

/** @deprecated Use KON_KEYS instead */
export const CORE_MODULE_KEYS = KON_KEYS;

/** @deprecated Use getCoreKons instead */
export const getCoreModules = getCoreKons;

/** @deprecated Use getOptionalKons instead */
export const getOptionalModules = getOptionalKons;

/** @deprecated Use getGrimoireKons instead */
export const getThemeModules = getGrimoireKons;

/** @deprecated Use getKonsByGrimoire instead */
export const getModulesByTheme = getKonsByGrimoire;

// ═══════════════════════════════════════════════════════════════
// Dependency Checking
// ═══════════════════════════════════════════════════════════════

export interface DisableCheckResult {
  canDisable: boolean;
  blockers: Array<{
    kon: string;
    konName: string;
    table: string;
    column: string;
    label: string;
    rowCount: number;
  }>;
  warnings: string[];
}

/** Query row from database execution */

interface QueryRow extends Record<string, unknown> {}

export async function checkCanDisable(
  konKey: string,
  enabledKonKeys: Set<string>
): Promise<DisableCheckResult> {
  const konDef = KON_REGISTRY.find((g) => g.key === konKey);
  if (!konDef) {
    return { canDisable: true, blockers: [], warnings: [] };
  }

  const blockers: DisableCheckResult["blockers"] = [];
  const warnings: string[] = [];

  for (const ref of konDef.referencedBy) {
    if (!enabledKonKeys.has(ref.kon)) continue;

    try {
      const result = await db.execute(
        sql.raw(`SELECT COUNT(*) as cnt FROM "${ref.table}" WHERE "${ref.column}" IS NOT NULL`)
      );
      const row = result.rows?.[0] as QueryRow;
      const count = Number(row?.cnt || 0);

      if (count > 0) {
        const refKonDef = KON_REGISTRY.find((g) => g.key === ref.kon);
        blockers.push({
          kon: ref.kon,
          konName: refKonDef?.name || ref.kon,
          table: ref.table,
          column: ref.column,
          label: ref.label,
          rowCount: count,
        });
      }
    } catch {
      warnings.push(`Could not check ${ref.table}.${ref.column}: table may not exist`);
    }
  }

  for (const otherGrim of KON_REGISTRY) {
    if (otherGrim.key === konKey) continue;
    if (!enabledKonKeys.has(otherGrim.key)) continue;
    if (!otherGrim.dependsOn.includes(konKey)) continue;

    let hasData = false;
    for (const table of otherGrim.tables) {
      try {
        const result = await db.execute(sql.raw(`SELECT COUNT(*) as cnt FROM "${table}" LIMIT 1`));
        const row = result.rows?.[0] as QueryRow;
        if (Number(row?.cnt || 0) > 0) {
          hasData = true;
          break;
        }
      } catch {
        // Ignore errors for individual table checks
      }
    }

    if (hasData) {
      blockers.push({
        kon: otherGrim.key,
        konName: otherGrim.name,
        table: "(dependency)",
        column: "(dependsOn)",
        label: `${otherGrim.name} depends on ${konDef.name} and has existing data`,
        rowCount: -1,
      });
    }
  }

  return {
    canDisable: blockers.length === 0,
    blockers,
    warnings,
  };
}
