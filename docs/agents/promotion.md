# Code promotion: how agent-written code becomes active

An AI agent can write the code of a **code action** (the code that runs in the
[sandbox](sandbox.md)), but it never edits the code that is running. Every
change is a **draft**: a new, numbered version that is tested, scanned and
compared with the active version, and that only becomes active through one of
two modes:

- **Suggestion** (default): a human approves it. Every draft becomes a
  proposal in the [approvals inbox](approvals.md).
- **Turbo**: it activates by itself, but **only** when every test and check
  passes and nothing in it widens permissions or touches anything sensitive.
  Otherwise it falls back to a human proposal, with the reasons.

After activation a **watch window** follows the new version; if it fails too
often it is rolled back automatically to the previous one. A human can also
roll back at any time.

Everything is in the admin panel (English or Spanish): **Approvals → Code
promotion** (the pipeline of every version, settings, approve, reject, roll
back) and **Agents → (an agent) → Approval → Code promotion** (the agent's
mode).

## Contents

- [The pipeline](#the-pipeline)
- [Submitting a draft (agents)](#submitting-a-draft-agents)
- [Tests](#tests)
- [The security scan](#the-security-scan)
- [Declared capabilities](#declared-capabilities)
- [The decision](#the-decision)
- [Turbo fallbacks](#turbo-fallbacks)
- [Activation](#activation)
- [Watch window and automatic rollback](#watch-window-and-automatic-rollback)
- [Manual rollback](#manual-rollback)
- [When code actions are disabled](#when-code-actions-are-disabled)
- [Only through the pipeline (agents) and versioned by hand (humans)](#only-through-the-pipeline-agents-and-versioned-by-hand-humans)
- [Who can do what](#who-can-do-what)
- [Idempotency](#idempotency)
- [Audit and notifications](#audit-and-notifications)
- [Row-level security](#row-level-security)
- [What is not covered](#what-is-not-covered)
- [API reference](#api-reference)
- [Upgrading](#upgrading)

## The pipeline

```
draft ──► sandbox tests ──► security scan + capability diff ──► decision
                                                                 │
                       suggestion, or any turbo fallback ◄───────┤
                       └► proposal ─► human approves ─► activate │
                                                                 │
                       turbo and everything green ◄──────────────┘
                       └► activate
activate ──► watch window ──► passed │ automatic rollback
```

1. **Draft**: a row in `code_versions` with the code, what it declares
   (scopes, outbound hosts, limits), its tests, the agent, its key and its
   human signer. The active version is never edited in place: activating
   writes the new version into the action and keeps the old one.
2. **Sandbox tests**: the draft's tests, plus the tests the action declares
   (`config.tests`, carried over from the active version), run in the real
   QuickJS sandbox with a **simulated** `kitsuden.api` and `fetch`.
3. **Security scan**: a local, deterministic static scan of the code (no
   network, no language model) plus the diff of the declared capabilities
   against the active version, and a classification of what the code touches.
4. **Decision**: suggestion → proposal; turbo → activation or proposal (see
   [the decision](#the-decision)).
5. **Watched activation** with automatic rollback.

## Submitting a draft (agents)

The agent needs the scope `promotion:propose` (also granted by
`promotion:*`, `kon:promotion:propose-draft` or `admin`).

```http
POST /api/promotion/drafts            (Authorization: Bearer kitsuden_agent_…)
Content-Type: application/json

{
  "target": { "slug": "sum" },
  "code": "return { total: (event.a ?? 0) + (event.b ?? 0) };",
  "tests": [
    { "name": "adds", "event": { "a": 2, "b": 3 }, "expect": { "result": { "total": 5 } } }
  ],
  "description": "Sum a and b"
}
```

- `target.actionId` (an existing code action) or `target.slug` (an existing
  one, or a new one together with `target.name`). Only actions of type
  `code` can be promoted. A new action is created with a `manual` trigger.
- `code`: up to 256 KiB (the scan fails anything above 64 KiB).
- `scopes`, `fetchAllow`, `timeoutMs`, `memoryLimitMb`, `maxCalls`: what the
  code declares, with the same meaning as in a code action
  ([sandbox](sandbox.md)). Omitted = none / the defaults (5000 ms, 64 MB, 50
  calls).
- `tests`: up to 20 test cases.
- A draft **never** carries environment variables: the action keeps the ones
  an admin configured.

The response (`201`) is the version with every report and the decision:

```json
{
  "version": {
    "id": "…", "versionNumber": 4, "status": "awaiting_approval", "mode": "suggestion",
    "contentHash": "…", "baseHash": "…",
    "testReport": { "total": 1, "passed": 1, "failed": 0, "errored": 0, "cases": [ … ] },
    "scanReport": { "passed": true, "findings": [], "apiCalls": [], "fetchHosts": [], "envVars": [] },
    "capabilityDiff": { "newTarget": false, "scopesAdded": [], "hostsAdded": [], … },
    "decision": { "route": "proposal", "reasons": ["suggestion_mode"], … },
    "proposal": { "id": "…", "statusUrl": "/api/proposals/…" }
  },
  "duplicate": false
}
```

Then poll `GET /api/promotion/drafts/{id}` (or the MCP tool
`promotion_status`; the proposal itself with `kitsuden_proposal_status`). Do
not resubmit: the same content returns the same version.

Over MCP the same operations are the tools `promotion_propose`,
`promotion_list` and `promotion_status` (arguments as usual: the body under
`body`). Activation is **not** a tool.

## Tests

A test case:

```json
{
  "name": "reads the dataset",
  "event": { "a": 1 },
  "env": { "REGION": "eu" },
  "api": { "GET /api/data-sets/clients/entries": { "status": 200, "body": { "entries": [] } } },
  "fetch": { "GET https://api.example.com/v1/rates": { "status": 200, "body": { "eur": 1 } } },
  "expect": { "success": true, "result": { "count": 0 } },
  "timeoutMs": 2000
}
```

- `event` is exactly what the code receives as `event` (for a real execution
  it is `{ action, trigger, event, request, timestamp }`).
- `env` is what the code receives as `env` in the test. Real values of the
  action are never used.
- `api` and `fetch` are the **simulated** responses, keyed by
  `METHOD /api/path` (with or without the query string) and
  `METHOD https://url` (or just the URL for `GET`). A call without a simulated
  response gets `404` and is listed in `unmockedCalls`. Tests never reach the
  real API or the network; `fetch` still enforces the declared `fetchAllow`
  list exactly as in production.
- `expect`: `success` (default `true`), `result` (deep equality),
  `resultContains`, `errorContains`, `logsContain`.
- Each test runs in its own sandbox process with the draft's memory and call
  limits and at most 10 s; three run at a time; the whole run has a 60 s
  budget (a test that does not get to run counts as **errored**).

A test is `passed`, `failed` (an expectation did not hold) or `errored` (time
out or the interpreter died, unless the test expected a failure).

## The security scan

Local and deterministic (`scanCode` in `@kitsuden/shared`): a small
JavaScript tokenizer, so comments and strings are not mistaken for code, and
fixed rules. The same input always gives the same report.

| Severity | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| high     | `dynamic_eval` (`eval`, `Function`, `setTimeout("…")`, also written with `\u` escapes), `dynamic_import`, `constructor_escape` (`constructor`, `__proto__`, `'prototype'`), `forbidden_global` (`process`, `require`, `globalThis`, `Bun`, `Deno`, `WebAssembly`… and the sandbox's internal functions), `secret_literal` (Kitsuden, AWS, GitHub, Slack, Stripe, Google, `sk-…` keys, JWTs, private keys, URLs with a password, `password = "…"`), `oversize` (> 64 KiB)                                                                                                                                                                                          |
| medium   | `obfuscation` (`atob`, `fromCharCode`, many `\x` escapes), `long_line` (> 1000 characters), `reflection` (`Proxy`, `Reflect`), `undeclared_host` (a literal `fetch` URL outside `fetchAllow`), `api_alias` (`kitsuden` used so that its API calls cannot be seen: aliases, `kitsuden["api"]`, destructuring), `unparsable`, `env_bulk_read` (`env` used as a whole instead of `env.NAME`), `encoded_api_path` (a percent-escape in a literal API path), `computed_member` (a member name built at run time), `ambiguous_slash` (a `/` the scanner cannot tell from a regex), `scope_beyond_author` (the draft declares scopes the submitting agent does not hold) |
| low      | `unbounded_loop` (`while (true)`, `for (;;)`: the sandbox time limit stops them)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The scan **passes** when there is no `high` or `medium` finding. A finding
names the line and the kind of problem, never the secret itself.

The scan also extracts what the decision needs: every `kitsuden.api.*` call
with its method and literal path (or `null` when the path is computed), the
literal `fetch` hosts, and the `env` variables the code reads.

It does not depend on AI-Infra-Guard (see [red-teaming](red-teaming.md)): no
key, no network, nothing to deploy.

## Declared capabilities

The draft's declared capabilities are compared with the **active version**
(or, for an action that never went through promotion, with what the action
declares now):

- `scopesAdded`: scopes the active version did not grant (wildcards count: a
  draft with `datasets:clients:read` under an active `datasets:*:read` adds
  nothing); `denialsRemoved`: `!deny` entries the draft drops (that widens
  too);
- `hostsAdded`: outbound hosts not covered by the active list (`*.a.com`
  covers `b.a.com`);
- `limitsIncreased`: higher `timeoutMs`, `memoryLimitMb` or `maxCalls`;
- `newTarget`: there is no active version (a new action).

Removing scopes, hosts or limits never blocks anything.

What the code **touches** is classified from its scopes, the literal paths of
its API calls and the `env` variables it reads. **Only what is new counts**
(by design): the same classification is made for the
active version's code (a `baseline` or `manual` version counts as the active
one), and a scope, a path, a secret-like `env` variable or a sensitive
operation the active version already had does not block turbo. A `DELETE` the
active version already made is fine; a new one is not. Sensitive operations
are compared by their operation key (or method and literal path for legacy
routes).

- **secrets**: `/api/admin/secrets`, `/api/admin/vault`, `/api/keys`…, scopes
  `secrets:*`, `vault:*`, `keys:*`, or reading an `env` variable whose name
  looks like a secret (`*_TOKEN`, `*SECRET*`, `*_KEY`, `PASSWORD`…) that the
  active version did not read;
- **users and roles**: `/api/auth`, `/api/users`, `/api/v1` (agents and their
  permissions), `/api/admin/agents`, `auth_*` tables, scopes `users:*`,
  `roles:*`, `agents:*`, `user:act`;
- **security configuration**: `/api/approvals`, `/api/proposals`,
  `/api/promotion`, `/api/settings`, `/api/modules`, `/api/system`,
  `/api/admin`, `/api/actions`, `/api/functions`, `/api/mcp`, scopes `admin`,
  `mcp:admin`, `kon:*`, `approvals:*`, `promotion:*`, `settings:*`…;
- **sensitive operations**: an API call whose operation is sensitive under the
  [approvals classification](approvals.md#what-is-sensitive) (the kon's
  declaration or the admin's override; for legacy routes the legacy rules,
  which make every `DELETE` sensitive by default).

## Only through the pipeline (agents) and versioned by hand (humans)

**Agents** (any agent identity, also with the `admin` scope) cannot create or
change an action's code anywhere else. "Code" is what the pipeline versions:
`config.code`, the declared `scopes`, `fetchAllow`, `timeoutMs`,
`memoryLimitMb`, `maxCalls`, `tests` and the `promotion` marker. Refused with
`403 KITSUDEN_E_FORBIDDEN`, `reason: "use_promotion_pipeline"`,
`tool: "promotion_propose"`:

- `POST /api/actions` of a `code` action (or with any of those fields), and
  `PATCH /api/actions/{id}` that changes any of them (replacing `config` with
  one that drops the code counts). Other fields (name, description, status,
  trigger, `envVars`…) work as before;
- `POST`/`PATCH /api/functions` with `code`;
- the MCP tool `kitsuden_define_action` with `type: "code"` or code fields.

**Generic routes write none of these tables, for anyone** (humans included):
`actions`, `kitsuden_functions`, `code_versions`, `action_executions`,
`function_executions` and `approval_settings` — `/api/items/*`, the data
explorer, GraphQL mutations (not generated for them) and the MCP table tools
answer `403 KITSUDEN_E_FORBIDDEN` (`reason: "table_has_its_own_route"`). Each
has its own route with its own version and audit, so the watch window cannot
be fed fake executions and the turbo cap cannot be changed behind the panel.

**Humans** (admins) still edit an action directly in `/api/actions`. Every
change to its code — creating a code action included — is stored as a
version with `origin: "manual"`, active at once, with its `baseHash` (what
was running before) and `previousVersionId`, and audited as
`promotion_manual_edit` (`by`, content, base and previous hashes). A manual
version has no watch window (it is a human decision) but can be rolled back
like any other. It also changes the base: a draft tested against the code
before the edit fails with `stale_base` when activated. If the code was
changed by some other means (SQL), the next activation or manual edit stores
a `baseline` snapshot of what was really running first.

## The decision

Implemented once, as `decidePromotion` in `@kitsuden/shared`
(`promotion.ts`). Every reason that applies is listed in
`decision.reasons`, in both modes, so the reviewer sees all of them:

| Agent mode   | Global `turboAllowed` | All checks green | Result                               |
| ------------ | --------------------- | ---------------- | ------------------------------------ |
| `suggestion` | any                   | any              | proposal (`suggestion_mode`)         |
| `turbo`      | off                   | any              | proposal (`turbo_disabled_globally`) |
| `turbo`      | on                    | no               | proposal with the reasons            |
| `turbo`      | on                    | yes              | **activated automatically**          |

The **global cap** `turboAllowed` is off by default: until an admin turns it
on, no agent activates anything by itself, whatever its mode. The per-agent
mode is `suggestion` by default.

**The approvals master switch stays the master of the approval gate.** It is
not a promotion switch: with it off, code drafts are still held for a human
(a draft is always a proposal unless turbo applies), and turbo still needs its
own cap. What the master switch does change: when it is **on** and an admin
put the agent in `propose` ("propose only"), turbo does not skip that either
(`agent_held_for_approval`).

## Turbo fallbacks

Turbo falls back to a human proposal, with the reason, when **any** of these
is true:

| Reason                                                                   | When                                                                                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turbo_disabled_globally`                                                | the global cap is off                                                                                                                              |
| `agent_held_for_approval`                                                | approvals are on and the agent is in `propose`                                                                                                     |
| `new_target`                                                             | the draft creates a new action                                                                                                                     |
| `no_tests`                                                               | there are no tests at all                                                                                                                          |
| `tests_failed` / `tests_errored`                                         | a test failed / errored or timed out                                                                                                               |
| `scan_failed`                                                            | the scan has a `high` or `medium` finding                                                                                                          |
| `scope_escalation`                                                       | it asks for scopes the active version did not have, or drops a deny                                                                                |
| `new_outbound_hosts`                                                     | it reaches hosts the active version could not                                                                                                      |
| `limits_increased`                                                       | it raises time, memory or call limits                                                                                                              |
| `touches_secrets` / `touches_users_or_roles` / `touches_security_config` | something the active version did not touch, see [declared capabilities](#declared-capabilities)                                                    |
| `target_has_env_vars`                                                    | the target action has environment variables: a new version would receive their real values, and the scan cannot prove what the code does with them |
| `sensitive_operation`                                                    | it calls a sensitive operation the active version did not call                                                                                     |
| `unclassifiable_api_call`                                                | an API call whose path is computed at runtime (or through an alias): nothing can be said about it, so a human decides                              |

So turbo can never widen permissions on its own: everything that adds a
scope, a host, a limit, a new action, or reaches something sensitive the
active version did not reach needs a human. A computed API path, no tests or
raised limits always need one. **First time human, then turbo**: the first
version of a new action always needs a human (`new_target`); after that the
active version is the reference and later drafts can go turbo when they ask
for nothing new.

## Activation

- **Suggestion / fallback**: the pipeline stores a proposal in the approvals
  inbox: `POST /api/promotion/versions/{id}/activate`, reason `sensitive`,
  operation `kon:promotion:activate-version`, with a summary (tests, scan,
  capability diff, reasons) as its diff. A human approves it in **Approvals →
  Inbox** or in **Approvals → Code promotion** (the same thing). The stored
  request then runs once **as the agent**, re-reading its identity: if the
  agent lost `promotion:propose`, was deactivated or its key was revoked, the
  proposal ends `failed` and nothing is activated. The approval marker is set
  by the server process; it cannot come from the network.
- **Turbo**: the pipeline activates the version in the same request.

Activation, in one database transaction with the action locked:

1. checks that the action is still what the draft was tested against
   (`baseHash`); if another version was activated meanwhile, or someone edited
   the action, the version ends `failed` with `stale_base` (submit it again);
2. if the action never went through promotion, stores a **baseline** version
   with what was running (so a rollback can return to it);
3. marks the previous active version `superseded`, writes the version's code,
   declared capabilities and tests into the action (environment variables and
   the trigger are kept) and resets the action's error counter;
4. starts the watch window.

The action's `config.promotion` records the active version
(`versionId`, `versionNumber`, `contentHash`).

## Watch window and automatic rollback

Settings (**Approvals → Code promotion → Settings**, admin):

| Setting         | Default | Range  |
| --------------- | ------- | ------ |
| `watchMinutes`  | 30      | 1–1440 |
| `minExecutions` | 3       | 1–1000 |
| `maxErrorRate`  | 0.5     | 0.01–1 |

The values are fixed on the version when it is activated. After every
execution of the action, and every minute, Kitsuden counts the executions
since activation (`action_executions`) and the ones that ended in `error` or
`timeout`. When there are at least `minExecutions` and the error rate is at
least `maxErrorRate`, the version is **rolled back automatically**: the
previous version becomes active again (or, if this was the action's first
version, the action is paused), the version ends `rolled_back` with the reason
and the counts, the rollback is audited and notified. When the window ends
without that, the watch is marked `passed` (audited).

## Manual rollback

An admin rolls back the active version from the panel (a reason is required)
or with `POST /api/approvals/promotion/versions/{id}/rollback`
`{ "reason": "…" }`. Same effect as the automatic one. Only the active
version can be rolled back.

## When code actions are disabled

With `ENABLE_CODE_ACTIONS` off (the production default, see
[sandbox](sandbox.md)) the pipeline still works: drafts are stored, their
tests run in the sandbox (they never reach the network or the real API), the
scan and the decision are made. **Activation** then does not happen: the
version stays `approved` with `activationError: "code_actions_disabled"`
(audited as `promotion_activation_blocked`; an approved proposal ends `failed`
with a `409`). Once code actions are enabled, an admin activates it from the
panel (**Activate now**) or with `POST
/api/approvals/promotion/versions/{id}/activate`.

## Who can do what

| Who                                      | Can                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent with `promotion:propose`           | submit drafts; read **its own** drafts (another agent's are `404`)                                                                                                  |
| Any agent, any scopes (`admin` included) | **never** approve, reject, activate, roll back or change modes and settings. Calling the activation route directly is `403`; `/api/approvals/*` is closed to agents |
| Admin (human)                            | everything: approve, reject, roll back, activate approved versions, settings, modes                                                                                 |
| Editor                                   | nothing here (activating code is an admin decision; an editor cannot approve these proposals in the inbox either)                                                   |

## Idempotency

- The same agent submitting the same content (code, declared capabilities and
  tests) for the same action gets **the same version** (`200`,
  `duplicate: true`), in whatever state it is (pending, rejected, active…),
  and no second proposal.
- `Idempotency-Key` works as on every write ([errors and
  retries](../install/errors-and-retries.md#idempotency-key)).
- Approving twice runs once (the approvals inbox reserves the proposal
  atomically).

Errors are `application/problem+json` with the usual `KITSUDEN_E_*` codes:
`KITSUDEN_E_VALIDATION` (422, bad draft), `KITSUDEN_E_NOT_FOUND`,
`KITSUDEN_E_FORBIDDEN`, `KITSUDEN_E_CONFLICT` (409, with `details.reason`:
`stale_base`, `code_actions_disabled`, `wrong_state`).

## Audit and notifications

Every step goes to `agent_audit_logs` (shown in **Approvals → Audit** and in
each version's audit trail), with the agent, its signer and the version
hashes:

| Action                                                                                                   | Details                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `promotion_submitted`                                                                                    | version number, `contentHash`, `baseHash`, parent, signer, channel, mode, route, reasons, test and scan summaries |
| `proposal_created` / `proposal_approved` / `proposal_rejected` / `proposal_executed` / `proposal_failed` | as for every [proposal](approvals.md#audit)                                                                       |
| `promotion_activated`                                                                                    | `by` (human id or `turbo`), `via`, proposal, signer, `contentHash`, previous version and hash                     |
| `promotion_activation_blocked` / `promotion_activation_failed`                                           | `code_actions_disabled` / `stale_base`                                                                            |
| `promotion_rejected`                                                                                     | reviewer and comment                                                                                              |
| `promotion_manual_edit`                                                                                  | a human changed the code in `/api/actions`: `by`, version, content, base and previous hashes                      |
| `promotion_rolled_back`                                                                                  | automatic or `by`, reason, counts, from/to hashes, whether the action was paused                                  |
| `promotion_watch_passed`                                                                                 | counts                                                                                                            |
| `promotion_settings_changed` / `promotion_mode_changed`                                                  | `by`, before, after                                                                                               |

A rollback is also logged as a warning and sent to the agent webhook
(`AGENT_WEBHOOK_URL`) when it is configured.

## Row-level security

`code_versions` has RLS with `FORCE` (`rls-owned-tables.sql`, "Code
promotion"): an agent reads only its own rows; a human admin and the system
read all of them; only the system (the API process) and a human admin write.
The agent routes read through the request's RLS transaction and also filter
by the agent's id.

## What is not covered

- **Direct SQL.** Someone with database access can still change `actions`;
  the next activation or manual edit then stores a `baseline` snapshot of what
  was really running, so a rollback returns to it.
- **Functions** (`/api/functions`) are deprecated and run as actions: promote
  the action.
- Only the code and its declared capabilities are versioned: the trigger and
  the environment variables stay as an admin configured them.

## API reference

Agents (`kon-promotion`, `/api/promotion`, MCP tools in brackets):

| Method | Path                                    |                                                                                                         |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/promotion/drafts`                 | submit a draft (`promotion_propose`)                                                                    |
| `GET`  | `/api/promotion/drafts`                 | own drafts (`status`, `slug`, `limit`, `offset`) (`promotion_list`)                                     |
| `GET`  | `/api/promotion/drafts/{id}`            | one draft with code and reports (`promotion_status`)                                                    |
| `POST` | `/api/promotion/versions/{id}/activate` | only as the execution of an approved proposal (or an admin, for an `approved` version); not an MCP tool |

Humans, admin only (`kon-promotion-admin`, `/api/approvals/promotion`; never
an agent):

| Method        | Path                      |                                                                                                                                                 |
| ------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET` / `PUT` | `/settings`               | `{ turboAllowed?, watchMinutes?, minExecutions?, maxErrorRate? }`; also reports `codeActionsEnabled`, `approvalsEnabled` and every agent's mode |
| `PUT`         | `/agents/{id}/mode`       | `{ mode: "suggestion" \| "turbo" }`                                                                                                             |
| `GET`         | `/versions`               | every version (`status`, `slug`, `agentId`)                                                                                                     |
| `GET`         | `/versions/{id}`          | detail: code, replaced code, reports, proposal, audit trail                                                                                     |
| `POST`        | `/versions/{id}/approve`  | `{ comment? }` → activates                                                                                                                      |
| `POST`        | `/versions/{id}/reject`   | `{ comment? }`                                                                                                                                  |
| `POST`        | `/versions/{id}/rollback` | `{ reason }`                                                                                                                                    |
| `POST`        | `/versions/{id}/activate` | an `approved` version                                                                                                                           |

All of them are in `GET /api/docs/openapi.json`.

## Upgrading

Migration `0053_code_promotion.sql` adds `agent_identities.promotion_mode`
(default `suggestion`) and `code_versions`; the RLS policies are applied by the
migration runner (`rls-owned-tables.sql`). Settings live in
`approval_settings` (row `code_promotion`); without it the defaults apply
(turbo off). Apply the migration before deploying the API: the new routes read
both. Existing actions are not touched until a draft for them is activated.
