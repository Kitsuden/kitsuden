# Threat model

Kitsuden lets AI agents read and write real application data. This page says
what it defends against, how, and what it does **not** cover. It is short on
purpose: every line points to the mechanism that implements it.

## Where Kitsuden sits

| Layer              | Decides                                                      | Examples                      |
| ------------------ | ------------------------------------------------------------ | ----------------------------- |
| Agent              | _what_ to do                                                 | Claude, Cursor, your own loop |
| Execution model    | _when_ and how often, durably                                | queues, retries, schedules    |
| **Action runtime** | **whether** this agent may do it, as whom, and who signs off | **Kitsuden**                  |

Kitsuden is the action runtime, and it also brings the second layer for its
own work: a Postgres queue with a transactional outbox
([queue](install/queue.md)).

## Assets

- The application data in Postgres (every kon's tables, datasets, media metadata).
- Credentials: agent keys, user sessions, the secrets vault, webhook secrets.
- The ability to change the system: code actions, kon activation, settings.

## Adversaries and what stops them

| Threat                                                                     | Defence                                                                                                                                                                                                                                                                                                                                                                                                                                   | Where                                                                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| An agent reads or writes rows it was not given                             | Three walls: the operation's **permission** (scopes, checked before the body is read), the handler's **owner filter**, and **Postgres RLS** with `FORCE`, run inside one transaction per request with the caller's identity                                                                                                                                                                                                               | `engine/src/operations.ts`, `engine/src/rls-request.ts`, `docs/agents/permissions.md`                                        |
| A bug in one handler leaks another tenant's rows                           | RLS is the last wall and does not depend on the handler; the API connects as a role **without** `BYPASSRLS`                                                                                                                                                                                                                                                                                                                               | `rls-policies.sql`, `docker/start-with-check.sh`                                                                             |
| An agent's key is broader than needed                                      | Fine scopes per kon, operation and dataset (`datasets:<slug>:read`), explicit denials (`!scope`), allowed-tools lists                                                                                                                                                                                                                                                                                                                     | `@kitsuden/shared` `agent-permission.ts`                                                                                     |
| An agent does something irreversible                                       | **Human approval**: sensitive operations (every `DELETE` by default) become proposals a person approves; on approval the agent's identity is **re-read** (revoked keys or scopes do not run)                                                                                                                                                                                                                                              | `lib/approvals.ts`, [approvals](agents/approvals.md)                                                                         |
| A queued job runs with stale permissions                                   | The job stores its actor and **re-reads** it before running; the handler runs under that actor's RLS                                                                                                                                                                                                                                                                                                                                      | `lib/queue.ts`                                                                                                               |
| A request rolls back but its side effect happens anyway                    | Jobs and webhooks are written in the **same transaction** (outbox); `ROLLBACK` removes them                                                                                                                                                                                                                                                                                                                                               | `lib/queue.ts`                                                                                                               |
| Retries cause double writes                                                | `Idempotency-Key` on every write (REST and MCP); queue handlers are idempotent by contract                                                                                                                                                                                                                                                                                                                                                | `lib/idempotency.ts`                                                                                                         |
| An agent floods the API or burns budget                                    | Per-agent rate, daily writes and budget units; global limiter (fail-closed on login and mail routes)                                                                                                                                                                                                                                                                                                                                      | `lib/agent-quotas.ts`, `lib/rate-limiter.ts`                                                                                 |
| Untrusted text written by third parties steers a model (prompt injection)  | Provenance on every row an agent reads (`X-Kitsuden-Provenance`), optional wrapping of untrusted text, and human approval for what matters. Kitsuden does **not** claim to detect injection                                                                                                                                                                                                                                               | `lib/provenance.ts`                                                                                                          |
| Server-side request forgery via agent-supplied URLs                        | Webhook URLs are set by an admin, and resolved addresses must be public; `webhook_out` actions and sandbox `fetch` do not follow redirects and read a bounded answer                                                                                                                                                                                                                                                                      | `lib/proposal-notifications.ts`, `lib/actions/handlers/webhook-out-handler.ts`, `lib/worker-sandbox.ts`, `lib/oauth/cimd.ts` |
| Customer data read by an execution is sent to a third party                | Fields and kon columns marked `sensitivity: "customer"`/`"personal"`; values an execution read are tracked in memory, and sandbox `fetch` refuses, `webhook_out` and notifications redact them, for hosts not allowed for customer data. Only a person allows a host or removes a mark. Audited (`customer_data_blocked`)                                                                                                                 | `lib/customer-data.ts`, [egress](agents/egress.md)                                                                           |
| An external MCP server changes a tool's description or schema after review | Fingerprint (SHA-256 of name, description, input schema) per tool; new, changed or removed tools need a **human** approval of the exact fingerprint. Agents call only approved tools, with an explicit `mcp-external:` scope (`admin` does not grant it); the fingerprint is checked again at each call, a mismatch is not called and goes back to review; every call is a write (approval, quota) and its output is wrapped as untrusted | `lib/external-mcp.ts`, `lib/external-mcp-bridge.ts`, [external MCP](agents/external-mcp.md)                                  |
| Arbitrary code execution                                                   | Code actions are **off by default** in production (`ENABLE_CODE_ACTIONS`); when on, they run in QuickJS compiled to WASM inside a child process with an empty environment                                                                                                                                                                                                                                                                 | `lib/worker-sandbox.ts`, [sandbox](agents/sandbox.md)                                                                        |
| A compromised API process reads every secret                               | The running API does not hold the superuser URL; the vault and webhook secrets are encrypted (AES-256-GCM)                                                                                                                                                                                                                                                                                                                                | `services/secrets.ts`                                                                                                        |
| Nobody notices an agent probing                                            | Agent audit log, and the request traces ("glass box"): every write, error and **blocked** write (owner filter or RLS) per actor                                                                                                                                                                                                                                                                                                           | `services/agent-audit.ts`, `lib/traces.ts`                                                                                   |

## Out of scope (today)

- **A malicious administrator.** Admins can change scopes, approve proposals
  and read audit logs; Kitsuden records it, it does not prevent it.
- **The host and Postgres itself.** Disk encryption, backups, network
  isolation and OS patching are the operator's job ([server](install/server.md)).
- **Model-level attacks.** Kitsuden limits what a model can _do_; it does not
  judge what it _says_. A prompt-injection classifier would be a second line
  after human approval, never the first.
- **Data loss prevention.** The customer-data limit recognises values as they
  were read (normalised, at least 5 characters). Encoded, hashed, split or
  reformatted copies get through, and so does anything an outside agent reads
  and then sends itself, or that an `agent` action puts in its model prompt
  ([egress](agents/egress.md#what-it-does-not-cover)).
- **External MCP tools at call time.** The review covers what a server
  announces, not what its tools do when called: the output is wrapped as
  untrusted, but a tool can still do something its description does not say.
- **The code sandbox as a hard boundary.** It is off by default and has not
  had an external review; do not turn it on for untrusted code until it has.
- **Edge/serverless deployments.** The guarantees above assume one persistent
  API next to its Postgres (warm pool, one local transaction per request).

## Reporting

See [SECURITY.md](../SECURITY.md).
