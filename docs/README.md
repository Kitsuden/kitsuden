# Kitsuden documentation

One path, in order. Everything a new user needs is on it; anything not linked
from here is reference.

## 1. Start

- **What Kitsuden is**: the action runtime for AI agents, a backend on Postgres
  with row-level security and human approval ([README](../README.md),
  [threat model](threat-model.md)).
- **Install for real**: [docs/install](install/README.md).

## 2. Models

- [Your first model in five minutes](first-model.md)
- [Models: `defineModel`](agents/models.md), including day-2 changes on tables
  with rows
- [Writing a kon](kons/README.md): operations, the request transaction,
  streaming operations (`output.flow`)

## 3. Permissions

- [Agent permissions, keys and quotas](agents/permissions.md)
- [Errors and safe retries](install/errors-and-retries.md)

## 4. Agents and approvals

- [Human approval](agents/approvals.md), and being told when a proposal is
  resolved (SSE or signed webhook)
- [Typed clients](agents/clients.md) (TypeScript, Python, MCP)
- [Record history](record-history.md): who changed a record, an agent or a person, and
  which fields; and the explorer's search and filters
- [Local AI](agents/local-ai.md): embeddings, semantic search, a second opinion
  on proposals
- [Limit on what leaves](agents/egress.md): customer data marks and where the
  values an execution read may go
- [External MCP servers](agents/external-mcp.md): tool fingerprints and their
  human review

## 5. Deployment

- [Server install](install/server.md) and [variables](install/variables.md)
- [Background jobs: the Postgres queue](install/queue.md)
- [PgBouncer](install/pgbouncer.md) · [Runtimes: Bun, Node, why not edge](install/runtimes.md)
- [Upgrades and backups](install/upgrade-and-backups.md)
- [Operations: migrations, RLS and backups](operations.md)
- [Security scanning](security-scanning.md): what CI scans, what blocks a release
