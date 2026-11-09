# Limit on what leaves: customer data

Scopes and row-level security decide who may **read** a value. This page is
about the next step: a value an execution read being **sent to a third party**.
A field marked as customer data can be read by an action or an agent that has
the scope for it, but the API will not send it to a host that is not allowed
for customer data.

## Contents

- [Marking fields](#marking-fields)
- [What is tracked](#what-is-tracked)
- [What happens on the way out](#what-happens-on-the-way-out)
- [Allowing a host](#allowing-a-host)
- [Who can change the marks and the hosts](#who-can-change-the-marks-and-the-hosts)
- [Audit](#audit)
- [Realtime is a read, not egress](#realtime-is-a-read-not-egress)
- [What it does not cover](#what-it-does-not-cover)
- [Files and tests](#files-and-tests)

## Marking fields

**Dataset fields:** add `sensitivity` to the field definition.

```json
{ "id": "f1", "key": "email", "label": "Email", "type": "text", "sensitivity": "customer" }
```

**Kon columns:** add a `sensitivity` block to `kon.json`, per table and column.

```json
"sensitivity": {
  "crm_contacts": { "email": "customer", "phone": "customer", "notes": "personal" }
}
```

There are two levels. `customer` is data about the business's customers;
`personal` is any other personal data (staff, contacts). Both are protected in
the same way; the level only appears in the audit. Repeater subfields can be
marked too. A field without `sensitivity` has no restriction.

Kon columns are matched **by name** (`email`, and its camelCase form for
`snake_case` names) in anything an execution reads that is not a dataset entry.
Dataset fields are matched only inside entries of their own dataset: an
unmarked `email` field in another dataset is not affected.

## What is tracked

Each execution keeps, **in memory and only while it runs**, the values it read
from marked fields:

| Execution                                                      | What counts as read                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A code action (sandbox)                                        | Its trigger event (`event.data`) and every answer it gets from `kitsuden.api.*`                                                |
| A `webhook_out` action                                         | The event data it would send                                                                                                   |
| An agent notification webhook                                  | The result of the proposal it reports (`proposal.result.body`)                                                                 |
| An agent run in the engine (an `agent` action, the playground) | Its trigger event (`event.data`, for an action) and every tool result the run gets (core tools, kon tools, external MCP tools) |

Values are normalised (Unicode NFKC, lower case, collapsed whitespace) and only
those of at least **5 characters** are tracked
(`KITSUDEN_CUSTOMER_DATA_MIN_LENGTH`, 3 to 64). Shorter values would match
too much text by accident. At most 20,000 values per execution are tracked; past
that, every request to a host not allowed for customer data is refused. Nothing
is stored: the audit records the field (`dataset:clients.email (customer)`),
never the value.

With each value, its usual transformed copies are tracked too:

| Form        | What is tracked                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Digests     | SHA-256, SHA-1 and MD5 of the value as read and of its normalised form, each as hex, base64 and base64url                                                    |
| Digits only | For a value that is mostly digits (at least 7 digits and 60% of its visible characters: phone numbers, IBANs), its digits: `+34 600 111 222` → `34600111222` |

A value that is only digits is matched on whole digit groups only, so
`600111222` is not found inside `16001112223`.

## What happens on the way out

Before a request leaves, its URL, header values and body are searched for any
tracked value in these forms:

- as sent, and percent-decoded (`%40` → `@`, one sequence at a time, so a stray
  `%` does not stop the rest);
- when the body is JSON, the strings inside it (so `@` escapes do not hide
  an `@`);
- base64 and base64url runs of at least 12 characters, and hex runs of even
  length, decoded when the result is valid UTF-8 text (one level; a run inside
  a URL path is also tried piece by piece). At most 256 runs and 256 KiB of
  decoded text per search, so a large body cannot make the check slow; a value
  encoded past that limit is not found;
- digit groups: `34 600-111-222` or `(34) 600.111.222` match the digits of a
  tracked phone number, but only as whole groups: never inside a longer number.

| Channel                                                                      | For a host not allowed for customer data                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox `fetch`                                                              | **Refused** with an error the code sees: _"Customer data cannot be sent to api.example.com: the body contains a value of dataset:clients.email (customer)…"_. Nothing is sent.                                                                                                                                                                             |
| `webhook_out`                                                                | **Redacted**: values under marked keys, and any other string that contains a tracked value, become `"[redacted: customer data]"`. With `config.customerData: "refuse"` the webhook is not sent and the run fails.                                                                                                                                          |
| Agent notification (proposal resolved)                                       | **Redacted** in `proposal.result.body`. The agent can still read the full result at `statusUrl`, with its own permissions.                                                                                                                                                                                                                                 |
| Model prompt of an engine agent run                                          | **Redacted** before every request to the model provider: the system prompt, the rendered `promptTemplate`, the history, the tool results and the tool-call arguments. Each tracked value is cut out in place (`Write to [redacted: customer data] about gold-plan`); a JSON tool result is redacted field by field, marked keys included. The run goes on. |
| Embeddings of an engine agent run                                            | The same, for the text sent to the embeddings provider (memory search, the semantic cache, saved conversation memory). A run whose message was redacted skips the semantic cache, so one customer's answer is never served for another's.                                                                                                                  |
| Core email tool (`kitsuden_dispatch_worker`, queue `email`) in an engine run | **Refused** when `subject`, `html` or `text` carries a tracked value and the recipient's domain is not allowed for customer data: _"Customer data cannot be emailed to other.example: the html contains a value of …"_. Nothing is queued. Writing **to the customer whose address was read** (the recipient is itself a tracked value) is allowed.        |
| External MCP tool (`ext_*`) in an engine run                                 | **Refused** before the call (and before it can be proposed for approval) when its arguments carry a tracked value and the external server's host is not allowed for customer data. Nothing is sent.                                                                                                                                                        |

The model provider's host is the base URL it is configured with (`OPENAI_BASE_URL`,
`ANTHROPIC_BASE_URL`, `OLLAMA_BASE_URL`, or the provider's public API). A
provider on this machine (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) or on a
host allowed for customer data gets the prompt as written. A model in another
container (`http://ollama:11434`) is not on this machine: allow its host.

Requests that carry no tracked value go out as before. If the marks cannot be
read from the database, the check fails closed: the sandbox refuses every
`fetch` to a host not allowed for customer data, `webhook_out` with event data
is not sent, a notification drops the result body, an engine agent run whose
model or embeddings provider is not allowed is refused, and the email tool
refuses every recipient on a domain not allowed.

## Allowing a host

A host that **should** receive customer data (your CRM, your mail provider) is
allowed in one of two places:

- per server: `KITSUDEN_CUSTOMER_DATA_HOSTS=crm.example.com,*.mail.example.com`;
- per action: `config.customerDataHosts: ["crm.example.com"]` (code,
  `webhook_out` and `agent` actions; for an `agent` action it names the model
  provider's host, and the email tool's recipient domains, that may receive it).

`*.example.com` matches subdomains, not `example.com` itself, as in the
sandbox allow-list. A code action still needs the host in `fetchAllow` as well:
`fetchAllow` decides where the code may connect at all, `customerDataHosts`
where customer data may go.

## Who can change the marks and the hosts

The limit is meant to hold against an agent that may read the data, so the
agent cannot lift it:

- `customerDataHosts` and `customerData` on an action are set by a **person**.
  An agent (even with `admin`) gets `403` from `POST`/`PATCH /api/actions` and
  from the MCP tool `kitsuden_define_action` when it tries to set or change them.
- An agent cannot **remove** the mark from a dataset field (`PATCH
/api/datasets/:id` answers `403`); it can add marks. A person can do both.
- Kon marks come from `kon.json`, which only the operator changes.
- `KITSUDEN_CUSTOMER_DATA_HOSTS` is server configuration.

## Audit

Every refusal or redaction writes an `agent_audit_logs` row with
`action = "customer_data_blocked"`, `resource` = the channel
(`sandbox_fetch`, `webhook_out`, `agent_notification`, `model_prompt`,
`email`, `external_mcp`), `resource_id` = the action, and in `details` the
decision, host, fields and where the value was found (`url`, `header X-…`,
`body`; `body` is the tool arguments for an external MCP tool; `prompt` or
`embedding` for a model prompt; `subject`, `html` or `text` for an email). A
model prompt is audited once per field and place per run, not on every call.
The agent is recorded when a real agent ran the action (for an `agent` action,
the agent it runs); cron and event runs of code actions have none. A warning
line `[customer-data] egress blocked` goes to the log with the same fields.

## Realtime is a read, not egress

The realtime channel (`/api/realtime`, `lib/realtime*.ts`) sends rows to the
browser of a signed-in person, not to a third party. What makes it safe is that
it is a read with that person's own permissions, the same as REST:

- the socket carries the signed-in session's user and role
  (`getSessionFromRequest` in `index.ts`); an agent's API key is not a session;
- subscribing to `table:<slug>` asks `checkReadAccess` on the dataset's
  `policyJson`, the gate REST and GraphQL use (no policy: admins only);
  `entry:` and `content:` channels are admin only;
- each event is filtered per subscriber before it is sent (`filterForClient`):
  the policy as of now, every `rlsRules` rule, and drafts only to their owner
  and the team (`publishedOrOwn`, as REST);
- a policy edited through the API applies to the next event: the policy cache
  is dropped on `dataset:updated` and `dataset:deleted` (an edit on another
  replica waits for the 30 s cache).

So a subscriber receives only rows it could read over REST, and with every
field REST would give it: marked fields are not removed, as they are not
removed from a REST read. `apps/api/src/tests/customer-data-egress.test.ts`
checks that a subscriber without read access to a dataset with marked fields
receives none of its change events, including right after its policy is
tightened.

## What it does not cover

This is a check on values leaving through Kitsuden's own outbound channels. It
is not data-loss prevention, and it is easy to get around for code that is
trying to:

- **Transformed values beyond the usual.** Encryption, reversing, splitting a
  value across requests or fields, sending part of it (a phone number without
  its country code), an encoding nested more than once (base64 of hex), an
  encoded copy that does not start at the beginning of its run
  (`prefix` + base64 glued together), or one past the decoding limit of a
  large body. Base64, base64url, hex, percent-encoding, the digests above and
  digits-only phone numbers are recognised.
- **Short values.** Anything under the minimum length is not tracked.
- **Outside agents.** An agent connected over MCP or REST reads the data with
  its own permissions and then does what it likes with it, including putting
  it in its prompt to its model provider. Kitsuden does not see that traffic.
- **Memory of earlier runs.** An engine run tracks only what it reads. Agent
  memory and session history saved by an earlier run are kept as the providers
  of that run could see them (redacted when either was not allowed), but a value
  saved in clear while the providers were allowed (a local model) is not tracked
  if the provider later changes.
- **Approved email.** An email tool call held for human approval and sent after
  a person approves it is not checked again: the person saw what it sends.
- **Other ways out.** Email sent by kon code (`kon-mail` lives in another
  repository and does not see the run's guard), exports, backups and kon code
  that calls the network itself are not covered. Neither are values the code
  receives from somewhere else (a `fetch` answer, an HTTP trigger body) and that
  happen to be customer data.
- **Generic grids and kon routes.** Values a code action reads through routes
  that return kon rows are matched by column name only; a kon that renames
  columns in its answers escapes the check.
- **DNS rebinding** and the other limits of the sandbox `fetch`
  ([sandbox](sandbox.md)) still apply.

## Files and tests

- `apps/api/src/lib/customer-data.ts`: tracking, matching, redaction, hosts.
- `apps/api/src/lib/customer-data-catalog.ts`: marks from datasets and kon
  manifests (cached 15 s, dropped when a dataset changes), audit.
- `packages/shared/src/sensitivity.ts`: the `sensitivity` field and manifest block.
- Wiring: `lib/worker-sandbox.ts`, `lib/actions/handlers/code-handler.ts`,
  `lib/actions/handlers/webhook-out-handler.ts`, `lib/proposal-notifications.ts`,
  `lib/actions/handlers/agent-handler.ts` and `services/agent-engine.ts` (model
  prompts; the provider's host from `providerBaseUrl` in `services/llm/index.ts`),
  `services/mcp-tools.ts` (tool rows tracked in `outputValue`, the email check in
  `kitsuden_dispatch_worker`), `services/agent-tools.ts` (the run's guard as
  `customerData` in the tool context), `lib/realtime-wiring.ts` (policy cache
  dropped on dataset edits).
- `apps/api/src/tests-unit/customer-data-egress.test.ts`: matching (transformed
  copies, whole digit groups, bounded decoding), redaction of free text and
  prompts, the email rule, and the sandbox against a local server that must
  receive nothing.
- `apps/api/src/tests/customer-data-egress.test.ts`: the real app on Postgres:
  code action, `webhook_out`, notifications, `agent` actions against a fake model
  provider (trigger event, tool result, allowed host), the email tool, realtime,
  and the agent gates.
