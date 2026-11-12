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

| Write path                                                                                                                                                                  | Recorded                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| kon-datasets: create (one or a bulk array), update, delete, restore to a snapshot                                                                                           | yes                                              |
| Lite API `POST /api/data-sets/:id/entries`                                                                                                                                  | yes                                              |
| Data explorer `POST`, `PATCH`, `DELETE /api/explorer/:collection[/:id]`                                                                                                     | yes                                              |
| A model's create, update and delete (`defineModel`)                                                                                                                         | yes                                              |
| Core MCP `kitsuden_create_record`, `kitsuden_update_record`, `kitsuden_delete_record`, on a dataset or a native table, and `kitsuden_insert_record`                         | yes (as the agent)                               |
| Imports: `POST /api/datasets/import` and `POST /api/datasets/import/package`, every strategy (an id of another dataset's entry is a row error: that entry is never changed) | yes, one row per created or updated entry        |
| GraphQL mutations `create…`/`update…`/`delete…` of a native table and `createDataset_…`/`updateDataset_…`/`deleteDataset_…`                                                 | yes                                              |
| A kon's writes through the shared repository `repo(table)`: `create`, `createMany`, `update`, `delete`                                                                      | yes, up to 500 rows per call (below)             |
| Generic items API `POST`/`PATCH`/`DELETE /api/items/:collection[/:id]`, on a dataset or a native table                                                                      | yes                                              |
| Batch: `POST /api/datasets/batch` and the engine's two batch processors (`BatchProcessor` of `batch.ts` and `batch-api.ts`)                                                 | yes, up to 500 rows per batch (below)            |
| The standalone MCP server (`packages/mcp-server`, `standalone.ts`)                                                                                                          | yes: it calls the API routes above, which record |
| `packages/mcp-server` embedded as a library (`createKitsudenMcpServer` with your own `db`): its `kitsuden_insert_record` writes through that `db`                           | no (nothing in this repository embeds it)        |
| A kon's hand-written Drizzle (`ctx.db.instance.insert(…)`, `.update(…)`) and raw SQL anywhere                                                                               | no                                               |

What is not recorded is not a rule a kon can rely on either way: a kon that wants its writes
in the history writes through `defineModel` or `repo(table)`, or calls `recordChange` itself
(`@kitsuden/engine`).

**A kon with a table updated very often** (a live score, a match clock, a presence or
heartbeat row, a counter) should write that table with `repo(table, { history: false })`:
every `update` otherwise adds a history row (and reads the row first), for a history nobody
reads. Keep the history on for the kon's other tables.

Bulk writes stay bounded:

- an import records every created or updated entry, in batched INSERTs of 100 rows inside
  the import's own transaction;
- one `repo(table)` call, or one batch, that writes more than 500 rows (`BULK_HISTORY_CAP`)
  records none of them: that is a bulk job, not an edit;
- a repository `update` and a batch `update`/`upsert` read the rows they are about to change
  first (at most 501), to know their values before;
- a batch records its rows at the end, in its own transaction (in a savepoint, as the system):
  they commit or roll back with the batch.

A table row is addressed as `table:<name>` with its column names whichever path wrote it
(explorer, model, MCP, GraphQL, items, batch, repository): the row has one history. A row of
`data_entries` is always a dataset entry (`dataset_entry`, fields as `data.<key>`), whichever
path wrote it.

Changes made before the history existed are not listed: the panel then shows the record's
own created and updated dates.

### Retention

Rows older than `RECORD_HISTORY_RETENTION_DAYS` days are deleted by the API every hour (and
once when it starts), at most 200,000 rows per pass in batches of 5,000.

| Value             | Means                    |
| ----------------- | ------------------------ |
| unset or empty    | 365 days (the default)   |
| a positive number | that many days           |
| `0`               | keep the history forever |
| anything else     | the default, 365         |

The same convention as `AGENT_KEY_DEFAULT_EXPIRY_DAYS`: empty is the default, `0` is never.
With Docker, set it in the root `.env`; `docker-compose.yml` passes it to the API.
A deleted record's history goes too once it is older than the limit.

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
