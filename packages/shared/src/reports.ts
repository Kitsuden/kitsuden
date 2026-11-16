/**
 * Reports: the aggregate query and the report definition (docs/reports.md)
 * ============================================================================
 *
 * Every other query surface returns ROWS. A report answers "how much, grouped
 * by what": deals won per month, orders per product, average ticket per stage.
 *
 *   {
 *     source:   { table: "crm_deals" },
 *     measures: [{ fn: "sum", field: "amount", as: "total" }, { fn: "count" }],
 *     groupBy:  [{ field: "closed_at", bucket: "month", as: "month" }],
 *     filters:  [{ field: "status", op: "eq", value: "won" }],
 *     orderBy:  [{ by: "month", dir: "asc" }],
 *   }
 *
 * It is DATA, not SQL: the host turns it into one statement with every
 * identifier checked against the real columns and every value bound, and runs
 * it as whoever asked, so row level security decides which rows are counted.
 *
 * This file is the shape and its checks. The SQL lives in the host.
 */

export const AGGREGATE_FUNCTIONS = ["count", "count_distinct", "sum", "avg", "min", "max"] as const;
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number];

export const DATE_BUCKETS = ["day", "week", "month", "quarter", "year"] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];

export const AGGREGATE_FILTER_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "is_null",
] as const;
export type AggregateFilterOperator = (typeof AGGREGATE_FILTER_OPERATORS)[number];

/** A table a kon declared as explorable, or a dataset by slug. Exactly one. */
export type AggregateSource =
  { table: string; dataset?: never } | { dataset: string; table?: never };

export interface AggregateMeasure {
  fn: AggregateFunction;
  /** Required for everything except `count`, which counts rows. */
  field?: string;
  /** Name of the column in the result. Default: `<fn>` or `<fn>_<field>`. */
  as?: string;
}

export interface AggregateDimension {
  field: string;
  /** Truncates a date or timestamp: `month` gives the first day of each month. */
  bucket?: DateBucket;
  as?: string;
}

export interface AggregateFilter {
  field: string;
  op: AggregateFilterOperator;
  /** `is_null` takes `true` (default) or `false`; `in` takes a list. */
  value?: unknown;
}

export interface AggregateOrder {
  /** The `as` of a measure or dimension. */
  by: string;
  dir?: "asc" | "desc";
}

export interface AggregateQuery {
  source: AggregateSource;
  measures: AggregateMeasure[];
  groupBy?: AggregateDimension[];
  filters?: AggregateFilter[];
  orderBy?: AggregateOrder[];
  /** Groups returned. Default 100, at most 1000. */
  limit?: number;
}

export const MAX_AGGREGATE_MEASURES = 10;
export const MAX_AGGREGATE_DIMENSIONS = 4;
export const MAX_AGGREGATE_FILTERS = 20;
export const MAX_AGGREGATE_GROUPS = 1000;
export const DEFAULT_AGGREGATE_GROUPS = 100;

/** A column, a jsonb key or a result alias: what may appear as an identifier. */
export const AGGREGATE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function isAggregateIdentifier(value: unknown): value is string {
  return typeof value === "string" && AGGREGATE_IDENTIFIER.test(value);
}

/** The result column of a measure when it has no `as`. */
export function measureAlias(measure: AggregateMeasure): string {
  if (measure.as) return measure.as;
  return measure.field ? `${measure.fn}_${measure.field}` : measure.fn;
}

/** The result column of a dimension when it has no `as`. */
export function dimensionAlias(dimension: AggregateDimension): string {
  if (dimension.as) return dimension.as;
  return dimension.bucket ? `${dimension.field}_${dimension.bucket}` : dimension.field;
}

/**
 * Why the query cannot run, or `null`. Checks SHAPE only: whether the table
 * may be read and whether a column exists is the host's answer, because only
 * the host knows the schema and who is asking.
 */
export function aggregateQueryProblem(query: unknown): string | null {
  const q = query as Partial<AggregateQuery> | null | undefined;
  if (!q || typeof q !== "object") return "the query must be an object";

  const source = q.source as { table?: unknown; dataset?: unknown } | undefined;
  if (!source || typeof source !== "object") return "source is required";
  const hasTable = source.table !== undefined;
  const hasDataset = source.dataset !== undefined;
  if (hasTable === hasDataset) return "source takes exactly one of table or dataset";
  if (hasTable && !isAggregateIdentifier(source.table)) return "source.table is not a valid name";
  if (
    hasDataset &&
    (typeof source.dataset !== "string" || !/^[a-z0-9][a-z0-9_-]{0,199}$/.test(source.dataset))
  ) {
    return "source.dataset must be a dataset slug";
  }

  if (!Array.isArray(q.measures) || q.measures.length === 0)
    return "at least one measure is required";
  if (q.measures.length > MAX_AGGREGATE_MEASURES) {
    return `at most ${MAX_AGGREGATE_MEASURES} measures`;
  }
  const aliases = new Set<string>();
  for (const [index, measure] of q.measures.entries()) {
    const at = `measure ${index + 1}`;
    if (!measure || typeof measure !== "object") return `${at} is not an object`;
    if (!AGGREGATE_FUNCTIONS.includes(measure.fn)) {
      return `${at}: fn must be one of ${AGGREGATE_FUNCTIONS.join(", ")}`;
    }
    if (measure.fn !== "count" && measure.field === undefined)
      return `${at}: ${measure.fn} needs a field`;
    if (measure.field !== undefined && !isAggregateIdentifier(measure.field)) {
      return `${at}: field is not a valid name`;
    }
    if (measure.as !== undefined && !isAggregateIdentifier(measure.as)) {
      return `${at}: as is not a valid name`;
    }
    const alias = measureAlias(measure);
    if (aliases.has(alias)) return `${at}: the result name "${alias}" is used twice`;
    aliases.add(alias);
  }

  const groupBy = q.groupBy ?? [];
  if (!Array.isArray(groupBy)) return "groupBy must be a list";
  if (groupBy.length > MAX_AGGREGATE_DIMENSIONS) {
    return `at most ${MAX_AGGREGATE_DIMENSIONS} dimensions in groupBy`;
  }
  for (const [index, dimension] of groupBy.entries()) {
    const at = `groupBy ${index + 1}`;
    if (!dimension || typeof dimension !== "object") return `${at} is not an object`;
    if (!isAggregateIdentifier(dimension.field)) return `${at}: field is not a valid name`;
    if (dimension.bucket !== undefined && !DATE_BUCKETS.includes(dimension.bucket)) {
      return `${at}: bucket must be one of ${DATE_BUCKETS.join(", ")}`;
    }
    if (dimension.as !== undefined && !isAggregateIdentifier(dimension.as)) {
      return `${at}: as is not a valid name`;
    }
    const alias = dimensionAlias(dimension);
    if (aliases.has(alias)) return `${at}: the result name "${alias}" is used twice`;
    aliases.add(alias);
  }

  const filters = q.filters ?? [];
  if (!Array.isArray(filters)) return "filters must be a list";
  if (filters.length > MAX_AGGREGATE_FILTERS) return `at most ${MAX_AGGREGATE_FILTERS} filters`;
  for (const [index, filter] of filters.entries()) {
    const at = `filter ${index + 1}`;
    if (!filter || typeof filter !== "object") return `${at} is not an object`;
    if (!isAggregateIdentifier(filter.field)) return `${at}: field is not a valid name`;
    if (!AGGREGATE_FILTER_OPERATORS.includes(filter.op)) {
      return `${at}: op must be one of ${AGGREGATE_FILTER_OPERATORS.join(", ")}`;
    }
    if (filter.op === "in") {
      if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 200) {
        return `${at}: "in" needs a list of 1 to 200 values`;
      }
    } else if (filter.op === "is_null") {
      if (filter.value !== undefined && typeof filter.value !== "boolean") {
        return `${at}: "is_null" takes true or false`;
      }
    } else if (
      filter.value === undefined ||
      filter.value === null ||
      typeof filter.value === "object"
    ) {
      return `${at}: "${filter.op}" needs a text, number or boolean value`;
    }
  }

  const orderBy = q.orderBy ?? [];
  if (!Array.isArray(orderBy)) return "orderBy must be a list";
  for (const [index, order] of orderBy.entries()) {
    const at = `orderBy ${index + 1}`;
    if (!order || typeof order !== "object") return `${at} is not an object`;
    if (!aliases.has(order.by))
      return `${at}: "${String(order.by)}" is not a measure or dimension of this query`;
    if (order.dir !== undefined && order.dir !== "asc" && order.dir !== "desc") {
      return `${at}: dir must be "asc" or "desc"`;
    }
  }

  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > MAX_AGGREGATE_GROUPS) {
      return `limit must be a whole number from 1 to ${MAX_AGGREGATE_GROUPS}`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report definitions
// ─────────────────────────────────────────────────────────────────────────────

export const REPORT_CHART_TYPES = ["table", "number", "bar", "line", "donut"] as const;
export type ReportChartType = (typeof REPORT_CHART_TYPES)[number];

/** How the panel should draw the result. A hint: the data is the same either way. */
export interface ReportChart {
  type: ReportChartType;
  /** Result column for the horizontal axis or the slices. */
  x?: string;
  /** Result columns to plot. */
  y?: string[];
}

/** A report a kon ships: `defineKon({ reports })`. Served as `kon:<kon id>/<id>`. */
export interface ReportDefinition {
  /** Unique inside the kon: `won-per-month`. */
  id: string;
  name: string;
  description?: string;
  query: AggregateQuery;
  chart?: ReportChart;
}

export const REPORT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function reportChartProblem(chart: unknown): string | null {
  if (chart === undefined || chart === null) return null;
  const c = chart as Partial<ReportChart>;
  if (typeof c !== "object") return "chart must be an object";
  if (!REPORT_CHART_TYPES.includes(c.type as ReportChartType)) {
    return `chart.type must be one of ${REPORT_CHART_TYPES.join(", ")}`;
  }
  if (c.x !== undefined && !isAggregateIdentifier(c.x)) return "chart.x is not a valid name";
  if (c.y !== undefined && (!Array.isArray(c.y) || !c.y.every(isAggregateIdentifier))) {
    return "chart.y must be a list of result names";
  }
  return null;
}

export function reportDefinitionProblem(report: unknown): string | null {
  const r = report as Partial<ReportDefinition> | null | undefined;
  if (!r || typeof r !== "object") return "a report must be an object";
  if (typeof r.id !== "string" || !REPORT_ID.test(r.id)) {
    return `report id "${String(r.id)}" must be lower case letters, digits and "-"`;
  }
  if (typeof r.name !== "string" || r.name.trim() === "") return `report "${r.id}" needs a name`;
  const queryProblem = aggregateQueryProblem(r.query);
  if (queryProblem) return `report "${r.id}": ${queryProblem}`;
  const chartProblem = reportChartProblem(r.chart);
  if (chartProblem) return `report "${r.id}": ${chartProblem}`;
  return null;
}
