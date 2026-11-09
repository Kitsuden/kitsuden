-- ============================================================================
-- RLS — Tables with PERSONAL ownership (expansion of the Titanium Wall)
-- ============================================================================
--
-- WHY THIS FILE EXISTS
--
-- rls-policies.sql covered 2 tables out of 147. The README promised "three
-- independent walls" and the database wall covered 1.4% of the schema: real
-- isolation rested on application policies, which is the layer
-- that has already leaked four times (GraphQL, datasets ×2, realtime).
--
-- WHICH TABLES ARE IN — AND WHICH ARE NOT, WHICH IS JUST AS IMPORTANT
--
-- In are the tables whose user_id/owner_id means "this row IS this
-- person's": sessions, payments, training progress, bookings. Isolating them per
-- user is always semantically correct.
--
-- NOT in are the tables where the column means authorship in a
-- COLLABORATIVE tool (crm_deals.created_by, agile_issues.created_by…): isolating by
-- creator would break the team visibility that is the point of those apps. Their
-- access control belongs to the application policies, which know about
-- teams and roles. Each exclusion is decided, not forgotten — the test
-- tests-unit/rls-coverage.test.ts forces every new table to be classified.
--
-- POLICY PATTERN (identical to rls-policies.sql)
--
-- They fail OPEN with empty context: migrations, seeds, webhooks and workers
-- run without a user and must keep working. Protection applies when
-- withTransactionalRLS() injects the context — that is, on every HTTP
-- request. And FORCE is mandatory: without it, the table owner (the app's
-- role) is exempt and the policy is decorative.
--
-- Run after the migrations:  psql -f rls-owned-tables.sql
-- Idempotent: DROP POLICY IF EXISTS before each CREATE.
-- ============================================================================

-- ── WHY `%I::text` AND NOT `%I` ────────────────────────────────────────────
--
-- `current_setting()` ALWAYS returns `text`. The owner column does not: in the
-- core tables it is `text` (better-auth ids are), but in the
-- kons' tables it is `uuid`. And Postgres has no `uuid = text` operator:
--
--     ERROR:  operator does not exist: uuid = text
--
-- The error does not appear when creating the policy —the body is not analyzed until
-- it is used— but when applying the file to a schema that ALREADY includes a kon
-- table with a uuid owner. That is: startup worked until someone
-- installed a kon, and then the whole container stopped coming up. The
-- cast goes on the column, not on `current_setting`, because a text that is not
-- a valid UUID would make the conversion fail at runtime.

-- ── THE HATCH BELONGS TO THE SYSTEM, NOT TO THE ANONYMOUS (2026-10-15) ─────
--
-- `withTransactionalRLS()` marks anyone without a session with id '' and role
-- 'anonymous'. The hatch used to look ONLY at the empty id, so an anonymous
-- inside an RLS transaction went through all these policies as if they were
-- the system. Now the hatch also requires an empty (or unset) role: the
-- connection without context (migrations, workers, better-auth) still passes; the
-- anonymous only sees rows whose owner is '' — none.
--
-- Template applied to each table:
--   USING:  empty context (system) | admin | owner of the row
--   CHECK:  same — nobody writes another's rows without being admin/system.

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      -- ── Core (always exist) ──────────────────────────────────────────
      ('auth_sessions',                'user_id'),
      ('builder_builds',               'owner_id'),
      -- A vote says WHO voted: it is a personal trace, like the build
      ('builder_build_votes',          'voter_id'),
      -- kon-collection: what someone has and what they are missing is theirs
      ('collection_marks',             'user_id'),
      ('tier_lists',                   'owner_id'),
      ('cardsim_decks',                'owner_id'),
      ('handlab_decks',                'owner_id'),
      ('auth_accounts',                'user_id'),
      ('agent_feedback',               'user_id'),
      -- ── kon-payments: personal financial data ──────────────────────
      ('pay_customers',                'user_id'),
      ('pay_subscriptions',            'user_id'),
      ('pay_events',                   'user_id'),
      -- ── kon-newsletter: the member's row is theirs ─────────────────
      ('nl_members',                   'user_id'),
      -- ── kon-academy-lms: personal progress and results ─────────────
      ('training_user_profiles',       'user_id'),
      ('course_progress',              'user_id'),
      ('topic_progress',               'user_id'),
      ('user_answers',                 'user_id'),
      ('quiz_results',                 'user_id'),
      ('learning_path_progress',       'user_id'),
      ('learning_path_assignments',    'user_id'),
      ('assignments',                  'user_id'),
      ('certificates',                 'user_id'),
      ('satisfaction_surveys',         'user_id'),
      ('feedback',                     'user_id'),
      -- ── kon-booking: personal bookings ─────────────────────────────
      ('booking_reservations',         'user_id'),
      ('booking_notes',                'user_id'),
      -- ── kon-dms: personal trace (not the documents, which are shared)
      ('dms_document_acknowledgments', 'user_id'),
      ('dms_workflow_notifications',   'user_id')
    ) AS owned(table_name, owner_column)
  LOOP
    -- Only if the table exists AND has its ownership column.
    --
    -- Checking only the table is not enough: there are tables that exist without the column
    -- because the migration of the kon that adds it is not in the chain. The
    -- policy is built with `format(... %I ...)` on that column, so
    -- without it Postgres aborts with `column "user_id" does not exist` and
    -- the entire rest of the loop is left unapplied — including the tables that
    -- were fine.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = t.table_name
        AND column_name = t.owner_column
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
      -- Without FORCE, the table owner (the app's role) is EXEMPT and
      -- the policy filters nothing in practice.
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);

      EXECUTE format('DROP POLICY IF EXISTS %I ON %I',
        t.table_name || '_owner_isolation', t.table_name);

      EXECUTE format($POLICY$
        CREATE POLICY %I ON %I
          FOR ALL
          TO PUBLIC
          USING (
            ((current_setting('app.current_user_id', true) = ''
              OR current_setting('app.current_user_id', true) IS NULL)
             AND COALESCE(current_setting('app.current_user_role', true), '') = '')
            OR current_setting('app.current_user_role', true) = 'admin'
            OR %I::text = current_setting('app.current_user_id', true)
          )
          WITH CHECK (
            ((current_setting('app.current_user_id', true) = ''
              OR current_setting('app.current_user_id', true) IS NULL)
             AND COALESCE(current_setting('app.current_user_role', true), '') = '')
            OR current_setting('app.current_user_role', true) = 'admin'
            OR %I::text = current_setting('app.current_user_id', true)
          )
      $POLICY$, t.table_name || '_owner_isolation', t.table_name,
         t.owner_column, t.owner_column);

      RAISE NOTICE 'RLS: % (isolated by %)', t.table_name, t.owner_column;
    END IF;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Vault collections (`vault_*`): strict "system"
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `services/vault.ts` created the policy with `current_user_id = ''` ALONE
-- as "system". The ANONYMOUS context also carries an empty id (with role
-- `anonymous`), so an anonymous that reached a collection saw it and
-- wrote all of it. Here it is rebuilt with the same strict condition as the
-- rest (id AND role empty). Rows without an owner (`owner_id IS NULL`) remain
-- shared-read, as designed, but no longer for anonymous users.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'vault\_%'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_owner_isolation', t);
    EXECUTE format($POLICY$
      CREATE POLICY %I ON %I
        FOR ALL
        TO PUBLIC
        USING (
          (COALESCE(current_setting('app.current_user_id', true), '') = ''
           AND COALESCE(current_setting('app.current_user_role', true), '') = '')
          OR current_setting('app.current_user_role', true) = 'admin'
          OR owner_id = current_setting('app.current_user_id', true)
          OR (owner_id IS NULL
              AND COALESCE(current_setting('app.current_user_id', true), '') <> '')
        )
        WITH CHECK (
          (COALESCE(current_setting('app.current_user_id', true), '') = ''
           AND COALESCE(current_setting('app.current_user_role', true), '') = '')
          OR current_setting('app.current_user_role', true) = 'admin'
          OR owner_id = current_setting('app.current_user_id', true)
        )
    $POLICY$, t || '_owner_isolation', t);
    RAISE NOTICE 'RLS: % (Vault, strict system)', t;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Agent memory (brain): owner + signer + optional shared visibility (0051)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Not the one-column template above: a note belongs to a USER or to an
-- AGENT (the agent's id is what `app.current_user_id` carries for an agent,
-- with role 'agent'), the agent's human signer may read it, and a `shared`
-- note is readable by the team and by agents.
--
--   READ  (brain_notes)   system | admin | owner (user or agent) | signer
--                          | visibility = 'shared' AND role IN (admin, editor, agent)
--   WRITE (brain_notes)   system | admin | the owner itself: an agent writes
--                          only rows whose owner_agent_id is itself; a person
--                          only rows with owner_user_id = itself and no agent.
--                          Nobody else's note is changed, shared or not.
--   brain_connections     read: BOTH notes readable (the subqueries run under
--                          brain_notes' own policy); write: system | admin |
--                          its owner, and both notes readable.
--   brain_claims          read: its note readable; write: system | admin |
--                          its owner, and the owner owns the note.
--
-- An agent with the `admin` SCOPE is still role 'agent' here: it sees its
-- own notes and the shared ones, not every private note (only a human admin
-- or the system does). Fails open only for the SYSTEM (id AND role empty),
-- never for the anonymous context.
DO $$
DECLARE
  t RECORD;
  sys text := $S$((COALESCE(current_setting('app.current_user_id', true), '') = ''
       AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      OR current_setting('app.current_user_role', true) = 'admin')$S$;
  own text := $S$((current_setting('app.current_user_role', true) = 'agent'
        AND owner_agent_id = current_setting('app.current_user_id', true))
      OR (COALESCE(current_setting('app.current_user_role', true), '') NOT IN ('agent', 'anonymous', '')
        AND owner_agent_id IS NULL
        AND owner_user_id = current_setting('app.current_user_id', true)))$S$;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('brain_notes',       'owner_user_id'),
      ('brain_connections', 'owner_user_id'),
      ('brain_claims',      'owner_user_id')
    ) AS owned(table_name, owner_column)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t.table_name AND column_name = 'owner_agent_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.table_name || '_read', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.table_name || '_insert', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.table_name || '_update', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.table_name || '_delete', t.table_name);

      IF t.table_name = 'brain_notes' THEN
        EXECUTE format($P$CREATE POLICY brain_notes_read ON brain_notes FOR SELECT TO PUBLIC USING (
          %s OR %s
          OR (owner_agent_id IS NULL AND owner_user_id = current_setting('app.current_user_id', true)
              AND COALESCE(current_setting('app.current_user_role', true), '') NOT IN ('agent', 'anonymous', ''))
          OR (sponsor_user_id = current_setting('app.current_user_id', true)
              AND COALESCE(current_setting('app.current_user_role', true), '') NOT IN ('agent', 'anonymous', ''))
          OR (visibility = 'shared'
              AND current_setting('app.current_user_role', true) IN ('admin', 'editor', 'agent'))
        )$P$, sys, own);
        EXECUTE format('CREATE POLICY brain_notes_insert ON brain_notes FOR INSERT TO PUBLIC WITH CHECK (%s OR %s)', sys, own);
        EXECUTE format('CREATE POLICY brain_notes_update ON brain_notes FOR UPDATE TO PUBLIC USING (%s OR %s) WITH CHECK (%s OR %s)', sys, own, sys, own);
        EXECUTE format('CREATE POLICY brain_notes_delete ON brain_notes FOR DELETE TO PUBLIC USING (%s OR %s)', sys, own);
      ELSIF t.table_name = 'brain_connections' THEN
        EXECUTE $P$CREATE POLICY brain_connections_read ON brain_connections FOR SELECT TO PUBLIC USING (
          EXISTS (SELECT 1 FROM brain_notes n WHERE n.id = source_note_id)
          AND EXISTS (SELECT 1 FROM brain_notes n WHERE n.id = target_note_id)
        )$P$;
        EXECUTE format($P$CREATE POLICY brain_connections_insert ON brain_connections FOR INSERT TO PUBLIC WITH CHECK (
          %s OR (%s
            AND EXISTS (SELECT 1 FROM brain_notes n WHERE n.id = source_note_id)
            AND EXISTS (SELECT 1 FROM brain_notes n WHERE n.id = target_note_id))
        )$P$, sys, own);
        EXECUTE format('CREATE POLICY brain_connections_update ON brain_connections FOR UPDATE TO PUBLIC USING (%s OR %s) WITH CHECK (%s OR %s)', sys, own, sys, own);
        EXECUTE format('CREATE POLICY brain_connections_delete ON brain_connections FOR DELETE TO PUBLIC USING (%s OR %s)', sys, own);
      ELSE
        EXECUTE $P$CREATE POLICY brain_claims_read ON brain_claims FOR SELECT TO PUBLIC USING (
          EXISTS (SELECT 1 FROM brain_notes n WHERE n.id = note_id)
        )$P$;
        EXECUTE format($P$CREATE POLICY brain_claims_insert ON brain_claims FOR INSERT TO PUBLIC WITH CHECK (
          %s OR (%s AND EXISTS (
            SELECT 1 FROM brain_notes n WHERE n.id = note_id
              AND (n.owner_agent_id = current_setting('app.current_user_id', true)
                   OR (n.owner_agent_id IS NULL AND n.owner_user_id = current_setting('app.current_user_id', true)))))
        )$P$, sys, own);
        EXECUTE format('CREATE POLICY brain_claims_update ON brain_claims FOR UPDATE TO PUBLIC USING (%s OR %s) WITH CHECK (%s OR %s)', sys, own, sys, own);
        EXECUTE format('CREATE POLICY brain_claims_delete ON brain_claims FOR DELETE TO PUBLIC USING (%s OR %s)', sys, own);
      END IF;
      RAISE NOTICE 'RLS: % (brain: owner/agent/signer/shared)', t.table_name;
    END IF;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Code promotion (0053): code_versions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The drafts an AGENT submits for an action's code (lib/promotion.ts). The
-- owner column is `agent_id` (the agent's id is what `app.current_user_id`
-- carries for an agent, with role 'agent'); `sponsor_user_id` is only the
-- signer recorded for the audit, it grants nothing.
--
--   READ   system | human admin | the agent itself (role 'agent' AND
--          agent_id = current_user_id). Another agent's drafts do not exist
--          for it; an editor or a plain user sees none.
--   WRITE  system | human admin. An agent never writes this table directly:
--          the pipeline (the API process, with an empty context) does.
--
-- An agent with the `admin` SCOPE is still role 'agent' here: it sees its own
-- drafts only. Fails open only for the SYSTEM (id AND role empty).
DO $$
DECLARE
  t RECORD;
  sys text := $S$((COALESCE(current_setting('app.current_user_id', true), '') = ''
       AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      OR current_setting('app.current_user_role', true) = 'admin')$S$;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('code_versions', 'agent_id')
    ) AS owned(table_name, owner_column)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t.table_name
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.table_name || '_read', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.table_name || '_insert', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.table_name || '_update', t.table_name);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.table_name || '_delete', t.table_name);
      EXECUTE format($P$CREATE POLICY code_versions_read ON code_versions FOR SELECT TO PUBLIC USING (
        %s
        OR (current_setting('app.current_user_role', true) = 'agent'
            AND agent_id = current_setting('app.current_user_id', true))
      )$P$, sys);
      EXECUTE format('CREATE POLICY code_versions_insert ON code_versions FOR INSERT TO PUBLIC WITH CHECK (%s)', sys);
      EXECUTE format('CREATE POLICY code_versions_update ON code_versions FOR UPDATE TO PUBLIC USING (%s) WITH CHECK (%s)', sys, sys);
      EXECUTE format('CREATE POLICY code_versions_delete ON code_versions FOR DELETE TO PUBLIC USING (%s)', sys);
      RAISE NOTICE 'RLS: % (code promotion: agent reads its own; system/admin write)', t.table_name;
    END IF;
  END LOOP;
END $$;
