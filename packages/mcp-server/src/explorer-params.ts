/**
 * The query string of `GET /api/explorer/:table` from the arguments of the standalone
 * server's `kitsuden_query_table` tool. The API's syntax (apps/api/src/lib/explorer-query.ts):
 *
 *   search=ana                           text in any textual column
 *   search_fields=name,email             …or only in these
 *   filter[status]=draft                 one condition per field (equals); all must hold
 *   filter[created_at][gte]=2026-01-01   with an operator: contains, equals, gt, lt, gte, lte
 *   filter_field / filter_op / filter_value   the older single filter, still honoured
 *
 * Nothing is checked here: the API answers 400 for an unknown operator or column, a secret
 * column, or more than 20 conditions, and the tool passes that answer on.
 */

export const FILTER_OPS = ["contains", "equals", "gt", "lt", "gte", "lte"] as const;

type Scalar = string | number | boolean;

export interface QueryTableArgs {
  limit?: number;
  page?: number;
  sort?: string;
  dir?: string;
  search?: string;
  /** Comma-separated, or a list. */
  search_fields?: string | string[];
  /** `{ field: value }` (equals) or `{ field: { op: value } }`. */
  filters?: Record<string, Scalar | Record<string, Scalar>>;
  filter_field?: string;
  filter_op?: string;
  filter_value?: string;
}

export function queryTableParams(args: QueryTableArgs): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(Number(args.limit ?? 25) || 25, 100)));
  params.set("page", String(Number(args.page ?? 1) || 1));
  if (args.sort) params.set("sort", args.sort);
  if (args.dir) params.set("dir", args.dir);
  if (args.search) params.set("search", args.search);
  const fields = Array.isArray(args.search_fields)
    ? args.search_fields.join(",")
    : args.search_fields;
  if (fields) params.set("search_fields", fields);
  if (args.filters && typeof args.filters === "object") {
    for (const [field, condition] of Object.entries(args.filters)) {
      if (condition !== null && typeof condition === "object") {
        for (const [op, value] of Object.entries(condition)) {
          if (value !== undefined && value !== null)
            params.append(`filter[${field}][${op}]`, String(value));
        }
      } else if (condition !== undefined && condition !== null) {
        params.append(`filter[${field}]`, String(condition));
      }
    }
  }
  if (args.filter_field) params.set("filter_field", args.filter_field);
  if (args.filter_op) params.set("filter_op", args.filter_op);
  if (args.filter_value) params.set("filter_value", args.filter_value);
  return params;
}
