-- ============================================================================
-- NATIVE POSTGRESQL RLS - The Titanium Wall (AI-Ready Phase)
-- ============================================================================
-- 
-- This file contains the native PostgreSQL Row Level Security (RLS)
-- policies. They act as a "second line of defense" against data leaks.
--
-- HYBRID ARCHITECTURE:
-- - Level 1 (Application): RLS via Drizzle WHERE (optimal performance)
-- - Level 2 (Database): Native PostgreSQL RLS (absolute security)
--
-- The policies use current_setting('app.current_user_id') injected by
-- the Hono middleware on every request.
--
-- NOTE: Run this file after the Drizzle migrations.
--
-- ── "EMPTY CONTEXT = ALLOW EVERYTHING" HAD A HOLE ──────────────────────────
--
-- The policies fail OPEN without context (migrations, seeds and workers
-- run without a user). But `current_setting('app.current_user_id', true)`
-- returns NULL —not ''— on a connection where NOBODY has set it yet, and
-- `NULL = ''` is not true: it is NULL. The policy allowed nothing.
--
-- Since connections come from a pool, the result depended on where that connection
-- had been before: a freshly opened one returned zero rows
-- and another, reused from a request with context, returned all of them. The
-- same anonymous GET to a public dataset gave one result or the other depending on which
-- connection it got. That is why `IS NULL` is now also checked, as in
-- rls-owned-tables.sql.
--
-- And each policy is DROPPED before being created: the applier swallows
-- "already exists", so without the DROP editing this file changed nothing
-- on a database that already had it applied.
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. ENABLE RLS ON CRITICAL TABLES
-- ═══════════════════════════════════════════════════════════════════════════

-- Table: data_entries (User data - Critical)
ALTER TABLE data_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_entries FORCE ROW LEVEL SECURITY; -- Applies even to the table owner

-- Table: ai_memories (AI data - Critical if it exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_memories') THEN
        ALTER TABLE ai_memories ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ai_memories FORCE ROW LEVEL SECURITY;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. POLICIES FOR data_entries
-- ═══════════════════════════════════════════════════════════════════════════

-- Policy: Users only see their own records
-- Applies when owner_id is set
DROP POLICY IF EXISTS data_entries_owner_isolation ON data_entries;

CREATE POLICY data_entries_owner_isolation ON data_entries
    FOR ALL
    TO PUBLIC
    USING (
        -- Without RLS context (id AND role empty or unset) it is the SYSTEM:
        -- migrations, loaders, workers. The empty id alone is NOT enough: the
        -- anonymous user of a request carries id '' and role `anonymous`, and used to
        -- go through this policy as if it were the system (2026-10-23).
        (COALESCE(current_setting('app.current_user_id', true), '') = ''
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
        OR
        -- If admin, allow everything
        current_setting('app.current_user_role', true) = 'admin'
        OR
        -- If the record's owner, allow
        owner_id = current_setting('app.current_user_id', true)
        OR
        -- If owner_id is NULL (legacy records), check in the data JSONB
        (
            owner_id IS NULL 
            AND data->>'ownerId' = current_setting('app.current_user_id', true)
        )
    )
    WITH CHECK (
        -- Only the owner can modify (or the system, see above)
        (COALESCE(current_setting('app.current_user_id', true), '') = ''
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
        OR
        current_setting('app.current_user_role', true) = 'admin'
        OR
        owner_id = current_setting('app.current_user_id', true)
    );

-- Policy: Public records are visible to everyone
-- (when there is no owner restriction)
DROP POLICY IF EXISTS data_entries_public_read ON data_entries;

CREATE POLICY data_entries_public_read ON data_entries
    FOR SELECT
    TO PUBLIC
    USING (
        -- Records without a specific owner are public
        owner_id IS NULL 
        AND (data->>'isPublic' = 'true' OR data->>'visibility' = 'public')
    );

-- Policy: what the DATASET declares readable, is readable (2026-10-23)
--
-- A dataset's visibility lives in `data_sets.policy_json` (`readAccess`:
-- public | authenticated | admin), and the application checks it with
-- `checkReadAccess()`. The database did not look at it: for a logged-in user who
-- was not admin, the entries of a PUBLIC dataset without an owner (all those of
-- the games) matched no policy and ZERO rows came out. And the
-- anonymous saw them only because it went through the system hatch.
--
-- With this, the database says the same as the application: `public` is readable by
-- anyone, `authenticated` by whoever has a session. Only for datasets WITHOUT
-- `rlsRules`: those that have them are per-owner and are filtered by
-- `data_entries_owner_isolation` (and `buildDatasetWhere` in the application).
--
-- The subquery does not depend on the row: Postgres evaluates it once per
-- query (hashed subplan), not once per entry.
DROP POLICY IF EXISTS data_entries_lectura_por_dataset ON data_entries;
DROP POLICY IF EXISTS data_entries_dataset_read ON data_entries;

CREATE POLICY data_entries_dataset_read ON data_entries
    FOR SELECT
    TO PUBLIC
    USING (
        data_set_id IN (
            SELECT ds.id FROM data_sets ds
            WHERE (
                ds.policy_json->>'readAccess' = 'public'
                OR (
                    ds.policy_json->>'readAccess' = 'authenticated'
                    AND COALESCE(current_setting('app.current_user_id', true), '') <> ''
                )
            )
            AND COALESCE(
                jsonb_array_length(
                    CASE WHEN jsonb_typeof(ds.policy_json->'rlsRules') = 'array'
                         THEN ds.policy_json->'rlsRules' END
                ), 0) = 0
        )
    );

-- Datasets opened by an agent's SCOPES (`datasets:<slug>:read|write|delete`).
-- The API sets the agent's scopes in app.agent_scopes (comma-separated,
-- local to the transaction: engine/src/rls-request.ts). These functions are the
-- SAME rule as @kitsuden/shared (agent-permission.ts): wildcards `x:*`,
-- `*:y`, `a:*:c`, `admin`, and a `!pattern` denial that beats everything. A test
-- (src/tests/fine-grained-agent-permissions.test.ts) compares the two with a table.
-- Without app.agent_scopes (humans, anonymous, system) they open nothing.
CREATE OR REPLACE FUNCTION kitsuden_pattern_covers(pattern text, required text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $FN$
DECLARE
  p text[];
  r text[];
  n int;
  i int;
BEGIN
  IF pattern IS NULL OR required IS NULL OR pattern = '' OR required = '' THEN RETURN false; END IF;
  IF pattern = required THEN RETURN true; END IF;
  p := string_to_array(pattern, ':');
  n := array_length(p, 1);
  IF n < 2 THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(p) AS x WHERE x <> '*') THEN RETURN false; END IF;
  IF p[1] = '*' THEN
    RETURN length(required) >= length(pattern) - 1
       AND right(required, length(pattern) - 1) = substr(pattern, 2);
  END IF;
  r := string_to_array(required, ':');
  IF p[n] = '*' THEN
    IF array_length(r, 1) <= n - 1 THEN RETURN false; END IF;
    n := n - 1;
  ELSIF array_length(r, 1) <> n THEN
    RETURN false;
  END IF;
  FOR i IN 1..n LOOP
    IF p[i] = '*' THEN
      IF coalesce(r[i], '') = '' THEN RETURN false; END IF;
    ELSIF p[i] IS DISTINCT FROM r[i] THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$FN$;

CREATE OR REPLACE FUNCTION kitsuden_agent_opens_dataset(p_data_set_id uuid, p_action text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
DECLARE
  raw_scopes text := coalesce(current_setting('app.agent_scopes', true), '');
  scopes text[];
  s text;
  req text;
BEGIN
  IF raw_scopes = '' THEN RETURN false; END IF;
  SELECT 'datasets:' || ds.slug || ':' || p_action INTO req FROM data_sets ds WHERE ds.id = p_data_set_id;
  IF req IS NULL THEN RETURN false; END IF;
  scopes := string_to_array(raw_scopes, ',');
  FOREACH s IN ARRAY scopes LOOP
    IF left(s, 1) = '!' AND kitsuden_pattern_covers(substr(s, 2), req) THEN RETURN false; END IF;
  END LOOP;
  FOREACH s IN ARRAY scopes LOOP
    IF left(s, 1) <> '!' AND (s = 'admin' OR s = 'admin:*' OR kitsuden_pattern_covers(s, req)) THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END
$FN$;

-- Reading includes writing and deleting: an INSERT/UPDATE with RETURNING has
-- to be able to see the row it writes. What the agent can READ is decided by the
-- application (canViewDataset in kon-datasets).
DROP POLICY IF EXISTS data_entries_agent_read ON data_entries;
CREATE POLICY data_entries_agent_read ON data_entries FOR SELECT
    USING (
        coalesce(current_setting('app.agent_scopes', true), '') <> ''
        AND (kitsuden_agent_opens_dataset(data_set_id, 'read')
             OR kitsuden_agent_opens_dataset(data_set_id, 'write')
             OR kitsuden_agent_opens_dataset(data_set_id, 'delete'))
    );
DROP POLICY IF EXISTS data_entries_agent_insert ON data_entries;
CREATE POLICY data_entries_agent_insert ON data_entries FOR INSERT
    WITH CHECK (coalesce(current_setting('app.agent_scopes', true), '') <> ''
                AND kitsuden_agent_opens_dataset(data_set_id, 'write'));
DROP POLICY IF EXISTS data_entries_agent_update ON data_entries;
CREATE POLICY data_entries_agent_update ON data_entries FOR UPDATE
    USING (coalesce(current_setting('app.agent_scopes', true), '') <> ''
           AND kitsuden_agent_opens_dataset(data_set_id, 'write'))
    WITH CHECK (coalesce(current_setting('app.agent_scopes', true), '') <> ''
                AND kitsuden_agent_opens_dataset(data_set_id, 'write'));
DROP POLICY IF EXISTS data_entries_agent_delete ON data_entries;
CREATE POLICY data_entries_agent_delete ON data_entries FOR DELETE
    USING (coalesce(current_setting('app.agent_scopes', true), '') <> ''
           AND kitsuden_agent_opens_dataset(data_set_id, 'delete'));

-- human approval in the database: the OTHER way the
-- application opens a dataset to an agent, without a fine-grained scope. It is the rule of
-- `requireDataset` (apps/api/src/services/mcp-tools.ts) and of
-- checkReadAccess/checkWriteAccess (@kitsuden/shared rls-builder.ts):
--
--   · the tool: `mcp:read` to read, `mcp:write` to write/delete;
--   · reading: `readAccess` public/authenticated, or the `dataset:view` scope;
--   · writing: also `writeAccess` authenticated, or `dataset-entry:create`;
--   · deleting: also `writeAccess` authenticated, or `dataset-entry:delete`;
--   · a denial `!datasets:<slug>:<action>` (or broader) always wins.
--
-- Without this, the core MCP tools could not run inside the
-- agent's RLS transaction: Postgres only knew the fine-grained scopes and the
-- application also opens by policy (with the signer as owner).

-- Does the agent's scope list grant `p_required`? (denial wins)
CREATE OR REPLACE FUNCTION kitsuden_agent_grants(p_required text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
DECLARE
  raw_scopes text := coalesce(current_setting('app.agent_scopes', true), '');
  scopes text[];
  s text;
BEGIN
  IF raw_scopes = '' OR p_required IS NULL THEN RETURN false; END IF;
  scopes := string_to_array(raw_scopes, ',');
  FOREACH s IN ARRAY scopes LOOP
    IF left(s, 1) = '!' AND kitsuden_pattern_covers(substr(s, 2), p_required) THEN RETURN false; END IF;
  END LOOP;
  FOREACH s IN ARRAY scopes LOOP
    IF left(s, 1) <> '!' AND (s = 'admin' OR s = 'admin:*' OR kitsuden_pattern_covers(s, p_required)) THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END
$FN$;

-- Is there an agent denial that covers `p_required`?
CREATE OR REPLACE FUNCTION kitsuden_agent_denied(p_required text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
DECLARE
  raw_scopes text := coalesce(current_setting('app.agent_scopes', true), '');
  s text;
BEGIN
  IF raw_scopes = '' THEN RETURN false; END IF;
  FOREACH s IN ARRAY string_to_array(raw_scopes, ',') LOOP
    IF left(s, 1) = '!' AND kitsuden_pattern_covers(substr(s, 2), p_required) THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END
$FN$;

CREATE OR REPLACE FUNCTION kitsuden_agent_opens_by_policy(p_data_set_id uuid, p_action text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
DECLARE
  v_slug text;
  v_policy jsonb;
  v_can_read boolean;
BEGIN
  IF coalesce(current_setting('app.agent_scopes', true), '') = '' THEN RETURN false; END IF;
  SELECT ds.slug, ds.policy_json INTO v_slug, v_policy FROM data_sets ds WHERE ds.id = p_data_set_id;
  IF v_slug IS NULL THEN RETURN false; END IF;
  IF kitsuden_agent_denied('datasets:' || v_slug || ':' || p_action) THEN RETURN false; END IF;
  IF NOT kitsuden_agent_grants(CASE WHEN p_action = 'read' THEN 'mcp:read' ELSE 'mcp:write' END) THEN
    RETURN false;
  END IF;
  v_can_read := coalesce(v_policy->>'readAccess', '') IN ('public', 'authenticated')
                OR kitsuden_agent_grants('dataset:view');
  IF p_action = 'read' THEN RETURN v_can_read; END IF;
  RETURN v_can_read AND (
    coalesce(v_policy->>'writeAccess', '') = 'authenticated'
    OR kitsuden_agent_grants(CASE WHEN p_action = 'delete' THEN 'dataset-entry:delete' ELSE 'dataset-entry:create' END)
  );
END
$FN$;

DROP POLICY IF EXISTS data_entries_agent_policy_read ON data_entries;
CREATE POLICY data_entries_agent_policy_read ON data_entries FOR SELECT
    USING (kitsuden_agent_opens_by_policy(data_set_id, 'read')
           OR kitsuden_agent_opens_by_policy(data_set_id, 'write')
           OR kitsuden_agent_opens_by_policy(data_set_id, 'delete'));
DROP POLICY IF EXISTS data_entries_agent_policy_insert ON data_entries;
CREATE POLICY data_entries_agent_policy_insert ON data_entries FOR INSERT
    WITH CHECK (kitsuden_agent_opens_by_policy(data_set_id, 'write'));
DROP POLICY IF EXISTS data_entries_agent_policy_update ON data_entries;
CREATE POLICY data_entries_agent_policy_update ON data_entries FOR UPDATE
    USING (kitsuden_agent_opens_by_policy(data_set_id, 'write'))
    WITH CHECK (kitsuden_agent_opens_by_policy(data_set_id, 'write'));
DROP POLICY IF EXISTS data_entries_agent_policy_delete ON data_entries;
CREATE POLICY data_entries_agent_policy_delete ON data_entries FOR DELETE
    USING (kitsuden_agent_opens_by_policy(data_set_id, 'delete'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. POLICIES FOR ai_memories (if it exists)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_memories') THEN
        -- Policy: Users only see their own memories
        DROP POLICY IF EXISTS ai_memories_user_isolation ON ai_memories;

        CREATE POLICY ai_memories_user_isolation ON ai_memories
            FOR ALL
            TO PUBLIC
            USING (
                -- System = id AND role empty (the anonymous carries role `anonymous`)
                (COALESCE(current_setting('app.current_user_id', true), '') = ''
                 AND COALESCE(current_setting('app.current_user_role', true), '') = '')
                OR
                user_id = current_setting('app.current_user_id', true)
            )
            WITH CHECK (
                user_id = current_setting('app.current_user_id', true)
            );
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. HELPER FUNCTIONS FOR RLS
-- ═══════════════════════════════════════════════════════════════════════════

-- Function: Check whether RLS is active for the current user
CREATE OR REPLACE FUNCTION is_rls_active()
RETURNS boolean AS $$
BEGIN
    RETURN COALESCE(current_setting('app.current_user_id', true), '') != '';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Get the user_id from the RLS context
CREATE OR REPLACE FUNCTION current_rls_user_id()
RETURNS text AS $$
BEGIN
    RETURN current_setting('app.current_user_id', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Set the RLS context (useful for testing and scripts)
CREATE OR REPLACE FUNCTION set_rls_context(user_id text, user_role text DEFAULT 'user')
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_user_id', user_id, false);
    PERFORM set_config('app.current_user_role', user_role, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Clear the RLS context
CREATE OR REPLACE FUNCTION clear_rls_context()
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_user_id', '', false);
    PERFORM set_config('app.current_user_role', '', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. INDEXES OPTIMIZED FOR RLS
-- ═══════════════════════════════════════════════════════════════════════════

-- Composite index for frequent queries: dataset + owner
CREATE INDEX IF NOT EXISTS idx_data_entries_dataset_owner 
    ON data_entries(data_set_id, owner_id);

-- Index for lookup by owner in data JSONB (legacy support)
CREATE INDEX IF NOT EXISTS idx_data_entries_data_owner 
    ON data_entries((data->>'ownerId'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. DOCUMENTATION COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE data_entries IS 'Data entries table with native RLS enabled. Access is controlled by owner_id and the app.current_user_id context.';

COMMENT ON POLICY data_entries_owner_isolation ON data_entries IS 'RLS policy: Only the owner or an admin may access the records';

-- ============================================================================
-- END OF RLS SCRIPT
-- ============================================================================
-- 
-- USAGE INSTRUCTIONS:
-- 1. Run: psql -d kitsuden -f apps/api/src/db/rls-policies.sql
-- 2. Verify: SELECT * FROM pg_policies WHERE tablename = 'data_entries';
-- 3. Testing: SELECT set_config('app.current_user_id', 'user-123', true);
--              SELECT * FROM data_entries; -- Must return only the user's records
--
-- ============================================================================
