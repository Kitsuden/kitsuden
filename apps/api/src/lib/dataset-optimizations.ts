/**
 * Dataset Optimizations — Low-risk JSONB enhancements
 *
 * Provides:
 * 1. Dynamic Zod validators built from a dataset's field schema.
 * 2. Automatic partial expression indexes on data_entries for filterable fields.
 *
 * Keeps the existing JSONB architecture intact while improving query
 * performance and data integrity for datasets.
 */

import { createHash } from "crypto";

import {
  buildFieldValidator,
  extractOptionValues,
  normalizeField,
  normalizeFields,
  validateAgainstFields,
  type NormalizedField,
  messageOf,
} from "@kitsuden/engine";
import { shouldIndexByDefault, shouldSearchByDefault } from "@kitsuden/shared";
import { sql } from "drizzle-orm";

import { db } from "../db";

// The compilation of fields to Zod lives in the engine: validating the shape of a datum
// is framework, not logic of this API. It is re-exported here so as not to break
// consumers that already imported from this module.
export {
  isFieldVisible,
  normalizeFields,
  buildFieldValidator,
  validateAgainstFields,
} from "@kitsuden/engine";
export type { NormalizedField, FieldCondition } from "@kitsuden/engine";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface SyncIndexOptions {
  /** Maximum number of field-level expression indexes to create per dataset. */
  maxFieldIndexes?: number;
  /** Whether to drop field indexes that no longer appear in the schema. */
  dropRemoved?: boolean;
  /** Whether to create a partial GIN index on data for this dataset. */
  enableGinIndex?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Validation (delegated to the engine)
// ═══════════════════════════════════════════════════════════════════════════════

/** Historical alias of `normalizeField`. */
export const normalizeDatasetField = normalizeField;

/** Historical alias of `buildFieldValidator`. */
export const buildDatasetEntryValidator = buildFieldValidator;

/** Historical alias of `validateAgainstFields`. */
export const validateDatasetEntry = validateAgainstFields;

// ═══════════════════════════════════════════════════════════════════════════════
// Schema versioning (lazy)
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEMA_VERSION_RESERVED_KEYS = ["_schemaVersion"];

/**
 * Compute a stable short hash for a dataset schema.
 * Used to tag each entry with the schema version it was created/updated with.
 */
export function getSchemaVersion(fields: unknown[]): string {
  const normalized = normalizeFields(fields)
    .map((f) => ({
      key: f.key,
      type: f.type,
      required: f.required,
      options: f.options ? extractOptionValues(f.options).sort() : undefined,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const payload = JSON.stringify(normalized);
  return createHash("sha256").update(payload).digest("hex").slice(0, 8);
}

/**
 * Inject the schema version into entry data without overwriting an existing one.
 */
export function addSchemaVersionToData(
  fields: unknown[],
  data: Record<string, unknown>
): Record<string, unknown> {
  if (data._schemaVersion !== undefined) return data;
  const version = fields.length > 0 ? getSchemaVersion(fields) : "0";
  return { ...data, _schemaVersion: version };
}

/**
 * Check whether an entry's schema version matches the current dataset schema.
 */
export function isEntrySchemaStale(fields: unknown[], data: Record<string, unknown>): boolean {
  const currentVersion = fields.length > 0 ? getSchemaVersion(fields) : "0";
  return data._schemaVersion !== currentVersion;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Index management
// ═══════════════════════════════════════════════════════════════════════════════

function sanitizeIdentifier(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^[0-9]/, "_$&")
    .toLowerCase()
    .slice(0, 40);
}

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Build SQL WHERE conditions for dataset entry filters.
 * Uses JSONB containment (@>) for exact equality / array values, which can
 * leverage partial GIN indexes. Falls back to ->> for nulls and complex objects.
 */
export function buildDatasetWhereConditions(
  filters: Record<string, unknown>
): ReturnType<typeof sql>[] {
  const conditions: ReturnType<typeof sql>[] = [];

  for (const [key, val] of Object.entries(filters)) {
    // Skip internal reserved keys.
    if (SCHEMA_VERSION_RESERVED_KEYS.includes(key) || key.startsWith("_")) continue;

    if (val === null) {
      conditions.push(sql`data->>${key} IS NULL`);
    } else if (typeof val === "object" && !Array.isArray(val)) {
      // Complex objects (e.g. nested filters) keep the generic ->> fallback.
      conditions.push(sql`data->>${key} = ${JSON.stringify(val)}`);
    } else {
      // Exact equality or array containment → GIN-friendly.
      const filterJson = JSON.stringify({ [key]: val });
      conditions.push(sql`data @> ${filterJson}::jsonb`);
    }
  }

  return conditions;
}

/**
 * Build a SQL condition for full-text search over searchable fields.
 * Uses ILIKE so it can leverage pg_trgm GIN indexes when available.
 */
export function buildDatasetSearchCondition(
  fields: unknown[],
  searchTerm: string
): ReturnType<typeof sql> | null {
  const normalized = normalizeFields(fields);
  const searchableFields = normalized.filter((f) => {
    if (f.searchable === true) return true;
    if (f.searchable === false) return false;
    return shouldSearchByDefault(f.type);
  });

  if (searchableFields.length === 0 || !searchTerm || searchTerm.trim().length === 0) {
    return null;
  }

  const pattern = `%${escapeSqlStringLiteral(searchTerm)}%`;
  const conditions = searchableFields.map((f) => sql`data->>${f.key} ILIKE ${pattern}`);

  if (conditions.length === 1) return conditions[0];

  // OR across all searchable fields
  return conditions.reduce((acc, cond) => sql`${acc} OR ${cond}`);
}

/**
 * Create partial expression indexes on data_entries for a dataset.
 *
 * Strategy:
 * - Up to N field-level btree indexes on data->>'key' for high-value fields.
 * - One partial GIN index on the data column for that dataset (JSONB path ops).
 * - All indexes are partial WHERE data_set_id = '<datasetId>'.
 *
 * This keeps indexes small and targeted instead of indexing all datasets together.
 */
export async function syncDatasetIndexes(
  datasetId: string,
  slug: string,
  fields: unknown[],
  options: SyncIndexOptions = {}
): Promise<void> {
  const { maxFieldIndexes = 5, enableGinIndex = true, dropRemoved = false } = options;

  const normalized = normalizeFields(fields);
  const safeSlug = sanitizeIdentifier(slug);
  const datasetSuffix = datasetId.replace(/-/g, "").slice(0, 8);

  // Choose fields to index: explicit index flag first, then high-value types.
  const explicit = normalized.filter((f) => f.index);
  const implicit = normalized
    .filter((f) => !f.index && shouldIndexByDefault(f.type))
    .sort((a, b) => a.key.localeCompare(b.key));

  const indexableFields =
    explicit.length > 0 ? explicit.slice(0, maxFieldIndexes) : implicit.slice(0, maxFieldIndexes);

  for (const field of indexableFields) {
    const safeKey = sanitizeIdentifier(field.key);
    const indexName = `idx_entries_${safeSlug}_${safeKey}_${datasetSuffix}`;
    const expr = `data->>'${escapeSqlStringLiteral(field.key)}'`;

    const statement = `
      CREATE INDEX IF NOT EXISTS "${indexName}"
      ON data_entries USING btree ((${expr}))
      WHERE data_set_id = '${datasetId}'
    `;

    try {
      await db.execute(sql.raw(statement));
    } catch (err: unknown) {
      // Index creation failures should not break dataset creation.
      // Log and continue so the feature is resilient to permission/lock issues.
      console.warn(`[DatasetOptimizations] Failed to create index ${indexName}:`, messageOf(err));
    }
  }

  // Trigram indexes for searchable text fields (requires pg_trgm extension).
  const searchableFields = normalized.filter(
    (f) => f.searchable || (shouldSearchByDefault(f.type) && f.searchable !== false)
  );

  for (const field of searchableFields) {
    const safeKey = sanitizeIdentifier(field.key);
    const indexName = `idx_entries_${safeSlug}_${safeKey}_trgm_${datasetSuffix}`;
    const expr = `data->>'${escapeSqlStringLiteral(field.key)}'`;

    const statement = `
      CREATE INDEX IF NOT EXISTS "${indexName}"
      ON data_entries USING gin ((${expr}) gin_trgm_ops)
      WHERE data_set_id = '${datasetId}'
    `;

    try {
      await db.execute(sql.raw(statement));
    } catch (err: unknown) {
      console.warn(
        `[DatasetOptimizations] Failed to create trigram index ${indexName} (pg_trgm may be missing):`,
        messageOf(err)
      );
    }
  }

  if (enableGinIndex) {
    const ginIndexName = `idx_entries_${safeSlug}_gin_${datasetSuffix}`;
    const ginStatement = `
      CREATE INDEX IF NOT EXISTS "${ginIndexName}"
      ON data_entries USING gin (data jsonb_path_ops)
      WHERE data_set_id = '${datasetId}'
    `;

    try {
      await db.execute(sql.raw(ginStatement));
    } catch (err: unknown) {
      console.warn(
        `[DatasetOptimizations] Failed to create GIN index ${ginIndexName}:`,
        messageOf(err)
      );
    }
  }

  if (dropRemoved) {
    await dropStaleDatasetIndexes(datasetId, slug, indexableFields, searchableFields);
  }
}

/**
 * Drop indexes for a dataset that no longer correspond to its current schema.
 */
async function dropStaleDatasetIndexes(
  datasetId: string,
  slug: string,
  currentFields: NormalizedField[],
  searchableFields: NormalizedField[] = []
): Promise<void> {
  const safeSlug = sanitizeIdentifier(slug);
  const datasetSuffix = datasetId.replace(/-/g, "").slice(0, 8);
  const expectedNames = new Set(
    currentFields.map(
      (f) => `idx_entries_${safeSlug}_${sanitizeIdentifier(f.key)}_${datasetSuffix}`
    )
  );
  for (const f of searchableFields) {
    expectedNames.add(`idx_entries_${safeSlug}_${sanitizeIdentifier(f.key)}_trgm_${datasetSuffix}`);
  }
  expectedNames.add(`idx_entries_${safeSlug}_gin_${datasetSuffix}`);

  try {
    const rows = (await db.execute(
      sql`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'data_entries'
          AND indexname LIKE ${`idx_entries_${safeSlug}_%_${datasetSuffix}`}
      `
    )) as unknown as Array<{ indexname: string }>;

    for (const row of rows) {
      if (!expectedNames.has(row.indexname)) {
        await db.execute(sql.raw(`DROP INDEX IF EXISTS "${row.indexname}"`));
      }
    }
  } catch (err: unknown) {
    console.warn(`[DatasetOptimizations] Failed to drop stale indexes:`, messageOf(err));
  }
}
