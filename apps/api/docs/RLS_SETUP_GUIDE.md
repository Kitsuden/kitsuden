# RLS Setup Guide - The Titanium Wall

## Activation checklist

### Step 1: Database migration

```bash
# Apply the migrations (this adds the owner_id column)
cd apps/api
bun run db:migrate
```

**Check:**

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'data_entries' AND column_name = 'owner_id';
-- Should return: owner_id | text
```

### Step 2: Apply the RLS policies

```bash
# Apply and verify the policies (idempotent, safe to run after every migration)
cd apps/api
bun run db:rls        # same as: bun run scripts/apply-rls.ts
```

The script applies, in order, `src/db/rls-policies.sql`, `src/db/rls-owned-tables.sql` and
`src/db/rls-system-only.sql`, then reports how many tables have RLS enabled and how many
also have `FORCE ROW LEVEL SECURITY`. It warns if the database role you connect with is a
superuser (see the next step).

### Step 3: Connect as a role that RLS applies to

PostgreSQL ignores RLS for superusers (and for roles with `BYPASSRLS`). The API must connect
with a plain, non-superuser role, otherwise the policies exist but protect nothing.
`FORCE ROW LEVEL SECURITY` makes the policies apply to the table owner too, but never to a
superuser.

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
-- rolsuper and rolbypassrls must both be false
```

### Step 4: Check the API integration

The middleware is wired in `apps/api/src/index.ts`:

```typescript
// Key lines:
app.use("/api/datasets/:id/entries", withTransactionalRLS());
app.use("/api/datasets/:slug/entries", withTransactionalRLS());
```

### Step 5: Manual testing

```bash
# 1. Start the API
cd apps/api
bun run dev

# 2. In another terminal, test with curl (authenticated)
curl -H "Cookie: session=..." \
     http://localhost:3000/api/datasets/test/entries

# 3. Set the log level to debug and check that the RLS context is injected:
# [RLS] transaction opened
```

### Step 6: Direct SQL check

```sql
-- Connect to PostgreSQL (as the application's role, not a superuser)
psql -d kitsuden

-- Empty context (no user)
SELECT current_setting('app.current_user_id', true);
-- Result: '' (empty)

-- Simulate a user context
SELECT set_config('app.current_user_id', 'test-user-123', false);
SELECT set_config('app.current_user_role', 'user', false);
SELECT current_setting('app.current_user_id', true);
-- Result: 'test-user-123'

-- Query with RLS active
SELECT id, title, owner_id FROM data_entries LIMIT 5;
-- Should return ONLY rows where owner_id = 'test-user-123'
-- or public rows (if there are any)

-- Clear the context
SELECT set_config('app.current_user_id', '', false);
SELECT set_config('app.current_user_role', '', false);
```

Note: with both settings empty, the policies treat the session as the system (migrations,
loaders, workers) and allow everything. That is why a request always sets the role as well
(`anonymous` for visitors).

---

## Troubleshooting

### Error: "policy already exists"

**Fix:** the policy files drop and recreate each policy, so they are idempotent. Re-run the script.

### Error: "permission denied for table data_entries"

**Cause:** the PostgreSQL user cannot create policies.
**Fix:** run the script as the table owner or a user with the privileges to create policies.

### Error: "column owner_id does not exist"

**Cause:** migrations were not applied.
**Fix:** run `bun run db:migrate` first.

### Entries come back empty when they should not

**Cause:** the RLS context is set but nothing matches.
**Debug:**

```sql
-- See which user_id is active
SELECT current_setting('app.current_user_id', true);

-- See entries without the RLS filter (as a superuser)
SET row_security = off;
SELECT id, title, owner_id FROM data_entries;
```

---

## Rollback (disable RLS)

```sql
-- Disable RLS on a table
ALTER TABLE data_entries DISABLE ROW LEVEL SECURITY;

-- Or drop specific policies
DROP POLICY IF EXISTS data_entries_owner_isolation ON data_entries;
DROP POLICY IF EXISTS data_entries_public_read ON data_entries;
```

---

## Monitoring

### Security logs

At debug level the middleware logs, for every request:

```
[RLS] transaction opened
```

and, at error level, when a request's transaction ended up aborted and nothing was saved.

### Recommended metrics

- p99 latency of endpoints that use RLS
- Rate of 403 errors (access denied)
- Number of queries rejected by RLS policies

---

## Support

- **Technical documentation:** `apps/api/docs/RLS_HYBRID_ARCHITECTURE.md`
- **Apply script:** `apps/api/scripts/apply-rls.ts`
- **SQL policies:** `src/db/rls-policies.sql`
- **Middleware:** `src/middleware/transactional-rls.ts`
