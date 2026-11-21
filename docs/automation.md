# Automation rules

A rule is a stored action of type `rule`:

```
WHEN  an event arrives (or a cron fires, or someone runs it by hand)
IF    its payload meets the conditions
THEN  run these steps, in order
```

It is data, not code: the panel can draw it, an agent can read it, and a dry run
can say what would happen without doing it. For anything a rule cannot express,
a `code` action still exists ([sandbox](agents/sandbox.md)).

```json
POST /api/actions
{
  "name": "Tell sales about big deals",
  "type": "rule",
  "trigger": "event",
  "triggerConfig": {
    "eventName": "crm:deal.won",
    "conditions": [{ "field": "amount", "op": "gte", "value": 100000 }]
  },
  "config": {
    "steps": [
      { "handler": "core:send-mail", "config": { "mailable": "crm.deal-won", "data": { "to": "{{event.ownerEmail}}", "dealName": "{{event.name}}" } } },
      { "handler": "kon-crm:create-activity", "config": { "dealId": "{{event.dealId}}", "type": "task", "title": "Send the contract" }, "continueOnError": true }
    ]
  }
}
```

## Triggers

The same as any stored action: `event`, `cron` and `manual`.

`GET /api/automation/catalog` lists every event a rule can listen to (the core's and
each loaded kon's, see [kon events](kons/events.md)) and every step it can use.

## Conditions

`triggerConfig.conditions` is a list; `triggerConfig.match` is `all` (default) or
`any`. Each condition reads the event payload by dot path:

| `op`                     | Passes when                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `eq`, `neq`              | The value is (not) the same. `5` and `"5"` are the same.                                                           |
| `gt`, `gte`, `lt`, `lte` | Numbers compare as numbers, also when one arrived as text; two texts compare as text. Anything else does not pass. |
| `contains`               | A text contains the value (case-insensitive), or a list has it.                                                    |
| `starts_with`            | A text starts with the value (case-insensitive).                                                                   |
| `in`                     | The field is one of a list of values.                                                                              |
| `exists`                 | The field is present and not null. With `"value": false`, it must be absent.                                       |

At most 20 conditions. An event that does not meet them is not an execution:
nothing is recorded, so a busy event does not bury the runs that matter.

Conditions work on every type of action, not only rules.

## Steps

Each step names a handler and gives it a `config`. A failing step stops the rule
and the rest are marked `skipped`, unless the step says `"continueOnError": true`.
At most 20 steps.

| Handler          | Does                                          | `config`                                                           |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `core:webhook`   | Sends the event as a signed POST              | `url`, `headers`, `secret`, `customerDataHosts`, `customerData`    |
| `core:send-mail` | Sends a registered mail template              | `mailable`, `data`, `locale`                                       |
| `core:run-agent` | Hands the event to one of the core's agents   | `agentId`, `promptTemplate`, `customerDataHosts`                   |
| `core:enqueue`   | Queues a job on a queue a kon opened to rules | `queue`, `job`, `payload`, `dedupeKey`, `delaySeconds`, `attempts` |
| `<kon id>:<id>`  | Whatever a kon contributed                    | see the catalog                                                    |

The three core steps reuse the handlers of single-purpose actions: a webhook sent
from a rule passes the same target check, the same [customer-data
guard](agents/egress.md) and the same signing as a `webhook_out` action.

### Placeholders

A string in a step's config may carry `{{event.<path>}}`, filled from the event
payload. `{{eventName}}`, `{{rule.id}}` and `{{rule.name}}` are also available.

- **The host of a webhook URL must be written out.** A placeholder is allowed in
  the path and the query (`https://example.com/hooks/{{event.id}}`), not between
  `://` and the first `/`: event data, such as a form a visitor filled in, must not
  choose where the payload is sent. The literal part passes the same target check
  as any webhook URL.
- A string that is only a placeholder keeps the type it points to:
  `"{{event.amount}}"` becomes the number `500`. The exception is the recipient
  keys of a `core:send-mail` step's `data` (`to`, `cc`, `bcc`, `replyTo`): they
  are always filled as text, so an event value that is a list becomes its JSON
  form, which the mailer refuses, instead of one recipient per item.
- A placeholder inside other text becomes text; one that points nowhere becomes
  an empty string, or `null` when it stands alone.
- **`core:run-agent` keeps event data marked as untrusted.** The rule does not
  fill the `{{event.<path>}}` placeholders of its `promptTemplate` (it does fill
  `{{eventName}}` and `{{rule.*}}`). The agent handler fills them: it puts each
  value between untrusted-content tags, starts the message with a notice that
  this text is data, and holds every write the agent makes for a person, as for a
  plain `agent` action. A `promptTemplate` that is not a string is dropped and
  the agent gets the default prompt.

## Dry run

```
POST /api/automation/actions/:id/dry-run     { "event": "crm:deal.won", "payload": { "amount": 250000 } }
```

Returns whether the action would run, the outcome of each condition with the
value it found, and each step's config with its placeholders filled, plus the
handler's own preview when it has one. Nothing is sent, nothing is written, and
no execution is recorded.

Credentials are hidden in the answer: every value under `headers`, and any value
under a key that names one (`secret`, `token`, `password`, `authorization`,
`api key`, `cookie`, `signature`…) comes back as `[hidden]`.

For the other types of action a dry run checks the conditions only.

## Run history

A rule's executions are in `GET /api/actions/:id/executions` and in the panel's
Runs view, like any action. `result.steps` has one entry per step with its
status, its result or error, and how long it took.

## Queue a job

A step that does its work at once (a webhook, an email) is fine for most rules.
Work that is slow, that must be retried, or that must not pile up (a model
looking a contact up) belongs in the [job queue](install/queue.md), and
`core:enqueue` is how a rule puts it there:

```json
{
  "handler": "core:enqueue",
  "config": {
    "queue": "kon-agents:research",
    "job": "identify",
    "payload": { "contactId": "{{event.contactId}}" },
    "dedupeKey": "identify:{{event.contactId}}"
  }
}
```

With the trigger `crm.contact.created` and the condition
`{ "field": "name", "op": "exists", "value": false }`, that is "a new contact
without a name is identified, once".

- **Only queues that opened themselves.** `queue` must be one of the `queues`
  in the catalog (a kon registers it with `rules`; see
  [Jobs from automation rules](install/queue.md#jobs-from-automation-rules)). The
  core's own queues and a kon's private ones are refused when the rule is
  saved and again when it runs.
- **The event does not choose where.** `queue` and `job` take no placeholders.
  `payload` and `dedupeKey` do.
- **`payload`** is what the queue's handler receives; without it, the event's
  data.
- **`dedupeKey`**: while a job with that key waits or runs on that queue, the
  step queues nothing and reports `deduplicated: true`.
- **`delaySeconds`** (up to a week) and **`attempts`** (1 to 25, default 3).
- **Whose job it is.** The rule's author, not whoever caused the event: the
  handler runs with that person's permissions as they are when it runs.
- The step succeeds when the job is queued. Whether the job then succeeds is
  the queue's business: retries, and the dead letter in the panel.
- A dry run shows the queue, the job and the filled payload and key, and queues
  nothing.

## Who may write a rule

A person with the administrator role. An agent cannot create or change a rule
(403), and the MCP tool `kitsuden_define_action` does not offer the type: a rule
can call a webhook, send mail and make an agent act, and each of those is a
person's decision.

## Steps from a kon

```ts
export default defineKon({
  id: "kon-crm",
  actionHandlers: [
    {
      id: "create-activity",
      label: "Create an activity",
      description: "Adds a task, call or note to a deal.",
      config: { dealId: "uuid of the deal", type: "task | call | note", title: "text" },
      validate: (config) => (typeof config.title === "string" ? null : "title is required"),
      run: async (input, ctx) => {
        // input.config: placeholders already filled
        // input.event: { name, data } or undefined
        // input.actorUserId: who answers for the rule
        return { activityId };
      },
      preview: (input) => ({ wouldCreate: input.config.title }),
    },
  ],
});
```

It is exposed as `kon-crm:create-activity`. What a handler must know:

- It runs after the triggering request committed, outside any request:
  `ctx.db.instance` is the system connection. The step runs **as the rule's
  owner**: `ctx.entities` and `ctx.secrets` attribute writes and openings to
  `input.actorUserId`, not to whoever triggered the event. Apply
  `input.actorUserId` yourself where ownership matters in your own queries.
- Delivery is at most once, but a rule can be run again by hand. Make the handler
  idempotent where a repeat would hurt.
- `validate` runs when the rule is stored, and again in a dry run with the filled
  config.

## Rules a kon keeps

A kon's own configuration is often a rule ("when a deal enters this stage, create
a task"). Instead of running those itself, the kon writes them with
`ctx.automation` and the core runs them:

```ts
if (ctx.automation) {
  await ctx.automation.upsertRule("kon-crm", {
    slug: `stage-${stage.id}-enter`,
    name: `On enter: ${stage.name}`,
    event: "crm:deal.moved",
    conditions: [{ field: "toStageId", op: "eq", value: stage.id }],
    steps: [
      {
        handler: "kon-crm:create-activity",
        config: { dealId: "{{event.dealId}}", type: "task", title: "Call" },
      },
    ],
    ownerUserId: user.id,
  });
}
```

- `upsertRule` creates the rule or replaces the one with the same slug.
  `removeRule(konId, slug)` and `listRules(konId)` complete the set.
- A kon's rule uses only that kon's own handlers. `core:webhook`,
  `core:run-agent` and another kon's steps are refused.
- A kon sees and changes only the rules it wrote: the context it receives refuses
  any other kon id (see [secrets](kons/secrets.md) for what that does and does not
  guarantee).
- `ctx.automation` is optional. Its presence is the capability: a host that has
  it runs kon steps.

## Limits

- Rules run in the API process, after commit, at most once: see
  [kon events](kons/events.md) for what that means when a process stops.
- There are no branches or loops. A rule is a list; use several rules with
  different conditions, or a `code` action.
- A cron rule runs once per tick across every API process: each process claims
  the tick first and only the first one runs it (migration `0091`,
  [kons/schedules.md](kons/schedules.md)). A tick that falls while no API
  process is running is not caught up.
- `core:webhook` makes one attempt when the rule runs. If the target does not
  answer, or answers 5xx or 429, the step succeeds with `retrying: true` and the
  retries go to the job queue (`kitsuden-rule-webhooks`): with backoff, up to
  `retryPolicy.maxRetries` (default 3, at most 10), surviving a restart. The
  queued job holds no secret: each retry re-reads the rule, so a rule paused or
  deleted meanwhile sends nothing. A 4xx fails the step at once.
