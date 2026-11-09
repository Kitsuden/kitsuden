/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DATASETS SNAPSHOTS - Denormalization and Immutable Snapshots
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Snapshot system for saving related data at creation time.
 * Critical for gaming builds where items/changes affect history.
 *
 * Features:
 * - Automatic snapshots on create/update
 * - Immutability of historical builds
 * - Restoring earlier versions
 * - Snapshot comparison
 * - Full audit trail
 */

import type { KonContext } from "@kitsuden/shared";
import { z } from "zod";

import type { DataSet, DataEntry } from "./datasets.schema";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES AND SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

export type SnapshotTrigger = "create" | "update" | "manual" | "scheduled";

export interface SnapshotConfig {
  /** Enable snapshots */
  enabled: boolean;
  /** Triggers that generate a snapshot */
  on: SnapshotTrigger[];
  /** Fields to snapshot (relations) */
  fields: SnapshotField[];
  /** Calculated fields to include */
  calculated?: string[];
  /** Retention: number of versions to keep (0 = infinite) */
  retention?: number;
}

export interface SnapshotField {
  /** Field that contains the relation ID */
  source: string;
  /** Fields of the related object to snapshot */
  snapshot: string[];
  /** Custom name in the snapshot */
  as?: string;
}

export interface SnapshotData {
  /** Snapshot timestamp */
  timestamp: string;
  /** Schema version */
  version: string;
  /** Snapshotted data */
  data: Record<string, unknown>;
  /** Snapshotted calculated fields */
  calculated?: Record<string, unknown>;
  /** Additional metadata */
  meta?: {
    triggeredBy?: string;
    reason?: string;
    source?: string;
  };
}

export interface SnapshotComparison {
  field: string;
  oldValue: any;
  newValue: any;
  changed: boolean;
}

export interface EntryVersion {
  version: number;
  entryId: string;
  datasetId: string;
  snapshot: SnapshotData;
  createdAt: string;
  restoredFrom?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMAS ZOD
// ═══════════════════════════════════════════════════════════════════════════════

export const snapshotFieldSchema = z.object({
  source: z.string(),
  snapshot: z.array(z.string()),
  as: z.string().optional(),
});

export const snapshotConfigSchema = z.object({
  enabled: z.boolean().default(false),
  on: z.array(z.enum(["create", "update", "manual", "scheduled"])).default(["create"]),
  fields: z.array(snapshotFieldSchema).default([]),
  calculated: z.array(z.string()).optional(),
  retention: z.number().int().min(0).default(0),
});

// ═══════════════════════════════════════════════════════════════════════════════
// SNAPSHOT ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

import { eq, sql } from "drizzle-orm";

/**
 * Checks whether a snapshot should be generated according to the configuration
 */
export function shouldSnapshot(config: SnapshotConfig, trigger: SnapshotTrigger): boolean {
  if (!config.enabled) return false;
  return config.on.includes(trigger);
}

/**
 * Generates a snapshot of an entry with its relations
 */
export async function generateSnapshot(
  ctx: KonContext,
  entry: DataEntry,
  config: SnapshotConfig,
  trigger: SnapshotTrigger,
  options?: {
    reason?: string;
    source?: string;
    calculatedValues?: Record<string, unknown>;
  }
): Promise<SnapshotData> {
  const snapshot: SnapshotData = {
    timestamp: new Date().toISOString(),
    version: "1.0",
    data: {},
    meta: {
      triggeredBy: trigger,
      reason: options?.reason,
      source: options?.source,
    },
  };

  // If there are related fields to snapshot
  if (config.fields.length > 0) {
    for (const field of config.fields) {
      const relatedId = (entry.data as any)[field.source];

      if (!relatedId) {
        snapshot.data[field.as || field.source] = null;
        continue;
      }

      // Determine the related table from the schema
      const relatedData = await fetchRelatedData(ctx, relatedId, field);

      if (relatedData) {
        // Filter only the requested fields
        const snapshotData: Record<string, unknown> = {};
        for (const key of field.snapshot) {
          snapshotData[key] = relatedData[key];
        }
        snapshot.data[field.as || field.source] = snapshotData;
      } else {
        snapshot.data[field.as || field.source] = null;
      }
    }
  }

  // Include calculated fields if provided
  if (options?.calculatedValues && config.calculated) {
    snapshot.calculated = {};
    for (const calcField of config.calculated) {
      if (options.calculatedValues[calcField] !== undefined) {
        snapshot.calculated[calcField] = options.calculatedValues[calcField];
      }
    }
  }

  return snapshot;
}

/**
 * Saves a snapshot in the entry
 */
export async function saveSnapshot(
  ctx: KonContext,
  entryId: string,
  snapshot: SnapshotData,
  config: SnapshotConfig
): Promise<void> {
  const { db } = ctx;
  const { dataEntries } = await import("./datasets.schema");

  // Get current entry
  const [entry] = await db.instance
    .select()
    .from(dataEntries)
    .where(eq(dataEntries.id, entryId))
    .limit(1);

  if (!entry) {
    throw new Error(`Entry not found: ${entryId}`);
  }

  // Build snapshot history
  const existingSnapshots: SnapshotData[] = (entry.data as any)._snapshots || [];

  // Add new snapshot at the start (most recent first)
  const newSnapshots = [snapshot, ...existingSnapshots];

  // Apply retention if configured
  if (config.retention && config.retention > 0) {
    while (newSnapshots.length > config.retention) {
      newSnapshots.pop();
    }
  }

  // Update entry with the snapshot
  const updatedData = {
    ...entry.data,
    _snapshot: snapshot, // Latest snapshot (quick access)
    _snapshots: newSnapshots, // Full history
  };

  await db.instance
    .update(dataEntries)
    .set({
      data: updatedData,
      updatedAt: new Date(),
    })
    .where(eq(dataEntries.id, entryId));

  ctx.logger.debug(`📸 Snapshot saved for entry ${entryId}`);
}

/**
 * Gets the current snapshot of an entry
 */
export async function getCurrentSnapshot(
  ctx: KonContext,
  entryId: string
): Promise<SnapshotData | null> {
  const { db } = ctx;
  const { dataEntries } = await import("./datasets.schema");

  const [entry] = await db.instance
    .select()
    .from(dataEntries)
    .where(eq(dataEntries.id, entryId))
    .limit(1);

  if (!entry) return null;

  return (entry.data as any)._snapshot || null;
}

/**
 * Gets the snapshot history of an entry
 */
export async function getSnapshotHistory(
  ctx: KonContext,
  entryId: string
): Promise<SnapshotData[]> {
  const { db } = ctx;
  const { dataEntries } = await import("./datasets.schema");

  const [entry] = await db.instance
    .select()
    .from(dataEntries)
    .where(eq(dataEntries.id, entryId))
    .limit(1);

  if (!entry) return [];

  return (entry.data as any)._snapshots || [];
}

/**
 * Compares two snapshots and returns the differences
 */
export function compareSnapshots(
  oldSnapshot: SnapshotData | null,
  newSnapshot: SnapshotData
): SnapshotComparison[] {
  const differences: SnapshotComparison[] = [];
  const allKeys = new Set([
    ...Object.keys(oldSnapshot?.data || {}),
    ...Object.keys(newSnapshot.data),
  ]);

  for (const key of allKeys) {
    const old = oldSnapshot?.data?.[key];
    const newValue = newSnapshot.data[key];

    differences.push({
      field: key,
      oldValue: old,
      newValue,
      changed: JSON.stringify(old) !== JSON.stringify(newValue),
    });
  }

  return differences;
}

/**
 * Restores an entry to a previous snapshot
 */
export async function restoreToSnapshot(
  ctx: KonContext,
  entryId: string,
  snapshotTimestamp: string
): Promise<boolean> {
  const { db } = ctx;
  const { dataEntries } = await import("./datasets.schema");

  const [entry] = await db.instance
    .select()
    .from(dataEntries)
    .where(eq(dataEntries.id, entryId))
    .limit(1);

  if (!entry) {
    throw new Error(`Entry not found: ${entryId}`);
  }

  const snapshots: SnapshotData[] = (entry.data as any)._snapshots || [];
  const targetSnapshot = snapshots.find((s) => s.timestamp === snapshotTimestamp);

  if (!targetSnapshot) {
    throw new Error(`Snapshot not found: ${snapshotTimestamp}`);
  }

  // Create a snapshot of the current state before restoring
  const currentSnapshot: SnapshotData = {
    timestamp: new Date().toISOString(),
    version: "1.0",
    data: { ...entry.data },
    meta: {
      triggeredBy: "restore",
      reason: "Auto-snapshot before restore",
      source: "restore_operation",
    },
  };

  // Restore data from the snapshot
  const restoredData = {
    ...targetSnapshot.data,
    _snapshot: targetSnapshot,
    _snapshots: [currentSnapshot, ...snapshots],
    _restoredFrom: snapshotTimestamp,
    _restoredAt: new Date().toISOString(),
  };

  await db.instance
    .update(dataEntries)
    .set({
      data: restoredData,
      updatedAt: new Date(),
    })
    .where(eq(dataEntries.id, entryId));

  ctx.logger.info(`⏪ Entry ${entryId} restored to snapshot ${snapshotTimestamp}`);

  return true;
}

/**
 * Creates a manual snapshot of an entry
 */
export async function createManualSnapshot(
  ctx: KonContext,
  entryId: string,
  config: SnapshotConfig,
  options?: {
    reason?: string;
    calculatedValues?: Record<string, unknown>;
  }
): Promise<SnapshotData> {
  const { db } = ctx;
  const { dataEntries } = await import("./datasets.schema");

  const [entry] = await db.instance
    .select()
    .from(dataEntries)
    .where(eq(dataEntries.id, entryId))
    .limit(1);

  if (!entry) {
    throw new Error(`Entry not found: ${entryId}`);
  }

  const snapshot = await generateSnapshot(ctx, entry, config, "manual", {
    reason: options?.reason || "Manual snapshot",
    calculatedValues: options?.calculatedValues,
  });

  await saveSnapshot(ctx, entryId, snapshot, config);

  return snapshot;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SNAPSHOT AUTO-CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detects automatic snapshot configuration from the dataset schema
 */
export function detectSnapshotConfig(dataset: DataSet): SnapshotConfig | null {
  const schema = dataset.schema as any;

  if (!schema?.snapshot?.enabled) {
    return null;
  }

  return snapshotConfigSchema.parse(schema.snapshot);
}

/**
 * Applies automatic snapshot in create/update hooks
 */
export async function autoSnapshotOnCreate(
  ctx: KonContext,
  entry: DataEntry,
  dataset: DataSet
): Promise<void> {
  const config = detectSnapshotConfig(dataset);

  if (!config || !shouldSnapshot(config, "create")) {
    return;
  }

  const snapshot = await generateSnapshot(ctx, entry, config, "create");
  await saveSnapshot(ctx, entry.id, snapshot, config);
}

export async function autoSnapshotOnUpdate(
  ctx: KonContext,
  entry: DataEntry,
  dataset: DataSet,
  oldEntry?: DataEntry
): Promise<void> {
  const config = detectSnapshotConfig(dataset);

  if (!config || !shouldSnapshot(config, "update")) {
    return;
  }

  // Check whether any field that requires a snapshot changed
  const fieldsToWatch = config.fields.map((f) => f.source);
  const hasChanged = fieldsToWatch.some((field) => {
    return (
      JSON.stringify((entry.data as any)[field]) !==
      JSON.stringify((oldEntry?.data as any)?.[field])
    );
  });

  if (!hasChanged) {
    return;
  }

  const snapshot = await generateSnapshot(ctx, entry, config, "update");
  await saveSnapshot(ctx, entry.id, snapshot, config);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchRelatedData(
  ctx: KonContext,
  relatedId: string,
  field: SnapshotField
): Promise<any> {
  const { db } = ctx;

  // Infer related table from the field name
  // Ej: weapon_id -> weapons, characterId -> characters
  const tableName = inferTableName(field.source);

  /**
   * The table comes from the name of a field in the dataset configuration, and the
   * whole row ends up inside a snapshot that anyone who can read the
   * dataset can read. Without this guard, an `auth_account_id` field copied a row from
   * `auth_accounts` (password hash included) into a public snapshot.
   */
  if (!allowedRelatedTable(tableName)) {
    ctx.logger.warn(`Snapshot: related table not allowed "${tableName}"`);
    return null;
  }

  try {
    // Use a raw query to get data from a dynamic table
    const result = await db.instance.execute(
      sql`SELECT * FROM ${sql.identifier(tableName)} WHERE id = ${relatedId} LIMIT 1`
    );

    return result.rows[0] || null;
  } catch (error) {
    ctx.logger.warn(`Failed to fetch related data from ${tableName}:`, error as any);
    return null;
  }
}

/**
 * Tables a snapshot NEVER copies a row from: accounts, sessions,
 * credentials, agents, secrets and system configuration. It is exported
 * so it can be tested.
 */
const BANNED_TABLES =
  /^(auth|better_auth|users?|sessions?|accounts?|verifications?|api_?keys?|agent|secret|vault|kitsuden_secret|modules|settings|mcp_|oauth|passkey|two_factor)/;

export function allowedRelatedTable(table: string): boolean {
  return /^[a-z][a-z0-9_]{0,62}$/.test(table) && !BANNED_TABLES.test(table);
}

export function inferTableName(fieldName: string): string {
  // Convert field name to a possible table name
  // weapon_id -> weapons
  // characterId -> characters

  let base = fieldName.replace(/_id$/, "").replace(/Id$/, "").toLowerCase();

  // Pluralize
  if (!base.endsWith("s")) {
    base += "s";
  }

  return base;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAMING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Predefined configuration for POE/Diablo builds
 */
export const GAMING_BUILD_SNAPSHOT_CONFIG: SnapshotConfig = {
  enabled: true,
  on: ["create", "update"],
  fields: [
    { source: "weapon_id", snapshot: ["name", "base_dps", "mods", "rarity"], as: "weapon" },
    { source: "character_id", snapshot: ["name", "class", "level", "ascendancy"], as: "character" },
    { source: "helmet_id", snapshot: ["name", "defense", "mods"], as: "helmet" },
    { source: "chest_id", snapshot: ["name", "defense", "mods"], as: "chest" },
    { source: "gloves_id", snapshot: ["name", "defense", "mods"], as: "gloves" },
    { source: "boots_id", snapshot: ["name", "defense", "mods"], as: "boots" },
  ],
  calculated: ["total_dps", "total_life", "total_resistances", "ehp"],
  retention: 10, // Keep the last 10 versions
};

/**
 * Compares two builds to show a visual diff
 */
export function diffBuilds(
  build1: SnapshotData,
  build2: SnapshotData
): { item: string; oldValue: any; newValue: any; change: "buff" | "nerf" | "neutral" }[] {
  const diff = compareSnapshots(build1, build2);

  return diff
    .filter((d) => d.changed)
    .map((d) => ({
      item: d.field,
      oldValue: d.oldValue,
      newValue: d.newValue,
      change: detectChangeType(d.field, d.oldValue, d.newValue),
    }));
}

function detectChangeType(field: string, oldVal: any, newVal: any): "buff" | "nerf" | "neutral" {
  // For numeric fields related to stats
  const buffFields = ["dps", "life", "mana", "armor", "evasion", "resistances", "damage"];
  const nerfFields = ["cost", "requirements"];

  const isBuffField = buffFields.some((f) => field.includes(f));
  const isNerfField = nerfFields.some((f) => field.includes(f));

  if (typeof oldVal === "number" && typeof newVal === "number") {
    if (isBuffField) {
      return newVal > oldVal ? "buff" : "nerf";
    }
    if (isNerfField) {
      return newVal < oldVal ? "buff" : "nerf";
    }
  }

  return "neutral";
}
