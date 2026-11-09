# Versioned agents

An agent's definition (its system prompt, allowed tools, capabilities, type,
scopes and MCP settings) used to have no history, and a run did not say which definition acted. Now four
things are kept apart:

| Record     | Where                                    | What it is                                                 |
| ---------- | ---------------------------------------- | ---------------------------------------------------------- |
| Definition | `agent_identities`                       | what an admin edits                                        |
| Version    | `agent_versions`                         | one numbered row per **distinct** definition               |
| Trigger    | `actions` / `action_executions`, MCP, UI | what started a run                                         |
| Run        | `agent_traces` (+ `agent_version_id`)    | the run, with the version that was current when it started |

## How versions are made

- Saving an agent through the API or the panel (`POST`/`PATCH /api/v1/agents`,
  `/api/v1/identities`, `POST`/`PUT /api/admin/agents`) snapshots it, and so does
  saving its scopes (`PUT /api/v1/agents/{id}/scopes`, `note = "scopes"`) or its
  MCP settings (`PUT /api/v1/agents/{id}/mcp-settings`, `note = "MCP settings"`). A new
  version only appears when the definition's hash changes: saving the same form
  twice adds nothing. The person who saved it is recorded (`created_by`).
- Every trace, whichever code path inserts it, gets `agent_version_id` from a
  database trigger. If the definition changed through a path that did not
  snapshot it (a script, a direct SQL update), the trigger snapshots it first,
  with `source = detected`. So a run always points at the exact definition that
  ran.
- Agents that existed before migration 0066 get version 1 (`baseline`) when it
  runs.
- `model` is recorded as `null` today: an agent has no model of its own (the
  server's provider decides). Keys, quotas, the signer and the approval mode are
  not part of the definition; their changes are in the audit log.
- Scopes and MCP settings joined the definition in migration 0074: what an agent
  may do shapes a run as much as its prompt. That migration gives every agent
  that already had versions one more (`baseline`, with a note), so the format
  change does not show up later as an unexplained `detected` version.

## Restoring

`POST /api/v1/agents/{id}/versions/{version}/restore` writes that version's
prompt, tools, capabilities, type, scopes and MCP settings back to the agent. A
version made before migration 0074 did not record scopes or MCP settings, so
restoring it leaves the current ones as they are. The result is recorded as a
**new** version (`source = restore`, `note = "restored version N"`).
History only grows; the restore is audited (`agent_version_restored`).

## API (admin only; an agent never writes an agent)

| Method | Path                                             |                                               |
| ------ | ------------------------------------------------ | --------------------------------------------- |
| `GET`  | `/api/v1/agents/{id}/versions`                   | newest first, without the prompt text         |
| `GET`  | `/api/v1/agents/{id}/versions/{version}`         | one version with its prompt and configuration |
| `POST` | `/api/v1/agents/{id}/versions/{version}/restore` | back to that definition, as a new version     |

In the panel: Agents → agent → History.

Code: `apps/api/src/lib/agent-versions.ts`; SQL: migration
`0066_agent_versions_and_unattended.sql` (`kitsuden_agent_snapshot()`) and
`0074_agent_versions_include_permissions.sql`.
