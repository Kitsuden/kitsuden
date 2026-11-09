/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DATASETS IMPORT/EXPORT - Data Import and Export
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Complete system for importing and exporting dataset data.
 * Supports multiple formats and import strategies.
 *
 * Features:
 * - Full export of datasets with schema and entries
 * - Import with strategies: upsert, replace, merge
 * - Validation of imported data
 * - Field mapping
 * - Progress of long imports
 * - Full backup/restore
 */

import { schemaFields, testPattern, type KonContext } from "@kitsuden/shared";
import { z } from "zod";

import type { DataEntry, FieldDefinition } from "./datasets.schema";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES AND SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

export type ImportStrategy = "upsert" | "replace" | "merge" | "insert";
export type ExportFormat = "json" | "csv" | "jsonl";

export interface ImportConfig {
  /** Import strategy */
  strategy: ImportStrategy;
  /** Field mapping { sourceField: targetField } */
  mapping?: Record<string, string>;
  /** Field used as ID for upsert/merge */
  idField?: string;
  /** Validate data before importing */
  validate?: boolean;
  /** Skip invalid records instead of failing */
  skipInvalid?: boolean;
  /** Transform data before inserting */
  transform?: (record: any) => any;
}

export interface ImportResult {
  success: boolean;
  stats: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  errors: ImportError[];
  durationMs: number;
}

export interface ImportError {
  index: number;
  record: any;
  error: string;
  field?: string;
}

export interface ExportConfig {
  /** Datasets to export */
  datasets: string[];
  /** Include schema */
  includeSchema?: boolean;
  /** Include calculated fields */
  includeCalculatedFields?: boolean;
  /** Include metadata */
  includeMetadata?: boolean;
  /** Export format */
  format?: ExportFormat;
  /** Filter entries */
  filter?: {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  };
}

export interface ExportPackage {
  metadata: {
    version: string;
    exportedAt: string;
    exportedBy: string;
    totalDatasets: number;
    totalEntries: number;
  };
  datasets: ExportedDataset[];
}

export interface ExportedDataset {
  id?: string;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  schema?: {
    fields: FieldDefinition[];
  };
  calculatedFields?: any[];
  entries: ExportedEntry[];
  stats: {
    totalEntries: number;
    exportedAt: string;
  };
}

export interface ExportedEntry {
  id?: string;
  title: string;
  data: Record<string, unknown>;
  status?: string;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
  createdById?: string;
  // Snapshot field if present
  _snapshot?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ZOD SCHEMAS FOR VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

export const importConfigSchema = z.object({
  strategy: z.enum(["upsert", "replace", "merge", "insert"]).default("upsert"),
  mapping: z.record(z.string(), z.string()).optional(),
  idField: z.string().optional(),
  validate: z.boolean().default(true),
  skipInvalid: z.boolean().default(false),
});

export const exportConfigSchema = z.object({
  datasets: z.array(z.string()).min(1),
  includeSchema: z.boolean().default(true),
  includeCalculatedFields: z.boolean().default(false),
  includeMetadata: z.boolean().default(true),
  format: z.enum(["json", "csv", "jsonl"]).default("json"),
  filter: z
    .object({
      status: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    })
    .optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exports complete datasets with schema and entries
 */
export async function exportDatasets(
  ctx: KonContext,
  config: ExportConfig,
  /** Who asked for the export (a user id); `system` for exports with no caller. */
  exportedBy = "system"
): Promise<ExportPackage> {
  const startTime = Date.now();
  const { db } = ctx;
  const { dataSets, dataEntries } = await import("./datasets.schema");
  const { dataSetCalculatedFields } = await import("./datasets.calculated.schema");

  const exportPackage: ExportPackage = {
    metadata: {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      exportedBy,
      totalDatasets: 0,
      totalEntries: 0,
    },
    datasets: [],
  };

  let totalEntries = 0;

  for (const datasetSlug of config.datasets) {
    // Get dataset
    const [dataset] = await db.instance
      .select()
      .from(dataSets)
      .where(eq(dataSets.slug, datasetSlug))
      .limit(1);

    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetSlug}`);
    }

    // The dataset filter and the optional ones go TOGETHER in a single `.where()`.
    //
    // Before, `dataSetId` was in the base query and each optional filter
    // called `.where()` again. In Drizzle that does not add: it REPLACES. So
    // as soon as an export ran with any filter (a status, a date
    // range) the dataset condition disappeared and the file came out with
    // entries from ALL the datasets in the installation. An export is
    // exactly what someone takes out of the system.
    const conditions = [eq(dataEntries.dataSetId, dataset.id)];
    if (config.filter?.status) {
      conditions.push(eq(dataEntries.status, config.filter.status));
    }
    if (config.filter?.dateFrom) {
      conditions.push(gte(dataEntries.createdAt, new Date(config.filter.dateFrom)));
    }
    if (config.filter?.dateTo) {
      conditions.push(lte(dataEntries.createdAt, new Date(config.filter.dateTo)));
    }

    const entries = await db.instance
      .select()
      .from(dataEntries)
      .where(and(...conditions))
      .orderBy(asc(dataEntries.sortOrder));

    // Get calculated fields if requested
    let calculatedFields: any[] = [];
    if (config.includeCalculatedFields) {
      calculatedFields = await db.instance
        .select()
        .from(dataSetCalculatedFields)
        .where(eq(dataSetCalculatedFields.dataSetId, dataset.id));
    }

    const exportedDataset: ExportedDataset = {
      id: dataset.id,
      name: dataset.name,
      slug: dataset.slug,
      description: dataset.description || undefined,
      icon: dataset.icon || undefined,
      schema: config.includeSchema ? dataset.schema : undefined,
      calculatedFields: config.includeCalculatedFields ? calculatedFields : undefined,
      entries: entries.map((e: DataEntry) => ({
        id: e.id,
        title: e.title,
        data: e.data,
        status: e.status,
        sortOrder: e.sortOrder,
        createdAt: e.createdAt?.toISOString(),
        updatedAt: e.updatedAt?.toISOString(),
        createdById: e.createdById || undefined,
      })),
      stats: {
        totalEntries: entries.length,
        exportedAt: new Date().toISOString(),
      },
    };

    exportPackage.datasets.push(exportedDataset);
    totalEntries += entries.length;
  }

  exportPackage.metadata.totalDatasets = exportPackage.datasets.length;
  exportPackage.metadata.totalEntries = totalEntries;

  ctx.logger.info(
    `📤 Exported ${totalEntries} entries from ${exportPackage.datasets.length} datasets in ${Date.now() - startTime}ms`
  );

  return exportPackage;
}

/**
 * Converts export to CSV format
 */
export function exportToCSV(dataset: ExportedDataset): string {
  if (dataset.entries.length === 0) return "";

  // Get all possible columns of data
  const allKeys = new Set<string>();
  dataset.entries.forEach((e) => {
    Object.keys(e.data).forEach((k) => allKeys.add(k));
  });
  const columns = ["id", "title", "status", ...Array.from(allKeys), "createdAt"];

  // Header
  let csv = columns.join(",") + "\n";

  // Rows
  for (const entry of dataset.entries) {
    const row = columns.map((col) => {
      let value: any;
      if (col === "id" || col === "title" || col === "status" || col === "createdAt") {
        value = (entry as any)[col];
      } else {
        value = entry.data[col];
      }

      // Escape values
      if (value === null || value === undefined) return "";
      if (typeof value === "object") return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
      if (typeof value === "string" && (value.includes(",") || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return String(value);
    });
    csv += row.join(",") + "\n";
  }

  return csv;
}

/**
 * Converts export to JSONL format
 */
export function exportToJSONL(dataset: ExportedDataset): string {
  return dataset.entries.map((e) => JSON.stringify(e)).join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

import { eq, and, asc, gte, lte } from "drizzle-orm";
import { messageOf } from "@kitsuden/engine";

/**
 * Imports data into a dataset
 */
export async function importToDataset(
  ctx: KonContext,
  datasetId: string,
  data: any[],
  config: ImportConfig
): Promise<ImportResult> {
  const startTime = Date.now();
  const { db } = ctx;
  const { dataSets, dataEntries } = await import("./datasets.schema");

  const result: ImportResult = {
    success: true,
    stats: {
      total: data.length,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    },
    errors: [],
    durationMs: 0,
  };

  // Check that the dataset exists
  const [dataset] = await db.instance
    .select()
    .from(dataSets)
    .where(eq(dataSets.id, datasetId))
    .limit(1);

  if (!dataset) {
    throw new Error(`Dataset not found: ${datasetId}`);
  }

  // Get schema for validation
  // List or `{fields}`: with a list, `schema.fields.map` blew up the import
  const fields = schemaFields(dataset.schema) as unknown as FieldDefinition[];
  const fieldMap = new Map(
    fields.map((f) => [(f.key ?? (f as { fieldName?: string }).fieldName) as string, f])
  );

  // Prepare operations
  const operations: any[] = [];

  for (let i = 0; i < data.length; i++) {
    const record = data[i];

    try {
      // Apply field mapping
      const mappedRecord = config.mapping ? applyMapping(record, config.mapping) : record;

      // Transform if there is a function
      const transformedRecord = config.transform ? config.transform(mappedRecord) : mappedRecord;

      // Validate if requested
      if (config.validate) {
        const validationErrors = validateRecord(transformedRecord, fieldMap);
        if (validationErrors.length > 0) {
          if (config.skipInvalid) {
            result.stats.skipped++;
            result.errors.push({
              index: i,
              record: transformedRecord,
              error: validationErrors.join("; "),
            });
            continue;
          } else {
            throw new Error(`Validation failed: ${validationErrors.join("; ")}`);
          }
        }
      }

      // Build entry
      const entry: Partial<DataEntry> = {
        dataSetId: datasetId,
        title: transformedRecord.title || transformedRecord.name || "Untitled",
        data: transformedRecord,
        status: transformedRecord.status || "published",
        sortOrder: transformedRecord.sortOrder || 0,
      };

      // Determine operation according to strategy
      const existingId = config.idField ? transformedRecord[config.idField] : null;

      if (config.strategy === "upsert" && existingId) {
        // Try update, if it does not exist create
        const [existing] = await db.instance
          .select({ id: dataEntries.id })
          .from(dataEntries)
          .where(eq(dataEntries.id, existingId))
          .limit(1);

        if (existing) {
          await db.instance
            .update(dataEntries)
            .set({
              ...entry,
              updatedAt: new Date(),
            })
            .where(eq(dataEntries.id, existingId));
          result.stats.updated++;
        } else {
          operations.push({ type: "create", entry: { ...entry, id: existingId } });
        }
      } else if (config.strategy === "replace" && existingId) {
        // Update only
        await db.instance
          .update(dataEntries)
          .set({
            ...entry,
            updatedAt: new Date(),
          })
          .where(eq(dataEntries.id, existingId));
        result.stats.updated++;
      } else if (config.strategy === "merge" && existingId) {
        // Merge existing data with new
        const [existing] = await db.instance
          .select()
          .from(dataEntries)
          .where(eq(dataEntries.id, existingId))
          .limit(1);

        if (existing) {
          const mergedData = { ...(existing.data as any), ...(entry.data as any) };
          await db.instance
            .update(dataEntries)
            .set({
              ...entry,
              data: mergedData,
              updatedAt: new Date(),
            })
            .where(eq(dataEntries.id, existingId));
          result.stats.updated++;
        } else {
          operations.push({ type: "create", entry: { ...entry, id: existingId } });
        }
      } else {
        // Insert
        operations.push({ type: "create", entry });
      }
    } catch (error: unknown) {
      result.stats.failed++;
      result.errors.push({
        index: i,
        record,
        error: messageOf(error),
      });

      if (!config.skipInvalid) {
        result.success = false;
        result.durationMs = Date.now() - startTime;
        return result;
      }
    }
  }

  // Run creations in batch
  if (operations.length > 0) {
    const entriesToCreate = operations.filter((op) => op.type === "create").map((op) => op.entry);

    if (entriesToCreate.length > 0) {
      // Insert in batches of 100
      const batchSize = 100;
      for (let i = 0; i < entriesToCreate.length; i += batchSize) {
        const batch = entriesToCreate.slice(i, i + batchSize);
        await db.instance.insert(dataEntries).values(batch);
        result.stats.created += batch.length;
      }
    }
  }

  result.durationMs = Date.now() - startTime;

  ctx.logger.info(
    `📥 Imported ${result.stats.created} created, ${result.stats.updated} updated, ${result.stats.skipped} skipped, ${result.stats.failed} failed in ${result.durationMs}ms`
  );

  return result;
}

/**
 * Imports a complete package (multiple datasets)
 */
export async function importPackage(
  ctx: KonContext,
  packageData: ExportPackage,
  config: Omit<ImportConfig, "mapping">
): Promise<Record<string, ImportResult>> {
  const { db } = ctx;
  const { dataSets } = await import("./datasets.schema");
  const results: Record<string, ImportResult> = {};

  for (const dataset of packageData.datasets) {
    // Check whether the dataset exists, if not create it
    const [existingDataset] = await db.instance
      .select({ id: dataSets.id })
      .from(dataSets)
      .where(eq(dataSets.slug, dataset.slug))
      .limit(1);

    let datasetId: string;

    if (!existingDataset) {
      // Create dataset
      const [newDataset] = await db.instance
        .insert(dataSets)
        .values({
          name: dataset.name,
          slug: dataset.slug,
          description: dataset.description,
          icon: dataset.icon,
          schema: dataset.schema || { fields: [] },
        })
        .returning();
      datasetId = newDataset.id;
      ctx.logger.info(`📊 Created dataset: ${dataset.name} (${dataset.slug})`);
    } else {
      datasetId = existingDataset.id;
    }

    // Import entries
    const entries = dataset.entries.map((e) => ({
      ...e.data,
      title: e.title,
      status: e.status,
      sortOrder: e.sortOrder,
      id: e.id,
    }));

    results[dataset.slug] = await importToDataset(ctx, datasetId, entries, {
      ...config,
      idField: "id",
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function applyMapping(record: any, mapping: Record<string, string>): any {
  const mapped: any = {};
  for (const [sourceKey, targetKey] of Object.entries(mapping)) {
    if (record[sourceKey] !== undefined) {
      mapped[targetKey] = record[sourceKey];
    }
  }
  // Include unmapped fields
  for (const key of Object.keys(record)) {
    if (!mapping[key]) {
      mapped[key] = record[key];
    }
  }
  return mapped;
}

function validateRecord(record: any, fieldMap: Map<string, FieldDefinition>): string[] {
  const errors: string[] = [];

  for (const [key, field] of fieldMap) {
    const value = record[key];

    // Validate required
    if (field.required && (value === undefined || value === null || value === "")) {
      errors.push(`${field.label} is required`);
      continue;
    }

    // If not required and empty, pass
    if (!field.required && (value === undefined || value === null || value === "")) {
      continue;
    }

    // Validate type
    if (field.type === "number" && typeof value !== "number") {
      errors.push(`${field.label} must be a number`);
    }

    if (field.type === "boolean" && typeof value !== "boolean") {
      errors.push(`${field.label} must be a boolean`);
    }

    // Validate min/max
    if (field.validation?.min !== undefined && typeof value === "number") {
      if (value < field.validation.min) {
        errors.push(`${field.label} must be at least ${field.validation.min}`);
      }
    }

    if (field.validation?.max !== undefined && typeof value === "number") {
      if (value > field.validation.max) {
        errors.push(`${field.label} must be at most ${field.validation.max}`);
      }
    }

    // Validate pattern
    if (field.validation?.pattern && typeof value === "string") {
      // No ReDoS: see @kitsuden/shared safe-pattern (earlier audit)
      if (!testPattern(field.validation.pattern, value)) {
        errors.push(field.validation.message || `${field.label} format is invalid`);
      }
    }
  }

  return errors;
}
