/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DATASETS AUTO-INDEXES - Smart Automatic Indexes
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * System for automatic detection, suggestion and management of PostgreSQL indexes.
 * Optimizes performance based on real query patterns.
 *
 * Features:
 * - Automatic detection of frequently queried fields
 * - Index suggestions based on statistics
 * - Declarative index creation in schema
 * - Query performance analysis
 * - Cleanup of unused indexes
 */

import { schemaFields } from "@kitsuden/shared";
import type { KonContext } from "@kitsuden/shared";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES AND SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

export type IndexType = "btree" | "gin" | "gist" | "hash" | "brin";

export interface IndexDefinition {
  /** Index name (auto-generated if not provided) */
  name?: string;
  /** Index type */
  type: IndexType;
  /** Field(s) to index */
  fields: string[];
  /** WHERE condition for a partial index */
  where?: string;
  /** Unique */
  unique?: boolean;
  /** Descending order */
  desc?: boolean;
}

export interface IndexConfig {
  /** Manually defined indexes */
  indexes: IndexDefinition[];
  /** Enable auto-detection */
  autoDetect?: boolean;
  /** Query threshold for suggesting an index */
  threshold?: number;
  /** Fields to exclude from auto-indexing */
  excludeFields?: string[];
}

export interface IndexSuggestion {
  id: string;
  table: string;
  field: string;
  type: IndexType;
  confidence: "high" | "medium" | "low";
  reason: string;
  estimatedQueries: number;
  estimatedImprovement: string;
  sql: string;
  createdAt: string;
  applied?: boolean;
  appliedAt?: string;
}

export interface IndexStats {
  name: string;
  table: string;
  fields: string[];
  type: IndexType;
  size: string;
  scans: number;
  rowsRead: number;
  lastUsed: string | null;
  isUsed: boolean;
}

export interface QueryStats {
  field: string;
  table: string;
  totalQueries: number;
  filterQueries: number;
  sortQueries: number;
  joinQueries: number;
  avgScanTime: number;
  lastQueryAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS ZOD
// ═══════════════════════════════════════════════════════════════════════════════

export const indexDefinitionSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["btree", "gin", "gist", "hash", "brin"]).default("btree"),
  fields: z.array(z.string()).min(1),
  where: z.string().optional(),
  unique: z.boolean().default(false),
  desc: z.boolean().default(false),
});

export const indexConfigSchema = z.object({
  indexes: z.array(indexDefinitionSchema).default([]),
  autoDetect: z.boolean().default(true),
  threshold: z.number().int().min(1).default(50),
  excludeFields: z.array(z.string()).default(["id", "created_at", "updated_at"]),
});

// ═══════════════════════════════════════════════════════════════════════════════
// INDEX MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

import { messageOf } from "@kitsuden/engine";

/**
 * Analyzes a dataset's schema and suggests optimal indexes
 */
export function suggestIndexesForDataset(datasetSlug: string, schema: unknown): IndexSuggestion[] {
  const suggestions: IndexSuggestion[] = [];

  for (const field of schemaFields(schema) as any[]) {
    const suggestion = analyzeFieldForIndex(datasetSlug, field);
    if (suggestion) {
      suggestions.push(suggestion);
    }
  }

  return suggestions;
}

/**
 * ── INJECTION-FREE INDEX SQL ───────────────────────────────────────────────
 *
 * This whole file builds DDL with text and runs it with `sql.raw` (a
 * `CREATE INDEX` accepts no parameters). A field key is written by an
 * EDITOR when defining the schema, and an admin applies the indexes afterwards: a
 * key like `x')); DROP TABLE …; --` was editor SQL run with the app
 * role. Now:
 *   · a field key has to be a simple identifier
 *     (`FIELD_KEY`); otherwise, that field is not indexed;
 *   · the index name is built with `identifier()` (only
 *     `[a-z0-9_]`, ≤ 63), or rejected if given and not valid;
 *   · `where` (free SQL for partial indexes) is no longer accepted: a partial
 *     index goes in a migration.
 */
const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;
const INDEX_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Text → unquoted SQL identifier: lowercase, `[a-z0-9_]`, ≤ 63. */
function identifier(text: string): string {
  const clean = text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 63);
  return /^[a-z_]/.test(clean) ? clean : `i_${clean}`.slice(0, 63);
}

function requireFieldKey(key: unknown): string {
  if (typeof key !== "string" || !FIELD_KEY.test(key)) {
    throw new Error(`Invalid field key for an index: ${JSON.stringify(key)}`);
  }
  return key;
}

function analyzeFieldForIndex(slug: string, field: any): IndexSuggestion | null {
  const fieldName = field.key || field.name;
  // A key that is not a simple identifier is not indexed (see above)
  if (typeof fieldName !== "string" || !FIELD_KEY.test(fieldName)) return null;
  const table = identifier(slug);

  // Suggestion rules based on field type
  switch (field.type) {
    case "relation":
    case "select":
      // Relation and select fields are frequently filtered
      return {
        id: identifier(`idx_${table}_${fieldName}_btree`),
        table: slug,
        field: fieldName,
        type: "btree",
        confidence: "high",
        reason: `Foreign key / Select field frequently filtered in queries`,
        estimatedQueries: 100,
        estimatedImprovement: "60-80%",
        sql: `CREATE INDEX ${identifier(`idx_${table}_${fieldName}_btree`)} ON data_entries ((data->>'${fieldName}'));`,
        createdAt: new Date().toISOString(),
      };

    case "text":
      if (field.validation?.pattern || field.unique) {
        // Fields with pattern or unique are good candidates
        return {
          id: identifier(`idx_${table}_${fieldName}_gin`),
          table: slug,
          field: fieldName,
          type: "gin",
          confidence: "medium",
          reason: `Text field with validation pattern, suitable for GIN index`,
          estimatedQueries: 50,
          estimatedImprovement: "40-60%",
          sql: `CREATE INDEX ${identifier(`idx_${table}_${fieldName}_gin`)} ON data_entries USING gin ((data->>'${fieldName}') gin_trgm_ops);`,
          createdAt: new Date().toISOString(),
        };
      }
      break;

    case "number":
      // Numbers are frequently used in ranges and sorting
      return {
        id: identifier(`idx_${table}_${fieldName}_btree`),
        table: slug,
        field: fieldName,
        type: "btree",
        confidence: "medium",
        reason: `Numeric field often used for range queries and sorting`,
        estimatedQueries: 75,
        estimatedImprovement: "50-70%",
        sql: `CREATE INDEX ${identifier(`idx_${table}_${fieldName}_btree`)} ON data_entries (((data->>'${fieldName}')::numeric));`,
        createdAt: new Date().toISOString(),
      };

    case "date":
    case "datetime":
      // Dates are almost always filtered and sorted
      return {
        id: identifier(`idx_${table}_${fieldName}_btree`),
        table: slug,
        field: fieldName,
        type: "btree",
        confidence: "high",
        reason: `Date field frequently used for range queries`,
        estimatedQueries: 150,
        estimatedImprovement: "70-90%",
        sql: `CREATE INDEX ${identifier(`idx_${table}_${fieldName}_btree`)} ON data_entries (((data->>'${fieldName}')::timestamp));`,
        createdAt: new Date().toISOString(),
      };

    case "multiselect":
    case "tags":
      // Arrays are perfect for GIN
      return {
        id: identifier(`idx_${table}_${fieldName}_gin`),
        table: slug,
        field: fieldName,
        type: "gin",
        confidence: "high",
        reason: `Array/Tags field, GIN index optimal for containment queries`,
        estimatedQueries: 80,
        estimatedImprovement: "80-95%",
        sql: `CREATE INDEX ${identifier(`idx_${table}_${fieldName}_gin`)} ON data_entries USING gin ((data->'${fieldName}'));`,
        createdAt: new Date().toISOString(),
      };
  }

  return null;
}

/**
 * Gets current index statistics
 */
export async function getIndexStats(ctx: KonContext): Promise<IndexStats[]> {
  const { db } = ctx;

  // `pg_indexes` has no `indexrelname` (it is called `indexname`) and `schemaname`
  // is in both views: the earlier `JOIN … USING (indexrelname)` failed
  // ALWAYS, and `/indexes/stats` and `/indexes/report` answered 500 (found by
  // Schemathesis). `idx_scan` and `idx_tup_read` come from the same
  // view: pg_stat_statements is not needed.
  const result = await db.instance.execute(sql`
    SELECT
      i.schemaname,
      i.tablename,
      i.indexname,
      i.indexdef,
      pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
      s.idx_scan,
      s.idx_tup_read
    FROM pg_indexes i
    JOIN pg_stat_user_indexes s
      ON s.schemaname = i.schemaname AND s.indexrelname = i.indexname
    WHERE i.schemaname = 'public'
    AND i.tablename IN ('data_entries', 'data_sets')
    ORDER BY pg_relation_size(s.indexrelid) DESC;
  `);

  return result.rows.map((row: any) => ({
    name: row.indexname,
    table: row.tablename,
    fields: extractFieldsFromIndexDef(row.indexdef),
    type: extractTypeFromIndexDef(row.indexdef),
    size: row.size,
    scans: Number(row.idx_scan ?? 0),
    rowsRead: Number(row.idx_tup_read ?? 0),
    lastUsed: null,
    isUsed: Number(row.idx_scan ?? 0) > 0,
  }));
}

/**
 * Creates an index in the database
 */
export async function createIndex(ctx: KonContext, suggestion: IndexSuggestion): Promise<boolean> {
  try {
    await ctx.db.instance.execute(sql.raw(suggestion.sql));
    ctx.logger.info(`📈 Created index: ${suggestion.id}`);
    return true;
  } catch (error) {
    ctx.logger.error(`Failed to create index ${suggestion.id}:`, error as any);
    return false;
  }
}

/**
 * Drops an index
 */
export async function dropIndex(ctx: KonContext, indexName: string): Promise<boolean> {
  try {
    await ctx.db.instance.execute(sql`DROP INDEX IF EXISTS ${sql.identifier(indexName)}`);
    ctx.logger.info(`🗑️ Dropped index: ${indexName}`);
    return true;
  } catch (error) {
    ctx.logger.error(`Failed to drop index ${indexName}:`, error as any);
    return false;
  }
}

/**
 * Applies suggested indexes automatically
 */
export async function applyAutoIndexes(
  ctx: KonContext,
  suggestions: IndexSuggestion[],
  minConfidence: "high" | "medium" = "high"
): Promise<{ created: string[]; failed: string[] }> {
  const result = { created: [] as string[], failed: [] as string[] };

  const confidenceLevels = { high: 2, medium: 1, low: 0 };
  const minLevel = confidenceLevels[minConfidence];

  for (const suggestion of suggestions) {
    if (confidenceLevels[suggestion.confidence] >= minLevel) {
      const success = await createIndex(ctx, suggestion);
      if (success) {
        result.created.push(suggestion.id);
      } else {
        result.failed.push(suggestion.id);
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyzes query performance on a dataset
 */
export async function analyzeQueryPerformance(
  ctx: KonContext,
  datasetId: string
): Promise<QueryStats[]> {
  const { db } = ctx;

  // Get the dataset's fields
  const { dataSets } = await import("./datasets.schema");

  const [dataset] = await db.instance
    .select()
    .from(dataSets)
    .where(eq(dataSets.id, datasetId))
    .limit(1);

  if (!dataset) {
    throw new Error(`Dataset not found: ${datasetId}`);
  }

  const stats: QueryStats[] = [];

  for (const field of schemaFields(dataset.schema) as any[]) {
    const fieldName = field.key || field.name;

    // Simulate analysis (in production this would read from pg_stat_statements)
    const fieldStats: QueryStats = {
      field: fieldName,
      table: dataset.slug,
      totalQueries: Math.floor(Math.random() * 1000), // Mock
      filterQueries: Math.floor(Math.random() * 500),
      sortQueries: Math.floor(Math.random() * 200),
      joinQueries: Math.floor(Math.random() * 100),
      avgScanTime: Math.random() * 100,
      lastQueryAt: new Date().toISOString(),
    };

    stats.push(fieldStats);
  }

  return stats.sort((a, b) => b.totalQueries - a.totalQueries);
}

/**
 * Generates a report of recommended indexes
 */
export async function generateIndexReport(ctx: KonContext): Promise<{
  existing: IndexStats[];
  suggested: IndexSuggestion[];
  unused: string[];
  recommendations: string[];
}> {
  const existing = await getIndexStats(ctx);
  const suggested: IndexSuggestion[] = [];

  // Analyze all datasets
  const { dataSets } = await import("./datasets.schema");
  const datasets = await ctx.db.instance.select().from(dataSets);

  for (const dataset of datasets) {
    if (schemaFields(dataset.schema).length > 0) {
      const dsSuggestions = suggestIndexesForDataset(dataset.slug, dataset.schema);
      suggested.push(...dsSuggestions);
    }
  }

  // Filter out suggestions that already exist
  const existingNames = new Set(existing.map((e) => e.name));
  const newSuggestions = suggested.filter((s) => !existingNames.has(s.id));

  // Indexes with no use at all according to pg_stat_user_indexes (the counter is reset
  // to zero when Postgres restarts: "unused" means "unused since startup").
  // Postgres primary keys end in `_pkey`.
  const unused = existing
    .filter((e) => e.scans === 0 && !e.name.includes("primary") && !e.name.endsWith("_pkey"))
    .map((e) => e.name);

  const recommendations: string[] = [];

  if (newSuggestions.length > 0) {
    recommendations.push(
      `Create ${newSuggestions.length} suggested indexes for better performance`
    );
  }

  if (unused.length > 0) {
    recommendations.push(`Consider removing ${unused.length} unused indexes to save space`);
  }

  return {
    existing,
    suggested: newSuggestions,
    unused,
    recommendations,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DECLARATIVE INDEX MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Applies declarative index configuration to a dataset
 */
export async function applyIndexConfig(
  ctx: KonContext,
  datasetId: string,
  config: IndexConfig
): Promise<{ created: string[]; removed: string[]; errors: string[] }> {
  const result = { created: [] as string[], removed: [] as string[], errors: [] as string[] };

  // Get dataset
  const { db } = ctx;
  const { dataSets } = await import("./datasets.schema");

  const [dataset] = await db.instance
    .select()
    .from(dataSets)
    .where(eq(dataSets.id, datasetId))
    .limit(1);

  if (!dataset) {
    throw new Error(`Dataset not found: ${datasetId}`);
  }

  // Create defined indexes
  for (const index of config.indexes) {
    try {
      if (index.name !== undefined && !INDEX_NAME.test(index.name)) {
        throw new Error(`Invalid index name: ${JSON.stringify(index.name)}`);
      }
      const indexName = index.name || generateIndexName(dataset.slug, index);
      const indexSql = buildIndexSQL("data_entries", indexName, index);

      await db.instance.execute(sql.raw(indexSql));
      result.created.push(indexName);
    } catch (error: unknown) {
      result.errors.push(`Failed to create index: ${messageOf(error)}`);
    }
  }

  return result;
}

function generateIndexName(table: string, index: IndexDefinition): string {
  const fields = index.fields.join("_");
  return identifier(`idx_${table}_${fields}_${index.type}`);
}

function buildIndexSQL(table: string, name: string, index: IndexDefinition): string {
  const unique = index.unique ? "UNIQUE" : "";
  const fields = index.fields
    .map((f) => {
      // For JSONB, access the field inside data
      const jsonPath = `(data->>'${requireFieldKey(f)}')`;
      return index.type === "btree" && index.desc ? `${jsonPath} DESC` : jsonPath;
    })
    .join(", ");

  if (!INDEX_NAME.test(name)) throw new Error(`Invalid index name: ${JSON.stringify(name)}`);
  let sql = `CREATE ${unique} INDEX ${name} ON ${table} `;

  if (index.type === "gin") {
    sql += `USING gin (${fields})`;
  } else if (index.type === "gist") {
    sql += `USING gist (${fields})`;
  } else if (index.type === "hash") {
    sql += `USING hash (${fields})`;
  } else {
    sql += `(${fields})`;
  }

  if (index.where) {
    // Free SQL: no longer (see "INJECTION-FREE INDEX SQL")
    throw new Error("Partial indexes (`where`) are not accepted here; add them in a migration");
  }

  return sql;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function extractFieldsFromIndexDef(indexDef: string): string[] {
  // Extract fields from the index definition
  const match = indexDef.match(/\((.*?)\)/);
  if (match) {
    return match[1].split(",").map((f) => f.trim());
  }
  return [];
}

function extractTypeFromIndexDef(indexDef: string): IndexType {
  if (indexDef.includes("USING gin")) return "gin";
  if (indexDef.includes("USING gist")) return "gist";
  if (indexDef.includes("USING hash")) return "hash";
  if (indexDef.includes("USING brin")) return "brin";
  return "btree";
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAMING OPTIMIZATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Recommended indexes for gaming datasets (builds, items, etc.)
 */
export const GAMING_RECOMMENDED_INDEXES: IndexDefinition[] = [
  // Indexes for builds
  { type: "btree", fields: ["character_class"], name: "idx_builds_class" },
  { type: "btree", fields: ["level"], name: "idx_builds_level" },
  { type: "btree", fields: ["created_at"], desc: true, name: "idx_builds_created" },
  { type: "gin", fields: ["tags"], name: "idx_builds_tags" },
  { type: "btree", fields: ["author_id", "created_at"], name: "idx_builds_author_created" },

  // Indexes for items
  { type: "btree", fields: ["rarity"], name: "idx_items_rarity" },
  { type: "btree", fields: ["item_type"], name: "idx_items_type" },
  { type: "btree", fields: ["base_dps"], desc: true, name: "idx_items_dps" },
  { type: "gin", fields: ["mods"], name: "idx_items_mods" },

  // Indexes for text search
  { type: "gin", fields: ["name"], name: "idx_search_name" },
];

/**
 * Index configuration for a specific game
 */
export function getGameIndexConfig(gameType: "poe" | "diablo" | "wow" | "genshin"): IndexConfig {
  const base = {
    indexes: [...GAMING_RECOMMENDED_INDEXES],
    autoDetect: true,
    threshold: 50,
  };

  switch (gameType) {
    case "poe":
      return {
        ...base,
        indexes: [
          ...base.indexes,
          { type: "btree", fields: ["league"], name: "idx_poe_league" },
          { type: "btree", fields: ["ascendancy"], name: "idx_poe_ascendancy" },
          { type: "gin", fields: ["skill_gems"], name: "idx_poe_skills" },
          { type: "btree", fields: ["total_dps"], desc: true, name: "idx_poe_dps" },
        ],
      };

    case "diablo":
      return {
        ...base,
        indexes: [
          ...base.indexes,
          { type: "btree", fields: ["paragon_level"], name: "idx_d4_paragon" },
          { type: "gin", fields: ["paragon_board"], name: "idx_d4_board" },
          { type: "btree", fields: ["tier"], name: "idx_d4_tier" },
        ],
      };

    case "genshin":
      return {
        ...base,
        indexes: [
          ...base.indexes,
          { type: "btree", fields: ["element"], name: "idx_gi_element" },
          { type: "btree", fields: ["constellation"], name: "idx_gi_constellation" },
          { type: "btree", fields: ["artifact_rating"], desc: true, name: "idx_gi_rating" },
        ],
      };

    default:
      return base;
  }
}
