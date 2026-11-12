# Agent permissions, keys and quotas

Every AI agent that talks to Kitsuden has an **identity** (`agent_identities`)
and one or more **API keys** (`kitsuden_agent_*`, in `agent_api_keys`). The key
authenticates every REST request and every MCP session. This page explains what
an agent can do with it, how to give it exactly that, and how to limit how much
it can do per minute and per day.

All of it is editable in the admin panel: **Agents → (an agent) → Permissions /
Keys / Quotas**, in English or Spanish.

## Contents

- [The rule: union, and deny wins](#the-rule-union-and-deny-wins)
- [What a scope can be](#what-a-scope-can-be)
- [Broad scopes and presets](#broad-scopes-and-presets)
- [Fine-grained scopes for kon operations](#fine-grained-scopes-for-kon-operations)
- [Per-dataset scopes](#per-dataset-scopes)
- [Deny](#deny)
- [Where each check happens](#where-each-check-happens)
- [Keys: expiry, rotation, revocation, last use](#keys-expiry-rotation-revocation-last-use)
- [Quotas](#quotas)
- [API reference](#api-reference)
- [Upgrading](#upgrading)

## The rule: union, and deny wins

An agent's permissions are a list of scope strings. The list is read with one
rule, implemented once in `@kitsuden/shared` (`agent-permission.ts`) and used
by the API, the engine, the kon SDK, the MCP tools and — translated to SQL —
the database's Row-Level Security:

1. **Grants are a union.** A request is allowed if _any_ granted scope covers
   it. A fine-grained scope never takes anything away from a broad one: an
   agent with `crm:*` and `kon:blog:create-post` keeps the whole CRM _and_
   can create blog posts.
2. **A deny wins over every grant**, `admin` included. `!kon:crm:delete-contact`
   next to `crm:*` means "all of the CRM except deleting contacts".
3. **`admin` (or `admin:*`) covers everything** that is not denied.

Human accounts carry no scopes; they are authorized by role (`admin`,
`editor`, `user`) through each kon's policy. Scopes are for agents.

## What a scope can be

| Form              | Example                                        | Meaning                                                            |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| broad             | `admin`, `mcp:read`, `content:edit`, `crm:*`   | what scopes always meant                                           |
| fine (operation)  | `kon:blog:create-post`                         | one operation of a kon built with the [kon SDK](../kons/README.md) |
| fine (dataset)    | `datasets:clients:read`                        | one action (`read`, `write`, `delete`) on one dataset              |
| trailing wildcard | `kon:blog:*`, `crm:*`                          | everything starting with the prefix (one or more segments)         |
| leading wildcard  | `*:read`                                       | everything ending with `:read`                                     |
| middle wildcard   | `datasets:*:read`                              | exactly one segment in that position                               |
| deny              | `!kon:blog:delete-post`, `!datasets:payroll:*` | removes what the pattern covers                                    |

Validation (the API answers `400`/`422` with the reason; nothing is dropped
silently any more): lowercase letters, digits, `_`, `-`, `.` and `*`, segments
separated by `:`, at most 5 segments and 200 characters, at most 200 scopes per
agent. A pattern made only of `*` (`*`, `*:*`) is rejected — it never granted
anything and still does not. `!admin` is rejected: remove `admin` instead. A
deny needs at least two segments.

## Broad scopes and presets

| Scope                                    | Grants                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`                                  | Everything (except what a deny removes).                                                                                                                                                                                                                         |
| `mcp:connect`                            | Open an MCP session. Every MCP client needs it.                                                                                                                                                                                                                  |
| `mcp:read`                               | The core's read-only MCP tools (query datasets and tables, describe, status).                                                                                                                                                                                    |
| `mcp:write`                              | The core's MCP tools that write records.                                                                                                                                                                                                                         |
| `mcp:admin`                              | The core's MCP tools that change the system (create datasets, install kons, define actions).                                                                                                                                                                     |
| `content:edit`                           | Pages, blocks and the editorial layer of games (visual page editing).                                                                                                                                                                                            |
| `memory:read`, `memory:write`            | The agent's own memory.                                                                                                                                                                                                                                          |
| `brain:read`, `brain:write`              | The brain (agent memory with an owner): read = search/read/list/export its own and shared notes; write = also write its own notes, connections and claims and import graphify graphs. See [memory.md](memory.md).                                                |
| `promotion:propose`                      | Submit code drafts for code actions and read its own drafts. Never approves or activates anything: a human approves, or turbo mode activates a draft only when nothing widens permissions. See [promotion.md](promotion.md).                                     |
| `<kon>:*`                                | Everything in that kon, e.g. `crm:*`, `blog:*`: its SDK operations, its legacy routes (the host's route gates let it in, for that kon only) and its data (the kon treats the agent as its administrator, also in Row-Level Security). `kon:<kon>:*` is the same. |
| `kon:*`                                  | Every operation of every kon built with the SDK. It does **not** open legacy routes or make the agent a kon administrator.                                                                                                                                       |
| `datasets:*:read` / `:write` / `:delete` | That action on every dataset.                                                                                                                                                                                                                                    |
| `mcp-external:<server>:<tool>`           | One approved tool of an external MCP server (`mcp-external:github:*`, `mcp-external:*` for more). Never granted by `admin`: it must be explicit. See [external-mcp.md](external-mcp.md#letting-agents-use-the-tools).                                            |

The panel computes, from the mounted kons and the existing datasets, which
operations and dataset permissions each broad scope actually opens
(`GET /api/v1/agent-access/catalog`).

Presets (applying one **replaces** the list):

| Preset         | Scopes                                                                                 |
| -------------- | -------------------------------------------------------------------------------------- |
| Connect only   | `mcp:connect`                                                                          |
| Read only      | `mcp:connect`, `mcp:read`, `datasets:*:read`                                           |
| Content editor | `mcp:connect`, `mcp:read`, `content:edit`, `kon:blog:*`, `kon:blocks:*`, `kon:media:*` |
| Data editor    | `mcp:connect`, `mcp:read`, `mcp:write`, `datasets:*:read`, `datasets:*:write`          |
| Full admin     | `admin`                                                                                |

## Fine-grained scopes for kon operations

Each operation declared with the kon SDK has a stable scope
`kon:<kon>:<operation>` (the kon id without `kon-`; the operation id from its
declaration). It also has a stable MCP tool name `<kon>__<operation>`.

An operation is allowed when any of these grants it: its fine scope (or
`kon:<kon>:*`, `kon:*`), the kon-wide `<kon>:*`, a broad scope the operation
declares, `admin`, the kon's policy, or a role it lists — unless a deny covers
it.

**The host's route gates accept fine scopes.** Some prefixes are reserved to
the team (`/api/blog` writes to staff, `/api/v1` to admins, …). When a request
under such a prefix is an SDK operation and the agent's scopes grant _that_
operation, the gate lets it through. Only that operation:

```
agent scopes: ["kon:blog:create-post"]

POST   /api/blog            → allowed (create-post)
PATCH  /api/blog/:id        → 403 (update-post is not granted)
DELETE /api/blog/:id        → 403
```

Routes of kons that are not on the SDK yet ("legacy" routes) keep their gate,
which also accepts the kon-wide scope of **that** kon (`crm:*` or
`kon:crm:*` opens `/api/crm`, never another kon's prefix or a core route).
One exception: `/api/blog/source` returns a row of any table and stays
staff-only. A deny of the whole kon (`!crm:*`, `!kon:crm:*`) wins, `admin`
included.

### Agents inside a kon

Kons decide with their policies and with Row-Level Security, and both used to
ask only for the _human_ role (`admin`, `editor`). An agent arrives with role
`agent`, so an agent with `admin` saw empty lists. The core now gives kons one
rule, in TypeScript and in SQL, compared by a test:

| TypeScript (`@kitsuden/engine`)                 | SQL (core, applied before kon migrations)             | True for                                                          |
| ----------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `isEffectiveAdmin(user, "crm")`                 | `kitsuden_effective_admin('crm')`                     | a human `admin`, or an agent with `admin`, `crm:*` or `kon:crm:*` |
| `isEffectiveStaff(user, "crm")`                 | `kitsuden_effective_staff('crm')`                     | the above, or a human `editor`                                    |
| `agentCan(user, "conta:view")`                  | `kitsuden_agent_can('conta:view')`                    | an agent whose scopes grant that scope                            |
| `agentCanInKon(user, "members", "member:view")` | `kitsuden_agent_can_in_kon('members', 'member:view')` | the above, or the whole kon, unless `!members:*` closes it        |

A deny always wins, also over a policy rule that says yes: `can()` refuses
`<resource>:<action>` when the key denies it.

> An agent is not a user account. Operations that store an author or an owner
> pointing at an account need one: for example a blog post needs `authorId`
> (the account the agent writes for), and a dataset entry created by an agent
> has no owner (`created_by_id` records the agent).

## Per-dataset scopes

`datasets:<slug>:read`, `datasets:<slug>:write` (create and edit entries) and
`datasets:<slug>:delete`, with wildcards (`datasets:*:read`, `datasets:clients:*`).

They are combined with the dataset's own `policyJson` and with the database's
Row-Level Security:

- a **granted** dataset scope opens that dataset to the agent even if its
  `policyJson` does not (`readAccess`/`writeAccess`);
- a **denied** one closes it even if the policy would open it;
- if the scopes say nothing about a dataset, its `policyJson` decides, as
  before; to write that way a key also needs `mcp:write` (a read-only key does
  not write in a `writeAccess: "authenticated"` dataset: it is not a session);
- inside the dataset, `policyJson.rlsRules` still filter the rows the agent
  sees, and Postgres RLS still applies: the API passes the agent's scopes to
  the transaction (`app.agent_scopes`) and the `data_entries_agent_*` policies
  evaluate them with `kitsuden_agent_opens_dataset()`, the same rule in SQL. A
  bug in a handler cannot leak entries of a dataset the scopes do not open.

`write` and `delete` also let the agent _reach_ the dataset to write (it does
not need `read` to create an entry), but listing and reading entries needs
`read`.

They apply everywhere datasets are reachable:

| Surface                                               | How                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST `/api/datasets/...` (kon-datasets)               | listing, reading, searching, snapshots, change history (read); creating, editing (write) and deleting (delete) entries                                                                                                                          |
| REST `/api/data-sets/...` (lite API)                  | listing, reading (read), creating entries (write)                                                                                                                                                                                               |
| MCP tools generated from kon-datasets (`datasets__*`) | the same pipeline as REST                                                                                                                                                                                                                       |
| Core MCP tools                                        | `kitsuden_list_datasets`, `kitsuden_describe_collection`, `kitsuden_query_collection`, `kitsuden_query_dataset` (read); `kitsuden_create_record`, `kitsuden_insert_record`, `kitsuden_update_record` (write); `kitsuden_delete_record` (delete) |

For the core MCP tools the order is: a deny on that dataset → refused; a
dataset scope → allowed; otherwise the tool's broad scope (`mcp:read` /
`mcp:write`) opens the **tool**, and the dataset's `policyJson` decides, the
same way REST does: reading needs a `readAccess` that lets a session in
(`public`, `authenticated`) or the policy scope `dataset:view`; writing also
needs `writeAccess` (or `dataset-entry:create` / `dataset-entry:delete`); a
dataset without a policy is admin-only, so only `admin` opens it. Listing
hides the datasets the agent cannot read, and `policyJson.rlsRules` filter the
rows returned by `kitsuden_query_collection` / `kitsuden_query_dataset` as
they do over REST. On native tables (not datasets) only the broad scope counts.

> Behavior change: before, `mcp:read`/`mcp:write` read
> and wrote **every** dataset, including admin-only ones. An agent that relied
> on that needs `datasets:<slug>:<action>` for those datasets now.
> Editing or deleting one entry by id follows REST (changed on 2026-10-31): a
> key let in only by `mcp:write` and the dataset's policy touches only its own
> rows; a scope that names the action (`datasets:<slug>:write`,
> `dataset-entry:update`, `admin`) reaches any row `rlsRules` let it see.
> Reading follows REST too: outside `admin`, only published rows and its own.

## Deny

A deny is a scope with a leading `!`. It never grants anything; it removes
whatever its pattern covers, and it wins over every grant.

| Deny                       | Effect                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `!kon:blog:delete-post`    | that operation is refused (REST and MCP), even with `admin`                                                                                                 |
| `!kon:blog:*` or `!blog:*` | every operation of the blog kon is refused — **including public ones**, for this key — and, for kons not on the SDK, every route under the kon's mount path |
| `!datasets:payroll:*`      | the dataset `payroll` is closed for this key (REST, MCP and RLS)                                                                                            |
| `!datasets:*:delete`       | no entry can be deleted in any dataset                                                                                                                      |

Limits of deny (by design):

- It removes what this **key** can do. Anything public stays public for
  everyone else — a denied agent could still read a public endpoint without
  its key.
- A deny of one _operation_ cannot close a legacy (non-SDK) route, because
  there is no operation to match; deny the whole kon instead.
- A deny of a broad scope that a kon checks literally (for example a policy
  that looks for `content:edit`) does not remove that broad scope: simply
  do not grant it.

## Where each check happens

| Layer                                               | What it checks                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| Authentication (`services/agent-auth.ts`)           | key format, hash, **revoked**, **expired**, agent active           |
| Quotas (`lib/agent-quotas.ts`)                      | requests per minute, writes and budget units per day               |
| Denies (`middleware/auth-guard.ts`, `agentDenials`) | an SDK operation, or a whole legacy kon, denied for this key → 403 |
| Prefix gates (`adminGate`)                          | role or broad scope — or the operation's fine scope                |
| The operation (`packages/engine/src/operations.ts`) | deny, then fine/broad/resource scopes ∪ roles ∪ policy             |
| Datasets (`packages/core/datasets`)                 | dataset scopes, then `policyJson`                                  |
| Postgres RLS (`rls-policies.sql`)                   | owner, admin, dataset policy — and the agent's dataset scopes      |

The MCP server runs SDK tools through the same gates, denies, idempotency and
RLS as REST, plus the agent's `allowedTools` list.

## Keys: expiry, rotation, revocation, last use

|                               |                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Expiry**                    | `expires_at`. Set when creating a key (30, 90, 365 days or none). An expired key answers `401`.                                                                                                                                                                                                                                         |
| **Rotation without downtime** | `POST …/keys/:keyId/rotate` creates a new key and shortens the old one to `now + graceHours` (default 24 h, at most 30 days; `0` = it stops now). Both keys work during the grace period, so you deploy the new key and let the old one expire. The new key records `rotated_from`. A revoked or expired key cannot be rotated (`409`). |
| **Revocation**                | `POST …/keys/:keyId/revoke` sets `revoked_at` and `revoked_by`. Authentication reads the database on every request, so the next request with that key answers `401` (`KEY_REVOKED`), including inside an open MCP session. The row stays for auditing.                                                                                  |
| **Last use**                  | `last_used_at`, updated on each successful authentication.                                                                                                                                                                                                                                                                              |

The secret is returned **once**, when the key is created or rotated, and is
stored only as an Argon2id hash.

Every change of scopes, keys or quotas is written to the agent audit log
(`agent_audit_logs`, action `config_change`) with who made it.

## Quotas

The same screen also shows the **tokens the auto format saved** for the agent
and its **MCP settings** (default toolset, wrapping of untrusted content): see
[toolsets.md](toolsets.md) and [untrusted-content.md](untrusted-content.md).

| Limit                      | Column                 | Default | Counts                                                  |
| -------------------------- | ---------------------- | ------- | ------------------------------------------------------- |
| Requests per minute        | `rate_limit`           | 60      | every request with the key                              |
| Writes per day (UTC)       | `writes_per_day`       | none    | `POST`/`PUT`/`PATCH`/`DELETE`, and MCP tools that write |
| Budget units per day (UTC) | `budget_units_per_day` | none    | 1 per operation, or the operation's declared `cost`     |

When a limit is exceeded the API answers **429** `application/problem+json`
with `retry_after` (and a `Retry-After` header):

- `KITSUDEN_E_RATE_LIMITED` — the per-minute limit; `retry_after` = seconds to
  the next minute;
- `KITSUDEN_E_QUOTA_EXCEEDED` — a daily limit; `quota` says which
  (`writes_per_day` or `budget_units_per_day`), `limit` the configured value,
  and `retry_after` the seconds until 00:00 UTC.

Over MCP, the HTTP request that carries the JSON-RPC message counts for the
per-minute limit, and each `tools/call` spends its own write and units; a tool
call over quota returns a tool error with the same problem.

Counters live in **Valkey** (shared by every API replica). If Valkey is
unavailable, the per-minute counter falls back to process memory and the daily
counters to the `agent_quota_usage` table in Postgres (only when the agent has
a daily limit). If neither can count, the request is allowed and a warning is
logged: a quota must not take the API down.

Requests rejected by a permission still count: an agent that keeps hammering a
`403` is slowed down too. A request rejected by a daily quota is not charged.

**Replays are free.** A request that the [idempotency layer](../install/errors-and-retries.md#idempotency-key)
answers with the stored response (`Idempotent-Replayed: true`) executes
nothing and charges nothing: no request, write or unit. Before charging, the
API looks the `Idempotency-Key` up in the idempotency store; if a stored
response for the same request is there, the quota is skipped. As a safety net,
anything charged on entry is refunded when the response turns out to be a
replay. The same holds over MCP for kon SDK tools called again with the same
`idempotency_key`.

## API reference

All under `/api/v1`, admin only:

| Method | Path                             |                                                                                                                                                  |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/agent-access/catalog`          | presets, broad scopes (and what each opens), SDK operations by kon, datasets                                                                     |
| `GET`  | `/agents/:id/access`             | the merged view: every operation and dataset action with its state (`granted`, `denied`, `open`, `policy`, `none`) and the scope that decided it |
| `PUT`  | `/agents/:id/scopes`             | `{ "scopes": [...] }` replaces the list (validated)                                                                                              |
| `GET`  | `/agents/:id/keys`               | keys without secrets, with `status` (`active`, `expiring`, `expired`, `revoked`)                                                                 |
| `POST` | `/agents/:id/keys`               | `{ "name"?, "expiresInDays"? }` → `{ key, apiKey }`                                                                                              |
| `POST` | `/agents/:id/keys/:keyId/rotate` | `{ "graceHours"?, "expiresInDays"?, "name"? }` → `{ key, apiKey, previous }`                                                                     |
| `POST` | `/agents/:id/keys/:keyId/revoke` | → `{ key }`                                                                                                                                      |
| `GET`  | `/agents/:id/quotas`             | `{ limits, usage }`                                                                                                                              |
| `PUT`  | `/agents/:id/quotas`             | `{ "requestsPerMinute"?, "writesPerDay"?, "budgetUnitsPerDay"? }` (`null` = no daily limit)                                                      |

**Keys expire by default.** A key created without `expiresInDays` (here, in
`POST /api/admin/agents`, `POST /api/admin/agents/:id/keys`, a rotation, or
`createAgent()`) expires after `AGENT_KEY_DEFAULT_EXPIRY_DAYS` days (90 unless
set; `0` restores keys that never expire). `"expiresInDays": null` asks for a
key that never expires; do that only for a key you will rotate by hand. Keys
issued before 2026-11-04 keep the expiry they had (often none): list them with
`GET /agents/:id/keys` and rotate the ones that matter. OAuth connections are
unaffected: their tokens already expire and rotate.

Example: an agent that can create blog posts and read one dataset, and nothing
else, with 500 writes a day:

```bash
curl -X PUT "$API/api/v1/agents/$AGENT/scopes" -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"scopes":["mcp:connect","kon:blog:create-post","datasets:clients:read"]}'

curl -X PUT "$API/api/v1/agents/$AGENT/quotas" -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" -d '{"writesPerDay":500}'
```

## Upgrading

- Migration `0047_agent_permissions_and_quotas.sql` adds the key columns
  (`name`, `revoked_at`, `revoked_by`, `rotated_from`), the quota columns and
  the `agent_quota_usage` table, with grants to `kitsuden_app`. It is
  idempotent.
- The RLS script (`rls-policies.sql`, applied by `migrate.ts` after the
  migrations, or by `apply-rls.ts`) adds `kitsuden_pattern_covers()`,
  `kitsuden_agent_opens_dataset()` and the `data_entries_agent_*` policies.
- Existing scopes keep their meaning. Before, saving scopes through
  `/api/admin/agents` silently dropped anything not matching `word:word`; now
  fine scopes are kept and invalid ones are rejected with the reason.
- Revoking a key through the old `DELETE /api/admin/agents/:id/keys/:keyId`
  now marks it revoked instead of deleting the row.
- The per-minute limit used to answer `401` and was counted twice per MCP
  message; it now answers `429` and is counted once.
