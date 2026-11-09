# What an agent chose not to do

The panel already showed what a person rejected (proposals) and where agents
get stuck (friction). It did not show the agent's own choices: an action it
considered and discarded left no trace. An agent now records them itself.

## Recording a decision

MCP tool `kitsuden_record_decision`, or REST:

```http
POST /api/agent/decisions
Authorization: Bearer kitsuden_agent_…
Content-Type: application/json

{
  "action": "refund order 1042",
  "reason": "the order is disputed; a person must decide",
  "alternatives": ["flagged it for support"],
  "context": { "orderId": 1042 },
  "traceId": "…"
}
```

| Field          | Rules                                                     |
| -------------- | --------------------------------------------------------- |
| `action`       | required, what it did not do, up to 500 characters        |
| `reason`       | required, why, up to 4000 characters                      |
| `alternatives` | optional, up to 10 texts of up to 500 characters          |
| `context`      | optional object, up to 16 KiB of JSON, never a secret     |
| `traceId`      | optional, linked only if it is one of this agent's traces |

- The row belongs to the agent of the **session**; the body cannot name another.
- It is never held for approval and costs no daily write (only the per-minute
  rate counts): it is what an [unattended run](approvals.md#unattended-runs) is
  told to do instead of a held write, so it must always be possible.
- It stores the [version](versions.md) of the agent that decided.
- Nobody edits a decision.
- Agents running inside Kitsuden (an `agent` action) have the same tool.

`GET /api/agent/decisions` returns the agent's own decisions (`limit`, `offset`,
`days`). Another agent's do not exist for it.

## Reading them

People of the team: `GET /api/v1/agent-decisions` (`days` 1-365, default 30;
`agentId`; `limit`; `offset`), with the agent's name and version number. An admin
sees every agent. An editor sees the agents whose proposals they may decide, so
not the ones they sponsor (the same rule as approving). No agent reads this list,
not even one with the `admin` scope. In the panel:
Approvals → Discarded (next to the inbox, where rejected proposals are), and
Agents → agent → History for one agent.

Code: `apps/api/src/lib/agent-decisions.ts`; table: migration
`0067_agent_decisions.sql`.
