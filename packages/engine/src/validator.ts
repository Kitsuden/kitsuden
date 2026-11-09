/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * VALIDATOR ENGINE - Declarative Validation Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Validation engine that processes declarative JSON rules:
 * - Basic rules: min, max, enum, pattern, required
 * - Conditional logic: if/then/else
 * - Native type validation
 * - Custom error messages
 *
 * @example
 * ```typescript
 * const rules = {
 *   name: { required: true, min: 3, max: 100 },
 *   type: { enum: ["combat", "support", "healer"] },
 *   strength: {
 *     min: 0,
 *     max: 100,
 *     if: { field: "type", eq: "combat" },
 *     then: { min: 10 }
 *   }
 * };
 *
 * const result = validate(data, rules);
 * // { valid: false, errors: [{ field: "strength", message: "..." }] }
 * ```
 */

import { testPattern } from "@kitsuden/shared";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES AND CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Individual validation rule */
export interface ValidationRule {
  /** Required value */
  required?: boolean;
  /** Expected data type */
  type?: "string" | "number" | "boolean" | "array" | "object" | "date";
  /** Minimum length (strings/arrays) or minimum value (numbers) */
  min?: number;
  /** Maximum length (strings/arrays) or maximum value (numbers) */
  max?: number;
  /** Allowed values */
  enum?: any[];
  /** Regex pattern (strings only) */
  pattern?: string;
  /** Custom error message */
  message?: string;
  /** Default value */
  default?: any;
  /** Conditional validation */
  if?: Condition;
  /** Rule to apply if the condition is true */
  then?: ValidationRule;
  /** Rule to apply if the condition is false */
  else?: ValidationRule;
  /** Custom validation */
  validate?: (value: any, data: Record<string, unknown>) => boolean | string;
}

/** Condition for if/then validation */
export interface Condition {
  /** Field to evaluate */
  field: string;
  /** Comparison operator */
  eq?: any;
  ne?: any;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: any[];
  contains?: any;
  empty?: boolean;
  /** Negate the condition */
  not?: boolean;
}

/** Complete validation schema */
export type ValidationSchema = Record<string, ValidationRule>;

/** Validation result */
export interface ValidationResult {
  /** Indicates whether all the data is valid */
  valid: boolean;
  /** List of errors found */
  errors: ValidationError[];
  /** Validated and transformed data */
  data?: Record<string, unknown>;
}

/** Individual validation error */
export interface ValidationError {
  /** Field that failed validation */
  field: string;
  /** Error message */
  message: string;
  /** Received value */
  received?: any;
  /** Rule that failed */
  rule?: string;
  /** Nested path (for nested objects) */
  path?: string;
}

/** Validation options */
export interface ValidatorOptions {
  /** Remove fields not defined in the schema */
  stripUnknown?: boolean;
  /** Stop at the first error */
  abortEarly?: boolean;
  /** Allow additional fields */
  allowUnknown?: boolean;
  /** Context for custom validations */
  context?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDIVIDUAL VALIDATORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates a rule against a value.
 */
function validateRule(
  value: any,
  rule: ValidationRule,
  fieldName: string,
  fullData: Record<string, unknown>,
  path?: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  const fieldPath = path ? `${path}.${fieldName}` : fieldName;

  // Handle conditional if/then/else
  if (rule.if) {
    const conditionMet = evaluateCondition(rule.if, fullData);
    const activeRule = conditionMet ? rule.then : rule.else;
    if (activeRule) {
      errors.push(...validateRule(value, activeRule, fieldName, fullData, path));
    }
    // Continue with base validations
  }

  // Validate required
  if (rule.required && (value === undefined || value === null || value === "")) {
    errors.push({
      field: fieldName,
      path: fieldPath,
      message: rule.message || `${fieldName} is required`,
      received: value,
      rule: "required",
    });
    return errors; // If required and missing, do not keep validating
  }

  // If not required and empty, pass
  if (!rule.required && (value === undefined || value === null || value === "")) {
    return errors;
  }

  // Validate type
  if (rule.type) {
    const typeError = validateType(value, rule.type, fieldName, fieldPath, rule.message);
    if (typeError) {
      errors.push(typeError);
      return errors; // If the type is wrong, do not continue
    }
  }

  // Validate min (strings: length, numbers: value, arrays: length)
  if (rule.min !== undefined) {
    const minError = validateMin(value, rule.min, fieldName, fieldPath, rule.message);
    if (minError) errors.push(minError);
  }

  // Validate max
  if (rule.max !== undefined) {
    const maxError = validateMax(value, rule.max, fieldName, fieldPath, rule.message);
    if (maxError) errors.push(maxError);
  }

  // Validate enum
  if (rule.enum && !rule.enum.includes(value)) {
    errors.push({
      field: fieldName,
      path: fieldPath,
      message: rule.message || `${fieldName} must be one of: ${rule.enum.join(", ")}`,
      received: value,
      rule: "enum",
    });
  }

  // Validate pattern
  if (rule.pattern && typeof value === "string") {
    // No ReDoS: see @kitsuden/shared safe-pattern (earlier audit)
    if (!testPattern(rule.pattern, value)) {
      errors.push({
        field: fieldName,
        path: fieldPath,
        message: rule.message || `${fieldName} format is invalid`,
        received: value,
        rule: "pattern",
      });
    }
  }

  // Custom validation
  if (rule.validate) {
    const result = rule.validate(value, fullData);
    if (result !== true) {
      errors.push({
        field: fieldName,
        path: fieldPath,
        message: typeof result === "string" ? result : `${fieldName} is invalid`,
        received: value,
        rule: "validate",
      });
    }
  }

  return errors;
}

/**
 * Evaluates a condition against the data.
 */
function evaluateCondition(condition: Condition, data: Record<string, unknown>): boolean {
  const value = data[condition.field];
  let result = false;

  if (condition.eq !== undefined) {
    result = value === condition.eq;
  } else if (condition.ne !== undefined) {
    result = value !== condition.ne;
  } else if (condition.gt !== undefined) {
    result = typeof value === "number" && value > condition.gt;
  } else if (condition.gte !== undefined) {
    result = typeof value === "number" && value >= condition.gte;
  } else if (condition.lt !== undefined) {
    result = typeof value === "number" && value < condition.lt;
  } else if (condition.lte !== undefined) {
    result = typeof value === "number" && value <= condition.lte;
  } else if (condition.in !== undefined) {
    result = condition.in.includes(value);
  } else if (condition.contains !== undefined) {
    result = Array.isArray(value) && value.includes(condition.contains);
  } else if (condition.empty !== undefined) {
    const isEmpty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value === "") ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" && Object.keys(value).length === 0);
    result = condition.empty === isEmpty;
  }

  return condition.not ? !result : result;
}

/**
 * Validates a value's type.
 */
function validateType(
  value: any,
  expectedType: string,
  fieldName: string,
  fieldPath: string,
  customMessage?: string
): ValidationError | null {
  const actualType = getType(value);

  if (actualType !== expectedType) {
    return {
      field: fieldName,
      path: fieldPath,
      message: customMessage || `${fieldName} must be ${expectedType}, received ${actualType}`,
      received: value,
      rule: "type",
    };
  }

  return null;
}

/**
 * Gets a value's type.
 */
function getType(value: any): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  return typeof value;
}

/**
 * Validates the minimum (length for strings/arrays, value for numbers).
 */
function validateMin(
  value: any,
  min: number,
  fieldName: string,
  fieldPath: string,
  customMessage?: string
): ValidationError | null {
  let valid = true;
  let actual: number = 0;

  if (typeof value === "string" || Array.isArray(value)) {
    actual = value.length;
    valid = actual >= min;
  } else if (typeof value === "number") {
    actual = value;
    valid = actual >= min;
  }

  if (!valid) {
    return {
      field: fieldName,
      path: fieldPath,
      message: customMessage || `${fieldName} must be at least ${min}`,
      received: actual ?? value,
      rule: "min",
    };
  }

  return null;
}

/**
 * Validates the maximum.
 */
function validateMax(
  value: any,
  max: number,
  fieldName: string,
  fieldPath: string,
  customMessage?: string
): ValidationError | null {
  let valid = true;
  let actual: number = 0;

  if (typeof value === "string" || Array.isArray(value)) {
    actual = value.length;
    valid = actual <= max;
  } else if (typeof value === "number") {
    actual = value;
    valid = actual <= max;
  }

  if (!valid) {
    return {
      field: fieldName,
      path: fieldPath,
      message: customMessage || `${fieldName} must be at most ${max}`,
      received: actual ?? value,
      rule: "max",
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates an object against a validation schema.
 *
 * @example
 * ```typescript
 * const schema = {
 *   name: { required: true, min: 3, max: 100 },
 *   email: { required: true, pattern: "^[^@]+@[^@]+$" },
 *   age: { type: "number", min: 0, max: 150 },
 *   role: { enum: ["admin", "user"] },
 *   department: {
 *     if: { field: "role", eq: "admin" },
 *     then: { required: true }
 *   }
 * };
 *
 * const result = validate({ name: "John", email: "john@example.com", role: "admin" }, schema);
 * // { valid: false, errors: [{ field: "department", message: "..." }] }
 * ```
 */
export function validate(
  data: Record<string, unknown>,
  schema: ValidationSchema,
  options: ValidatorOptions = {}
): ValidationResult {
  const errors: ValidationError[] = [];
  const validatedData: Record<string, unknown> = {};
  const { stripUnknown = false, abortEarly = false, allowUnknown = false } = options;

  // Validate fields defined in the schema
  for (const [fieldName, rule] of Object.entries(schema)) {
    const value = data[fieldName];
    const fieldErrors = validateRule(value, rule, fieldName, data);

    if (fieldErrors.length > 0) {
      errors.push(...fieldErrors);
      if (abortEarly) {
        return { valid: false, errors };
      }
    } else if (value !== undefined) {
      validatedData[fieldName] = value;
    }
  }

  // Handle unknown fields
  for (const key of Object.keys(data)) {
    if (!(key in schema)) {
      if (!allowUnknown && !stripUnknown) {
        errors.push({
          field: key,
          path: key,
          message: `${key} is not allowed`,
          received: data[key],
          rule: "unknown",
        });
        if (abortEarly) {
          return { valid: false, errors };
        }
      } else if (allowUnknown) {
        validatedData[key] = data[key];
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    data: validatedData,
  };
}

/**
 * Validates an array of objects against a schema.
 */
export function validateBatch(
  items: Record<string, unknown>[],
  schema: ValidationSchema,
  options: ValidatorOptions = {}
): Array<ValidationResult & { index: number }> {
  return items.map((item, index) => ({
    index,
    ...validate(item, schema, options),
  }));
}

/**
 * Creates a reusable validator with a predefined schema.
 */
export function createValidator(schema: ValidationSchema, defaultOptions: ValidatorOptions = {}) {
  return {
    validate: (data: Record<string, unknown>, options?: ValidatorOptions) =>
      validate(data, schema, { ...defaultOptions, ...options }),
    validateBatch: (items: Record<string, unknown>[], options?: ValidatorOptions) =>
      validateBatch(items, schema, { ...defaultOptions, ...options }),
    schema,
  };
}

/**
 * Schema composition (merge of multiple schemas).
 */
export function composeSchemas(...schemas: ValidationSchema[]): ValidationSchema {
  return schemas.reduce((acc, schema) => ({ ...acc, ...schema }), {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREDEFINED SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/** Base schema for IDs */
export const idSchema: ValidationSchema = {
  id: { type: "string", required: true, min: 1 },
};

/** Base schema for timestamps */
export const timestampSchema: ValidationSchema = {
  createdAt: { type: "string", required: false },
  updatedAt: { type: "string", required: false },
};

/** Schema for pagination */
export const paginationSchema: ValidationSchema = {
  page: { type: "number", min: 1, default: 1 },
  limit: { type: "number", min: 1, max: 1000, default: 50 },
  offset: { type: "number", min: 0, default: 0 },
};

/** Schema for agent identities */
export const agentIdentitySchema: ValidationSchema = {
  name: { required: true, min: 1, max: 200 },
  description: { max: 2000 },
  type: { enum: ["custom", "service", "system", "user"], default: "custom" },
  isActive: { type: "boolean", default: true },
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════
// Note: Types are already exported as interfaces above
