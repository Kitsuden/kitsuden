// @ts-nocheck
/**
 * Kitsuden — Central Configuration
 *
 * ── WHAT THIS FILE DECIDES (and what it does not) ──────────────────────────
 *
 * The kons are no longer part of the core: they live in the `kitsuden-kons` repo and are
 * INSTALLED with `kitsuden kon add <name>`, which declares them in
 * `kitsuden.kons.json` (project root). `KITSUDEN_KONS` in the environment adds
 * more (see `src/lib/installed-kons.ts`). This file does NOT walk any
 * folder: what is not installed does not exist for the API.
 *
 * What it does decide is the SEED: which installed kons come enabled by
 * default the first time the `modules` table hears about them
 * (`lib/seed-modules.ts`). After that, the panel is in charge.
 *
 * Seed order for an installed kon:
 *   1. `enabled` of its entry in kitsuden.kons.json (`kitsuden kon add --enable`)
 *   2. the table below (BASE_FEATURE_KONS)
 *   3. `defaultEnabled` of its manifest
 *   4. off
 */

import { listInstalledKons } from "./src/lib/installed-kons";

// ═══════════════════════════════════════════════════════════════
// MANUAL CONFIGURATION (Override)
// ═══════════════════════════════════════════════════════════════

/** Core modules that are always loaded first (if enabled). */
const CORE_KONS = [
  {
    id: "kon-datasets",
    enabled: true,
    core: true,
    priority: 0,
  },
  {
    id: "kon-media",
    enabled: true,
    core: true,
    priority: 1,
  },
];

/**
 * Factory seed by TIER — only for kons that are INSTALLED.
 * ═══════════════════════════════════════════════════════════════
 *
 * The criterion is: does this serve anyone who installs the kon without knowing
 * anything about your use case? NOT "is it what I am building today?".
 *
 * - essential  → on. Serves almost any project.
 * - common     → on. Not universal, but most real businesses want it
 *                (sales, shipping, payments).
 * - specialized → OFF. Specific vertical; enabled on purpose,
 *                never by surprise on first startup.
 *
 * A kon in this list that is not installed is not seeded.
 */
const BASE_FEATURE_KONS = [
  { id: "kon-blocks", enabled: true }, // Content blocks (core) — used by the blog and any composed page.
  // ── essential (ON) ──
  { id: "kon-blog", enabled: true }, // Content + SEO/GEO. Almost every product wants a content layer.
  { id: "kon-members", enabled: true }, // Reader/customer identity without a CMS account. Base for any paywall or audience.
  // ── common (ON) ──
  { id: "kon-newsletter", enabled: true }, // As soon as there is an audience, there are submissions. Composes with members.
  { id: "kon-crm", enabled: true }, // Contacts and sales — a very widespread business need.
  { id: "kon-payments", enabled: true }, // Monetization. Composes with members for paid memberships.
  { id: "kon-analytics", enabled: true }, // Views per subject and day, without cookies: who reads what.
  // ── specialized (OFF) ──
  { id: "kon-booking", enabled: false },
  { id: "kon-academy-lms", enabled: false },
  { id: "kon-agile", enabled: false },
  { id: "kon-conta", enabled: false },
  { id: "kon-dms", enabled: false },
  { id: "kon-directory", enabled: false },
  { id: "kon-vekstudio", enabled: false },
  { id: "kon-ocr-training", enabled: false },
  { id: "kon-games", enabled: false },
  { id: "kon-streamers", enabled: false },
  { id: "kon-esports", enabled: false },
  { id: "kon-broadcast", enabled: false },
  { id: "kon-formulas", enabled: false },
  { id: "kon-character-builder", enabled: false },
  { id: "kon-wiki", enabled: false },
  { id: "kon-maps", enabled: false },
  { id: "kon-cardsim", enabled: false },
  { id: "kon-tierlist", enabled: false },
  { id: "kon-autobattler", enabled: false },
];

// ═══════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════

export interface KonRef {
  id: string;
  enabled: boolean;
  core?: boolean;
  priority?: number;
}

export interface KitsudenConfig {
  core: KonRef[];
  features: KonRef[];
  grimoire?: string[];
  kons?: string[];
  modules?: string[];
}

// ═══════════════════════════════════════════════════════════════
// WHAT IS INSTALLED → CONFIGURATION
// ═══════════════════════════════════════════════════════════════

function buildConfig(): KitsudenConfig {
  const base = new Map(BASE_FEATURE_KONS.map((k) => [k.id, k.enabled]));
  const coreIds = new Set(CORE_KONS.map((k) => k.id));

  const features: KonRef[] = [];
  for (const kon of listInstalledKons()) {
    if (coreIds.has(kon.id)) continue;
    // Declared but not found on disk: not seeded (the loader
    // warns with the command that fixes it).
    if (!kon.path) continue;
    const enabled =
      kon.declaredOne.enabled ??
      base.get(kon.id) ??
      (kon.manifest?.defaultEnabled === true ? true : false);
    features.push({ id: kon.id, enabled });
  }
  // The table's order first (it is the order in which the schemas are merged,
  // and the one there was before), then the rest alphabetically.
  const order = BASE_FEATURE_KONS.map((k) => k.id);
  const position = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  features.sort((a, b) => position(a.id) - position(b.id) || a.id.localeCompare(b.id));

  const allEnabled = [
    ...CORE_KONS.filter((g) => g.enabled).map((g) => g.id),
    ...features.filter((g) => g.enabled).map((g) => g.id),
  ];

  return {
    core: CORE_KONS,
    features,
    grimoire: [],
    // Backward compatibility
    kons: allEnabled,
    modules: allEnabled,
  };
}

// ═══════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════

let cachedConfig: KitsudenConfig | null = null;

export async function getConfig(): Promise<KitsudenConfig> {
  if (!cachedConfig) {
    cachedConfig = buildConfig();
  }
  return cachedConfig;
}

/**
 * The same configuration, synchronous. There is no longer a difference between the two: before,
 * this was a hand-written list and `getConfig()` merged it with whatever
 * was on disk; now both come from what is installed.
 */
export const staticConfig: KitsudenConfig = buildConfig();

const config = staticConfig;

export function isKonEnabled(id: string): boolean {
  const core = config.core.find((g) => g.id === id);
  if (core) return core.enabled;

  const feature = config.features.find((g) => g.id === id);
  if (feature) return feature.enabled;

  return config.grimoire?.includes(id) || false;
}

export function getKonConfig(id: string): KonRef | undefined {
  return config.core.find((g) => g.id === id) || config.features.find((g) => g.id === id);
}

/** The seed table, for whoever wants to show it (CLI, docs). */
export const FACTORY_SEEDS = BASE_FEATURE_KONS;

export default config;
