# Reports

Every other query surface returns rows. A report answers "how much, grouped by
what": deals won per month, orders per product, average ticket per stage.

Three things live under `/api/reports`:

- **aggregate**: an ad hoc query. Nothing is stored.
- **reports**: queries a person saved, listed together with the ones kons ship.
- **dashboards**: ordered tiles, each pointing at a report.

## The aggregate query

```json
POST /api/reports/aggregate
{
  "query": {
    "source":   { "table": "crm_deals" },
    "measures": [{ "fn": "sum", "field": "amount", "as": "total" }, { "fn": "count" }],
    "groupBy":  [{ "field": "closed_at", "bucket": "month", "as": "month" }],
    "filters":  [{ "field": "status", "op": "eq", "value": "won" }],
    "orderBy":  [{ "by": "month", "dir": "asc" }],
    "limit": 24
  }
}
```

```json
{
  "columns": [
    { "name": "month", "role": "dimension" },
    { "name": "total", "role": "measure" },
    { "name": "count", "role": "measure" }
  ],
  "rows": [{ "month": "2026-01-01T00:00:00.000Z", "total": 184000, "count": 7 }],
  "truncated": false
}
```

| Part       |                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`   | Exactly one of `table` (a table an installed kon declares) or `dataset` (a dataset slug, including [kon entities](kons/entities.md)).            |
| `measures` | 1 to 10. `fn`: `count`, `count_distinct`, `sum`, `avg`, `min`, `max`. `count` without `field` counts rows. `sum` and `avg` need a numeric field. |
| `groupBy`  | Up to 4. `bucket` (`day`, `week`, `month`, `quarter`, `year`) truncates a date, in UTC.                                                          |
| `filters`  | Up to 20, all must hold. `op`: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `is_null`.                                               |
| `orderBy`  | By the result name of a measure or dimension.                                                                                                    |
| `limit`    | Groups returned: default 100, at most 1000. `truncated` says there were more.                                                                    |

Result names default to the function and field (`sum_amount`, `count`,
`closed_at_month`); set `as` to choose one.

For a dataset, `field` is a key of the entry's `data`, or one of the entry's own
columns: `status`, `owner_id`, `created_at`, `updated_at`. A value that is not a
number in a numeric field counts as empty; it does not fail the report.

## What may be read

Three checks, in this order:

1. **Which tables.** Only a table some installed kon declares in its `kon.json`
   (`tables`, or the table of an admin view), or a dataset. Core tables (users,
   settings, keys, secrets, actions) are refused whoever asks.
2. **Which columns.** Every field is looked up in the table's real columns. A
   column that holds a secret by name (`…token`, `…password`, `…secret`,
   `…_hash`) is refused in any position: a `min()` or a `GROUP BY` reads values
   as well as a `SELECT` does.
3. **Which rows.** The query runs as whoever asked, inside the request's
   transaction, so the table's row policies decide what is counted.

A fourth check applies to **agents**. Columns marked as customer or personal data
(`sensitivity` in a kon's `kon.json`, or on a dataset field) cannot be read through
the result: an agent cannot group by them, take their `min`/`max`, `sum`/`avg` them
or filter on their value, because a `GROUP BY` on an email column is a dump of every
email. Counting rows, `count_distinct` and an `is_null` filter stay allowed. A person
with the administrator role is not restricted. Mark the columns that hold personal
data; an unmarked column is readable by any agent that holds `reports:read`.

A table with no row policies counts every row. That is why the operations are
for **administrators**, and for agents that hold the scope:

| Scope           | Opens                                                    |
| --------------- | -------------------------------------------------------- |
| `reports:read`  | aggregate, list and run reports, read and run dashboards |
| `reports:write` | everything, including saving and deleting                |

The query is data, not SQL. Identifiers are used only after being found in the
schema, and values are always bound parameters.

Values are compared as the field's own type: `in [5]` finds `5.00`, a timestamp
finds the same instant, and `contains` is for text only (it answers 400 on any other
type). `min` and `max` of a text field return text, so `00123` stays `00123`. A date
that has the shape but does not exist (`2026-02-31`) counts as no date.

## Saved reports

```
GET    /api/reports                 saved reports and the ones kons ship
POST   /api/reports                 { name, description?, query, chart? }
GET    /api/reports/:id
PATCH  /api/reports/:id
DELETE /api/reports/:id
POST   /api/reports/run             { report: "<id>" }
```

A report is checked against the real tables when it is saved: one that could not
run is refused with the reason.

`chart` is a hint for the panel: `type` (`table`, `number`, `bar`, `line`,
`donut`), `x` (a result name) and `y` (a list of result names). The data is the
same whatever the chart.

## Reports from a kon

```ts
export default defineKon({
  id: "kon-crm",
  reports: [
    {
      id: "won-per-month",
      name: "Deals won per month",
      query: {
        source: { table: "crm_deals" },
        measures: [{ fn: "sum", field: "amount", as: "total" }],
        groupBy: [{ field: "closed_at", bucket: "month", as: "month" }],
        filters: [{ field: "status", op: "eq", value: "won" }],
        orderBy: [{ by: "month" }],
      },
      chart: { type: "bar", x: "month", y: ["total"] },
    },
  ],
});
```

It appears in `GET /api/reports` with `source: "kon"` and the id
`kon:kon-crm/won-per-month`, is run with `POST /api/reports/run`, and is
read-only. A malformed report is reported in the load log and skipped.

A kon's report is not exempt from the checks above: it reads only declared
tables, and runs as whoever runs it.

## Dashboards

```
GET    /api/reports/dashboards
POST   /api/reports/dashboards            { name, description?, tiles: [{ report, title?, width? }] }
GET    /api/reports/dashboards/:id
PATCH  /api/reports/dashboards/:id
DELETE /api/reports/dashboards/:id
POST   /api/reports/dashboards/:id/run
```

A tile's `report` is the id of a saved report or `kon:<kon id>/<report id>`;
`width` goes from 1 to 12. Running a dashboard runs each tile in order and
returns each result with its chart hint. A tile whose report is gone carries
`error` instead of `result`; the others still come back.

## For agents

`reports_aggregate`, `reports_list` and `reports_run` are MCP tools. Saving
reports and editing dashboards are panel tasks and are not exposed.

## Limits

- One source per query: no joins. Put what a report needs on the row, or run two
  queries.
- The panel has chart components but no dashboard screen yet; the operations
  return everything one needs.
- Results are not cached. `aggregate` and `run` cost 2 budget units, and running
  a dashboard costs 5.
