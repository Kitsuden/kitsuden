/**
 * DataSets Calculated Fields - Backend
 *
 * Server-side calculated fields system for DataSets.
 * Lets you define Excel-style formulas that are evaluated in the backend.
 *
 * Features:
 * - Math and logic expressions
 * - References to dataset fields: {fieldName}
 * - Built-in functions: SUM, COUNT, AVG, IF, etc.
 * - Aggregations over relations
 * - Safe (sandboxed) evaluation
 */

import { z } from "zod";

import { evaluateSafeExpression } from "./safe-expression";

// ═══════════════════════════════════════════════════════════════════════════
// CALCULATED FIELD TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type CalculatedFieldType =
  | "formula" // Math/logic expression: {price} * {quantity}
  | "count" // Count related records
  | "sum" // Sum values from a relation
  | "avg" // Average
  | "min" // Minimum value
  | "max" // Maximum value
  | "concat" // Concatenate strings
  | "date_diff" // Difference between dates
  | "date_add" // Add time to a date
  | "conditional" // IF/THEN/ELSE
  | "lookup" // Look up a value in another table
  | "rollup"; // Aggregation from a relation

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

export interface CalculatedField {
  id: string;
  dataSetId: string;
  name: string; // Technical name (used in the API)
  label: string; // Label for the UI
  type: CalculatedFieldType;

  // Configuration depending on the type
  config: {
    // For type "formula"
    expression?: string; // Ej: "{price} * {quantity} * (1 - {discount})"

    // For aggregations (count, sum, avg, min, max)
    sourceTable?: string; // Source table/relation
    sourceField?: string; // Field to aggregate
    filter?: FilterConfig; // Optional filter

    // For concat
    fields?: string[]; // Fields to concatenate
    separator?: string; // Separator

    // For date_diff/date_add
    startField?: string; // Start date field
    endField?: string; // End date field
    dateField?: string; // Base field for date_add
    value?: number; // Value to add/subtract
    unit?: "days" | "hours" | "minutes" | "seconds" | "months" | "years";

    // For conditional
    condition?: ConditionConfig;
    trueValue?: any;
    falseValue?: any;

    // For lookup
    targetTable?: string;
    targetField?: string;
    matchField?: string; // Local field for matching
    returnField?: string; // Field to return

    // For rollup
    relationField?: string; // Field that defines the relation
  };

  // Output format
  format?: {
    type:
      | "text"
      | "number"
      | "currency"
      | "percentage"
      | "date"
      | "datetime"
      | "duration"
      | "badge"
      | "boolean";
    currency?: string; // For currency: "USD", "EUR"
    decimals?: number; // For number/currency
    prefix?: string; // Ej: "$"
    suffix?: string; // Ej: "%", " items"
    color?: string; // For badge
  };

  // Dependencies (fields it uses)
  dependsOn: string[];

  // Metadata
  description?: string;
  category?: string; // For grouping KPIs
  isKpi?: boolean; // Is it a headline KPI?
  target?: number; // Target value (for KPIs)
  warningThreshold?: number; // Alert threshold

  // State
  isActive: boolean;
  sortOrder: number;

  // Audit
  createdAt: Date;
  updatedAt: Date;
  createdById?: string;
}

export interface FilterConfig {
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "empty" | "not_empty";
  value?: any;
}

export interface ConditionConfig {
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "empty" | "not_empty" | "in";
  value?: any;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMAS ZOD
// ═══════════════════════════════════════════════════════════════════════════

export const filterConfigSchema = z.object({
  field: z.string(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "empty", "not_empty"]),
  value: z.any().optional(),
});

export const conditionConfigSchema = z.object({
  field: z.string(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "empty", "not_empty", "in"]),
  value: z.any().optional(),
});

export const calculatedFieldConfigSchema = z.object({
  expression: z.string().max(2000).optional(),
  sourceTable: z.string().optional(),
  sourceField: z.string().optional(),
  filter: filterConfigSchema.optional(),
  fields: z.array(z.string()).optional(),
  separator: z.string().optional(),
  startField: z.string().optional(),
  endField: z.string().optional(),
  dateField: z.string().optional(),
  value: z.number().optional(),
  unit: z.enum(["days", "hours", "minutes", "seconds", "months", "years"]).optional(),
  condition: conditionConfigSchema.optional(),
  trueValue: z.any().optional(),
  falseValue: z.any().optional(),
  targetTable: z.string().optional(),
  targetField: z.string().optional(),
  matchField: z.string().optional(),
  returnField: z.string().optional(),
  relationField: z.string().optional(),
});

export const formatConfigSchema = z.object({
  type: z.enum([
    "text",
    "number",
    "currency",
    "percentage",
    "date",
    "datetime",
    "duration",
    "badge",
    "boolean",
  ]),
  currency: z.string().optional(),
  decimals: z.number().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  color: z.string().optional(),
});

export const createCalculatedFieldSchema = z.object({
  dataSetId: z.guid(),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Must start with letter, only letters/numbers/underscores"),
  label: z.string().min(1).max(200),
  type: z.enum([
    "formula",
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "concat",
    "date_diff",
    "date_add",
    "conditional",
    "lookup",
    "rollup",
  ]),
  config: calculatedFieldConfigSchema,
  format: formatConfigSchema.optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  isKpi: z.boolean().optional(),
  target: z.number().optional(),
  warningThreshold: z.number().optional(),
  dependsOn: z.array(z.string()).default([]),
});

export const updateCalculatedFieldSchema = createCalculatedFieldSchema
  .partial()
  .omit({ dataSetId: true })
  .extend({
    // Editable only on UPDATE (the table has them with defaults on CREATE).
    // Without this, Zod dropped them in the safeParse and the PATCH could never
    // enable/disable a field or reorder it.
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  });

// ═══════════════════════════════════════════════════════════════════════════
// FORMULA EVALUATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export interface EvaluationContext {
  row: Record<string, unknown>; // Current record
  entries?: Record<string, unknown>[]; // Related entries (for aggregations)
  relatedData?: Record<string, unknown>; // Relation data
  now?: Date; // Current date (for testing)
}

/**
 * Evaluates a math/logic expression
 * E.g.: "{price} * {quantity} * (1 - {discount})"
 *
 * It used to be `new Function("return " + expression)()` with the field values
 * pasted in as text: code execution on the server for anyone who
 * could save a formula or a text value ending in `\`. Now
 * `evaluateSafeExpression` interprets it (see `safe-expression.ts`). Any
 * error still returns `null`.
 */
export function evaluateExpression(expression: string, context: EvaluationContext): any {
  try {
    return evaluateSafeExpression(expression, context.row ?? {});
  } catch (err) {
    console.error(
      "Expression evaluation error:",
      err instanceof Error ? err.message : String(err),
      "Expression:",
      String(expression).slice(0, 200)
    );
    return null;
  }
}

/**
 * Equality for dataset filters.
 *
 * Neither `==` nor `===` works here. The filter value arrives from JSON, almost
 * always as text, `"30"`, and the row's comes from a JSONB column, where
 * that same datum may be stored as a number. With `===`, the filter
 * `age eq 30` would find nothing. With `==` it would, but `==` brings its
 * traps: `"" == 0` and `"0" == false` are true, so a filter `eq 0`
 * would end up matching rows whose field is EMPTY. In a CMS those are
 * wrong results, not a style detail.
 *
 * So coercion is applied on purpose only where it means something (text↔number,
 * text↔boolean, dates) and the empty value is left out. The same rule is used by
 * `eq`, `neq` and `in`, which before did not agree with each other.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // "No value" is ONE single thing: null and undefined are not told apart, but
  // they do not match anything else either (not 0, not "", not false).
  const toEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (toEmpty || bEmpty) return toEmpty && bEmpty;

  // Two dates with the same instant are equal even if they are different objects.
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : Date.parse(String(a));
    const tb = b instanceof Date ? b.getTime() : Date.parse(String(b));
    return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
  }

  // Boolean against text: "true"/"false" are valid, which is what a
  // form sends. 0/1/"" are NOT valid; there `==` gets it right by accident and gets it wrong
  // as soon as the field is empty.
  if (typeof a === "boolean" || typeof b === "boolean") {
    const asBool = (v: unknown): boolean | null =>
      typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null;
    const ab = asBool(a);
    const bb = asBool(b);
    return ab !== null && bb !== null && ab === bb;
  }

  // Number against text: compared as a number. The empty or blank string
  // is NOT zero — it is exactly the case that broke the loose operator.
  if (typeof a === "number" || typeof b === "number") {
    const num = typeof a === "number" ? a : (b as number);
    const other = typeof a === "number" ? b : a;
    if (typeof other !== "string" || other.trim() === "") return false;
    const n = Number(other);
    return Number.isFinite(n) && n === num;
  }

  return false;
}

/**
 * Evaluates a condition
 */
export function evaluateCondition(condition: ConditionConfig, context: EvaluationContext): boolean {
  const { row } = context;
  const fieldValue = row[condition.field];
  const compareValue = condition.value;

  switch (condition.operator) {
    case "eq":
      return sameValue(fieldValue, compareValue);
    case "neq":
      return !sameValue(fieldValue, compareValue);
    case "gt":
      return Number(fieldValue) > Number(compareValue);
    case "gte":
      return Number(fieldValue) >= Number(compareValue);
    case "lt":
      return Number(fieldValue) < Number(compareValue);
    case "lte":
      return Number(fieldValue) <= Number(compareValue);
    case "contains":
      return String(fieldValue).includes(String(compareValue));
    case "empty":
      return fieldValue === null || fieldValue === undefined || fieldValue === "";
    case "not_empty":
      return fieldValue !== null && fieldValue !== undefined && fieldValue !== "";
    case "in":
      // Same rule as `eq`: this used to use `includes`, that is `===`, and
      // that is why `eq 30` found a `"30"` stored as text but
      // `in [30]` did not. Two sibling operators cannot disagree.
      return Array.isArray(compareValue) && compareValue.some((v) => sameValue(fieldValue, v));
    default:
      return false;
  }
}

/**
 * Aggregation functions
 */
export const aggregationFunctions = {
  sum: (entries: any[], field: string): number => {
    return entries.reduce((acc, entry) => acc + (Number(entry[field]) || 0), 0);
  },

  count: (entries: any[]): number => entries.length,

  avg: (entries: any[], field: string): number => {
    if (!entries.length) return 0;
    const sum = aggregationFunctions.sum(entries, field);
    return sum / entries.length;
  },

  min: (entries: any[], field: string): number => {
    if (!entries.length) return 0;
    return Math.min(...entries.map((e) => Number(e[field]) || Infinity));
  },

  max: (entries: any[], field: string): number => {
    if (!entries.length) return 0;
    return Math.max(...entries.map((e) => Number(e[field]) || -Infinity));
  },
};

/**
 * Date functions
 */
export const dateFunctions = {
  diff: (start: Date, end: Date, unit: string): number => {
    const diffMs = end.getTime() - start.getTime();
    switch (unit) {
      case "seconds":
        return Math.floor(diffMs / 1000);
      case "minutes":
        return Math.floor(diffMs / (1000 * 60));
      case "hours":
        return Math.floor(diffMs / (1000 * 60 * 60));
      case "days":
        return Math.floor(diffMs / (1000 * 60 * 60 * 24));
      case "months":
        return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30));
      case "years":
        return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 365));
      default:
        return diffMs;
    }
  },

  add: (date: Date, value: number, unit: string): Date => {
    const result = new Date(date);
    switch (unit) {
      case "seconds":
        result.setSeconds(result.getSeconds() + value);
        break;
      case "minutes":
        result.setMinutes(result.getMinutes() + value);
        break;
      case "hours":
        result.setHours(result.getHours() + value);
        break;
      case "days":
        result.setDate(result.getDate() + value);
        break;
      case "months":
        result.setMonth(result.getMonth() + value);
        break;
      case "years":
        result.setFullYear(result.getFullYear() + value);
        break;
    }
    return result;
  },

  now: (): Date => new Date(),

  today: (): Date => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EVALUATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluates a complete calculated field
 */
export function evaluateCalculatedField(field: CalculatedField, context: EvaluationContext): any {
  const { config, type } = field;

  /**
   * Converts a row value into a date, or `null`.
   *
   * `context.row` is `Record<string, unknown>`: anything someone saved in the
   * field can arrive here. `new Date(unknown)` does not compile,
   * but forcing it with a cast is no good either, and not because of the types:
   *
   *     new Date(true)  →  1970-01-01T00:00:00.000Z
   *
   * **It is not an invalid date.** The `isNaN(...getTime())` that was below accepted it,
   * so a boolean field (or the number 0) became
   * a 1970 date and the calculated field returned a 56-year difference
   * without anything failing.
   *
   * Only the three types that truly represent a date pass.
   */
  const asDate = (v: unknown): Date | null => {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v !== "string" && typeof v !== "number") return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };

  try {
    switch (type) {
      case "formula": {
        if (!config.expression) return null;
        return evaluateExpression(config.expression, context);
      }

      case "conditional": {
        if (!config.condition) return null;
        const conditionMet = evaluateCondition(config.condition, context);
        return conditionMet ? config.trueValue : config.falseValue;
      }

      case "concat": {
        if (!config.fields) return null;
        const values = config.fields.map((f) => context.row[f] || "");
        return values.join(config.separator || " ");
      }

      case "date_diff": {
        if (!config.startField || !config.endField) return null;
        const start = asDate(context.row[config.startField]);
        const end = asDate(context.row[config.endField]);
        if (!start || !end) return null;
        return dateFunctions.diff(start, end, config.unit || "days");
      }

      case "date_add": {
        if (!config.dateField || config.value === undefined) return null;
        const date = asDate(context.row[config.dateField]);
        if (!date) return null;
        return dateFunctions.add(date, config.value, config.unit || "days");
      }

      case "count":
      case "sum":
      case "avg":
      case "min":
      case "max": {
        // These require related data passed in context.entries
        if (!context.entries || !config.sourceField) return null;
        const func = aggregationFunctions[type];
        return func(context.entries, config.sourceField);
      }

      case "rollup": {
        // Aggregation from a relation
        if (!context.entries || !config.sourceField) return null;
        // Apply filter if present
        let entries = context.entries;
        if (config.filter) {
          entries = entries.filter((e) => {
            const value = e[config.filter!.field];
            switch (config.filter!.operator) {
              case "eq":
                return sameValue(value, config.filter!.value);
              case "neq":
                return !sameValue(value, config.filter!.value);
              case "gt":
                return Number(value) > Number(config.filter!.value);
              case "lt":
                return Number(value) < Number(config.filter!.value);
              default:
                return true;
            }
          });
        }
        return aggregationFunctions.sum(entries, config.sourceField);
      }

      case "lookup": {
        // Look up a value in related data
        if (!context.relatedData || !config.returnField) return null;
        const matchValue = context.row[config.matchField!];
        // `relatedData[table]` is `unknown`: with a badly saved
        // lookup configuration, `.find` blows up at runtime instead of not finding anything.
        const relatedItems = context.relatedData[config.targetTable!];
        const found = Array.isArray(relatedItems)
          ? relatedItems.find(
              (item: Record<string, unknown>) => item[config.targetField!] === matchValue
            )
          : undefined;
        return found?.[config.returnField] || null;
      }

      default:
        return null;
    }
  } catch (err) {
    console.error(`Error evaluating calculated field "${field.name}":`, err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RESULT FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

export function formatCalculatedValue(value: any, format?: CalculatedField["format"]): any {
  if (value === null || value === undefined) return null;
  if (!format) return value;

  switch (format.type) {
    case "number": {
      const num = Number(value);
      if (isNaN(num)) return value;
      return format.decimals !== undefined ? num.toFixed(format.decimals) : num;
    }

    case "currency": {
      const currency = Number(value);
      if (isNaN(currency)) return value;
      const formatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: format.currency || "USD",
        minimumFractionDigits: format.decimals || 2,
        maximumFractionDigits: format.decimals || 2,
      }).format(currency);
      return format.prefix ? `${format.prefix}${formatted}` : formatted;
    }

    case "percentage": {
      const pct = Number(value);
      if (isNaN(pct)) return value;
      const formatted =
        format.decimals !== undefined
          ? `${(pct * 100).toFixed(format.decimals)}%`
          : `${(pct * 100).toFixed(0)}%`;
      return format.suffix ? `${formatted}${format.suffix}` : formatted;
    }

    case "date":
    case "datetime": {
      if (!(value instanceof Date) && typeof value !== "string") return value;
      const date = value instanceof Date ? value : new Date(value);
      if (isNaN(date.getTime())) return value;
      return date.toISOString();
    }

    case "duration": {
      const seconds = Number(value);
      if (isNaN(seconds)) return value;
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      if (hours > 0) return `${hours}h ${mins}m`;
      if (mins > 0) return `${mins}m ${secs}s`;
      return `${secs}s`;
    }

    case "boolean": {
      return Boolean(value);
    }

    case "badge":
    case "text":
    default: {
      let result = String(value);
      if (format.prefix) result = format.prefix + result;
      if (format.suffix) result = result + format.suffix;
      return result;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNCTIONS FOR THE FORMULA BUILDER
// ═══════════════════════════════════════════════════════════════════════════

export const FORMULA_FUNCTIONS = [
  {
    id: "abs",
    name: "Absolute",
    description: "Absolute value",
    example: "ABS(-5) → 5",
    category: "math",
  },
  {
    id: "round",
    name: "Round",
    description: "Round number",
    example: "ROUND(3.14159, 2) → 3.14",
    category: "math",
  },
  {
    id: "ceil",
    name: "Ceiling",
    description: "Round up",
    example: "CEIL(3.2) → 4",
    category: "math",
  },
  {
    id: "floor",
    name: "Floor",
    description: "Round down",
    example: "FLOOR(3.8) → 3",
    category: "math",
  },
  {
    id: "sqrt",
    name: "Square Root",
    description: "Square root",
    example: "SQRT(16) → 4",
    category: "math",
  },
  { id: "pow", name: "Power", description: "Power", example: "POW(2, 3) → 8", category: "math" },
  {
    id: "len",
    name: "Length",
    description: "Text length",
    example: "LEN('hello') → 5",
    category: "text",
  },
  {
    id: "upper",
    name: "Uppercase",
    description: "Uppercase",
    example: "UPPER('hello') → 'HELLO'",
    category: "text",
  },
  {
    id: "lower",
    name: "Lowercase",
    description: "Lowercase",
    example: "LOWER('HELLO') → 'hello'",
    category: "text",
  },
  {
    id: "trim",
    name: "Trim",
    description: "Trim whitespace",
    example: "TRIM('  hello  ') → 'hello'",
    category: "text",
  },
  {
    id: "concat",
    name: "Concatenate",
    description: "Join texts",
    example: "CONCAT('Hello', ' ', 'World')",
    category: "text",
  },
  {
    id: "substring",
    name: "Substring",
    description: "Extract part",
    example: "SUBSTRING('hello', 0, 3) → 'hel'",
    category: "text",
  },
  {
    id: "now",
    name: "Now",
    description: "Current date/time",
    example: "NOW() → 2026-03-19",
    category: "date",
  },
  {
    id: "today",
    name: "Today",
    description: "Current date",
    example: "TODAY() → 2026-03-19",
    category: "date",
  },
  {
    id: "year",
    name: "Year",
    description: "Year of date",
    example: "YEAR({createdAt}) → 2026",
    category: "date",
  },
  {
    id: "month",
    name: "Month",
    description: "Month of date",
    example: "MONTH({createdAt}) → 3",
    category: "date",
  },
  {
    id: "day",
    name: "Day",
    description: "Day of date",
    example: "DAY({createdAt}) → 19",
    category: "date",
  },
  {
    id: "datediff",
    name: "Date Diff",
    description: "Date difference",
    example: "DATEDIFF({start}, {end}, 'days')",
    category: "date",
  },
  {
    id: "if",
    name: "If",
    description: "Conditional",
    example: "IF({status}='active', 1, 0)",
    category: "logic",
  },
  {
    id: "and",
    name: "And",
    description: "Logical AND",
    example: "AND({a}>0, {b}<100)",
    category: "logic",
  },
  {
    id: "or",
    name: "Or",
    description: "Logical OR",
    example: "OR({status}='a', {status}='b')",
    category: "logic",
  },
  { id: "not", name: "Not", description: "Negation", example: "NOT({active})", category: "logic" },
  {
    id: "coalesce",
    name: "Coalesce",
    description: "First non-null",
    example: "COALESCE({nickname}, {name})",
    category: "logic",
  },
  {
    id: "sum",
    name: "Sum",
    description: "Sum values",
    example: "SUM({items}, 'price')",
    category: "aggregate",
  },
  {
    id: "count",
    name: "Count",
    description: "Count items",
    example: "COUNT({items})",
    category: "aggregate",
  },
  {
    id: "avg",
    name: "Average",
    description: "Average",
    example: "AVG({items}, 'price')",
    category: "aggregate",
  },
  {
    id: "min",
    name: "Minimum",
    description: "Minimum value",
    example: "MIN({items}, 'price')",
    category: "aggregate",
  },
  {
    id: "max",
    name: "Maximum",
    description: "Maximum value",
    example: "MAX({items}, 'price')",
    category: "aggregate",
  },
] as const;

export const FORMULA_OPERATORS = [
  { id: "+", name: "Add", symbol: "+", description: "Sum", precedence: 2 },
  { id: "-", name: "Subtract", symbol: "-", description: "Subtraction", precedence: 2 },
  { id: "*", name: "Multiply", symbol: "×", description: "Multiplication", precedence: 3 },
  { id: "/", name: "Divide", symbol: "÷", description: "Division", precedence: 3 },
  { id: "%", name: "Modulo", symbol: "%", description: "Remainder", precedence: 3 },
  { id: "^", name: "Power", symbol: "^", description: "Power", precedence: 4 },
  { id: "==", name: "Equals", symbol: "=", description: "Equal", precedence: 1 },
  { id: "!=", name: "Not Equals", symbol: "≠", description: "Not equal", precedence: 1 },
  { id: ">", name: "Greater", symbol: ">", description: "Greater than", precedence: 1 },
  {
    id: ">=",
    name: "Greater Eq",
    symbol: "≥",
    description: "Greater than or equal",
    precedence: 1,
  },
  { id: "<", name: "Less", symbol: "<", description: "Less than", precedence: 1 },
  { id: "<=", name: "Less Eq", symbol: "≤", description: "Less than or equal", precedence: 1 },
  { id: "&", name: "Concat", symbol: "&", description: "Concatenate", precedence: 1 },
] as const;
