/**
 * ============================================================================
 * FIELD COMPILER → ZOD
 * ============================================================================
 *
 * A field definition is an AUTHORING contract: it carries label, icon, width
 * and order, things validation does not care about. A `ValidationRule` is an
 * EXECUTION contract: it carries functions, which cannot be serialized in a
 * `kon.json`.
 *
 * Merging them into a single type would have given a type that does both
 * badly. What is unified here is the PATH: any field vocabulary in the repo
 * —datasets, a tournament's custom fields, SQL columns— is normalized to
 * `NormalizedField` and compiled with this single function.
 *
 * It lives in the engine and not in the app because validating the shape of
 * data is framework, not API business logic.
 *
 * INVARIANT THAT IS NOT TOUCHED: the resulting object is `passthrough()`. Keys
 * that are not in the schema are kept as they are. It is what allows putting
 * arbitrary fields in the jsonb without declaring them, and it is deliberate: a
 * custom field builder with no escape hatch forces you to migrate the schema
 * to store a loose piece of data.
 */

import {
  fieldTypeSpec,
  resolveFieldType,
  schemaFields,
  MAX_LENGTH_TO_TEST,
  safePattern,
} from "@kitsuden/shared";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Normalized contract
// ─────────────────────────────────────────────────────────────────────────────

export interface FieldCondition {
  field: string;
  operator: "eq" | "neq" | "contains" | "gt" | "lt";
  value: string;
}

export interface NormalizedField {
  key: string;
  /**
   * The type AS the author wrote it, without resolving aliases.
   *
   * It is kept raw on purpose: `getSchemaVersion` hashes it to detect whether
   * the schema changed, and resolving aliases here would move the hash of every
   * schema that uses one — marking as stale entries nobody touched. The
   * version must reflect what the author wrote, not our internal
   * representation.
   */
  type: string;
  /** The canonical type from the registry. It is the one compilation uses. */
  resolvedType: string;
  label: string;
  required: boolean;
  defaultValue?: unknown;
  options?: Array<string | { value?: string; label?: string }>;
  isUnique?: boolean;
  validationRegex?: string;
  minValue?: number;
  maxValue?: number;
  minLength?: number;
  maxLength?: number;
  index?: boolean;
  searchable?: boolean | undefined;
  /** Shape of each row for `repeater`. A single level. */
  subFields?: unknown[];
  /** Conditional visibility. */
  showIf?: FieldCondition;
}

const CONDITION_OPERATORS = new Set(["eq", "neq", "contains", "gt", "lt"]);

/**
 * Normalizes the field vocabularies that coexist in the repo:
 *
 *   - modern admin:   { key, type, isRequired, ... }
 *   - old backend:    { fieldName, fieldType, required, ... }
 *   - kon-esports:    { key, type, required, help, visibility, min, max }
 *   - SQL columns:    { name, type: "varchar" | "integer" | ... }
 *
 * The type is resolved against the shared registry, which already knows about
 * aliases, so adding a new vocabulary does not touch this file.
 */
export function normalizeField(field: unknown): NormalizedField | null {
  if (!field || typeof field !== "object") return null;
  const f = field as Record<string, unknown>;

  const key = (f.key ?? f.fieldName ?? f.name) as string | undefined;
  if (!key || typeof key !== "string" || key.length === 0) return null;

  const rawType = (f.type ?? f.fieldType ?? "text") as string;

  return {
    key,
    type: rawType,
    resolvedType: resolveFieldType(rawType),
    label: (f.label ?? f.fieldName ?? key) as string,
    required: Boolean(f.required ?? f.isRequired ?? f.is_required ?? false),
    defaultValue: parseDefaultValue(f.defaultValue ?? f.default),
    options: f.options as NormalizedField["options"],
    isUnique: Boolean(f.isUnique ?? f.is_unique ?? false),
    validationRegex: (f.validationRegex ?? f.pattern) as string | undefined,
    // `min`/`max` are the names kon-esports uses; they mean the same thing.
    minValue: (f.minValue ?? f.min) as number | undefined,
    maxValue: (f.maxValue ?? f.max) as number | undefined,
    minLength: f.minLength as number | undefined,
    maxLength: f.maxLength as number | undefined,
    index: Boolean(f.index ?? f.indexable ?? false),
    searchable:
      f.searchable === undefined && f.search === undefined && f.fullText === undefined
        ? undefined
        : Boolean(f.searchable ?? f.search ?? f.fullText ?? false),
    subFields: Array.isArray(f.subFields) ? f.subFields : undefined,
    showIf: normalizeCondition(f.showIf),
  };
}

export function normalizeFields(fields: unknown): NormalizedField[] {
  // List or `{fields}`: see `schemaFields` in @kitsuden/shared
  return schemaFields(fields)
    .map(normalizeField)
    .filter((f): f is NormalizedField => f !== null);
}

function parseDefaultValue(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * A half condition is worse than none: if it comes incomplete or with a
 * nonexistent operator it is discarded and the field behaves as always
 * visible. The opposite —treating it as "never visible"— would make data
 * silently disappear because of a typo in the schema.
 */
export function normalizeCondition(raw: unknown): FieldCondition | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.field !== "string" || c.field.length === 0) return undefined;
  if (typeof c.operator !== "string" || !CONDITION_OPERATORS.has(c.operator)) return undefined;
  return {
    field: c.field,
    operator: c.operator as FieldCondition["operator"],
    value: String(c.value ?? ""),
  };
}

/**
 * Evaluates a condition against the object the field lives in — the whole
 * form for a top-level field, or THE ROW for a repeater subfield.
 */
export function isFieldVisible(
  field: Pick<NormalizedField, "showIf">,
  scope: Record<string, unknown>
): boolean {
  const c = field.showIf;
  if (!c) return true;

  const actual = scope[c.field];
  // Comparing as text keeps the condition readable and stable: the schema
  // stores `value` as a string and the data may arrive as a number or boolean.
  const a = actual === undefined || actual === null ? "" : String(actual);

  switch (c.operator) {
    case "eq":
      return a === c.value;
    case "neq":
      return a !== c.value;
    case "contains":
      return a.includes(c.value);
    case "gt":
    case "lt": {
      // If either side is not numeric, the comparison means
      // nothing; it resolves to false instead of a misleading lexicographic order
      // ("10" < "9" would be true as text).
      const na = Number(actual);
      const nb = Number(c.value);
      if (Number.isNaN(na) || Number.isNaN(nb)) return false;
      return c.operator === "gt" ? na > nb : na < nb;
    }
    default:
      return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compilation to Zod
// ─────────────────────────────────────────────────────────────────────────────

export function extractOptionValues(options: NormalizedField["options"]): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => (typeof o === "string" ? o : (o as { value?: string }).value))
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Builds a field's validator from the FAMILY declared in the registry, not
 * from its name. That is why `datetime` and `date` share a path without
 * repeating a branch, and adding a new type of an existing family does not
 * touch this function.
 */
/**
 * A web address: http(s) and nothing else.
 *
 * A bare `z.string().url()` accepts `javascript:alert(1)` and `data:`, and a
 * `url` or `image` field ends up in an `href` or `src` of the public site.
 */
function urlWeb() {
  return z
    .string()
    .url()
    .refine((v) => /^https?:\/\//i.test(v), { message: "The URL must be http(s)" });
}

function fieldToZod(field: NormalizedField): z.ZodTypeAny {
  const spec = fieldTypeSpec(field.resolvedType);

  switch (spec.kind) {
    case "number": {
      let n = z.number();
      if (field.minValue !== undefined) n = n.min(field.minValue);
      if (field.maxValue !== undefined) n = n.max(field.maxValue);
      return n;
    }

    case "boolean":
      return z.boolean();

    case "date":
      return z.union([
        z.string().datetime({ message: "Invalid datetime" }),
        z.string().date(),
        z.coerce.date(),
      ]);

    case "uuid":
      return z.guid();

    case "mediaRef":
      // Media library id or http(s) URL
      return z.union([z.guid(), urlWeb()]);

    case "json":
      return z.record(z.string(), z.any());

    case "stringArray": {
      const values = extractOptionValues(field.options);
      return values.length > 0
        ? z.array(z.enum(values as [string, ...string[]]))
        : z.array(z.string());
    }

    case "rows": {
      // Subfields do not carry `subFields`, so this call cannot
      // re-enter here: nesting is cut off at one level.
      const rows = buildObjectValidator(normalizeFields(field.subFields ?? []));
      let arr = z.array(rows);
      // The repeater reuses minLength/maxLength as the minimum/maximum number of ROWS.
      if (field.minLength !== undefined) arr = arr.min(field.minLength);
      if (field.maxLength !== undefined) arr = arr.max(field.maxLength);
      return arr;
    }

    case "string":
    default: {
      if (spec.supportsOptions) {
        const values = extractOptionValues(field.options);
        if (values.length > 0) return z.enum(values as [string, ...string[]]);
      }
      if (spec.format === "email") return z.string().email();
      if (spec.format === "url") return urlWeb();

      let s = z.string();
      if (field.minLength !== undefined) s = s.min(field.minLength);
      if (field.maxLength !== undefined) s = s.max(field.maxLength);
      if (field.validationRegex) {
        // Editor pattern: if invalid or at risk of ReDoS it is ignored, and the
        // value being tested is capped (audit,
        // @kitsuden/shared safe-pattern).
        const re = safePattern(field.validationRegex);
        if (re) s = s.max(MAX_LENGTH_TO_TEST).regex(re);
      }
      return s;
    }
  }
}

/**
 * Builds the validator for ONE object: a whole form or a repeater row.
 *
 * The delicate part is the conditional `required`. A required field that is
 * only shown when another equals X cannot be declared required in the shape:
 * Zod validates each key in isolation and does not see its siblings, so it
 * would reject the form even with the field hidden, which the user could never
 * fill in.
 *
 * That is why conditional fields are declared optional and their requiredness
 * is checked in a `superRefine` that does see the whole object, emitting the
 * error on the field's path so the form paints it where it belongs.
 */
export function buildObjectValidator(normalized: NormalizedField[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  const conditionals: NormalizedField[] = [];

  for (const field of normalized) {
    let schema = fieldToZod(field);
    const isConditional = field.showIf !== undefined;

    if (!field.required || isConditional) {
      schema = schema.optional();
    }
    if (isConditional && field.required) {
      conditionals.push(field);
    }
    if (field.defaultValue !== undefined) {
      schema = schema.default(field.defaultValue as never);
    }
    shape[field.key] = schema;
  }

  // passthrough: undeclared keys are kept. See header.
  const object = z.object(shape).passthrough();
  if (conditionals.length === 0) return object;

  return object.superRefine((data, ctx) => {
    for (const field of conditionals) {
      if (!isFieldVisible(field, data as Record<string, unknown>)) continue;
      const v = (data as Record<string, unknown>)[field.key];
      if (v === undefined || v === null || v === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field.key],
          message: `${field.label} is required when ${field.showIf?.field} ${field.showIf?.operator} "${field.showIf?.value}"`,
        });
      }
    }
  });
}

/** Compiles a set of field definitions (of any vocabulary). */
export function buildFieldValidator(fields: unknown) {
  return buildObjectValidator(normalizeFields(fields));
}

/** Validates an object against a set of field definitions. */
export function validateAgainstFields(
  fields: unknown,
  data: Record<string, unknown>
): { success: true; data: Record<string, unknown> } | { success: false; error: z.ZodError } {
  const result = buildFieldValidator(fields).safeParse(data);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}
