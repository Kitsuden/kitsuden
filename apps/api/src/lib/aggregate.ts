/**
 * Aggregate queries: from data to one SQL statement (docs/reports.md)
 * ============================================================================
 *
 * `AggregateQuery` (packages/shared/src/reports.ts) says WHAT to compute. This
 * file decides whether it may be computed and writes the SQL.
 *
 * ── THE THREE WALLS ────────────────────────────────────────────────────────
 *
 *   1. WHICH TABLES. Only a table some installed kon declared (the same
 *      allowlist as the data explorer, minus the explorer's own core tables)
 *      or a dataset. Never a forbidden table, whoever asks.
 *   2. WHICH COLUMNS. Every field is looked up in the table's real columns;
 *      a column that holds a secret (by name) is refused in any position:
 *      `min(api_token)` and `GROUP BY password_hash` read values just as well
 *      as a SELECT does.
 *   3. WHICH ROWS. The statement runs on the request's connection, as whoever
 *      asked, so the table's row policies decide what is counted. A table
 *      with no policies counts every row: that is why the operation is for
 *      administrators and for agents holding the scope.
 *
 * ── HOW THE SQL IS WRITTEN ─────────────────────────────────────────────────
 *
 * Identifiers go through `sql.identifier` AFTER being found in the catalog;
 * values are always bound parameters; the only raw fragments are keywords
 * chosen from fixed lists in this file. Nothing from the request is ever
 * concatenated.
 *
 * Dataset fields live in `data_entries.data` (jsonb), where anything may be
 * stored. A number is read with a guard (`CASE WHEN … ~ '^-?[0-9]…'`) so one
 * row with "n/a" in a numeric field gives a NULL, not a failed report.
 */

// Deep imports, not the facade: the facade reaches the loader, which imports this file.
import {
  DEFAULT_AGGREGATE_GROUPS,
  aggregateQueryProblem,
  dimensionAlias,
  measureAlias,
  schemaFields,
  type AggregateDimension,
  type AggregateFilter,
  type AggregateMeasure,
  type AggregateQuery,
} from "@kitsuden/shared";
import { sql, type SQL } from "drizzle-orm";

import { resolveExecutor } from "../../../../packages/engine/src/request-scope";
import { isSecretColumn } from "../../../../packages/engine/src/secret-columns";
import { db } from "../db";

import type { SensitivityCatalog } from "./customer-data";
import { loadSensitivityCatalog } from "./customer-data-catalog";
import { FORBIDDEN_TABLES, isForbiddenNativeTable, tableIsExplorable } from "./explorable-tables";

// ─────────────────────────────────────────────────────────────────────────────
// Catalog: what a source is made of
// ─────────────────────────────────────────────────────────────────────────────

type ColumnKind = "number" | "time" | "boolean" | "text" | "json";

interface TableCatalog {
  kind: "table";
  table: string;
  columns: Map<string, ColumnKind>;
}

interface DatasetCatalog {
  kind: "dataset";
  datasetId: string;
  slug: string;
  /** Declared fields and what they hold; an undeclared key is read as text. */
  fields: Map<string, ColumnKind>;
}

type Catalog = TableCatalog | DatasetCatalog;

/** A request that cannot be answered: 400 (the query), 403 (the source) or 404. */
export class AggregateError extends Error {
  readonly status: 400 | 403 | 404;
  constructor(status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = "AggregateError";
    this.status = status;
  }
}

const NUMERIC_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "money",
]);
const TIME_TYPES = new Set(["date", "timestamp without time zone", "timestamp with time zone"]);

function columnKind(dataType: string): ColumnKind {
  if (NUMERIC_TYPES.has(dataType)) return "number";
  if (TIME_TYPES.has(dataType)) return "time";
  if (dataType === "boolean") return "boolean";
  if (dataType === "json" || dataType === "jsonb" || dataType === "ARRAY") return "json";
  return "text";
}

/** The columns of the dataset's own row, usable next to the fields of `data`. */
const ENTRY_COLUMNS = new Map<string, ColumnKind>([
  ["status", "text"],
  ["owner_id", "text"],
  ["created_at", "time"],
  ["updated_at", "time"],
]);

const FIELD_KIND: Record<string, ColumnKind> = {
  number: "number",
  boolean: "boolean",
  date: "time",
  datetime: "time",
  kpi: "number",
};

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

async function tableCatalog(table: string): Promise<TableCatalog> {
  if (FORBIDDEN_TABLES.has(table) || isForbiddenNativeTable(table)) {
    throw new AggregateError(403, `The table "${table}" cannot be used in a report.`);
  }
  // Only what a kon declared: the explorer's own core tables (users, settings…) are not report material.
  const verdict = await tableIsExplorable(table, []);
  if (!verdict.allowed) {
    throw new AggregateError(
      403,
      `The table "${table}" is not declared by any installed kon, so it cannot be used in a report.`
    );
  }
  // A schema question, asked as the system: a row policy must not hide the columns.
  const columns = rowsOf<{ column_name: string; data_type: string }>(
    await db.execute(sql`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${table}`)
  );
  if (columns.length === 0) throw new AggregateError(404, `The table "${table}" does not exist.`);
  return {
    kind: "table",
    table,
    columns: new Map(columns.map((c) => [c.column_name, columnKind(c.data_type)])),
  };
}

async function datasetCatalog(slug: string): Promise<DatasetCatalog> {
  // As the caller: a dataset they cannot see is, for them, a dataset that does not exist.
  const found = rowsOf<{ id: string; schema: unknown }>(
    await resolveExecutor(db).execute(
      sql`SELECT id, schema FROM data_sets WHERE slug = ${slug} LIMIT 1`
    )
  );
  if (found.length === 0) throw new AggregateError(404, `There is no dataset "${slug}".`);
  const fields = new Map<string, ColumnKind>();
  for (const field of schemaFields(found[0].schema) as Array<Record<string, unknown>>) {
    const key = String(field.key ?? field.fieldName ?? field.name ?? "");
    const type = String(field.type ?? field.fieldType ?? "text");
    if (key) fields.set(key, FIELD_KIND[type] ?? "text");
  }
  return { kind: "dataset", datasetId: String(found[0].id), slug, fields };
}

// ─────────────────────────────────────────────────────────────────────────────
// Expressions
// ─────────────────────────────────────────────────────────────────────────────

interface Resolved {
  kind: ColumnKind;
  /** The value as stored: a column, or the text of a jsonb key. */
  raw: SQL;
  /** The value as a number (NULL when it is not one). */
  number: SQL;
  /** The value as a timestamp (NULL when it does not look like one). */
  time: SQL;
  text: SQL;
}

const LOOKS_NUMERIC = "^-?[0-9]+(\\.[0-9]+)?$";
const LOOKS_LIKE_DATE =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?)?$";

/** What the query may do beyond the three walls: set by who is asking. */
interface Policy {
  /**
   * Columns marked `customer` or `personal` (kon.json `sensitivity`, dataset field `sensitivity`)
   * cannot be read through the result: no grouping, no min/max, no sum/avg, no filter on their
   * value. Counting rows and checking for nulls stay allowed. For agents.
   */
  marks: SensitivityCatalog | null;
}

/** `value`: the query can learn what the column holds. `presence`: only whether there is one. */
type Use = "value" | "presence";

function isMarked(policy: Policy, catalog: Catalog, field: string): boolean {
  const marks = policy.marks;
  if (!marks) return false;
  if (marks.global.has(field)) return true;
  return catalog.kind === "dataset" && (marks.datasets.get(catalog.slug)?.has(field) ?? false);
}

function resolveField(
  policy: Policy,
  catalog: Catalog,
  field: string,
  where: string,
  use: Use = "value"
): Resolved {
  if (isSecretColumn(field)) {
    throw new AggregateError(
      403,
      `${where}: "${field}" holds a secret and cannot be used in a report.`
    );
  }
  if (use === "value" && isMarked(policy, catalog, field)) {
    throw new AggregateError(
      403,
      `${where}: "${field}" is marked as customer or personal data, so an agent cannot read its values through a report (counting rows and checking for empty values is allowed).`
    );
  }
  if (catalog.kind === "table") {
    const kind = catalog.columns.get(field);
    if (!kind) {
      throw new AggregateError(
        400,
        `${where}: the table "${catalog.table}" has no column "${field}".`
      );
    }
    const column = sql`${sql.identifier(field)}`;
    return {
      kind,
      raw: column,
      number: kind === "number" ? sql`${column}::numeric` : sql`NULL::numeric`,
      time: kind === "time" ? sql`${column}::timestamptz` : sql`NULL::timestamptz`,
      text: sql`${column}::text`,
    };
  }

  const entryKind = ENTRY_COLUMNS.get(field);
  if (entryKind) {
    const column = sql`${sql.identifier(field)}`;
    return {
      kind: entryKind,
      raw: column,
      number: sql`NULL::numeric`,
      time: entryKind === "time" ? sql`${column}::timestamptz` : sql`NULL::timestamptz`,
      text: sql`${column}::text`,
    };
  }
  // A key of `data`. Bound as a parameter: it is a value to Postgres, not an identifier.
  const value = sql`(data ->> ${field})`;
  const kind = catalog.fields.get(field) ?? "text";
  return {
    kind,
    raw: value,
    number: sql`CASE WHEN ${value} ~ ${LOOKS_NUMERIC} THEN ${value}::numeric END`,
    // The shape is not enough: `2026-02-31` has it and does not exist, and one such row would fail
    // the whole statement. The function (core migration 0081) turns an impossible date into NULL.
    time: sql`CASE WHEN ${value} ~ ${LOOKS_LIKE_DATE} THEN kitsuden_try_timestamptz(${value}) END`,
    text: value,
  };
}

/** Keywords, never request text: the only raw SQL this file writes. */
const BUCKET_UNIT = {
  day: sql.raw("'day'"),
  week: sql.raw("'week'"),
  month: sql.raw("'month'"),
  quarter: sql.raw("'quarter'"),
  year: sql.raw("'year'"),
} as const;

function measureSql(policy: Policy, catalog: Catalog, measure: AggregateMeasure, at: string): SQL {
  if (measure.fn === "count" && measure.field === undefined) return sql`count(*)`;
  const presenceOnly = measure.fn === "count" || measure.fn === "count_distinct";
  const field = resolveField(
    policy,
    catalog,
    measure.field as string,
    at,
    presenceOnly ? "presence" : "value"
  );
  switch (measure.fn) {
    case "count":
      return sql`count(${field.raw})`;
    case "count_distinct":
      return sql`count(DISTINCT ${field.text})`;
    case "sum":
    case "avg": {
      if (field.kind !== "number") {
        throw new AggregateError(
          400,
          `${at}: ${measure.fn} needs a numeric field, and "${measure.field}" is ${field.kind}.`
        );
      }
      return measure.fn === "sum" ? sql`sum(${field.number})` : sql`avg(${field.number})`;
    }
    case "min":
    case "max": {
      if (field.kind === "json" || field.kind === "boolean") {
        throw new AggregateError(
          400,
          `${at}: ${measure.fn} does not apply to "${measure.field}" (${field.kind}).`
        );
      }
      const value =
        field.kind === "number" ? field.number : field.kind === "time" ? field.time : field.text;
      return measure.fn === "min" ? sql`min(${value})` : sql`max(${value})`;
    }
    default:
      throw new AggregateError(400, `${at}: unknown function.`);
  }
}

/** Does this measure produce a number? `min` and `max` keep the type of what they read. */
function measureIsNumeric(catalog: Catalog, measure: AggregateMeasure): boolean {
  if (measure.fn === "count" || measure.fn === "count_distinct") return true;
  if (measure.fn === "sum" || measure.fn === "avg") return true;
  if (measure.field === undefined) return true;
  const kind =
    catalog.kind === "table"
      ? catalog.columns.get(measure.field)
      : (ENTRY_COLUMNS.get(measure.field) ?? catalog.fields.get(measure.field) ?? "text");
  return kind === "number";
}

function dimensionSql(
  policy: Policy,
  catalog: Catalog,
  dimension: AggregateDimension,
  at: string
): SQL {
  const field = resolveField(policy, catalog, dimension.field, at);
  if (dimension.bucket) {
    if (field.kind !== "time") {
      throw new AggregateError(
        400,
        `${at}: a ${dimension.bucket} bucket needs a date field, and "${dimension.field}" is ${field.kind}.`
      );
    }
    // In UTC: the same report must give the same months whatever the server's time zone.
    return sql`date_trunc(${BUCKET_UNIT[dimension.bucket]}, ${field.time} AT TIME ZONE 'UTC')`;
  }
  if (field.kind === "json") {
    throw new AggregateError(
      400,
      `${at}: "${dimension.field}" is structured data and cannot be grouped by.`
    );
  }
  return field.kind === "number" ? field.number : field.kind === "time" ? field.time : field.raw;
}

function numberValue(value: unknown, at: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || (typeof value === "string" && value.trim() === "")) {
    throw new AggregateError(400, `${at}: a number is expected.`);
  }
  return n;
}

function timeValue(value: unknown, at: string): string {
  const date = new Date(typeof value === "number" ? value : String(value));
  if (Number.isNaN(date.getTime())) throw new AggregateError(400, `${at}: a date is expected.`);
  return date.toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const COMPARISON = {
  eq: sql.raw("="),
  neq: sql.raw("IS DISTINCT FROM"),
  gt: sql.raw(">"),
  gte: sql.raw(">="),
  lt: sql.raw("<"),
  lte: sql.raw("<="),
} as const;

function filterSql(policy: Policy, catalog: Catalog, filter: AggregateFilter, at: string): SQL {
  const field = resolveField(
    policy,
    catalog,
    filter.field,
    at,
    filter.op === "is_null" ? "presence" : "value"
  );
  if (filter.op === "is_null") {
    return filter.value === false ? sql`${field.raw} IS NOT NULL` : sql`${field.raw} IS NULL`;
  }
  if (filter.op === "contains") {
    if (field.kind !== "text") {
      throw new AggregateError(
        400,
        `${at}: contains looks for text inside a text field, and "${filter.field}" is ${field.kind}.`
      );
    }
    return sql`${field.text} ILIKE ${`%${escapeLike(String(filter.value))}%`}`;
  }
  if (filter.op === "in") {
    // Compared as the field's own type: `5` must find `5.00`, and a date must find the same
    // instant however Postgres prints it.
    const list = filter.value as unknown[];
    if (field.kind === "number") {
      const values = list.map((v) => sql`${numberValue(v, at)}::numeric`);
      return sql`${field.number} IN (${sql.join(values, sql`, `)})`;
    }
    if (field.kind === "time") {
      const values = list.map((v) => sql`${timeValue(v, at)}::timestamptz`);
      return sql`${field.time} IN (${sql.join(values, sql`, `)})`;
    }
    const values = list.map((v) => sql`${String(v)}`);
    return sql`${field.text} IN (${sql.join(values, sql`, `)})`;
  }
  const operator = COMPARISON[filter.op];
  if (field.kind === "number") {
    return sql`${field.number} ${operator} ${numberValue(filter.value, at)}::numeric`;
  }
  if (field.kind === "time") {
    return sql`${field.time} ${operator} ${timeValue(filter.value, at)}::timestamptz`;
  }
  if (field.kind === "boolean" && catalog.kind === "table") {
    if (filter.op !== "eq" && filter.op !== "neq") {
      throw new AggregateError(400, `${at}: a true/false field only takes eq and neq.`);
    }
    const wanted = filter.value === true || filter.value === "true";
    return sql`${field.raw} ${operator} ${wanted}`;
  }
  return sql`${field.text} ${operator} ${String(filter.value)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The statement
// ─────────────────────────────────────────────────────────────────────────────

export interface AggregateColumn {
  name: string;
  role: "dimension" | "measure";
}

export interface AggregateResult {
  columns: AggregateColumn[];
  rows: Array<Record<string, unknown>>;
  /** There were more groups than `limit`. */
  truncated: boolean;
}

interface Built {
  statement: SQL;
  columns: AggregateColumn[];
  /** Result columns whose text from Postgres (`numeric`, `bigint`) should become a JS number. */
  numeric: Set<string>;
  limit: number;
}

function build(policy: Policy, catalog: Catalog, query: AggregateQuery): Built {
  const columns: AggregateColumn[] = [];
  const numeric = new Set<string>();
  const selected: SQL[] = [];
  const grouped: SQL[] = [];

  for (const [index, dimension] of (query.groupBy ?? []).entries()) {
    const alias = dimensionAlias(dimension);
    const expression = dimensionSql(policy, catalog, dimension, `groupBy ${index + 1}`);
    selected.push(sql`${expression} AS ${sql.identifier(alias)}`);
    // By POSITION, not by repeating the expression: a jsonb key is a bound parameter, and Postgres
    // does not see `data ->> $1` and `data ->> $6` as the same expression. Dimensions are selected
    // first, so the position is the index. A number this file writes, never request text.
    grouped.push(sql.raw(String(index + 1)));
    columns.push({ name: alias, role: "dimension" });
  }
  for (const [index, measure] of query.measures.entries()) {
    const alias = measureAlias(measure);
    selected.push(
      sql`${measureSql(policy, catalog, measure, `measure ${index + 1}`)} AS ${sql.identifier(alias)}`
    );
    columns.push({ name: alias, role: "measure" });
    if (measureIsNumeric(catalog, measure)) numeric.add(alias);
  }

  const conditions: SQL[] = [];
  if (catalog.kind === "dataset") conditions.push(sql`data_set_id = ${catalog.datasetId}`);
  for (const [index, filter] of (query.filters ?? []).entries()) {
    conditions.push(filterSql(policy, catalog, filter, `filter ${index + 1}`));
  }

  const from = catalog.kind === "table" ? sql`${sql.identifier(catalog.table)}` : sql`data_entries`;
  // `orderBy` was checked against the aliases; an alias is an identifier of THIS statement.
  const ordering = (query.orderBy ?? []).map(
    (order) =>
      sql`${sql.identifier(order.by)} ${order.dir === "desc" ? sql.raw("DESC") : sql.raw("ASC")} NULLS LAST`
  );
  const limit = query.limit ?? DEFAULT_AGGREGATE_GROUPS;

  const statement = sql`SELECT ${sql.join(selected, sql`, `)} FROM ${from}${
    conditions.length > 0 ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``
  }${grouped.length > 0 ? sql` GROUP BY ${sql.join(grouped, sql`, `)}` : sql``}${
    ordering.length > 0 ? sql` ORDER BY ${sql.join(ordering, sql`, `)}` : sql``
    // One more than asked: the only way to know there were more without a second query.
  } LIMIT ${limit + 1}`;

  return { statement, columns, numeric, limit };
}

/**
 * What Postgres returns as text (`numeric`, `bigint`) becomes a number when the column is numeric
 * and it fits one. A `min` of text that happens to look like a number (`00123`) stays text.
 */
function plain(value: unknown, isNumeric: boolean): unknown {
  if (value instanceof Date) return value.toISOString();
  if (isNumeric && typeof value === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
  }
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= -BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return value;
}

export interface AggregateOptions {
  /**
   * The caller is an agent: columns marked as customer or personal data cannot be read through the
   * result (see `Policy`). A person with the administrator role sees everything the explorer shows.
   */
  restrictSensitive?: boolean;
}

async function policyFor(options: AggregateOptions): Promise<Policy> {
  // Fails closed: if the marks cannot be read, the query is not run.
  return { marks: options.restrictSensitive ? await loadSensitivityCatalog() : null };
}

/**
 * Runs an aggregate query as whoever is asking. Throws `AggregateError` for
 * anything the caller can fix or may not do.
 */
export async function runAggregate(
  query: unknown,
  options: AggregateOptions = {}
): Promise<AggregateResult> {
  const problem = aggregateQueryProblem(query);
  if (problem) throw new AggregateError(400, problem);
  const q = query as AggregateQuery;

  const catalog =
    q.source.table !== undefined
      ? await tableCatalog(q.source.table)
      : await datasetCatalog(q.source.dataset as string);
  const { statement, columns, numeric, limit } = build(await policyFor(options), catalog, q);

  // The request's connection: the row policies of the table decide what is counted.
  const rows = rowsOf<Record<string, unknown>>(await resolveExecutor(db).execute(statement));
  const truncated = rows.length > limit;
  return {
    columns,
    rows: rows.slice(0, limit).map((row) => {
      const output: Record<string, unknown> = {};
      for (const column of columns)
        output[column.name] = plain(row[column.name], numeric.has(column.name));
      return output;
    }),
    truncated,
  };
}

/** Checks a query without running it: what saving a report does. */
export async function aggregateProblem(query: unknown): Promise<string | null> {
  const shape = aggregateQueryProblem(query);
  if (shape) return shape;
  const q = query as AggregateQuery;
  try {
    const catalog =
      q.source.table !== undefined
        ? await tableCatalog(q.source.table)
        : await datasetCatalog(q.source.dataset as string);
    // Saved by a person, run by whoever holds the scope: the check that depends on who runs it
    // happens when it runs.
    build({ marks: null }, catalog, q);
    return null;
  } catch (err: unknown) {
    if (err instanceof AggregateError) return err.message;
    throw err;
  }
}
