/**
 * The list query of the data explorer (`GET /api/explorer/:collection`), read from the URL.
 *
 *   ?search=ana                         text in ANY searchable column (OR)
 *   ?search=ana&search_fields=name,email  …or only in these
 *   ?filter[status]=draft               one condition per field (equals), all of them (AND)
 *   ?filter[created_at][gte]=2026-01-01 with an operator: contains, equals, gt, lt, gte, lte
 *   ?filter_field=email&filter_op=contains&filter_value=@x   the older single filter, kept
 *
 * The route used to ignore `search` and honour ONE `filter_field`: the panel's search box
 * filtered a single column and a second filter replaced the first without a word.
 *
 * Nothing here touches the database: it turns the query into conditions and refuses what it
 * does not understand. An unknown operator, a malformed field or a secret column is an
 * error, never "no filter": returning the whole table to someone who believes it is
 * filtered is worse than a 400.
 */
import { isSecretColumn } from "./explorable-tables";

export const FILTER_OPS = ["contains", "equals", "gt", "lt", "gte", "lte"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface ExplorerCondition {
  field: string;
  op: FilterOp;
  value: string;
  /**
   * From the older `filter_field` triple. The typed path used to skip it when the table had
   * no such column; that is kept. A `filter[...]` condition on an unknown column is refused.
   */
  legacy: boolean;
}

export interface ExplorerQuery {
  conditions: ExplorerCondition[];
  /** Trimmed search text, or null. */
  search: string | null;
  /** Columns the search is limited to, or null for every searchable one. */
  searchFields: string[] | null;
}

/** What the caller got wrong; the route answers 400 with it. */
export class ExplorerQueryError extends Error {
  constructor(
    message: string,
    readonly supported?: readonly string[]
  ) {
    super(message);
    this.name = "ExplorerQueryError";
  }
}

export const EXPLORER_QUERY_LIMITS = { conditions: 20, search: 200, searchFields: 30 } as const;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILTER_KEY = /^filter\[([^\]]*)\](?:\[([^\]]*)\])?$/;

const last = (values: string[] | undefined): string | undefined =>
  values && values.length > 0 ? values[values.length - 1] : undefined;

function checkField(field: string): string {
  if (!IDENTIFIER.test(field)) {
    throw new ExplorerQueryError(`Malformed filter field: "${field}"`);
  }
  // A secret column never reaches a response; filtering by it would answer "does this
  // token start with ab?" one request at a time.
  if (isSecretColumn(field)) {
    throw new ExplorerQueryError(`Cannot filter or search by "${field}"`);
  }
  return field;
}

function checkOp(op: string): FilterOp {
  if (!(FILTER_OPS as readonly string[]).includes(op)) {
    throw new ExplorerQueryError(`Unsupported filter operator: "${op}"`, FILTER_OPS);
  }
  return op as FilterOp;
}

/**
 * `queries` is every query parameter with all its values (Hono's `c.req.queries()`).
 * Throws `ExplorerQueryError` for anything it cannot honour.
 */
export function parseExplorerQuery(queries: Record<string, string[]>): ExplorerQuery {
  const conditions: ExplorerCondition[] = [];

  for (const [key, values] of Object.entries(queries)) {
    const m = FILTER_KEY.exec(key);
    if (!m) continue;
    const field = checkField(m[1] ?? "");
    const op = checkOp(m[2] ?? "equals");
    for (const value of values) {
      // An empty value is "this filter is not set", as a form sends it.
      if (value === "") continue;
      conditions.push({ field, op, value, legacy: false });
    }
  }

  // The older triple: one field, one operator, one value.
  const legacyField = last(queries.filter_field);
  const legacyValue = last(queries.filter_value);
  if (legacyField && legacyValue) {
    const op = checkOp(last(queries.filter_op) || "contains");
    // Not `checkField`: an odd name used to be skipped (typed) or sanitised (dynamic), and
    // that stays. A secret column is refused here too.
    if (isSecretColumn(legacyField)) {
      throw new ExplorerQueryError(`Cannot filter or search by "${legacyField}"`);
    }
    conditions.push({ field: legacyField, op, value: legacyValue, legacy: true });
  }

  if (conditions.length > EXPLORER_QUERY_LIMITS.conditions) {
    throw new ExplorerQueryError(`At most ${EXPLORER_QUERY_LIMITS.conditions} filters`);
  }

  const rawSearch = (last(queries.search) ?? "").trim();
  if (rawSearch.length > EXPLORER_QUERY_LIMITS.search) {
    throw new ExplorerQueryError(
      `Search text is limited to ${EXPLORER_QUERY_LIMITS.search} characters`
    );
  }

  const rawFields = (last(queries.search_fields) ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (rawFields.length > EXPLORER_QUERY_LIMITS.searchFields) {
    throw new ExplorerQueryError(`At most ${EXPLORER_QUERY_LIMITS.searchFields} search fields`);
  }
  const searchFields = rawFields.length > 0 ? rawFields.map(checkField) : null;

  return { conditions, search: rawSearch || null, searchFields };
}

/** `%text%` for ILIKE, with the user's own `%`, `_` and `\` taken literally. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * The columns a search runs over: the textual ones that are not secret, narrowed to
 * `searchFields` when given. A requested field that is not a searchable column is an error.
 */
export function searchableColumns(textColumns: string[], searchFields: string[] | null): string[] {
  const allowed = textColumns.filter((c) => !isSecretColumn(c));
  if (!searchFields) return allowed;
  const unknown = searchFields.filter((f) => !allowed.includes(f));
  if (unknown.length > 0) {
    throw new ExplorerQueryError(`Not a searchable column: ${unknown.join(", ")}`, allowed);
  }
  return searchFields;
}

/** Postgres types whose text a search can read (`information_schema.columns.data_type`). */
export function isTextualPgType(type: string): boolean {
  const t = type.toLowerCase();
  return (
    t === "text" ||
    t === "uuid" ||
    t === "citext" ||
    t === "name" ||
    t.startsWith("character") ||
    t.startsWith("varchar") ||
    t.startsWith("char")
  );
}
