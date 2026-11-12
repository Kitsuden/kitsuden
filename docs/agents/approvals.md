# Human approval of agent requests

Kitsuden can hold back what an AI agent asks for until a human says yes. When
an agent's request needs approval it is **not executed**: it is stored as a
**proposal**, the agent gets `202 Accepted` with the proposal id, and a person
on your team approves or rejects it in the admin panel. An approved proposal
runs once, with the agent's identity, and the agent can read the real result.

It is **off by default**. With the default settings Kitsuden behaves exactly
as it did before this feature existed. Humans are never held back; only agents
(`kitsuden_agent_*` keys) are.

Everything is in the admin panel (English or Spanish): **Approvals** (inbox,
settings, audit) and **Agents → (an agent) → Approval**.

## Contents

- [Turning it on](#turning-it-on)
- [The decision: operation → agent → global](#the-decision-operation--agent--global)
- [What is sensitive](#what-is-sensitive)
- [What the agent sees](#what-the-agent-sees)
- [Unattended runs](#unattended-runs)
- [Retries and idempotency](#retries-and-idempotency)
- [What a proposal stores](#what-a-proposal-stores)
- [Image uploads](#image-uploads)
- [Approving and rejecting](#approving-and-rejecting)
- [Who can approve what](#who-can-approve-what)
- [Execution](#execution)
- [Expiry](#expiry)
- [Audit](#audit)
- [Configuration changes and cost](#configuration-changes-and-cost)
- [What is not covered](#what-is-not-covered)
- [API reference](#api-reference)
- [Human signer](#human-signer)
- [Code drafts from agents](#code-drafts-from-agents)
- [Upgrading](#upgrading)

## Turning it on

Three switches, all in the panel and all audited:

1. **Global** (**Approvals → Settings**): the **master switch**, on or off.
   Off by default. While it is off **no agent is asked for approval**, not even
   the ones in `propose`: turning it off also releases the agents you were
   watching (the panel warns you, and lists them, before you do).
2. **Per agent** (**Agents → (agent) → Approval**, or the agents list in
   **Approvals → Settings**), with the global switch on:
   - `inherit` (default): only its sensitive operations wait;
   - `propose` — "propose only": its writes become proposals too, as the
     **retention** says (below);
   - `direct`: this agent is never asked for approval.

   **Retention** of `propose` (**Approvals → Settings**, `proposeRetention`):
   - `selective` (default): every write except the `POST` operations their kon
     declares read-only (`readOnly`: validate, compare, preview, report).
     Routes that are not kon SDK operations declare nothing and are held.
   - `strict`: every write (`POST`, `PUT`, `PATCH`, `DELETE`), no exceptions.

3. **Per operation** (**Approvals → Settings → Operations**): which operations
   are sensitive. The default comes from each operation's declaration in its
   kon (`sensitive`, see [the kon SDK](../kons/README.md#sensitive-operations));
   an admin can force any operation to sensitive or not sensitive, or reset it
   to the default.

Only an `admin` (a human) can change any of this. No agent can, whatever its
scopes — `admin` included.

## The decision: operation → agent → global

For every request that comes from an agent:

1. **The operation**: is it sensitive? The admin's override if there is one,
   else the kon's declaration (`DELETE` only, by default); for routes that are
   not kon SDK operations, the legacy rules; for core MCP tools, the ones that
   delete.
2. **The global switch** (master): off → run everything, whatever the mode.
3. **The agent's mode**: `direct` → run it; `inherit` → hold the sensitive
   operations; `propose` → hold every sensitive operation and every write
   (`POST`, `PUT`, `PATCH`, `DELETE`), except, with `selective` retention, the
   `POST` operations declared read-only.

| Global / agent mode    | Sensitive | Other write | Read-only `POST` | Other read |
| ---------------------- | --------- | ----------- | ---------------- | ---------- |
| global off, any mode   | runs      | runs        | runs             | runs       |
| `direct`               | runs      | runs        | runs             | runs       |
| `propose`, `selective` | proposal  | proposal    | runs             | runs       |
| `propose`, `strict`    | proposal  | proposal    | proposal         | runs       |
| `inherit`              | proposal  | runs        | runs             | runs       |

The table is implemented once, as `decideApproval` in `@kitsuden/shared`
(`approvals.ts`), and used by REST and MCP.

A request the agent could not run anyway is **not** turned into a proposal: if
its key lacks the permission for a kon SDK operation (or a deny covers it), the
route answers its usual `403`. Proposals are only for what the agent may do,
pending a human.

## What is sensitive

- **Kon SDK operations**: the `sensitive` flag of the declaration (`true` for
  `DELETE`, `false` otherwise) unless an admin overrode it. The override key is
  the operation's fine scope, e.g. `kon:blog:delete-post`.
- **Legacy routes** (anything that is not a kon SDK operation): a list of
  `{ method, path }` rules. `method` is `*` or an HTTP method; in `path`, `*` is
  one segment and `**` any rest. The default list is
  `[{ "method": "DELETE", "path": "/api/**" }]`, so every `DELETE` is sensitive,
  SDK or not. Remove it, or add your own (`PATCH /api/games/*`, …).
- **Core MCP tools** (`kitsuden_*`, and tools that kons register as actions):
  key `mcp:<tool name>`. Sensitive by default when the name contains `delete`
  (`kitsuden_delete_record`). A tool "writes" when its scope is `mcp:write` or
  `mcp:admin`, and action tools always count as writes.
- **Kon SDK tools over MCP** follow their operation, exactly as over REST.

Any method can be marked sensitive, reads included (an export, say). A
sensitive read is held like a write.

## What the agent sees

### REST

```http
DELETE /api/blog/categories/6fa9…   (Authorization: Bearer kitsuden_agent_…)

HTTP/1.1 202 Accepted
Location: /api/proposals/31ae80ea-…
Content-Type: application/json

{
  "code": "KITSUDEN_E_APPROVAL_REQUIRED",
  "status": 202,
  "title": "Pending human approval",
  "detail": "This request needs human approval. It was stored as proposal 31ae80ea-… and has NOT been executed.",
  "retryable": false,
  "hint": "Nothing was executed yet: … poll `proposal.statusUrl` …",
  "proposal": {
    "id": "31ae80ea-…",
    "status": "pending",
    "reason": "sensitive",
    "method": "DELETE",
    "path": "/api/blog/categories/6fa9…",
    "operation": "kon:blog:delete-category",
    "expiresAt": "2026-10-31T10:00:00.000Z",
    "statusUrl": "/api/proposals/31ae80ea-…"
  },
  "type": "…/errors-and-retries.md#kitsuden_e_approval_required",
  "docs": "…/errors-and-retries.md#kitsuden_e_approval_required"
}
```

`reason` is `sensitive` or `propose_only`. Then:

```http
GET /api/proposals/31ae80ea-…
→ 200 { "id": …, "status": "executed", "comment": "ok",
        "result": { "status": 200, "contentType": "application/json", "body": { … } } }
```

`status` is one of `pending`, `executing`, `executed`, `failed`, `rejected`,
`expired`. `result` appears once it ran (`executed` or `failed`); `comment` is
the reviewer's comment. An agent only sees its own proposals (another agent's
id is `404`). `GET /api/proposals?status=pending` lists them.

### MCP

The tool call returns a result that is **not** an error, with the same body in
`structuredContent` (`code: "KITSUDEN_E_APPROVAL_REQUIRED"`, `proposal`), and
a text telling the model not to call the tool again. Every agent session also
gets the tool `kitsuden_proposal_status`:

```json
{ "name": "kitsuden_proposal_status", "arguments": { "proposal_id": "31ae80ea-…" } }
```

It returns the same view as `GET /api/proposals/{id}`. If the agent has an **allowed tools** list, the tool
is only offered when that list includes `kitsuden_proposal_status`; the REST
endpoint always works.

### Being told instead of polling

Two ways, both fired when the proposal ends up `executed`, `failed`,
`rejected` or `expired`:

**Server-Sent Events**, nothing to configure:

```http
GET /api/proposals/31ae80ea-…/events
Accept: text/event-stream

id: 1
data: { "id": "31ae80ea-…", "status": "pending", … }

id: 2
data: { "id": "31ae80ea-…", "status": "executed", "result": { … } }

event: end
data: {"count":2}
```

The first event is the proposal as it is now; then one per change, and the
stream ends when it is resolved. A `: ping` comment every 15 s keeps proxies
from closing it; it closes after 15 minutes without a resolution (reconnect).
In the typed SDK it is an `AsyncIterable`:
`for await (const p of kitsuden.proposals.proposalEvents({ id })) …`.

**A signed webhook** to the agent's own server. An admin sets the agent's
notify URL (`https://` and a public address; the agent cannot set it):

```http
PUT /api/admin/agents/{agentId}/notify
{ "url": "https://agent.example.com/kitsuden" }
→ 200 { "url": "…", "secret": "whsec_…" }   ← shown only this once
```

Each resolution is then POSTed as JSON (`{ type, deliveryId, createdAt,
agentId, proposal }`) with:

| Header                 |                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------- |
| `X-Kitsuden-Event`     | `proposal.executed`, `proposal.failed`, `proposal.rejected`, `proposal.expired` |
| `X-Kitsuden-Delivery`  | the delivery id, the same on every retry: deduplicate on it                     |
| `X-Kitsuden-Signature` | `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`                       |

Verify the HMAC over the **raw** body and reject a `t` older than five
minutes. Delivery goes through the Postgres queue: it is atomic with the
decision, retried with backoff (up to 8 attempts) when your server fails, and
a `410 Gone` stops it. Failed deliveries stay as dead jobs in the panel
(**Requests and queue → Queue**). `POST /api/admin/agents/{id}/notify/rotate`
issues a new secret; `{ "url": null }` turns the webhook off.

## Unattended runs

A proposal waits for a person. When nobody is waiting for the answer either,
the agent cannot act on a `202` and the inbox fills with requests nobody asked
for. For those runs an admin can choose to **refuse** what would be held, with a
text that says what to do instead.

A run is unattended when:

- the code of a panel-defined action runs from a **cron**, **event** or **HTTP**
  trigger (its `kitsuden.api.*` calls). An HTTP trigger has a caller, but it is a
  machine (a provider's webhook) that will not come back for a pending proposal;
- an agent run is started by a cron, event or HTTP action (its tool calls).

A **manual** run is attended: whoever ran it, a person in the panel or an agent,
can follow the proposal.

- an agent says so with the header `Kitsuden-Unattended: true` on a REST request,
  or on the MCP `POST` that carries the `tools/call`. The header can only make
  things stricter, so it is trusted.

What happens to a request that **would be held** (nothing else changes; what
runs directly still runs directly):

| Setting          | Unattended                                         | Attended |
| ---------------- | -------------------------------------------------- | -------- |
| `hold` (default) | `202 KITSUDEN_E_APPROVAL_REQUIRED`, as always      | `202`    |
| `deny`           | `403 KITSUDEN_E_DENIED_UNATTENDED` + `alternative` | `202`    |

- Global: `PUT /api/approvals/settings` with `unattended: "hold" | "deny"` and
  `unattendedAlternative` (text, or `null` for the default).
- Per agent: `PUT /api/approvals/agents/{id}/unattended` with
  `{ mode: "hold" | "deny" | null, alternative: text | null }`; `null` follows
  the global value. In the panel: Agents → agent → Approval → "When nobody is
  attending".
- Per operation: `alternatives: { "<key>": text | null }` in the settings (the
  same keys as `operations`), and `alternative` on a legacy rule.

The alternative is the most specific one written: operation or legacy rule,
then the agent's, then the global one, then the default, which tells the agent
to record its decision with `kitsuden_record_decision` (see
[decisions](decisions.md)) so a person can act. Over MCP the refusal is an error
result whose text ends with `What to do instead: …` and whose
`structuredContent` carries `code` and `alternative`. Every refusal is audited
(`unattended_denied`) and shows in the audit tab; nothing is stored as a
proposal.

Not covered: queue jobs of TypeScript actions do not go through approval at all
(they are code, not an agent), so there is nothing to refuse there.

## Retries and idempotency

- **Same `Idempotency-Key`** (REST header, or MCP `idempotency_key` argument)
  → the same proposal. Over REST the [idempotency layer](../install/errors-and-retries.md#idempotency-key)
  replays the original `202` (`Idempotent-Replayed: true`); that body is a
  snapshot, so read `statusUrl` for the current state. After the idempotency
  store forgets the key (24 h) the proposal still remembers it: same key and
  same request → same proposal, in any state.
- **Same key, different request** → `422 KITSUDEN_E_IDEMPOTENCY_KEY_REUSED`.
- **No key, identical request while a proposal for it is pending** → that
  pending proposal again (the inbox does not fill with retries).
- **Approving twice does not run twice.** Approval reserves the proposal with
  one atomic `UPDATE … WHERE status = 'pending'`; a second approval (or two at
  the same time) gets `409` with the current state.

## What a proposal stores

Agent, key id, channel (`rest`/`mcp`), method, path with query, the kon
operation (or MCP tool), the body (or tool arguments), the idempotency key, the
agent's scopes at that moment, the reason, the expected diff, the expiry date,
and later the decision (who, when, comment) and the real result (status,
content type, body).

**Never secrets.** A request whose body carries a secret (a field named like a
password, token, secret or key, or a value that looks like a Kitsuden key) is
not stored: it gets `403 KITSUDEN_E_APPROVAL_UNSUPPORTED` (`reason: "secret"`)
and is not executed. This is a decision, not a missing feature: a watched agent
does not touch secrets without a human in front.

**Image uploads can be proposals; other files cannot.** A multipart upload
made only of images is held like a JSON body (see [Image uploads](#image-uploads)).
An upload with any file that is not an image by its content gets the same 403
(`reason: "not_image"`), and a form that cannot be read gets
`reason: "multipart"`. Other non-JSON bodies (`not_json`) and JSON or text
over 256 KiB (`too_large`) are rejected too. Results that contain a secret are stored as `{ "omitted": "secret" }`.
No request headers are stored.

**The diff** is computed when it is cheap: for `PATCH`/`PUT`/`DELETE` Kitsuden
reads the same path with `GET` **as the agent** (so it never shows what the
agent could not read) and stores `changes: [{ field, before, after }]`, or the
current resource for a `DELETE`. For `POST` it is the proposed body; for core
MCP tools, the arguments. If the read fails, the diff says so
(`currentUnavailable`) and nothing else changes.

## Image uploads

An agent that needs approval can upload **images** (for example
`POST /api/media/upload`): the upload becomes a proposal (`202`) like any
other request. It is held only when **every** file in the form passes these
checks; otherwise nothing is stored and the agent gets
`403 KITSUDEN_E_APPROVAL_UNSUPPORTED` with the reason:

| Check                                                                                                                                                                                                                 | Reason when it fails |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Each file is JPEG, PNG, GIF, WebP or AVIF **by its first bytes** (the same detection as the media library); the file name and the `Content-Type` the client sends do not count. SVG, HTML, PDF and video are refused. | `not_image`          |
| Each image is at most `APPROVALS_MAX_UPLOAD_MB` (default **10**, the media library's limit; 1 to 100), and there are at most 20 files                                                                                 | `too_large`          |
| The text fields (and file names) carry no secret, by name or by value, as for JSON bodies                                                                                                                             | `secret`             |
| The form can be parsed                                                                                                                                                                                                | `multipart`          |

**Where the files wait.** Not in `/media`: the bytes are kept in the database
table `agent_proposal_files`, written in the same transaction as the
proposal. The media storage is public by design (local `/media/*`, or an S3
bucket behind `S3_PUBLIC_URL`), so a "private prefix" there would only be
private as long as nobody makes the bucket public. The proposal's `body`
keeps the text fields and, for each file, its field, name, detected type, size
and SHA-256 (no bytes).

**Who sees them.** Team members only, in the inbox, as thumbnails served by
`GET /api/approvals/proposals/{id}/files/{fileId}` (the same gate as the rest of
`/api/approvals`: anonymous `401`, a plain user or any agent `403`). The
response has the re-checked image type, `Cache-Control: private, no-store`,
`X-Content-Type-Options: nosniff` and an empty CSP.

**On approval** the form is rebuilt (same fields, same files with their
detected type; a file whose SHA-256 no longer matches stops the execution) and
sent again with the agent's identity, exactly like a JSON proposal. The upload
then lands in the media library as if the agent had sent it directly.

**Deletion.** The held files are deleted when the proposal is rejected,
expires or has been executed (successfully or not), and with the proposal if
it is ever deleted. After that the thumbnail route answers `404` and the
inbox says the images were deleted.

**Retries.** The proposal fingerprint uses the fields and the SHA-256 of each
file, not the raw multipart bytes (the boundary changes on every send): an
identical retry finds the same pending proposal.

An upload by an agent is stored with `created_by_id` = its valid
[human signer](#human-signer), or empty when it has none (an agent is not an
account), and `metadata.agentId` = the agent.

## Approving and rejecting

**Approvals** in the panel: the inbox (pending first, with a counter in the
menu), filters by status, and each proposal's detail — request, body, diff,
agent, key, scopes — with **Approve** and **Reject** and an optional comment the
agent will see.

- **Approve** runs the request now and shows the result.
- **Reject** never runs it.

A proposal that writes a record (a dataset entry, `kitsuden_create_record` /
`kitsuden_update_record`, a kon operation with a JSON body) can also be decided
**field by field**, with the agent's evidence next to each field, and either
decision can schedule a later review: see the [agent data ledger](ledger.md).

## Who can approve what

Only humans of the team: `admin` and `editor` accounts. An agent never can
(not even with `admin`); neither can a plain `user` account. And a human can
only approve what they could do themselves:

- an **admin** can approve anything;
- an **editor** can approve kon SDK operations their role is granted (the same
  check the route makes: roles and the kon's policy) and legacy routes behind
  a team ("staff") gate; not routes behind an admin gate or under
  `/api/admin`, not legacy routes without a gate (Kitsuden cannot know what
  they check inside), and not core MCP tools;
- an **editor never approves the proposals of an agent they sponsor** (its
  [signer](#human-signer), as recorded on the proposal or as the agent has now):
  another editor or an admin has to (`cannotDecideReason: "own_agent"`). An
  admin may approve their own agent's proposals: admins are trusted, and an
  install with a single human has that human sponsor every agent.

Any team member (`admin` or `editor`) can **reject** any proposal: rejecting
never runs anything. The detail view says whether you can approve
(`canDecide`) and why not. The role is read from the database at that moment,
not from the session cookie.

## Execution

On approval the stored request runs **once**, by the same path it came in:

- **REST**: it re-enters the API with the agent's identity, set by the server
  process itself (a value no HTTP request can carry). It goes through the deny
  list, the role gates, the operation's permission, row-level security and the
  handler again. It skips the approval gate and the agent's quotas (they were
  counted when it was proposed). No `Idempotency-Key` is forwarded.
- **MCP**: the same tool is called again with the same arguments and a session
  rebuilt for the agent.

**The agent's identity is re-read at that moment.** If the agent was
deactivated, the key it used was revoked or has expired, or its permission for
the operation was removed (or a deny added), the proposal ends as `failed`
with `result.error` saying why (`not_executed: key_revoked`, …) and nothing
runs. The scopes used are the agent's current ones, not the stored snapshot.

The approver is recorded on the proposal (`decidedBy`) and in the audit;
the operation itself runs as the agent (rows it creates belong to the agent,
not to the human).

A proposal whose execution returns `4xx`/`5xx` ends `failed`, with that
response as its result. If the server stops in the middle of an execution the
proposal stays `executing` and is **never** retried automatically
(at-most-once): check the result by hand.

## Expiry

A pending proposal expires after `ttlHours` (default 168 h = 7 days; 1 to 720)
set in **Approvals → Settings**. Expired proposals cannot be approved and are
never executed. They are marked `expired` (and audited) every 5 minutes and
whenever the inbox or a proposal is read. The lifetime is fixed when the
proposal is created.

## Audit

Everything goes to `agent_audit_logs` and is visible in **Approvals → Audit**
(`GET /api/approvals/audit`):

| Action                                    | When                                                                           | Details                            |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| `approval_settings_changed`               | an admin changed the global switch, lifetime, an operation or the legacy rules | `by`, `before`, `after`            |
| `approval_mode_changed`                   | an admin changed an agent's mode                                               | `by`, `before`, `after`            |
| `proposal_created`                        | an agent's request was held                                                    | channel, reason, operation or tool |
| `proposal_approved` / `proposal_rejected` | a human decided                                                                | `by`, `comment`                    |
| `proposal_executed` / `proposal_failed`   | the approved request ran (or could not)                                        | `by`, result status, error         |
| `proposal_expired`                        | it was never decided                                                           | —                                  |

Settings changes, new proposals and decisions are audited synchronously: the
request fails if its audit entry cannot be written. The execution result and
expiry entries are best-effort (the result itself is always on the proposal).

### Audit retention

The API deletes `agent_audit_logs` rows older than `AGENT_AUDIT_RETENTION_DAYS` days
every hour (and once when it starts): unset or empty = 90, `0` = keep the log forever, any
other value that is not a positive number = 90. Before 2026-11-12 the log was never pruned,
although the comment of core migration 0076 says it was; the first sweep after upgrading
deletes everything older than the limit. Set `AGENT_AUDIT_RETENTION_DAYS=0` before upgrading
to keep it all.

## Configuration changes and cost

Changes apply **without a restart**: the process that saves them drops its
cache at once; other API processes pick them up within
`APPROVALS_CACHE_SECONDS` (default 10).

With the global switch off the cost is
nothing for humans and one in-memory check for agents; the configuration is
read from Postgres at most once every `APPROVALS_CACHE_SECONDS`, and only when
an agent makes a request. When approval applies to a request, creating the
proposal costs a few queries (and one internal `GET` for the diff).

## What is not covered

- Routes mounted before the session middleware (`/api/system`, `/api/admin/system`,
  the observability and search-index routes): admin-only, and they do not go
  through this gate.
- `/api/auth/*` (sign-in and sign-up) and the MCP transport itself (`/api/mcp`):
  MCP tools are checked one by one, as described above.
- The approval routes themselves.
- Uploads with a file that is not an image, other non-JSON bodies and
  requests with secrets cannot be proposed (`KITSUDEN_E_APPROVAL_UNSUPPORTED`).

## API reference

Agents (their own proposals; a team member sees all of them):

| Method | Path                         |                                                      |
| ------ | ---------------------------- | ---------------------------------------------------- |
| `GET`  | `/api/proposals`             | own proposals (`status`, `limit`, `offset`)          |
| `GET`  | `/api/proposals/{id}`        | status and, once run, the result                     |
| `GET`  | `/api/proposals/{id}/events` | the same, as Server-Sent Events until it is resolved |

Humans of the team (`admin`, `editor`; never an agent):

| Method | Path                                           |                                                                                                                                            |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/api/approvals/proposals`                     | inbox (`status`, `agentId`, `limit`, `offset`)                                                                                             |
| `GET`  | `/api/approvals/proposals/count`               | `{ pending }`                                                                                                                              |
| `GET`  | `/api/approvals/proposals/{id}`                | detail with diff, `canDecide` and `cannotDecideReason` (`not_staff`, `core_mcp_tool`, `admin_route`, `role_cannot`, `legacy_without_gate`) |
| `GET`  | `/api/approvals/proposals/{id}/files/{fileId}` | the bytes of a held image (thumbnail); `404` once deleted                                                                                  |
| `POST` | `/api/approvals/proposals/{id}/approve`        | `{ comment? }` → runs it                                                                                                                   |
| `POST` | `/api/approvals/proposals/{id}/reject`         | `{ comment? }`                                                                                                                             |
| `GET`  | `/api/approvals/settings`                      | switch, lifetime, rules, every operation and MCP tool with its default/override, agents' modes                                             |
| `PUT`  | `/api/approvals/settings`                      | **admin**: `{ enabled?, ttlHours?, operations?: { key: true \| false \| null }, legacyRules?: [{ method, path }] }`                        |
| `PUT`  | `/api/approvals/agents/{id}/mode`              | **admin**: `{ mode: "inherit" \| "propose" \| "direct" }`                                                                                  |
| `PUT`  | `/api/approvals/agents/{id}/unattended`        | **admin**: `{ mode?: "hold" \| "deny" \| null, alternative?: text \| null }` ([unattended runs](#unattended-runs))                         |
| `GET`  | `/api/approvals/audit`                         | `agentId`, `proposalId`, `limit`, `offset`                                                                                                 |

All of them are in `GET /api/docs/openapi.json` with their schemas; none is an
MCP tool (an agent must not be able to decide).

## Human signer

Each agent can have a fixed **human signer**: an `admin` or `editor` account,
chosen by an admin in **Agents → (agent) → Signer** (`PUT
/api/v1/agents/{id}/sponsor` with `{ "userId": "…" }`, `null` removes it).
What the agent creates is signed by that person:

| What                                                                                                                               | Field set to the signer | Still recording the agent      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------ |
| Blog post (`POST /api/blog`)                                                                                                       | `authorId`              | the agent's audit log          |
| Dataset entry (REST `/api/datasets`, lite `/api/data-sets`, `/api/items`, MCP `kitsuden_create_record` / `kitsuden_insert_record`) | `owner_id`              | `created_by_id` = the agent id |

Rules (implemented once in `@kitsuden/shared`, `signer.ts`):

- **With a signer**, the agent sends no author (or its signer's id) and the
  signer is used. Another `authorId` / `ownerId` is refused with `403
KITSUDEN_E_FORBIDDEN` — unless the agent has the `admin` scope, which may
  name any account.
- **Without a signer**, nothing changes: a blog post still needs an explicit
  `authorId` (400 otherwise), and dataset entries an agent creates have no
  owner. Over MCP an agent without `admin` can no longer put another user's id
  in `data.ownerId` (it used to be accepted silently).
- **If the signer is deleted or stops being an admin or editor**, the agent
  cannot create signed content: `403 KITSUDEN_E_AGENT_SPONSOR_INVALID` until an
  admin assigns a new signer (the panel shows the signer in red). The id is
  kept on purpose (no foreign key), so a deleted signer is not mistaken for
  "no signer".
- **On approval**, the proposal records the agent, its signer
  (`sponsorUserId`, the one used at execution) and the approver
  (`decidedBy`); the audit entries carry `sponsor` and `by`.

The signer's role is checked on every agent request that has one (one indexed
lookup).

## Code drafts from agents

Code an agent writes for an action never runs directly: it goes through the
[code promotion pipeline](promotion.md) (sandbox tests, local scan, capability
diff). A draft that needs a human appears in this inbox as a proposal for
`POST /api/promotion/versions/{id}/activate` (operation
`kon:promotion:activate-version`, reason `sensitive`), with the test and scan
summary as its diff; approving it activates the version. Only an admin can
approve it. `/api/promotion` itself is not held by this gate (a draft already
is a proposal), and code drafts are held whatever the master switch says.

## Upgrading

Migration `0048_agent_human_approval.sql` adds
`agent_identities.approval_mode` (default `inherit`), `approval_settings` and
`agent_proposals`; `0049_agent_signer.sql` adds
`agent_identities.sponsor_user_id` and `agent_proposals.sponsor_user_id`;
`0050_proposal_files.sql` adds `agent_proposal_files` (held images).
Run the migration runner as usual. Until it runs, the API
logs one warning and keeps behaving as before (everything off).
