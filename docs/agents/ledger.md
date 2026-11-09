# Agent data ledger

An agent proposes data **with its evidence**, and a person accepts or rejects it
**field by field**. The mechanism is in the core and serves any record an agent
writes: a dataset entry, a row of a kon operation. A kon such as a CRM only adds
its vocabulary.

It builds on [human approval](approvals.md): an agent whose request needs
approval gets `202` with a proposal; this page is what changes for proposals that
write a record. Everything else (switches, modes, who may approve, execution with
the agent's identity, expiry, audit) is as described there.

## Contents

- [What counts as a record](#what-counts-as-a-record)
- [Evidence: what the agent sends](#evidence-what-the-agent-sends)
- [The per-field diff](#the-per-field-diff)
- [Deciding field by field](#deciding-field-by-field)
- [Evidence kept with the row](#evidence-kept-with-the-row)
- [Later reviews](#later-reviews)
- [The agent's budget pays for its queued work](#the-agents-budget-pays-for-its-queued-work)
- [API reference](#api-reference)
- [What is not covered](#what-is-not-covered)
- [Upgrading](#upgrading)

## What counts as a record

| Request                                                                                                    | Fields                                                                 | Entity                                                |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| `POST /api/datasets/{id}/entries` (one object, not a bulk array)                                           | `title`, `status`, `sortOrder`, `thumbnailId`, `ownerId`, `data.<key>` | `dataset_entry`                                       |
| `PATCH /api/datasets/{id}/entries/{entryId}`                                                               | the same                                                               | `dataset_entry`                                       |
| MCP `kitsuden_create_record` / `kitsuden_update_record`                                                    | `data.<key>`, `status`                                                 | `dataset_entry`, or `table:<name>` for a native table |
| Any other kon SDK operation with a JSON object body (`POST`, `PUT`, `PATCH`), over REST or as its MCP tool | the top-level keys of the body                                         | `sdk:<kon id>`                                        |

Anything else (a `DELETE`, a legacy route, a bulk array, an upload, a core tool
that is not a record) is decided whole, exactly as before.

## Evidence: what the agent sends

An optional `_evidence` section, next to the fields:

```http
PATCH /api/datasets/6f1c…/entries/9a2e…   (Authorization: Bearer kitsuden_agent_…)
Content-Type: application/json

{
  "data": { "price": 49, "plan": "pro" },
  "_evidence": [
    {
      "field": "data.price",
      "source": "https://acme.example/pricing",
      "quote": "Pro plan: 49 per month",
      "confidence": 0.9,
      "retrievedAt": "2026-11-01T10:00:00Z"
    },
    { "field": "data.plan", "source": "doc:contract-2026.pdf#p4" }
  ]
}
```

| Key           |                                                                                   |
| ------------- | --------------------------------------------------------------------------------- |
| `field`       | required; a field of this request (`title`, `data.price`, a body key)             |
| `source`      | required; a URL or a reference to a document (1–2000 characters)                  |
| `quote`       | optional; the excerpt that supports the value (`excerpt` is accepted too), ≤ 4000 |
| `confidence`  | optional; 0 to 1                                                                  |
| `retrievedAt` | optional; ISO date                                                                |

- Over MCP it is the `_evidence` argument of `kitsuden_create_record` /
  `kitsuden_update_record`, or a `_evidence` key inside the `body` argument of a
  kon SDK tool.
- It is taken out of the body, so the operation never receives it:
  - **held** (the request needs approval): it is stored with the proposal and the
    reviewer sees it next to each field;
  - **not held** (an agent in `direct` mode, or a write no rule holds): it is
    validated the same way and, once the write succeeds, kept with the row at once.
    This applies to requests that write a record (dataset entries, the MCP record
    tools, kon SDK operations with a JSON body). Anything else (a delete, a legacy
    route) receives the body as sent.
- Invalid evidence (no `source`, a confidence over 1, a field the request does not
  write, more than 200 items) is refused with `422 KITSUDEN_E_VALIDATION`
  (`reason: "evidence"`), and nothing is stored: fix it and send again.
- Evidence with a secret is refused like any body with a secret.

## The per-field diff

When the proposal is created Kitsuden reads the current row **as the agent**
(so it never shows what the agent could not read) and stores `fieldDiff`:

```json
{
  "target": { "kind": "update", "shape": "entry", "entity": "dataset_entry", "rowId": "9a2e…" },
  "fields": [
    { "field": "data.price", "before": 40, "after": 49, "change": "update" },
    { "field": "data.plan", "after": "pro", "change": "add" },
    { "field": "data.legacy", "before": "x", "change": "remove" }
  ]
}
```

- Fields whose value does not change are left out: there is nothing to decide.
- `remove`: the REST `PATCH` of an entry replaces `data`, so a key the agent left
  out would be deleted. It is shown, and can be rejected.
- If the row cannot be read, every proposed field counts as changed and
  `currentUnavailable` says why.

## Deciding field by field

`POST /api/approvals/proposals/{id}/approve` takes an optional `fields` list:

```json
{
  "comment": "Price checked; the plan is not confirmed yet",
  "fields": [
    { "field": "data.price", "decision": "accept", "value": 45 },
    { "field": "data.plan", "decision": "reject" }
  ]
}
```

- With `fields`, a field that is not listed is **rejected**: only what you said yes
  to runs. Without `fields` the whole request runs, as before. An empty list is a
  `422`. The panel sends no list when you accept everything as proposed, and lists
  every field as soon as you reject or edit one.
- `value` (accept only) replaces the agent's value. It is checked for secrets and
  capped at 64 KiB.
- Every field rejected = the proposal is **rejected**, and nothing runs.
- An unknown field, a field decided twice or a value on a rejection: `422`, and the
  proposal stays pending.
- Only the accepted fields are executed, by the same path as before, with the
  agent's **current** identity and permissions (the route checks them again). For
  the REST `PATCH` of an entry, the accepted `data.*` fields are applied over the
  row **as the agent reads it at that moment**: what changed meanwhile and was not
  decided is not overwritten. If the row cannot be read then, the proposal ends
  `failed` with `not_executed: current_unavailable`.
- For MCP `kitsuden_update_record` (which merges), only the accepted keys are sent.
- The decision is stored on the proposal (`fieldDecisions`) and in the audit
  (`proposal_approved` / `proposal_rejected` with `fields: { accepted, rejected,
edited }`). The agent sees, in `GET /api/proposals/{id}`, which fields went in:
  `fieldDecisions: [{ field, decision, edited }]`.

In the panel, **Approvals → Inbox** shows the fields of such a proposal as a table
with the current and proposed value, the agent's evidence, an accept checkbox and
an optional new value for each.

## Evidence kept with the row

Once executed, the evidence of each **accepted** field is stored per row in
`field_evidence` (entity, row id, field, the value applied, source, quote,
confidence, retrieval date, whether the reviewer edited the value, the proposal,
the agent and who accepted it). A rejected field keeps nothing. Several entries
for a field are its history; the newest one is shown.

A write that was not held keeps its evidence the same way, with `proposalId` and
`acceptedBy` set to `null`: nobody reviewed it, and provenance shows it as the
agent's own word. If the write fails, nothing is kept.

Reading it:

- **The team**: `GET /api/approvals/evidence?entity=dataset_entry&rowId=…`.
- **Whoever reads the row**, through its [provenance](untrusted-content.md):
  REST with `X-Kitsuden-Provenance: 1` (`/api/datasets/{id}/entries`,
  `/api/data-sets/…`, `/api/items/…`) and MCP `_meta["kitsuden/provenance"]`
  (`kitsuden_query_collection`, `kitsuden_query_dataset`). Each record carries
  `fields`:

  ```json
  "_provenance": {
    "id": "9a2e…", "author": "agent", "untrusted": true,
    "fields": {
      "data.price": {
        "source": "https://acme.example/pricing", "quote": "Pro plan: 49 per month",
        "confidence": 0.9, "retrievedAt": "2026-11-01T10:00:00.000Z",
        "value": 45, "current": true, "edited": true,
        "proposalId": "31ae…", "agentId": "…", "acceptedBy": "…", "acceptedAt": "…"
      }
    }
  }
  ```

  `current` says whether the row still holds the value the evidence backs (a person
  may have edited it since).

`field_evidence` has row-level security: the system and the human team (`admin`,
`editor`) read everything; anyone else reads the evidence of a dataset entry only
if they can read the entry. Only the system writes it.

## Later reviews

When deciding, a person can ask to look again later:

```json
POST /api/approvals/proposals/{id}/approve
{ "reviewAt": "2026-12-01T09:00:00Z", "reviewNote": "Prices change in December" }
```

`reject` takes the same two keys, and `POST /api/approvals/proposals/{id}/review`
(`{ reviewAt, note?, fields? }`) schedules one for a proposal already decided
(executed, failed or rejected). `reviewAt` is in the future and within a year.

The review is a row in `ledger_reviews` and a queue job with that run date
(`kitsuden-ledger-reviews`). When the job runs, the review becomes **due** (audited
as `proposal_review_due`). The list also counts a scheduled review past its date as
due, so a lost job never hides one. `GET /api/approvals/reviews` lists the due ones
(`status=scheduled|done|cancelled|all` for the rest), and
`POST /api/approvals/reviews/{id}/done` closes it (`{ comment?, cancel? }`). In the
panel: **Approvals → Reviews**.

When the review turns due, the person who scheduled it also gets an **email** with
the request, their note and a link to it in the panel (`ADMIN_URL`). If that account
no longer exists, it goes to the administrators. It is sent once, and only when mail
is configured (`RESEND_API_KEY`, `SMTP_HOST` or `MAIL_DRIVER`); with the `log` or
`memory` driver the Reviews tab is the only notice.

## The agent's budget pays for its queued work

A job queued by an agent (in its request, or by an action it triggered) is charged
to the agent's **daily budget** ([quotas](permissions.md)) when it runs:

```ts
await queue.dispatch("reports", "monthly", payload, {
  cost: 5, // budget units; default QUEUE_AGENT_JOB_COST (1); 0 = free
  onBudgetExhausted: "fail", // or "postpone"; default QUEUE_BUDGET_EXHAUSTED (postpone)
});
```

- It is charged when it **runs**, on every attempt (a retry is work too), not
  when it is queued.
- With the budget spent: `postpone` puts the job back to pending until the next
  UTC day without using an attempt; `fail` sends it to the dead letter with
  `budget_exhausted: …` as its error. Either way the agent's audit records
  `job_budget_exhausted`.
- Jobs of people, of the system and on `kitsuden-*` queues (e-mail, webhooks,
  classifier, embeddings, reviews) are never charged. An agent without a daily
  budget is never held.

| Variable                 | Default    |                                                       |
| ------------------------ | ---------- | ----------------------------------------------------- |
| `QUEUE_AGENT_JOB_COST`   | `1`        | Units of a job whose dispatch does not set `cost`.    |
| `QUEUE_BUDGET_EXHAUSTED` | `postpone` | `postpone` or `fail`, when the dispatch does not say. |

## API reference

Humans of the team (`admin`, `editor`; never an agent):

| Method | Path                                    |                                                                                |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------ |
| `POST` | `/api/approvals/proposals/{id}/approve` | `{ comment?, fields?: [{ field, decision, value? }], reviewAt?, reviewNote? }` |
| `POST` | `/api/approvals/proposals/{id}/reject`  | `{ comment?, reviewAt?, reviewNote? }`                                         |
| `POST` | `/api/approvals/proposals/{id}/review`  | `{ reviewAt, note?, fields? }` → `201 { review }`                              |
| `GET`  | `/api/approvals/reviews`                | `status` (`due` by default), `proposalId`, `limit`, `offset`                   |
| `POST` | `/api/approvals/reviews/{id}/done`      | `{ comment?, cancel? }`; `409` once closed                                     |
| `GET`  | `/api/approvals/evidence`               | `entity`, `rowId` → `{ fields: { <field>: evidence } }`                        |

`GET /api/approvals/proposals/{id}` adds `fieldDiff`, `evidence`, `fieldDecisions`
and `reviews`.

## What is not covered

- A write that was not held keeps its evidence only when the row id can be read:
  from the path on an update, from the `id` of the answer on a create (a JSON
  answer; a TOON answer to a create keeps nothing).
- A kon operation's row id is read from the `id` of its answer; if the answer has
  none, the evidence stays on the proposal and is not attached to a row.
- Bulk creates (an array body) and uploads are decided whole.

## Upgrading

Migration `0068_agent_data_ledger.sql` adds `agent_proposals.field_diff`,
`evidence` and `field_decisions`, and the `field_evidence` table with its RLS;
`0069_ledger_reviews_and_job_budget.sql` adds `ledger_reviews`,
`kitsuden_outbox.cost` and `budget_policy`, and `kitsuden_queue_postpone`. Run the
migration runner as usual.
