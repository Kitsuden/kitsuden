import { t } from "$lib/i18n";

import { evaluateFormula } from "./evaluate";
/**
 * Calculated Fields / KPI Components
 *
 * Components to create and manage calculated fields in datasets.
 */

export { default as FormulaBuilder } from "./FormulaBuilder.svelte";
export { default as KpiCreator } from "./KpiCreator.svelte";

// Inline type definitions (avoiding external dependency)
export type CalculatedFieldType =
  | "formula"
  | "count"
  | "sum"
  | "average"
  | "min"
  | "max"
  | "concat"
  | "date_diff"
  | "conditional"
  | "lookup";

export interface FilterConfig {
  field: string;
  operator: string;
  value?: any;
}

export interface CalculatedField {
  id: string;
  name: string;
  label: string;
  type: CalculatedFieldType;
  config: {
    expression?: string;
    sourceTable?: string;
    sourceField?: string;
    filter?: FilterConfig;
    fields?: string[];
    separator?: string;
    startField?: string;
    endField?: string;
    unit?: "days" | "hours" | "minutes" | "seconds";
    condition?: {
      field: string;
      operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "empty";
      value?: any;
    };
    trueValue?: string;
    falseValue?: string;
    lookupTable?: string;
    lookupField?: string;
    lookupKey?: string;
  };
  format?: {
    type: string;
    currency?: string;
    decimals?: number;
    prefix?: string;
    suffix?: string;
  };
  dependsOn?: string[];
  isKpi?: boolean;
  target?: number;
  warningThreshold?: number;
}

export interface FormulaBuilderNode {
  type: "field" | "operator" | "function" | "value";
  value: string;
  children?: FormulaBuilderNode[];
}

export const FORMULA_FUNCTIONS = [
  { id: "abs", label: "ABS", description: t("index.absoluteValue") },
  { id: "round", label: t("index.round"), description: t("index.roundDescription") },
  { id: "ceil", label: "CEIL", description: t("index.roundUp") },
  { id: "floor", label: t("index.floor"), description: t("index.roundDown") },
  { id: "min", label: "MIN", description: t("index.minValue") },
  { id: "max", label: "MAX", description: t("index.maxValue") },
  { id: "sum", label: "SUM", description: t("index.sum") },
  { id: "avg", label: "AVG", description: t("index.average") },
  { id: "count", label: t("index.count"), description: t("index.countDescription") },
  { id: "if", label: "IF", description: t("index.conditional") },
  { id: "and", label: "AND", description: t("index.andLogical") },
  { id: "or", label: "OR", description: t("index.logicalOr") },
  { id: "not", label: "NOT", description: t("index.negation") },
  { id: "concat", label: t("index.concat"), description: t("index.concatenate") },
  { id: "length", label: t("index.length"), description: t("index.length") },
  { id: "upper", label: t("index.upper"), description: t("index.uppercase") },
  { id: "lower", label: t("index.lower"), description: t("index.lowercase") },
  { id: "substring", label: t("index.substring"), description: t("index.subcadena") },
  { id: "replace", label: t("index.replace"), description: t("index.replaceDescription") },
  { id: "date_diff", label: t("index.dateDiff"), description: t("index.dateDifference") },
  { id: "now", label: "NOW", description: t("index.currentDate") },
  { id: "today", label: t("index.today"), description: t("index.hoy") },
];

export const FORMULA_OPERATORS = [
  { id: "+", label: "+", description: t("index.sum") },
  { id: "-", label: "-", description: t("index.subtracts") },
  { id: "*", label: "×", description: t("index.multiplication") },
  { id: "/", label: "÷", description: t("index.division") },
  { id: "%", label: "%", description: t("index.module") },
  { id: "^", label: "^", description: t("index.strength") },
  { id: "=", label: "=", description: t("index.equal") },
  { id: "!=", label: "≠", description: t("index.different") },
  { id: ">", label: ">", description: t("index.greaterThan") },
  { id: ">=", label: "≥", description: t("index.greaterOrEqual") },
  { id: "<", label: "<", description: t("index.lessThan") },
  { id: "<=", label: "≤", description: t("index.lessOrEqual") },
  { id: "&", label: "&", description: t("index.concatenate") },
];

export const fieldPresets = {
  price: { type: "number", label: t("index.price") },
  quantity: { type: "number", label: t("index.amount") },
  discount: { type: "number", label: t("index.discount") },
  subtotal: { type: "number", label: t("index.subtotal") },
  tax: { type: "number", label: t("index.tax") },
  total: { type: "number", label: t("index.total") },
};

export const calculatedHelpers = {
  // Helper functions for calculated fields
  evaluateExpression: (expression: string, context: Record<string, any>): number => {
    // A parser, not the Function constructor: the panel's CSP has no 'unsafe-eval' (./evaluate.ts)
    try {
      const v = evaluateFormula(expression, context);
      return typeof v === "number" ? v : Number(v) || 0;
    } catch {
      return 0;
    }
  },
};
