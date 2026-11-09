/**
 * ============================================================================
 * THE ZOD BRIDGE - Shared Validation Schemas
 * ============================================================================
 *
 * Single source of truth for data validation between Backend (Hono)
 * and Frontend (SvelteKit).
 *
 * Any change in the data structure must be reflected here.
 */

import { z } from "zod";

import { FIELD_TYPE_NAMES } from "./field-types";
import { SENSITIVITY_LEVELS } from "./sensitivity";

// ─────────────────────────────────────────────────────────────────────────────
// Field Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derived from the registry instead of repeating the list: maintaining two copies is
 * exactly how `multiselect`, `textarea`, `datetime` and `media` ended up
 * validating in the backend without existing for the user.
 */
export const FieldTypeSchema = z.enum(FIELD_TYPE_NAMES);

export type FieldType = z.infer<typeof FieldTypeSchema>;

export const RelationTypeSchema = z.enum(["one-to-one", "one-to-many", "many-to-many"]);

export type RelationType = z.infer<typeof RelationTypeSchema>;

export const RelationTargetSchema = z.enum([
  "games",
  "blog-posts",
  "platforms",
  "tags",
  "streamers",
  "dataset",
]);

export type RelationTarget = z.infer<typeof RelationTargetSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Relations and options
// ─────────────────────────────────────────────────────────────────────────────

export const RelationConfigSchema = z.object({
  target: RelationTargetSchema,
  targetDatasetId: z.string().optional(),
  targetDatasetName: z.string().optional(),
  type: RelationTypeSchema,
  displayField: z.string().optional(),
});

export type RelationConfig = z.infer<typeof RelationConfigSchema>;

export const SelectOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export type SelectOption = z.infer<typeof SelectOptionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Conditional logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shows a field only if another field of the same form meets the condition.
 *
 * It reuses the `rlsRules` operator vocabulary on purpose: the user already
 * knows it from access policies, and does not deserve a second dialect.
 *
 * Inside a repeater, `field` is resolved against the SAME row, not against
 * the parent form. It is what whoever configures it expects, and it prevents a
 * row from depending on the state of another.
 */
export const ShowIfSchema = z.object({
  field: z.string().min(1, "showIf.field is required"),
  operator: z.enum(["eq", "neq", "contains", "gt", "lt"]),
  value: z.string(),
});

export type ShowIf = z.infer<typeof ShowIfSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Field Definition (The heart of the schema)
// ─────────────────────────────────────────────────────────────────────────────

/** Fields common to a top-level field and a repeater subfield. */
const FieldBaseShape = {
  // Identification
  id: z.string().min(1, "Field ID is required"),
  key: z.string().min(1, "Field key is required"),
  label: z.string().min(1, "Field label is required"),
  type: FieldTypeSchema,

  // Metadata
  helpText: z.string().optional(),
  order: z.number().int().min(0).default(0),

  // Validations (Django-style)
  isRequired: z.boolean().default(false),
  isUnique: z.boolean().default(false),
  validationRegex: z.string().optional(),
  defaultValue: z.string().optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),

  // Options for selects
  options: z.array(SelectOptionSchema).optional(),

  // Relation configuration
  relation: RelationConfigSchema.optional(),

  // UI configuration
  width: z.number().optional(),
  hidden: z.boolean().default(false),

  /** Conditional visibility. `hidden` is fixed; this depends on another field. */
  showIf: ShowIfSchema.optional(),

  /**
   * Customer or personal data: an execution that reads this field cannot send
   * its value to a host not allowed for customer data (docs/agents/egress.md).
   */
  sensitivity: z.enum(SENSITIVITY_LEVELS).optional(),
};

/**
 * Subfield of a repeater: it is a full field MINUS `subFields`.
 *
 * Nesting is cut off at ONE level on purpose, not by oversight. A repeater
 * inside a repeater multiplies rows by rows: the render and validation
 * cost grows quadratically, and in practice almost everything
 * people solve this way (FAQs, team members, price tiers) is flat.
 * Also, an unbounded recursive schema allows building a definition that
 * blows the stack when generating the validator — an explicit limit is also
 * a security limit.
 */
export const SubFieldDefinitionSchema = z.object(FieldBaseShape);

export type SubFieldDefinition = z.infer<typeof SubFieldDefinitionSchema>;

/**
 * Zod schema for the definition of an individual field.
 *
 * CRITICAL: This schema validates that each field has:
 * - unique id
 * - key (machine name)
 * - label (visible name)
 * - type (one of the allowed FieldTypes)
 * - Optional validations (required, unique, regex, min/max)
 */
export const FieldDefinitionSchema = z.object({
  ...FieldBaseShape,

  /**
   * Only for `type: "repeater"`. Defines the shape of each row.
   *
   * The repeater's own `minLength` / `maxLength` act as the minimum and maximum
   * number of ROWS, instead of inventing two new fields that mean the same thing.
   */
  subFields: z.array(SubFieldDefinitionSchema).optional(),
});

export type FieldDefinition = z.infer<typeof FieldDefinitionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Dataset Policy & Workflow (Enterprise)
// ─────────────────────────────────────────────────────────────────────────────

export const DatasetPolicySchema = z.object({
  readAccess: z.enum(["admin", "public", "authenticated"]),
  writeAccess: z.enum(["admin", "authenticated"]),
  enableRLS: z.boolean().default(false),
  rlsRules: z
    .array(
      z.object({
        field: z.string(),
        operator: z.enum(["eq", "neq", "contains", "gt", "lt"]),
        value: z.string(),
      })
    )
    .optional(),
});

export type DatasetPolicy = z.infer<typeof DatasetPolicySchema>;

export const DatasetWorkflowSchema = z.object({
  requireApproval: z.boolean(),
  approverUserIds: z.array(z.string()).optional(),
});

export type DatasetWorkflow = z.infer<typeof DatasetWorkflowSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Dataset Definition (The Absolute Truth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema for the complete definition of a Dataset.
 *
 * CRITICAL: This schema guarantees that:
 * 1. The dataset has a valid name and slug
 * 2. It contains an array of fields (NOT a flat object)
 * 3. Each field meets FieldDefinitionSchema
 *
 * Backend use: Validates the POST/PATCH payload with @hono/zod-validator
 * Frontend use: Imports the inferred type with z.infer<typeof DatasetDefinitionSchema>
 */
export const DatasetDefinitionSchema = z.object({
  // Identification
  id: z.string(),
  name: z.string().min(1, "Dataset name is required"),
  slug: z.string().min(1, "Dataset slug is required"),
  description: z.string().optional(),
  icon: z.string().optional(),

  // The heart: array of structured fields
  fields: z.array(FieldDefinitionSchema).min(0),

  // Enterprise configuration
  policyJson: DatasetPolicySchema.nullable().optional(),
  workflowJson: DatasetWorkflowSchema.nullable().optional(),

  // Metadata
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type DatasetDefinition = z.infer<typeof DatasetDefinitionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Dataset Entry
// ─────────────────────────────────────────────────────────────────────────────

export const DatasetEntrySchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  data: z.record(z.string(), z.any()),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type DatasetEntry = z.infer<typeof DatasetEntrySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Payload Validation (for use in Hono)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema for creating a new Dataset (no ID or timestamps)
 */
export const CreateDatasetPayloadSchema = DatasetDefinitionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  // Optional fields for creation
  displayConfig: z
    .object({
      titleField: z.string().optional(),
      sortField: z.string().optional(),
      sortDirection: z.enum(["asc", "desc"]).optional(),
    })
    .optional(),
});

export type CreateDatasetPayload = z.infer<typeof CreateDatasetPayloadSchema>;

/**
 * Schema for updating a Dataset (all fields optional)
 */
export const UpdateDatasetPayloadSchema = DatasetDefinitionSchema.partial()
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    displayConfig: z
      .object({
        titleField: z.string().optional(),
        sortField: z.string().optional(),
        sortDirection: z.enum(["asc", "desc"]).optional(),
      })
      .optional(),
  });

export type UpdateDatasetPayload = z.infer<typeof UpdateDatasetPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Validation Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates that an object is a valid DatasetDefinition.
 * Throws ZodError if it does not meet the schema.
 */
export function validateDatasetDefinition(data: unknown): DatasetDefinition {
  return DatasetDefinitionSchema.parse(data);
}

/**
 * Validates safely without throwing exceptions.
 * Returns { success: true, data } or { success: false, error }
 */
export function safeValidateDataset(
  data: unknown
): { success: true; data: DatasetDefinition } | { success: false; error: z.ZodError } {
  const result = DatasetDefinitionSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Generates a unique field ID
 */
export function generateFieldId(): string {
  return `fld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Creates an empty field of the specified type
 */
export function createEmptyField(type: FieldType, order: number): FieldDefinition {
  return {
    id: generateFieldId(),
    key: "",
    label: "",
    type,
    isRequired: false,
    isUnique: false,
    order,
    hidden: false,
    // A repeater without subfields is not editable in the admin and validates nothing useful:
    // it is seeded with a text row so that it works from the first click.
    ...(type === "repeater"
      ? {
          subFields: [
            {
              id: generateFieldId(),
              key: "",
              label: "",
              type: "text" as const,
              isRequired: false,
              isUnique: false,
              order: 0,
              hidden: false,
            },
          ],
        }
      : {}),
  };
}
