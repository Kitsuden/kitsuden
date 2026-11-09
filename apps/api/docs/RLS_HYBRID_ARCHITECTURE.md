# Hybrid RLS Architecture: The Titanium Wall

---

## Summary

Kitsuden uses a **two-level** security architecture for Row Level Security (RLS):

1. **Level 1 (application):** RLS through Drizzle `WHERE` clauses. Good performance.
2. **Level 2 (database):** native PostgreSQL RLS. Strong guarantees.

Having both means that **even if the application code has a bug, or an AI generates a wrong
query**, PostgreSQL still refuses to show a user another user's data. This holds as long as the
API connects with a role that RLS applies to (not a superuser, see [the setup guide](RLS_SETUP_GUIDE.md)).

---

## Why two levels?

### Level 1 alone is not enough for AI

```typescript
// Example: a bug or a badly generated AI query
const entries = await db.select().from(dataEntries); // No RLS WHERE!
// ^^^ DATA LEAK - every record exposed
```

### Level 2: defensive security

```sql
-- PostgreSQL intercepts AUTOMATICALLY
SELECT * FROM data_entries;
-- RLS policy: WHERE owner_id = current_setting('app.current_user_id')
-- Result: only the current user's records
```

### Comparison

| Aspect             | Level 1 (app) | Level 2 (native) | Hybrid (both)    |
| ------------------ | ------------- | ---------------- | ---------------- |
| Performance        | Best          | Transaction cost | Good, and secure |
| Protection vs bugs | No            | Yes              | Yes              |
| Protection vs AI   | No            | Yes              | Yes              |
| Complexity         | Low           | Medium           | Medium           |
| Automatic rollback | No            | Yes              | Yes              |

---

## Detailed architecture

### Request flow with hybrid RLS

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         HTTP REQUEST                                    │
│                  GET /api/datasets/recipes/entries                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  MIDDLEWARE: withTransactionalRLS()                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 1. Get the user from the Better-Auth session                    │   │
│  │ 2. Start a PostgreSQL transaction                               │   │
│  │ 3. Run: SELECT set_config('app.current_user_id', 'u123', true)  │   │
│  │ 4. Store the tx with c.set("tx", tx)                            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  HANDLER: GET /:id/entries                                              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ // LEVEL 1: Drizzle WHERE (performance)                         │   │
│  │ const { where } = buildDatasetWhere(datasetId, rules, user);    │   │
│  │                                                                  │   │
│  │ const docs = await tx                                           │   │
│  │   .select().from(dataEntries)                                   │   │
│  │   .where(where);  // ← explicit filter in SQL                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  POSTGRESQL: query execution                                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ SELECT * FROM data_entries WHERE data_set_id = '...';           │   │
│  │                                                                  │   │
│  │ // LEVEL 2: native RLS (security)                               │   │
│  │ POLICY data_entries_owner_isolation APPLIED AUTOMATICALLY:      │   │
│  │ WHERE owner_id = current_setting('app.current_user_id', TRUE)   │   │
│  │                                                                  │   │
│  │ Final result: intersection of the WHERE and the POLICY          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  COMMIT / ROLLBACK                                                      │
│  • If everything is fine: COMMIT (changes persist)                     │
│  • On error: automatic ROLLBACK (no partial leaks)                     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. RLS middleware (`middleware/transactional-rls.ts`)

`withTransactionalRLS()` wraps the request in a transaction (through the engine's
`rlsTransaction`), sets `app.current_user_id` and `app.current_user_role` for that
transaction, exposes the transaction as `c.get("tx")`, and rolls back if the route fails.
The context is always transaction-local. Helpers that set it at session level on a pooled
connection (`withRLSContextOnly`, `rlsContextMiddleware`, `withRLSQuery`) or that ran as a
made-up admin (`withAdminRLS`, `lib/agent-rls.ts`) were removed on 2026-11-04: they had no
callers and a context that outlives its request leaks to the next one.

### 2. Policies (`db/rls-policies.sql`)

Abridged. The real file also covers the system (no context), agent scopes and public records:

```sql
-- Enable RLS on the table
ALTER TABLE data_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_entries FORCE ROW LEVEL SECURITY;

-- Policy: only the owner can see their records
CREATE POLICY data_entries_owner_isolation ON data_entries
    FOR ALL
    TO PUBLIC
    USING (
        -- Admin bypass
        current_setting('app.current_user_role', true) = 'admin'
        OR
        -- Owner of the record
        owner_id = current_setting('app.current_user_id', true)
        OR
        -- Legacy: owner stored in the JSONB
        (owner_id IS NULL AND data->>'ownerId' = current_setting('app.current_user_id', true))
    );
```

---

## Protection scenarios

### Scenario 1: bug in the code

```typescript
// BUG: a developer forgets to apply the RLS filters
app.get("/api/debug/all-entries", async (c) => {
  // No RLS middleware, no WHERE filters
  return await db.select().from(dataEntries);
});
```

**Result:**

- Without native RLS: **LEAK**, every record exposed
- With native RLS: **SAFE**, PostgreSQL requires a matching owner_id

**Mitigation:** the bug exposes the route, but PostgreSQL still protects the data. Note
that a request that never sets a context looks like the system to the policies, so every
route that serves user data must go through the RLS middleware.

---

### Scenario 2: query generated by AI (MCP server)

```typescript
// An MCP server generates a dynamic query
const userQuery = "Give me all the entries";
const sql = await ai.generateSQL(userQuery);
// The AI "hallucinates": SELECT * FROM data_entries WHERE 1=1
const result = await db.execute(sql.raw(sql));
```

**Result:**

- Without native RLS: **LEAK**, the AI ignored the user context
- With native RLS: **SAFE**, PostgreSQL applies the policy automatically

---

### Scenario 3: direct database access

```bash
# An attacker gets access to PostgreSQL with a limited role
psql -h db.example.com -U readonly

readonly=> SELECT * FROM data_entries;
```

**Result:**

- Without native RLS: **LEAK**, the whole table can be read
- With native RLS: **SAFE** for non-superuser roles, because the policies apply to them
  (and, with `FORCE ROW LEVEL SECURITY`, to the table owner). Superusers and `BYPASSRLS`
  roles always skip RLS.

---

### Scenario 4: SQL injection

```typescript
// Malicious input
const search = "' OR '1'='1";
const query = `SELECT * FROM data_entries WHERE title = '${search}'`;
```

**Result:**

- Without native RLS: **LEAK**, the injection works and data is exposed
- With native RLS: **PARTIAL**, the injection may run but RLS limits the visible data to what the authenticated user may see

---

## Configuration and use

### 1. Installation

```bash
# Apply the migrations (adds the owner_id column)
cd apps/api
bun run db:migrate

# Apply the RLS policies
bun run db:rls
```

### 2. Verification

```sql
-- Check the active policies
SELECT schemaname, tablename, policyname, cmd
FROM pg_policies
WHERE tablename = 'data_entries';

-- Check that RLS is enabled
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname = 'data_entries';
```

### 3. Manual testing

```sql
-- Simulate a user context
SELECT set_config('app.current_user_id', 'user-123', false);
SELECT set_config('app.current_user_role', 'user', false);

-- The query should return ONLY user-123's records
SELECT id, title, owner_id FROM data_entries;

-- Clear the context
SELECT set_config('app.current_user_id', '', false);
SELECT set_config('app.current_user_role', '', false);
```

---

## Performance considerations

Running every request in a transaction costs some latency and throughput compared with
plain queries. For high-frequency read-only endpoints you can skip the transactional
middleware and rely on Level 1 only; measure on your own hardware before deciding.

### Optimizations

1. **Critical indexes:**

   ```sql
   CREATE INDEX entries_owner_idx ON data_entries(owner_id);
   CREATE INDEX idx_data_entries_dataset_owner ON data_entries(data_set_id, owner_id);
   ```

2. **Operations without a user** (jobs, startup): use the engine's `asSystem`, which
   sets the system context explicitly. There is no helper that pretends to be an admin.

---

## References

- [PostgreSQL Row Level Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Drizzle ORM Transactions](https://orm.drizzle.team/docs/transactions)
- [Better-Auth Sessions](https://www.better-auth.com/docs/concepts/sessions)
- [Model Context Protocol](https://modelcontextprotocol.io/)

---

## Glossary

| Term     | Definition                                           |
| -------- | ---------------------------------------------------- |
| **RLS**  | Row Level Security: access control at the row level  |
| **MCP**  | Model Context Protocol: protocol for LLM integration |
| **TX**   | Transaction: a database transaction                  |
| **BaaS** | Backend as a Service                                 |
