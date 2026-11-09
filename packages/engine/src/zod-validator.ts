/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ZOD VALIDATOR - Anti-Hallucination Protection
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Integration of Zod with the declarative validation engine.
 * Provides strict schemas to prevent the AI from generating impossible data.
 *
 * Features:
 * - Predefined Zod schemas for common datasets (characters, skills, items)
 * - Automatic ValidationRule → ZodSchema conversion
 * - Strict validation with AI-friendly error messages
 * - Sanitization of unknown data
 *
 * @example
 * ```typescript
 * import { validateWithZod, characterSchema } from "./zod-validator";
 *
 * // Validate against a Zod schema
 * const result = validateWithZod(characterSchema, {
 *   name: "Mage",
 *   mana_cost: -10 // ← Rejected!
 * });
 *
 * // Result
 * { success: false, errors: ["mana_cost: Number must be >= 0"] }
 * ```
 */

import { MAX_LENGTH_TO_TEST, safePattern } from "@kitsuden/shared";
import { z, ZodError, type ZodObject, type ZodRawShape, type ZodSchema, type ZodType } from "zod";

import type { ValidationRule, ValidationSchema } from "./validator";

// ═══════════════════════════════════════════════════════════════════════════════
// PREDEFINED ZOD SCHEMAS - Anti-Hallucination
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Base schema for any entity in the system.
 * Prevents dangerous or unknown fields.
 */
export const baseEntitySchema = z.object({
  id: z.guid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

/**
 * Schema for characters - Gaming CMS.
 * Protects against impossible values in stats.
 */
export const characterSchema = baseEntitySchema.extend({
  // Basic stats with realistic ranges
  level: z.number().int().min(1).max(100).default(1),
  rarity: z.number().int().min(3).max(5),

  // Valid game elements
  element: z.enum(["pyro", "hydro", "electro", "cryo", "anemo", "geo", "dendro"], {
    error: "Invalid element. Options: pyro, hydro, electro, cryo, anemo, geo, dendro",
  }),

  // Allowed weapon types
  weapon_type: z.enum(["sword", "claymore", "polearm", "bow", "catalyst"]),

  // Numeric stats with anti-hallucination ranges
  hp: z.number().min(0).max(999999),
  atk: z.number().min(0).max(999999),
  def: z.number().min(0).max(999999),
  mana_cost: z.number().min(0).max(1000).optional(),
  cooldown: z.number().min(0).max(3600).optional(), // seconds, max 1 hour

  // Slug for URLs
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, "Slug can only contain lowercase letters, numbers and hyphens")
    .max(200),

  // Flexible but controlled metadata
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema for skills.
 */
export const skillSchema = baseEntitySchema.extend({
  character_id: z.guid(),

  // Damage/healing with reasonable ranges
  damage: z.number().min(0).max(999999).optional(),
  healing: z.number().min(0).max(999999).optional(),

  // Costs that cannot be negative
  mana_cost: z.number().min(0).max(1000),
  energy_cost: z.number().min(0).max(1000).optional(),

  // Reasonable cooldowns
  cooldown_seconds: z.number().min(0).max(3600),
  duration_seconds: z.number().min(0).max(3600).optional(),

  // Skill type
  skill_type: z.enum(["normal", "charged", "plunge", "skill", "burst", "passive"]),

  // Element (optional, inherits from the character if not specified)
  element: z.enum(["pyro", "hydro", "electro", "cryo", "anemo", "geo", "dendro"]).optional(),
});

/**
 * Schema for weapons.
 */
export const weaponSchema = baseEntitySchema.extend({
  type: z.enum(["sword", "claymore", "polearm", "bow", "catalyst"]),
  rarity: z.number().int().min(1).max(5),

  // Stats base
  base_atk: z.number().min(0).max(1000),
  sub_stat: z
    .enum([
      "crit_rate",
      "crit_dmg",
      "atk_percent",
      "def_percent",
      "hp_percent",
      "elemental_mastery",
      "energy_recharge",
      "physical_dmg",
    ])
    .optional(),
  sub_stat_value: z.number().min(0).max(100).optional(), // percentage
});

/**
 * Schema for builds (immutable snapshots).
 */
export const buildSchema = z.object({
  character_id: z.guid(),
  weapon_id: z.guid(),
  artifact_ids: z.array(z.guid()).max(5),

  // Calculated values (denormalized)
  total_atk: z.number().min(0),
  total_hp: z.number().min(0),
  total_def: z.number().min(0),

  // Data snapshot for immutability
  _snapshot: z.object({
    character: z.record(z.string(), z.unknown()),
    weapon: z.record(z.string(), z.unknown()),
    artifacts: z.array(z.record(z.string(), z.unknown())),
    calculated_at: z.string().datetime(),
  }),
});

/**
 * Schema for agents (already exists in the system but reinforced).
 */
export const agentIdentitySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  type: z.enum(["claude-desktop", "service", "internal", "webhook"]),
  scopes: z.array(z.string()).default([]),
  rateLimit: z.number().int().min(1).max(10000).default(60),
  capabilities: z.array(z.string()).default([]),
  systemPrompt: z.string().max(10000).optional(),
  allowedTools: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSION: ValidationRule → ZodSchema
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converts a declarative validation rule to a Zod schema.
 */
export function ruleToZod(rule: ValidationRule): ZodSchema {
  let schema: ZodSchema = z.any();

  // Base type
  switch (rule.type) {
    case "string":
      schema = z.string();
      break;
    case "number":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array":
      schema = z.array(z.any());
      break;
    case "object":
      schema = z.record(z.string(), z.any());
      break;
    case "date":
      schema = z.union([z.date(), z.string().datetime()]);
      break;
    default:
      schema = z.any();
  }

  // Required
  if (rule.required) {
    schema = (schema as any).refine((val: any) => val !== undefined && val !== null && val !== "", {
      message: rule.message || "Required field",
    });
  } else {
    schema = schema.optional();
  }

  // Min (length for strings/arrays, value for numbers)
  if (rule.min !== undefined) {
    if (rule.type === "number") {
      schema = (schema as z.ZodNumber).min(rule.min, {
        message: rule.message || `Must be greater than or equal to ${rule.min}`,
      });
    } else if (rule.type === "string") {
      schema = (schema as z.ZodString).min(rule.min, {
        message: rule.message || `Minimum ${rule.min} characters`,
      });
    }
  }

  // Max
  if (rule.max !== undefined) {
    if (rule.type === "number") {
      schema = (schema as z.ZodNumber).max(rule.max, {
        message: rule.message || `Must be less than or equal to ${rule.max}`,
      });
    } else if (rule.type === "string") {
      schema = (schema as z.ZodString).max(rule.max, {
        message: rule.message || `Maximum ${rule.max} characters`,
      });
    }
  }

  // Enum
  if (rule.enum) {
    schema = z.enum(rule.enum as [string, ...string[]], {
      error: rule.message || `Allowed values: ${rule.enum?.join(", ")}`,
    });
  }

  // Pattern (regex)
  if (rule.pattern) {
    // No ReDoS: see @kitsuden/shared safe-pattern (earlier audit)
    const re = safePattern(rule.pattern);
    if (re) {
      schema = (schema as z.ZodString).max(MAX_LENGTH_TO_TEST).regex(re, {
        message: rule.message || "Invalid format",
      });
    }
  }

  return schema;
}

/**
 * Converts a complete declarative validation schema to Zod.
 */
export function validationSchemaToZod(schema: ValidationSchema): ZodObject<ZodRawShape> {
  // Built here, so mutable; zod 4's `ZodRawShape` is a read-only view of the same thing.
  const shape: Record<string, ZodType> = {};

  for (const [field, rule] of Object.entries(schema)) {
    shape[field] = ruleToZod(rule);
  }

  return z.object(shape).strict();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

export interface ZodValidationResult {
  success: boolean;
  data?: any;
  errors: Array<{
    field: string;
    message: string;
    received?: any;
  }>;
}

/**
 * Validates data against a Zod schema.
 */
export function validateWithZod(schema: ZodSchema, data: unknown): ZodValidationResult {
  try {
    const parsed = schema.parse(data);
    return {
      success: true,
      data: parsed,
      errors: [],
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        success: false,
        errors: error.issues.map((err) => ({
          field: err.path.join("."),
          message: err.message,
          received: err.code,
        })),
      };
    }
    return {
      success: false,
      errors: [{ field: "unknown", message: String(error) }],
    };
  }
}

/**
 * Validates using a declarative schema (automatic conversion to Zod).
 */
export function validateDeclarativeWithZod(
  schema: ValidationSchema,
  data: unknown
): ZodValidationResult {
  const zodSchema = validationSchemaToZod(schema);
  return validateWithZod(zodSchema, data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE FOR BATCH API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a BatchProcessor-compatible validator that uses Zod.
 */
export function createZodBatchValidator(schema: ZodSchema) {
  return (data: unknown) => {
    const result = validateWithZod(schema, data);
    return {
      valid: result.success,
      errors: result.errors.map((e) => ({
        field: e.field,
        message: e.message,
        path: e.field,
      })),
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTRY DE SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

const schemaRegistry = new Map<string, ZodSchema>([
  ["character", characterSchema],
  ["characters", characterSchema],
  ["skill", skillSchema],
  ["skills", skillSchema],
  ["weapon", weaponSchema],
  ["weapons", weaponSchema],
  ["build", buildSchema],
  ["builds", buildSchema],
  ["agent", agentIdentitySchema],
  ["agents", agentIdentitySchema],
]);

/**
 * Gets a Zod schema by dataset name.
 */
export function getSchemaForDataset(dataset: string): ZodSchema | undefined {
  return schemaRegistry.get(dataset.toLowerCase());
}

/**
 * Registers a new Zod schema for a dataset.
 */
export function registerSchema(dataset: string, schema: ZodSchema): void {
  schemaRegistry.set(dataset.toLowerCase(), schema);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI-FRIENDLY MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generates an error message that the AI can understand and act on.
 */
export function generateAIRecoveryHint(errors: Array<{ field: string; message: string }>): string {
  if (errors.length === 0) return "Validation successful.";

  const hints = errors.map((err) => {
    switch (err.field) {
      case "mana_cost":
      case "damage":
      case "hp":
      case "atk":
      case "def":
        return `The field '${err.field}' must be a positive number (>= 0). Negative values are not valid in this system.`;
      case "rarity":
        return "Rarity must be between 3 (rare) and 5 (legendary). There are no rarities above 5 in this system.";
      case "element":
        return "The valid elements are: pyro (fire), hydro (water), electro (lightning), cryo (ice), anemo (wind), geo (earth), dendro (nature).";
      case "slug":
        return "The slug must be lowercase, with no spaces, using only hyphens (-) as separators.";
      default:
        return `Error in '${err.field}': ${err.message}`;
    }
  });

  return hints.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { z, ZodError };
export type { ZodSchema };
