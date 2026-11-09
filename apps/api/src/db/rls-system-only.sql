-- ============================================================================
-- RLS — CORE tables that only the system and administration read
-- ============================================================================
--
-- WHY
--
-- `rls-owned-tables.sql` isolates what BELONGS to a person. That left out the
-- core tables that belong to nobody but hold secrets or personal
-- traces: credentials (`data_sources.password`, `kitsuden_secrets`,
-- `api_keys`, `agent_api_keys`), better-auth verification tokens,
-- records with IPs (`audit_logs`, `agent_audit_logs`), the configuration of
-- actions (webhook secrets) and the code of functions, and the emails
-- of `auth_users`.
--
-- It was shown that a single application gate is not enough: `/api/graph/<table>`
-- let any account read ALL of them (fixed in
-- services/graphify.ts). With these policies, any surface that runs
-- in a request's RLS transaction (Graphify, GraphQL, Vault, entries)
-- returns ZERO rows to anyone who is not admin, even if its application gate
-- fails again.
--
-- PATTERN
--
--   USING / CHECK:  empty or NULL context (system: better-auth, workers,
--                   migrations, any route that does not open an RLS transaction)
--                   | admin role
--                   (+ on `auth_users`, the row's own record)
--
-- `auth_verifications` does NOT admit even admin: its rows are live
-- verification and reset tokens, and only better-auth (empty context)
-- needs them.
--
-- FORCE is mandatory: without it, the table owner is exempt.
-- Idempotent: DROP POLICY IF EXISTS before each CREATE. It only acts on
-- the tables that exist.
-- ============================================================================

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('kitsuden_secrets'),
      ('data_sources'),
      ('api_keys'),
      ('agent_api_keys'),
      -- OAuth for MCP (0055): hashes of codes, tokens and client secrets
      ('oauth_clients'),
      ('oauth_authorization_requests'),
      ('oauth_grants'),
      ('oauth_codes'),
      ('oauth_tokens'),
      ('audit_logs'),
      ('agent_audit_logs'),
      ('actions'),
      ('action_executions'),
      ('kitsuden_functions'),
      -- External MCP servers (0070): an auth header and the approved fingerprints
      ('external_mcp_servers'),
      ('external_mcp_tools')
    ) AS s(table_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t.table_name
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I',
        t.table_name || '_solo_sistema', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I',
        t.table_name || '_system_only', t.table_name);
      EXECUTE format($POLICY$
        CREATE POLICY %I ON %I
          FOR ALL
          TO PUBLIC
          USING (
            ((current_setting('app.current_user_id', true) = ''
              OR current_setting('app.current_user_id', true) IS NULL)
             AND COALESCE(current_setting('app.current_user_role', true), '') = '')
            OR current_setting('app.current_user_role', true) = 'admin'
          )
          WITH CHECK (
            ((current_setting('app.current_user_id', true) = ''
              OR current_setting('app.current_user_id', true) IS NULL)
             AND COALESCE(current_setting('app.current_user_role', true), '') = '')
            OR current_setting('app.current_user_role', true) = 'admin'
          )
      $POLICY$, t.table_name || '_system_only', t.table_name);
    END IF;
  END LOOP;
END $$;

-- The team's approval inbox: system, admin and editor. An agent's proposals
-- (the body it asked to run, the reviewer's comment) and the later reviews of a
-- decision (0069). Only the API and the panel touch them, without an RLS
-- context; under one, anyone who is not on the human team reads zero rows,
-- whatever surface asks (GraphQL, Graphify, the explorer).
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES ('agent_proposals'), ('ledger_reviews')) AS s(table_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t.table_name
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I',
        t.table_name || '_sistema_y_equipo', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I',
        t.table_name || '_system_and_team', t.table_name);
      EXECUTE format($POLICY$
        CREATE POLICY %I ON %I
          FOR ALL
          TO PUBLIC
          USING (
            ((current_setting('app.current_user_id', true) = ''
              OR current_setting('app.current_user_id', true) IS NULL)
             AND COALESCE(current_setting('app.current_user_role', true), '') = '')
            OR current_setting('app.current_user_role', true) IN ('admin', 'editor')
          )
          WITH CHECK (
            ((current_setting('app.current_user_id', true) = ''
              OR current_setting('app.current_user_id', true) IS NULL)
             AND COALESCE(current_setting('app.current_user_role', true), '') = '')
            OR current_setting('app.current_user_role', true) IN ('admin', 'editor')
          )
      $POLICY$, t.table_name || '_system_and_team', t.table_name);
    END IF;
  END LOOP;
END $$;

-- auth_users: each person their own row; admin and system, all of them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'auth_users'
  ) THEN
    ALTER TABLE auth_users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE auth_users FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS auth_users_propia_o_sistema ON auth_users;
    DROP POLICY IF EXISTS auth_users_own_or_system ON auth_users;
    CREATE POLICY auth_users_own_or_system ON auth_users
      FOR ALL
      TO PUBLIC
      USING (
        ((current_setting('app.current_user_id', true) = ''
          OR current_setting('app.current_user_id', true) IS NULL)
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
        OR current_setting('app.current_user_role', true) = 'admin'
        OR id::text = current_setting('app.current_user_id', true)
      )
      WITH CHECK (
        ((current_setting('app.current_user_id', true) = ''
          OR current_setting('app.current_user_id', true) IS NULL)
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
        OR current_setting('app.current_user_role', true) = 'admin'
      );
  END IF;
END $$;

-- auth_verifications: system only (better-auth runs without context).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'auth_verifications'
  ) THEN
    ALTER TABLE auth_verifications ENABLE ROW LEVEL SECURITY;
    ALTER TABLE auth_verifications FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS auth_verifications_solo_sistema ON auth_verifications;
    DROP POLICY IF EXISTS auth_verifications_system_only ON auth_verifications;
    CREATE POLICY auth_verifications_system_only ON auth_verifications
      FOR ALL
      TO PUBLIC
      USING (
        ((current_setting('app.current_user_id', true) = ''
          OR current_setting('app.current_user_id', true) IS NULL)
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      )
      WITH CHECK (
        ((current_setting('app.current_user_id', true) = ''
          OR current_setting('app.current_user_id', true) IS NULL)
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      );
  END IF;
END $$;

-- auth_two_factors (0072): TOTP secrets and backup codes. Same rule as
-- auth_verifications: system only, not even admin. better-auth runs without context.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'auth_two_factors'
  ) THEN
    ALTER TABLE auth_two_factors ENABLE ROW LEVEL SECURITY;
    ALTER TABLE auth_two_factors FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS auth_two_factors_solo_sistema ON auth_two_factors;
    DROP POLICY IF EXISTS auth_two_factors_system_only ON auth_two_factors;
    CREATE POLICY auth_two_factors_system_only ON auth_two_factors
      FOR ALL
      TO PUBLIC
      USING (
        ((current_setting('app.current_user_id', true) = ''
          OR current_setting('app.current_user_id', true) IS NULL)
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      )
      WITH CHECK (
        ((current_setting('app.current_user_id', true) = ''
          OR current_setting('app.current_user_id', true) IS NULL)
         AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      );
  END IF;
END $$;
