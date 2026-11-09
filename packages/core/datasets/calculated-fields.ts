/**
 * Calculated Fields / KPI System
 *
 * Calculated fields system for datasets and tables.
 * Lets you define metrics and formulas that are evaluated in real time.
 */

export type CalculatedFieldType =
  | "formula" // Math/logic expression
  | "count" // Count related records
  | "sum" // Sum values
  | "average" // Average
  | "min" // Minimum value
  | "max" // Maximum value
  | "concat" // Concatenate strings
  | "date_diff" // Difference between dates
  | "conditional" // IF/THEN/ELSE
  | "lookup"; // Look up a value in another table

export interface CalculatedField {
  id: string;
  name: string;
  label: string;
  type: CalculatedFieldType;

  // Configuration depending on the type
  config: {
    // For type "formula"
    expression?: string; // Ej: "{price} * {quantity} * (1 - {discount})"

    // For aggregations (count, sum, average, min, max)
    sourceTable?: string; // Source table
    sourceField?: string; // Field to aggregate
    filter?: FilterConfig; // Optional filter

    // For concat
    fields?: string[]; // Fields to concatenate
    separator?: string; // Separator

    // For date_diff
    startField?: string; // Start date field
    endField?: string; // End date field
    unit?: "days" | "hours" | "minutes" | "seconds";

    // For conditional
    condition?: {
      field: string;
      operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "empty";
      value?: any;
    };
    trueValue?: any;
    falseValue?: any;

    // For lookup
    targetTable?: string;
    targetField?: string;
    matchField?: string; // Local field for matching
    returnField?: string; // Field to return
  };

  // Output format
  format?: {
    type: "text" | "number" | "currency" | "percentage" | "date" | "duration" | "badge";
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
}

export interface FilterConfig {
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";
  value: any;
}

// Visual builder for creating formulas
export interface FormulaBuilderNode {
  id: string;
  type: "field" | "operator" | "function" | "value" | "group";
  value: any;
  children?: FormulaBuilderNode[];
}

// Functions available in the builder
export const FORMULA_FUNCTIONS = [
  { id: "abs", name: "Absolute", description: "Absolute value", example: "ABS(-5) → 5" },
  {
    id: "round",
    name: "Round",
    description: "Round number",
    example: "ROUND(3.14159, 2) → 3.14",
  },
  { id: "ceil", name: "Ceiling", description: "Round up", example: "CEIL(3.2) → 4" },
  { id: "floor", name: "Floor", description: "Round down", example: "FLOOR(3.8) → 3" },
  { id: "len", name: "Length", description: "Text length", example: "LEN('hello') → 5" },
  {
    id: "upper",
    name: "Uppercase",
    description: "Uppercase",
    example: "UPPER('hello') → 'HELLO'",
  },
  {
    id: "lower",
    name: "Lowercase",
    description: "Lowercase",
    example: "LOWER('HELLO') → 'hello'",
  },
  {
    id: "trim",
    name: "Trim",
    description: "Trim whitespace",
    example: "TRIM('  hello  ') → 'hello'",
  },
  { id: "now", name: "Now", description: "Current date/time", example: "NOW() → 2026-03-18" },
  { id: "today", name: "Today", description: "Current date", example: "TODAY() → 2026-03-18" },
  { id: "year", name: "Year", description: "Year of date", example: "YEAR({createdAt}) → 2026" },
  { id: "month", name: "Month", description: "Month of date", example: "MONTH({createdAt}) → 3" },
  { id: "day", name: "Day", description: "Day of date", example: "DAY({createdAt}) → 18" },
  { id: "if", name: "If", description: "Conditional", example: "IF({status}='active', 1, 0)" },
  { id: "and", name: "And", description: "Logical AND", example: "AND({a}>0, {b}<100)" },
  { id: "or", name: "Or", description: "Logical OR", example: "OR({status}='a', {status}='b')" },
  { id: "not", name: "Not", description: "Negation", example: "NOT({active})" },
  {
    id: "coalesce",
    name: "Coalesce",
    description: "First non-null",
    example: "COALESCE({nickname}, {name})",
  },
] as const;

// Operators
export const FORMULA_OPERATORS = [
  { id: "+", name: "Add", symbol: "+", description: "Sum" },
  { id: "-", name: "Subtract", symbol: "-", description: "Subtraction" },
  { id: "*", name: "Multiply", symbol: "×", description: "Multiplication" },
  { id: "/", name: "Divide", symbol: "÷", description: "Division" },
  { id: "%", name: "Modulo", symbol: "%", description: "Remainder" },
  { id: "^", name: "Power", symbol: "^", description: "Power" },
  { id: "==", name: "Equals", symbol: "=", description: "Equal" },
  { id: "!=", name: "Not Equals", symbol: "≠", description: "Not equal" },
  { id: ">", name: "Greater", symbol: ">", description: "Greater than" },
  { id: ">=", name: "Greater Eq", symbol: "≥", description: "Greater than or equal" },
  { id: "<", name: "Less", symbol: "<", description: "Less than" },
  { id: "<=", name: "Less Eq", symbol: "≤", description: "Less than or equal" },
  { id: "&", name: "Concat", symbol: "&", description: "Concatenate" },
] as const;
