# Record history and the explorer's list query

Reference for two read paths the admin panel uses and an agent or script can call too:
the change history of a record, and the search and filters of the data explorer.

## Change history of a record

Every create, update and delete of a record is kept in `record_changes` (core migration
0076): who did it, a person or an agent, when, and the fields that changed with their value
before and after. The panel shows it in the record page's History tab.

### Read it

| Record                                     | Route                                            | Who                                   |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------------- |
| A dataset entry                            | `GET /api/datasets/:id/entries/:entryId/history` | whoever can read the entry (else 404) |
| A row of any explorable table (kon, model) | `GET /api/history/:collection/:id`               | admin, like the rest of the explorer  |

Both take `?limit=` (1-200, default 50) and `?offset=` and answer, newest first:

```json
{
  "history": [
    {
      "id": "…",
      "action": "update",
      "at": "2026-11-11T10:04:00.000Z",
      "actor": { "type": "agent", "id": "agt_…", "name": "Catalog Curator" },
      "changes": [
        { "field": "data.price", "before": 19.5, "after": 21 },
        { "field": "data.api_token", "redacted": true }
      ],
      "truncated": false,
      "proposalId": "…",
      "approvedBy": "…"
    }
  ],
  "total": 3,
  "limit": 50,
  "offset": 0
}
```

- `actor.type` is `user`, `agent` or `system`; `name` is the one it had then.
- A dataset entry's own fields are `data.<key>`; a table's are its column names. A row of a
  model and the same row edited through the explorer share one history.
- A create lists the values it set (`after`), a delete the values it removed (`before`).
  Timestamps the write moves by itself (`updated_at`…) are not listed, and an update that
  changed nothing leaves no entry.
- `proposalId` and `approvedBy` (a user id) are set when the write was an approved agent
  proposal.
- A deleted record keeps its history: it is what says who deleted it.

### What is never kept

- **Secret values.** A field named like a secret (ending in token, password, secret or a
  hash: the same rule as `isSecretColumn`) is listed as `{ field, redacted: true }` with no
  value; secret keys inside a JSON value are dropped.
- **Large values.** A value over 2,000 characters of JSON becomes
  `{ truncated: true, bytes, preview }`; a change keeps at most 60 fields and 48 KiB, and
  `truncated` says when something was cut.

### Visibility

The table has row-level security, with FORCE: the system and the human team (admin,
editor) read all of it; anyone else reads the history of a dataset entry only when they can
read the entry itself, and never the history of another table. Only the system writes it.

### Which writes are recorded

| Write path                                                                                                | Recorded           |
| --------------------------------------------------------------------------------------------------------- | ------------------ |
| kon-datasets: create (one or a bulk array), update, delete, restore to a snapshot                         | yes                |
| Lite API `POST /api/data-sets/:id/entries`                                                                | yes                |
| Data explorer `POST`, `PATCH`, `DELETE /api/explorer/:collection[/:id]`                                   | yes                |
| A model's create, update and delete (`defineModel`)                                                       | yes                |
| Core MCP `kitsuden_create_record`, `kitsuden_update_record`, `kitsuden_delete_record` on a dataset        | yes (as the agent) |
| Core MCP record tools on a native table, imports, GraphQL mutations, a kon's own hand-written routes, SQL | no                 |

Changes made before the history existed are not listed: the panel then shows the record's
own created and updated dates.

## The explorer's list query

`GET /api/explorer/:collection` (admin only; the panel's generic list screen) pages with
`limit` (1-500, default 50) and `page`, sorts with `sort` and `dir` (`asc`/`desc`), and
filters with:

| Parameter                                   | Meaning                                                               |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `search=ana`                                | text in any textual column, case-insensitive (at most 200 characters) |
| `search_fields=name,email`                  | …only in these columns (at most 30)                                   |
| `filter[status]=draft`                      | a condition on a column, `equals`                                     |
| `filter[created_at][gte]=2026-01-01`        | with an operator: `contains`, `equals`, `gt`, `lt`, `gte`, `lte`      |
| `filter_field`, `filter_op`, `filter_value` | the older single filter (operator `contains` by default)              |

All conditions must hold (AND), the older single filter included; a column can carry
several (`filter[price][gte]=10&filter[price][lt]=20`). At most 20 conditions. An empty value
is "not set".

Refused with 400 (`{ error, supported? }`), never answered with an unfiltered table:

- an operator not in the list (the answer lists the supported ones);
- a column the table does not have, or a malformed name, in `filter[...]` (the older single
  filter keeps its old behaviour: on a table of the explorer's own registry a missing column
  is ignored);
- a `search_fields` entry that is not a searchable column;
- a secret column, in a filter or in the search: filtering by it would answer "does this
  token start with ab?" one request at a time.

The source of truth is the header of `apps/api/src/lib/explorer-query.ts`. The TypeScript
SDK's `kitsuden.from(table).list({ search, search_fields, filters })` and the standalone MCP
server's `kitsuden_query_table` send this syntax.
