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
| `all`      | no restriction, and always the direct list (see discovery mode below)                                 |
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

### Discovery mode: the default when nobody chose

An agent with no toolset (no panel default, no `?toolset=`) used to get every
definition. Now, when those definitions are over `MCP_TOOLS_LIST_MAX_BYTES`
(default 64 000 bytes ≈ 16k tokens), `tools/list` returns only:

| Tool                  | What it does                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `kitsuden_find_tools` | with `query`, the best matches with their input schemas; without it, tool counts per group |
| `kitsuden_call_tool`  | `{ name, arguments }`: calls one of them                                                   |

plus `kitsuden_proposal_status` and `kitsuden_record_decision`. The result's
`_meta["kitsuden/tools"]` says `mode: "discovery"`, how many tools are behind it
and their size.

- **Nothing is granted.** `kitsuden_call_tool` runs the inner tool through the
  same path as a direct call: `allowedTools`, toolsets, scopes, quota, human
  approval. The audit log and the friction report record the inner tool's name
  (`details.via = "kitsuden_call_tool"`).
- **An installation that fits the budget sees no change.** Neither does an
  agent with any toolset, or with `all` named explicitly (`?toolset=all` or the
  panel default `all`): they get the direct list.
- `MCP_TOOLS_LIST_MAX_BYTES=0` turns the mode off. The list is sorted by name in
  both modes, so the same agent gets the same bytes on every connection and
  clients can cache the prefix.

The saving of discovery mode and of the smaller results, measured before and after
on the same install, is in [benchmarks.md §4](benchmarks.md#4-agent-context-tokens-per-call).

### Smaller results

- `MCP_RESULT_MAX_CHARS` (default 100 000 characters ≈ 25k tokens; `0` = off):
  a longer tool result is cut, ends with a note saying how much was shown, drops
  `structuredContent`, and carries `_meta["kitsuden/truncated"]`
  (`shownChars`, `totalChars`).
- `kitsuden_query_collection` and `kitsuden_query_dataset` return **20** rows
  unless `limit` says otherwise (was 50), and accept `fields: ["title", …]`:
  only those keys of each row (read from the row, else from its `data`), plus
  `id`.
- Kon tool schemas leave out what tells a model nothing: the ±2⁵³ bounds
  `z.number().int()` emits, and a `pattern` next to a `format` that already says
  it (`uuid`, `email`). The OpenAPI keeps the full schema, and the server still
  validates with it.

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

`apps/api/src/lib/mcp-settings.ts` (toolsets, settings), `lib/tool-discovery.ts`
(discovery mode, result cap, `fields`), `lib/format-measure.ts`
(the per-call measurement, no database), `lib/format-savings.ts` (the daily
aggregate), `routes/mcp.ts` (wiring) and `routes/agent-permissions.ts`
(`/mcp-settings`, `formatSavings`). Panel: `AgentMcpSettings.svelte`,
`AgentQuotas.svelte`.
