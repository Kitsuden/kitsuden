# MCP toolsets and format savings

## Toolsets: send fewer tool definitions

Every MCP session starts with `tools/list`, and the client puts every tool
definition (name, description, JSON Schema) into the model's context on every
turn. An admin agent on a Kitsuden with all kons on sees **661 tools ≈ 188k
tokens** — more than most context windows. A toolset narrows that list.

Choose it at connect time, or as the agent's default in the panel:

```text
GET /api/mcp?toolset=read,kon:blog
Admin panel → Agents → (agent) → Quotas → MCP settings → Default toolset
PUT /api/v1/agents/:id/mcp-settings   { "toolset": "data" }    (null or "all" = no restriction)
```

| Toolset    | Tools                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `all`      | no restriction (the default)                                                                          |
| `read`     | read-only: core tools with `mcp:read`, kon `GET` operations                                           |
| `data`     | core dataset/collection tools: list, describe, query, create/update/delete/insert record              |
| `core`     | every core `kitsuden_*` tool                                                                          |
| `actions`  | engine actions (`kitsuden_define_action`)                                                             |
| `kons`     | every kon SDK operation                                                                               |
| `kon:<id>` | the operations of one kon (`kon:blog`, `kon:crm`…)                                                    |
| `external` | approved tools of external MCP servers (`ext_*`, [external-mcp.md](external-mcp.md)); never in `read` |

Comma-separated values are a **union**. `kitsuden_proposal_status` is in every
toolset (it only reads the agent's own proposals). An unknown name is a `400`
at connect time, not a silently empty list.

**A toolset never grants anything.** A tool is listed and callable only if it
is in the toolset **and** in the agent's `allowedTools` (when set) **and**
allowed by its scopes. With both a panel default and `?toolset=`, the session
uses the **intersection**: the URL can narrow the agent's default, never widen
it. `tools/call` on a tool outside the toolset fails with
`KITSUDEN_E_FORBIDDEN`, like a tool outside `allowedTools`. The panel default
is re-read on every MCP message, so a change applies without reconnecting.

### Measured

`tools/list` on the real app with every installed kon on (2026-10-28, a fresh
test database; definitions serialised as the client receives them; offline
tokenizers via `js-tiktoken@1.0.21`):

| Agent                                 | Toolset         | Tools |   Bytes | `o200k_base` | `cl100k_base` | vs. all |
| ------------------------------------- | --------------- | ----: | ------: | -----------: | ------------: | ------: |
| admin (`admin` scope)                 | all             |   661 | 715,361 |      187,822 |       185,075 |       — |
| admin                                 | `read`          |   276 | 196,651 |       48,680 |        48,240 | −74.1 % |
| admin                                 | `kon:blog`      |    18 |  20,633 |        5,855 |         5,720 | −96.9 % |
| admin                                 | `data,kon:blog` |    26 |  26,254 |        7,144 |         6,967 | −96.2 % |
| admin                                 | `core`          |    16 |   9,745 |        2,218 |         2,144 | −98.8 % |
| admin                                 | `data`          |     9 |   6,176 |        1,409 |         1,365 | −99.2 % |
| data editor (`mcp:read`, `mcp:write`) | all             |   261 | 254,097 |       64,829 |        63,692 |       — |
| data editor                           | `read`          |   154 | 104,740 |       25,490 |        25,121 | −60.7 % |
| data editor                           | `data,kon:blog` |    15 |  10,139 |        2,369 |         2,302 | −96.3 % |
| data editor                           | `data`          |     9 |   6,176 |        1,409 |         1,365 | −97.8 % |

A typical content agent (`data,kon:blog`) goes from ~65k to ~2.4k tokens of
tool definitions per turn. These are not Claude's tokenizer (there is no
offline one; see docs/agents/benchmarks.md §1); expect Claude to count
somewhat more, with the same ratios.

## Format savings per agent

Results already come in the shortest lossless format (`auto`: compact JSON,
TOON or TRON; `X-Kitsuden-Format`, `_meta["kitsuden/format"]`). Kitsuden also
**records how much that saved, per agent and per day**, and the panel shows it next to the quotas (Agents → (agent) → Quotas →
_Tokens saved by the auto format_).

- What is counted: every MCP tool call of an agent identity, and every REST
  response to an agent that asked for `auto`/`toon`/`tron`. For each:
  bytes of the compact JSON, bytes actually sent, and **estimated** tokens of
  both (characters ÷ the `o200k_base` characters-per-token measured in
  benchmarks.md §1: JSON 3.06, TOON 3.10, TRON 2.81).
- Stored in `agent_format_savings` (migration 0052): agent id, UTC day,
  channel (`mcp`/`rest`) and six counters. No arguments, no results, no
  user ids, no IPs. Added up in memory and written at most every 15 s.
- API: `GET /api/v1/agents/:id/quotas` now also returns `formatSavings`
  (`today`, `period` = last 30 days, `daily`). Admin only, like the quotas.
- Legacy `kitsuden_sk_*` keys are not counted (they have no agent identity).

## Implementation

`apps/api/src/lib/mcp-settings.ts` (toolsets, settings), `lib/format-measure.ts`
(the per-call measurement, no database), `lib/format-savings.ts` (the daily
aggregate), `routes/mcp.ts` (wiring) and `routes/agent-permissions.ts`
(`/mcp-settings`, `formatSavings`). Panel: `AgentMcpSettings.svelte`,
`AgentQuotas.svelte`.
