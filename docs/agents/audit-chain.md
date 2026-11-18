# The agent audit log as a hash chain

`agent_audit_logs` records what agents do: authentications, tool calls,
proposals and their decisions, configuration changes. Since migration `0088` it
is **tamper-evident**: every row is linked to the previous one by a hash and
signed with a key the database does not hold, the table is append-only, and an
admin can verify the whole chain at any time.

Inspired by alibaba/open-agent-auth's verifiable audit records (Apache-2.0); no
code is copied.

## Contents

- [How a row is linked](#how-a-row-is-linked)
- [Append-only](#append-only)
- [Verifying](#verifying)
- [Anchoring the head outside the database](#anchoring-the-head-outside-the-database)
- [Retention](#retention)
- [Keys and rotation](#keys-and-rotation)
- [What it detects and what it does not](#what-it-detects-and-what-it-does-not)
- [Upgrading](#upgrading)

## How a row is linked

Each new row gets, inside one transaction that holds an advisory lock (so
concurrent writers never fork the chain):

- `seq`: the next integer, gapless;
- `prev_hash`: the previous row's `row_hash` (64 zeros for the first);
- `row_hash`: SHA-256 of a canonical form of every audited field (id, time,
  agent, key, action, resource, details with sorted keys, IP, user agent,
  duration, success, error) plus `prev_hash`;
- `mac`: HMAC-SHA256 of `row_hash` with a key derived from
  `KITSUDEN_SECRETS_KEY` (a subkey with its own label: never the encryption key
  itself), and `key_version`, which names that key without revealing it.

The hash is computed from the values exactly as they are stored, so it can be
recomputed from the row later (`apps/api/src/lib/audit-chain.ts`). Writers
(`logAgentAction`, `registerAgentAction`) keep their signatures: nothing that
logs changed.

## Append-only

A trigger refuses every `UPDATE`, `TRUNCATE`, and any `INSERT` that does not
extend the chain. `DELETE` is refused except inside `kitsuden_audit_prune()`, the
retention function. The application role has no `UPDATE`, `DELETE` or
`TRUNCATE` on the table.

The foreign key to `agent_identities` is gone: deleting an agent used to erase
its history (`ON DELETE CASCADE`). Now its rows stay, with the agent's id.

## Verifying

```http
GET /api/admin/audit/verify[?fromSeq=&toSeq=]
GET /api/admin/audit/head
```

Human admins only (never an agent, whatever its scopes). `verify` walks the
chain and answers `{ ok, checked, head, legacyRows, … }`, or on the first
problem `{ ok: false, reason, firstBadSeq, detail }` with `reason` one of
`seq_gap`, `prev_hash_mismatch`, `hash_mismatch`, `mac_mismatch` or
`checkpoint_mismatch`.

From a shell:

```bash
cd apps/api && bun run scripts/verify-audit.ts [--from N] [--to N] [--expect-head <row_hash>]
```

It prints the same JSON and exits `1` when anything does not verify.

## Anchoring the head outside the database

The chain cannot notice, on its own, that the NEWEST rows were removed all
together (it would just end earlier). The API logs the chain head
(`seq`, `row_hash`) at start and once a day ("Agent audit chain head"); ship those
lines to a place the database's owner cannot rewrite (a log service, a ticket, a
signed commit). Later, `--expect-head <row_hash>` checks that the anchored link
is still there.

## Retention

`AGENT_AUDIT_RETENTION_DAYS` (90; `0` = forever) still applies, hourly. The prune
removes only a **prefix** of the chain (the oldest rows), and first writes a row
to `agent_audit_checkpoints` with the last removed `seq`, `row_hash` and `mac`.
The remaining chain verifies from that checkpoint. A prune cutoff less than a
day old is refused.

## Keys and rotation

The MAC key comes from `KITSUDEN_SECRETS_KEY`. After a rotation, keep the old
value in `KITSUDEN_SECRETS_KEY_OLD` (as `rekey-secrets` already asks): rows
signed with it still verify, and a row signed with the OLD key after rows signed
with the new one is refused. Without any configured key (development only),
rows are signed with a fixed fallback and reported as `unkeyedRows`.

## What it detects and what it does not

Detects: a row edited, inserted in the middle, removed from the middle, or
reordered; a forged row whose hash was recomputed by someone without the key;
removal of the newest rows, if you anchored the head.

Does not stop: someone with **both** the secrets key and write access to the
database can rewrite the chain from some point on and re-sign it. Anchoring the
head outside closes that too, up to the last anchor. It records what happened;
it does not prevent it.

## Upgrading

Rows written before `0088` are not chained (`seq` is null); `verify` counts them
as `legacyRows` and does not check them. They are removed by retention like the
rest. Tests and scripts that used to `DELETE FROM agent_audit_logs` now fail: the
log is append-only.
