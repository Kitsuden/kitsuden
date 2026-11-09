/**
 * Kitsuden — Aggregated schema for Drizzle Kit
 * ============================================================================
 *
 * ⚠️ This file is a thin facade. The real aggregate (core + kons) is
 * AUTO-GENERATED in `schema-kons.generated.ts`. It is NOT edited by hand.
 *
 * BEFORE: every kon `export *` had to be added/curated here manually,
 * taking care of collisions between global Postgres enums.
 *
 * NOW: each kon declares a `schema` block in its `kon.json`:
 *   "schema": { "entry": "./x.schema.ts", "strategy": "drizzle" }
 * and the aggregate is regenerated with:
 *   kitsuden sync-schema      (→ apps/api/scripts/sync-kon-schema.ts)
 *
 * Strategies per kon:
 *   - "drizzle": tables managed by drizzle-kit → included in the aggregate.
 *   - "sql":     the kon auto-migrates with its own SQL → EXCLUDED (types only),
 *                avoiding enum collisions.
 *   - "authoritative": the kon's symbols win over schema-core on
 *                collision (e.g. `media`, whose canonical definition lives in
 *                packages/core/media, not in schema-core's legacy one).
 *
 * The generated file already re-exports schema-core, so here it is enough to
 * re-export it.
 */

export * from "./schema-kons.generated";
