/**
 * Dataset Module Types
 * Defines the schema for virtual tables (dataset_definitions + dataset_entries)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MIGRATED: This file now re-exports from @kitsuden/shared
 * to keep a single source of truth.
 *
 * The "Zod Bridge" guarantees that Frontend and Backend use the same types.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// The re-export below does NOT bring the name into local scope: to use it here
// a real import is needed.
import { creatableFieldTypes } from "@kitsuden/shared";

// ═══════════════════════════════════════════════════════════════════════════
// RE-EXPORTS FROM THE ZOD BRIDGE (@kitsuden/shared)
// ═══════════════════════════════════════════════════════════════════════════

export {
  // Core types
  type FieldType,
  type RelationType,
  type RelationTarget,
  type RelationConfig,
  type SelectOption,
  type FieldDefinition,
  type DatasetPolicy,
  type DatasetWorkflow,
  type DatasetDefinition,
  type DatasetEntry,
  type CreateDatasetPayload,
  type UpdateDatasetPayload,

  // Zod schemas (for runtime validation if needed)
  FieldTypeSchema,
  RelationTypeSchema,
  RelationTargetSchema,
  FieldDefinitionSchema,
  DatasetDefinitionSchema,

  // Helpers
  generateFieldId,
  createEmptyField,
  safeValidateDataset,
  creatableFieldTypes,
} from "@kitsuden/shared";

// ═══════════════════════════════════════════════════════════════════════════
// UI-SPECIFIC TYPES (Frontend only)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Field type option for the SchemaBuilder UI
 */
export interface FieldTypeOption {
  type: import("@kitsuden/shared").FieldType;
  label: string;
  icon: string;
  description: string;
  color: string;
}

/**
 * Field type options available in the SchemaBuilder.
 *
 * They are derived from the shared registry instead of keeping a second
 * list here. That second list is the reason `multiselect`, `textarea`,
 * `datetime` and `media` validated in the backend without being creatable: nobody
 * added them here when adding them there.
 *
 * Types marked `creatable: false` in the registry (legacy aliases)
 * are left out on purpose: they still validate, but offering two names for the
 * same thing in the palette only confuses.
 */
export const FIELD_TYPE_OPTIONS: FieldTypeOption[] = creatableFieldTypes().map((t) => ({
  type: t.type,
  label: t.label,
  icon: t.icon,
  description: t.description,
  color: t.color,
}));

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY HELPERS (Kept for compatibility)
// ═══════════════════════════════════════════════════════════════════════════

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function generateFieldKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION NOTE
// ═══════════════════════════════════════════════════════════════════════════
//
// Before: Each app defined its own types, causing drift.
// After: Everyone uses @kitsuden/shared which holds the Absolute Truth.
//
// If you need to modify a Dataset's structure:
// 1. Edit packages/shared/src/schemas.ts
// 2. Run `pnpm build` in packages/shared
// 3. Changes propagate automatically to API and Frontend
//
// Zod validation in the backend will automatically reject payloads
// that do not comply with the schema, preventing data corruption.
